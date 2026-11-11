package io.github.whatmekota.playhound.net

import android.content.Context
import android.net.Uri
import android.util.Log
import android.webkit.CookieManager
import io.github.whatmekota.playhound.folders.ContentSource
import io.github.whatmekota.playhound.folders.MediaServer
import io.github.whatmekota.playhound.folders.WriteSessions
import java.io.FileNotFoundException
import java.io.OutputStream
import java.net.Proxy

/** The WebView's cookie store, which the forum's sign-in page fills (ForumLoginActivity). */
object WebViewCookies : CookieJar {
    override fun cookieFor(url: String): String? = try {
        CookieManager.getInstance().getCookie(url)
    }
    catch (_: Exception) {
        null
    }

    override fun store(url: String, setCookies: List<String>) {
        try {
            val cm = CookieManager.getInstance()
            for (c in setCookies) cm.setCookie(url, c)
            cm.flush()
        }
        catch (_: Exception) {
        }
    }
}

/**
 * The one loopback server of the app, shared by the plugins: the media
 * server for picked folders (folders/MediaServer.kt) with the routes the
 * others add: "p" and "m" (net/NetRoutes.kt), "w" (folders/WriteSessions.kt).
 * Started on first use; a new one (with a new token) after the activity
 * is recreated.
 */
object LocalServer {
    private const val TAG = "PhServer"

    /** The proxy from Settings → Network, as the user wrote it, and as a Proxy. */
    @Volatile
    var proxyText: String = ""
        private set

    @Volatile
    private var proxy: Proxy? = null

    val fetcher = Fetcher(WebViewCookies, { proxy })
    val streams = StreamRegistry()

    @Volatile
    private var writes: WriteSessions? = null

    private var server: MediaServer? = null

    /** Use this proxy for everything (blank: none). Throws with a message on a bad address. */
    fun setProxy(raw: String) {
        val parsed = parseProxy(raw)
        proxyText = parsed?.first ?: ""
        proxy = parsed?.second
    }

    @Synchronized
    fun get(context: Context): MediaServer {
        server?.let { return it }
        val resolver = context.applicationContext.contentResolver
        val w = WriteSessions({ uri -> openForWrite(resolver, uri) })
        writes = w
        return MediaServer(
            ContentSource(resolver),
            log = { Log.w(TAG, it) },
            routes = mapOf(
                "p" to ProxyRoute(fetcher),
                "m" to StreamRoute(fetcher, streams),
                "w" to w.route,
            ),
        ).also { server = it }
    }

    fun writes(context: Context): WriteSessions {
        get(context)
        return writes!!
    }

    @Synchronized
    fun close() {
        server?.close()
        server = null
    }

    /** From empty ("wt"); a provider without truncate gets "w" on a file just made empty. */
    private fun openForWrite(resolver: android.content.ContentResolver, uri: String): OutputStream {
        val u = Uri.parse(uri)
        return try {
            resolver.openOutputStream(u, "wt")
        }
        catch (_: IllegalArgumentException) {
            resolver.openOutputStream(u, "w")
        }
        catch (_: UnsupportedOperationException) {
            resolver.openOutputStream(u, "w")
        }
        catch (_: FileNotFoundException) {
            // Some providers say "unsupported mode" this way.
            resolver.openOutputStream(u, "w")
        } ?: throw FileNotFoundException("Could not open it for writing")
    }
}
