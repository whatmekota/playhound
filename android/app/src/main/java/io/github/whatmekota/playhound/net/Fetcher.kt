package io.github.whatmekota.playhound.net

import java.io.ByteArrayInputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URI
import java.net.URL

/** The Chrome the desktop app's resolvers say they are (server/net.mjs), unless a request names its own. */
const val DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

/**
 * Cookies kept between requests, for the hosts that want a session (the
 * forum, after signing in). On the phone this is the WebView's own cookie
 * store, in the app's private storage: the sign-in page writes to it, and
 * requests here read and update it the way a browser would.
 */
interface CookieJar {
    /** The Cookie header for `url`, or null. */
    fun cookieFor(url: String): String?

    /** Keep what a response to `url` set. */
    fun store(url: String, setCookies: List<String>)
}

object NoCookies : CookieJar {
    override fun cookieFor(url: String): String? = null
    override fun store(url: String, setCookies: List<String>) {}
}

/**
 * This phone or the local network: localhost, 127/8, ::1, the private ranges
 * and .local names (server/net.mjs isLocalHost). A proxy out on the internet
 * cannot reach these, so they always go direct.
 */
fun isLocalHost(hostname: String?): Boolean {
    val h = (hostname ?: "").lowercase().trim('[', ']')
    if (h.isEmpty()) return false
    if (h == "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true
    val v4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.\\d{1,3}\\.\\d{1,3}$").find(h)
    if (v4 != null) {
        val a = v4.groupValues[1].toInt()
        val b = v4.groupValues[2].toInt()
        return a == 127 || a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254)
    }
    if (h.contains(':')) return h == "::1" || Regex("^f[cd][0-9a-f]{2}:").containsMatchIn(h) || Regex("^fe[89ab][0-9a-f]:").containsMatchIn(h)
    return false
}

/**
 * "host:port" or "http://host:port" as an HTTP proxy, or null for none.
 * Throws with a message for the user on anything else (server/net.mjs
 * normaliseProxy). Proxies with a user name are not supported here.
 */
fun parseProxy(raw: String?): Pair<String, Proxy>? {
    val text = (raw ?: "").trim()
    if (text.isEmpty()) return null
    val uri = try {
        URI(if (text.contains("://")) text else "http://$text")
    }
    catch (_: Exception) {
        throw IllegalArgumentException("That is not a proxy address. Try http://127.0.0.1:8080")
    }
    if (uri.scheme?.lowercase() != "http") throw IllegalArgumentException("${uri.scheme?.uppercase()} proxies are not supported here; use its HTTP port")
    if (uri.host.isNullOrEmpty()) throw IllegalArgumentException("That is not a proxy address. Try http://127.0.0.1:8080")
    if (uri.port <= 0) throw IllegalArgumentException("The proxy needs a port, like http://127.0.0.1:8080")
    if (uri.userInfo != null) throw IllegalArgumentException("Proxies with a user name and password are not supported in the Android app")
    return "http://${uri.host}:${uri.port}" to Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved(uri.host, uri.port))
}

/** A response, after any redirects. Close it to let the connection go. */
class Upstream(private val conn: HttpURLConnection, val url: String, val status: Int, val setCookies: List<String>) : Closeable {
    /** Every header but Set-Cookie (see setCookies), names as sent. */
    val headers: List<Pair<String, String>> = conn.headerFields.entries.flatMap { (k, vs) ->
        if (k == null || k.equals("set-cookie", ignoreCase = true)) emptyList() else vs.map { k to it }
    }

    fun header(name: String): String? = headers.firstOrNull { it.first.equals(name, ignoreCase = true) }?.second

    /** The length the server promised, or -1. */
    val length: Long get() = conn.contentLengthLong

    val body: InputStream by lazy {
        try {
            if (status >= 400) conn.errorStream ?: ByteArrayInputStream(ByteArray(0)) else conn.inputStream
        }
        catch (_: IOException) {
            conn.errorStream ?: ByteArrayInputStream(ByteArray(0))
        }
    }

