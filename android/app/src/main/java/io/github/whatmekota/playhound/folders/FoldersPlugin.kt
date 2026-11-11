package io.github.whatmekota.playhound.folders

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors

/**
 * Library folders on Android (src/lib/android/folders.ts is the page's side).
 *
 * - pick: the system folder picker (Storage Access Framework), keeping the
 *   permission across restarts.
 * - trees / forget: the folders kept, and letting one go.
 * - scan: every relevant file in one, recursively, sent back in batches as
 *   "scanBatch" events.
 * - server: the local media server's address, for streaming them.
 * - readText: a small file's text over the bridge (the server does it too).
 */
@CapacitorPlugin(name = "PhFolders")
class FoldersPlugin : Plugin() {
    private val work = Executors.newCachedThreadPool { r -> Thread(r, "ph-folders").apply { isDaemon = true } }
    private var server: MediaServer? = null

    @Synchronized
    private fun mediaServer(): MediaServer = server ?: MediaServer(ContentSource(context.contentResolver)) { Log.w(TAG, it) }.also { server = it }

    override fun handleOnDestroy() {
        server?.close()
        server = null
        work.shutdownNow()
    }

    @PluginMethod
    fun pick(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
        startActivityForResult(call, intent, "picked")
    }

    @ActivityCallback
    private fun picked(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            call.resolve(JSObject().put("cancelled", true))
            return
        }
        val resolver = context.contentResolver
        val granted = result.data!!.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        try {
            resolver.takePersistableUriPermission(uri, granted)
        }
        catch (_: SecurityException) {
            try {
                resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            catch (e: SecurityException) {
                call.reject("Android would not let playhound keep access to that folder: ${e.message}")
                return
            }
        }
        call.resolve(treeJson(uri))
    }

    private fun treeJson(uri: Uri): JSObject {
        val perm = context.contentResolver.persistedUriPermissions.firstOrNull { it.uri == uri }
        return JSObject()
            .put("uri", uri.toString())
            .put("name", TreeScanner.nameOf(context.contentResolver, uri) ?: uri.lastPathSegment?.substringAfterLast(':')?.substringAfterLast('/') ?: "Folder")
            .put("read", perm?.isReadPermission == true)
            .put("write", perm?.isWritePermission == true)
    }

    /** The folders this app still has access to. */
    @PluginMethod
    fun trees(call: PluginCall) {
        background(call) {
            val list = JSArray()
            for (p in context.contentResolver.persistedUriPermissions) {
                if (p.isReadPermission) list.put(treeJson(p.uri))
            }
            call.resolve(JSObject().put("trees", list))
        }
    }

    /**
     * Work off the bridge's thread. Whatever it throws is the call's error:
     * an exception escaping a pool thread would end the app.
     */
    private fun background(call: PluginCall, body: () -> Unit) {
        try {
            work.execute {
                try {
                    body()
                }
                catch (e: Throwable) {
                    Log.w(TAG, "${call.methodName}: $e")
                    call.reject(e.message ?: e.javaClass.simpleName)
                }
            }
        }
        catch (e: java.util.concurrent.RejectedExecutionException) {
            call.reject("The app is closing")
        }
    }

    @PluginMethod
    fun forget(call: PluginCall) {
        val uri = call.getString("uri") ?: return call.reject("No uri")
        try {
            context.contentResolver.releasePersistableUriPermission(
                Uri.parse(uri),
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        }
        catch (_: SecurityException) {
            // Not held (any more): nothing to let go.
        }
        call.resolve()
    }

    @PluginMethod
    fun scan(call: PluginCall) {
        val uri = call.getString("uri") ?: return call.reject("No uri")
        val id = call.getString("id") ?: ""
        val label = call.getString("label") ?: "Folder"
        val exts = try {
            call.getArray("extensions")?.toList<String>()?.map { it.lowercase() }?.toSet() ?: emptySet()
        }
        catch (_: Exception) {
            return call.reject("extensions must be a list of strings")
        }
        background(call) {
            val started = System.nanoTime()
            try {
                val scanner = TreeScanner(context.contentResolver, Uri.parse(uri), label, exts) { files ->
                    val arr = JSArray()
                    for (f in files) {
                        arr.put(
                            JSObject()
                                .put("uri", f.uri)
                                .put("path", f.path)
                                .put("name", f.name)
                                .put("size", f.size)
                                .put("modified", f.modified)
                                .put("mime", f.mime),
                        )
                    }
                    notifyListeners("scanBatch", JSObject().put("id", id).put("files", arr))
                }
                val count = scanner.run()
                call.resolve(
                    JSObject()
                        .put("count", count)
                        .put("failedDirs", scanner.failedDirs)
                        .put("ms", (System.nanoTime() - started) / 1_000_000),
                )
            }
            catch (e: Exception) {
                call.reject(e.message ?: "The folder could not be read", "UNREADABLE")
            }
        }
    }

    @PluginMethod
    fun server(call: PluginCall) {
        background(call) {
            try {
                call.resolve(JSObject().put("base", mediaServer().base))
            }
            catch (e: Exception) {
                call.reject("The media server did not start: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun readText(call: PluginCall) {
        val uri = call.getString("uri") ?: return call.reject("No uri")
        background(call) {
            try {
                // Scripts and subtitles: a few MB at most. Anything bigger is
                // not what this is for, and would not fit through the bridge.
                val text = context.contentResolver.openInputStream(Uri.parse(uri))?.use { input ->
                    val out = java.io.ByteArrayOutputStream()
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        if (out.size() + n > MAX_TEXT_BYTES) throw java.io.IOException("Too big to read as text")
                        out.write(buf, 0, n)
                    }
                    out.toString(Charsets.UTF_8.name())
                }
                if (text == null) call.reject("Could not open it") else call.resolve(JSObject().put("text", text))
            }
            catch (e: Exception) {
                call.reject(e.message ?: "Could not read it")
            }
        }
    }

    private companion object {
        const val TAG = "PhFolders"
        const val MAX_TEXT_BYTES = 32 * 1024 * 1024
    }
}
