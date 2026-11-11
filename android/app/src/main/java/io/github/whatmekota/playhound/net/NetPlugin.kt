package io.github.whatmekota.playhound.net

import android.app.Activity
import android.content.Intent
import android.util.Base64
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors

/**
 * The internet for the page without the desktop app's Node proxy
 * (src/lib/android/net.ts is the page's side):
 *
 * - server: the loopback server's address; "p" on it is a CORS-free fetch
 *   with any headers (net/NetRoutes.kt).
 * - register / registerMega: a stream for <video> that needs headers, or a
 *   MEGA file decrypted on the fly; answers the URL to play.
 * - setProxy / getProxy: the HTTP proxy from Settings → Network.
 * - forumStatus / forumLogin / forumLogout: EroScripts' own sign-in page in
 *   a WebView of the app; the session cookie stays in the WebView's cookie
 *   store (the app's private storage), and "p" requests marked X-Ph-Jar use
 *   and refresh it the way a browser does.
 */
@CapacitorPlugin(name = "PhNet")
class NetPlugin : Plugin() {
    private val work = Executors.newCachedThreadPool { r -> Thread(r, "ph-net").apply { isDaemon = true } }

    override fun handleOnDestroy() {
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

    private fun base(): String = LocalServer.get(context).base

    @PluginMethod
    fun server(call: PluginCall) {
        background(call) { call.resolve(JSObject().put("base", base())) }
    }

    @PluginMethod
    fun register(call: PluginCall) {
        val url = call.getString("url")?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
            ?: return call.reject("Only http(s) streams can be played through here")
        val headers = LinkedHashMap<String, String>()
        call.getObject("headers")?.let { h ->
            for (k in h.keys()) {
                val v = h.opt(k)
                if (v is String && Regex("^[\\w-]+$").matches(k)) headers[k] = v
            }
        }
        val name = call.getString("name") ?: url.substringBefore('?').substringAfterLast('/')
        val hls = call.getString("kind") == "hls"
        background(call) {
            val key = LocalServer.streams.register(StreamTarget.Http(url, headers, name, hls))
            call.resolve(JSObject().put("url", "${base()}m/$key"))
        }
    }

    @PluginMethod
    fun registerMega(call: PluginCall) {
        val url = call.getString("url")?.takeIf { it.startsWith("https://") || it.startsWith("http://") }
        val request = call.getString("request")
        if (url == null && request == null) return call.reject("No download URL, and no way to ask for one")
        val key = try {
            Base64.decode(call.getString("key") ?: "", Base64.DEFAULT)
        }
        catch (_: IllegalArgumentException) {
            return call.reject("Bad key")
        }
        if (key.size != 32) return call.reject("A MEGA file key is 32 bytes")
        val size = call.getLong("size") ?: call.getDouble("size")?.toLong() ?: return call.reject("No size")
        val name = call.getString("name") ?: "video.mp4"
        background(call) {
            val k = LocalServer.streams.register(StreamTarget.Mega(url, request, call.getString("folder"), key, size, name))
            call.resolve(JSObject().put("url", "${base()}m/$k"))
        }
    }

    private fun proxyJson(): JSObject {
        val p = LocalServer.proxyText.ifEmpty { null }
        return JSObject().put("configured", p).put("env", null).put("effective", p)
    }

    @PluginMethod
    fun setProxy(call: PluginCall) {
        try {
            LocalServer.setProxy(call.getString("proxy") ?: "")
            call.resolve(proxyJson())
        }
        catch (e: IllegalArgumentException) {
            call.reject(e.message ?: "That is not a proxy address")
        }
    }

    @PluginMethod
    fun getProxy(call: PluginCall) {
        call.resolve(proxyJson())
    }

    // ── EroScripts ───────────────────────────────────────────────────────────

    @PluginMethod
    fun forumStatus(call: PluginCall) {
        call.resolve(JSObject().put("signedIn", ForumLoginActivity.signedIn()))
    }

    @PluginMethod
    fun forumLogin(call: PluginCall) {
        startActivityForResult(call, Intent(context, ForumLoginActivity::class.java), "loggedIn")
    }

    @ActivityCallback
    private fun loggedIn(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val ok = ForumLoginActivity.signedIn()
        call.resolve(JSObject().put("signedIn", ok).put("cancelled", result.resultCode != Activity.RESULT_OK && !ok))
    }

    @PluginMethod
    fun forumLogout(call: PluginCall) {
        ForumLoginActivity.signOut()
        call.resolve(JSObject().put("signedIn", false))
    }
}