    override fun close() {
        try {
            body.close()
        }
        catch (_: Exception) {
        }
        conn.disconnect()
    }
}

/**
 * HTTP(S) requests for the page, with the headers it asks for: what the
 * desktop app's local proxy (es-proxy.mjs, server/net.mjs) does there.
 * Redirects are followed here, the way fetch() follows them: a 303, or a
 * 301/302 to a POST, becomes a GET, and the cookies and credentials a request
 * carried stay behind when it moves to another host. Range goes along.
 */
class Fetcher(
    private val jar: CookieJar = NoCookies,
    private val proxy: () -> Proxy? = { null },
    private val connectTimeoutMs: Int = 20_000,
    private val readTimeoutMs: Int = 60_000,
) {
    fun open(
        url: String,
        method: String = "GET",
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        useJar: Boolean = false,
        maxRedirects: Int = 8,
    ): Upstream {
        var current = url
        var verb = method.uppercase()
        var payload = body
        var sent = headers.filterKeys { it.lowercase() !in NOT_FORWARDED }
        val cookies = ArrayList<String>()
        for (hop in 0..maxRedirects) {
            val target = URL(current)
            if (target.protocol != "http" && target.protocol != "https") throw IOException("Only http(s) links")
            val p = proxy()?.takeIf { !isLocalHost(target.host) } ?: Proxy.NO_PROXY
            val conn = target.openConnection(p) as HttpURLConnection
            conn.instanceFollowRedirects = false
            conn.connectTimeout = connectTimeoutMs
            conn.readTimeout = readTimeoutMs
            conn.requestMethod = verb
            conn.useCaches = false
            var hasUa = false
            var hasCookie = false
            for ((k, v) in sent) {
                if (k.equals("user-agent", ignoreCase = true)) hasUa = true
                if (k.equals("cookie", ignoreCase = true)) hasCookie = true
                conn.setRequestProperty(k, v)
            }
            if (!hasUa) conn.setRequestProperty("User-Agent", DEFAULT_UA)
            if (useJar && !hasCookie) jar.cookieFor(current)?.takeIf { it.isNotEmpty() }?.let { conn.setRequestProperty("Cookie", it) }
            if (payload != null && verb != "GET" && verb != "HEAD") {
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(payload.size)
                conn.outputStream.use { it.write(payload) }
            }
            else if (verb == "POST" || verb == "PUT") {
                // An empty POST still says how long it is (some APIs insist).
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(0)
                conn.outputStream.close()
            }
            val status = conn.responseCode
            val set = conn.headerFields.entries.filter { it.key?.equals("set-cookie", ignoreCase = true) == true }.flatMap { it.value }
            if (set.isNotEmpty()) {
                cookies.addAll(set)
                if (useJar) jar.store(current, set)
            }
            val location = conn.getHeaderField("Location")
            if (status in REDIRECTS && location != null && hop < maxRedirects) {
                try {
                    (if (status >= 400) conn.errorStream else conn.inputStream)?.close()
                }
                catch (_: IOException) {
                }
                conn.disconnect()
                val next = URL(target, location)
                if (status == 303 || ((status == 301 || status == 302) && verb == "POST")) {
                    verb = "GET"
                    payload = null
                    sent = sent.filterKeys { !it.equals("content-type", ignoreCase = true) }
                }
                if (!next.host.equals(target.host, ignoreCase = true)) {
                    sent = sent.filterKeys { it.lowercase() !in CREDENTIALS }
                }
                current = next.toString()
                continue
            }
            return Upstream(conn, current, status, cookies)
        }
        throw IOException("Too many redirects")
    }

    companion object {
        private val REDIRECTS = setOf(301, 302, 303, 307, 308)

        /** Set by the connection itself, or meaningless for a hop. */
        private val NOT_FORWARDED = setOf(
            "host", "content-length", "connection", "keep-alive", "transfer-encoding", "te", "trailer",
            "upgrade", "accept-encoding", "proxy-authorization", "proxy-connection",
        )

        /** What does not follow a redirect to another host. */
        private val CREDENTIALS = setOf("cookie", "authorization", "x-website-token")
    }
}
