package io.github.whatmekota.playhound.app

import android.content.ClipData
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Base64
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import io.github.whatmekota.playhound.net.LocalServer
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The app itself (src/lib/android/app.ts is the page's side):
 *
 * - info: version, and whether this is a debug build (a release build
 *   cannot update one: they are signed with different keys).
 * - share: Android's share sheet for a file the page made (the share card).
 * - downloadUpdate / cancelUpdate / installUpdate / canInstall: the in-app
 *   updater. The APK goes to the app's cache ("updates/"), is checked
 *   against the SHA-256 GitHub lists for it, and is handed to Android's
 *   package installer through the FileProvider; Android itself refuses one
 *   signed with another key than the installed app.
 */
@CapacitorPlugin(name = "PhApp")
class AppPlugin : Plugin() {
    private val work = Executors.newCachedThreadPool { r -> Thread(r, "ph-app").apply { isDaemon = true } }
    private val cancel = AtomicBoolean(false)

    override fun handleOnDestroy() {
        cancel.set(true)
        work.shutdownNow()
    }

    private fun background(call: PluginCall, body: () -> Unit) {
        try {
            work.execute {
                try {
                    body()
                }
                catch (e: Throwable) {
                    call.reject(e.message ?: e.javaClass.simpleName)
                }
            }
        }
        catch (_: java.util.concurrent.RejectedExecutionException) {
            call.reject("The app is closing")
        }
    }

    private val authority get() = "${context.packageName}.fileprovider"

    @PluginMethod
    fun info(call: PluginCall) {
        val pm = context.packageManager
        val pkg = pm.getPackageInfo(context.packageName, 0)
        @Suppress("DEPRECATION")
        val code = if (Build.VERSION.SDK_INT >= 28) pkg.longVersionCode else pkg.versionCode.toLong()
        call.resolve(
            JSObject()
                .put("version", pkg.versionName)
                .put("code", code)
                .put("debug", (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0)
                .put("sdk", Build.VERSION.SDK_INT),
        )
    }

    // ── Share ────────────────────────────────────────────────────────────────

    /** Share { name, mime, data (base64) } through the share sheet; resolves once the sheet is up. */
    @PluginMethod
    fun share(call: PluginCall) {
        val name = call.getString("name")?.replace(Regex("[\\\\/:*?\"<>|]"), "_")?.takeIf { it.isNotBlank() } ?: "playhound.png"
        val mime = call.getString("mime") ?: "image/png"
        val data = call.getString("data") ?: return call.reject("Nothing to share")
        val title = call.getString("title") ?: "Share"
        background(call) {
            val dir = File(context.cacheDir, "share").apply { mkdirs() }
            // Only the latest is kept: an app that was shared to has read it by the next one.
            dir.listFiles()?.forEach { it.delete() }
            val file = File(dir, name)
            file.writeBytes(Base64.decode(data, Base64.DEFAULT))
            val uri = FileProvider.getUriForFile(context, authority, file)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData.newRawUri(name, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, title).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            activity.runOnUiThread {
                try {
                    activity.startActivity(chooser)
                    call.resolve()
                }
                catch (e: Exception) {
                    call.reject("Nothing on this phone takes it: ${e.message}")
                }
            }
        }
    }

    // ── Updates ──────────────────────────────────────────────────────────────

    private fun updatesDir() = File(context.cacheDir, "updates").apply { mkdirs() }

    /**
     * Download { url, name, sha256? } into the cache with "updateProgress"
     * events ({ received, total }). Resolves { path, size }.
     */
    @PluginMethod
    fun downloadUpdate(call: PluginCall) {
        val url = call.getString("url")?.takeIf { it.startsWith("https://") } ?: return call.reject("Not an https link")
        val name = call.getString("name")?.takeIf { Regex("^[\\w.-]+\\.apk$").matches(it) } ?: return call.reject("Not an APK name")
        val sha = call.getString("sha256")?.lowercase()?.removePrefix("sha256:")
        cancel.set(false)
        background(call) {
            val dir = updatesDir()
            // Earlier downloads: one APK at a time is enough.
            dir.listFiles()?.forEach { if (it.name != name) it.delete() }
            val out = File(dir, "$name.part")
            val digest = MessageDigest.getInstance("SHA-256")
            LocalServer.fetcher.open(url, headers = mapOf("Accept" to "application/octet-stream")).use { up ->
                if (up.status !in 200..299) throw IOException("GitHub answered ${up.status}")
                val total = up.length
                var received = 0L
                var lastTell = 0L
                out.outputStream().use { file ->
                    val buf = ByteArray(256 * 1024)
                    while (true) {
                        if (cancel.get()) throw IOException("Cancelled")
                        val n = up.body.read(buf)
                        if (n < 0) break
                        file.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        received += n
                        val now = System.nanoTime()
                        if (now - lastTell > 250_000_000L) {
                            lastTell = now
                            notifyListeners("updateProgress", JSObject().put("received", received).put("total", total))
                        }
                    }
                }
                if (total >= 0 && received != total) throw IOException("The download stopped early")
                notifyListeners("updateProgress", JSObject().put("received", received).put("total", total))
            }
            val got = digest.digest().joinToString("") { "%02x".format(it) }
            if (sha != null && sha.isNotEmpty() && sha != got) {
                out.delete()
                throw IOException("The download is damaged (its SHA-256 does not match the release's)")
            }
            val apk = File(dir, name)
            apk.delete()
            if (!out.renameTo(apk)) throw IOException("Could not keep the download")
            call.resolve(JSObject().put("path", apk.absolutePath).put("size", apk.length()))
        }
    }

    @PluginMethod
    fun cancelUpdate(call: PluginCall) {
        cancel.set(true)
        call.resolve()
    }

    /** Whether Android lets this app install packages (Settings → Install unknown apps). */
    @PluginMethod
    fun canInstall(call: PluginCall) {
        call.resolve(JSObject().put("allowed", allowed()))
    }

    private fun allowed(): Boolean = Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    /**
     * Hand { path } to the package installer. Without the permission to
     * install, opens the setting for it instead and resolves { needsPermission: true }.
     */
    @PluginMethod
    fun installUpdate(call: PluginCall) {
        val path = call.getString("path") ?: return call.reject("No path")
        val file = File(path)
        if (file.parentFile?.canonicalPath != updatesDir().canonicalPath || !file.isFile) return call.reject("No such download")
        if (!allowed()) {
            val ask = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            activity.startActivity(ask)
            call.resolve(JSObject().put("needsPermission", true))
            return
        }
        val uri = FileProvider.getUriForFile(context, authority, file)
        val install = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            activity.startActivity(install)
            call.resolve(JSObject().put("started", true))
        }
        catch (e: Exception) {
            call.reject("Android's installer did not open: ${e.message}")
        }
    }
}
