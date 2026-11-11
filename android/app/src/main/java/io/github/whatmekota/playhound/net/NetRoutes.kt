package io.github.whatmekota.playhound.net

import io.github.whatmekota.playhound.folders.Exchange
import io.github.whatmekota.playhound.folders.RangeAnswer
import io.github.whatmekota.playhound.folders.Route
import io.github.whatmekota.playhound.folders.parseRange
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.CipherInputStream
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/*
 * What the desktop app's local proxy does (es-proxy.mjs, server/media.mjs),
 * on the phone's loopback media server, so the page needs no Node:
 *
 *   p   fetch any http(s) URL with the headers the page names, CORS-free:
 *       the page's nativeFetch (src/lib/android/net.ts) goes through here
 *   m   streams registered with their headers, for <video>: a file with
 *       Range, an HLS playlist rewritten to come back through here, or a
 *       MEGA file decrypted as it streams
 *
 * Both sit behind the server's random token, which only the page knows.
 */

/** Response headers that describe the connection, not the content, or that the answer sets itself. */
private val HOP = setOf(
    "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authenticate",
    "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers",
    "access-control-expose-headers", "access-control-allow-credentials", "access-control-max-age",
    "content-length", "x-frame-options", "content-security-policy", "alt-svc", "strict-transport-security",
)

private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

/** The headers a request names in X-Ph-Headers: JSON, URI-encoded (a header value is Latin-1 only). */
fun parseHeaderJson(raw: String?): Map<String, String> {
    if (raw.isNullOrBlank()) return emptyMap()
    val obj = JSONObject(URLDecoder.decode(raw, "UTF-8"))
    val out = LinkedHashMap<String, String>()
    for (k in obj.keys()) {
        if (Regex("^[A-Za-z0-9!#$%&'*+.^_`|~-]+$").matches(k)) out[k] = obj.optString(k)
    }
    return out
}

/**
 * Pass an upstream answer on: its status and headers (less the ones about
 * the hop), with the final URL and the cookies it set in headers of our own
 * (a page cannot read Set-Cookie). Returns false when the connection has to
 * close to mark the end of a body of unknown length.
 */
private fun relay(ex: Exchange, up: Upstream, contentType: String? = null, headOnly: Boolean = false): Boolean {
    val headers = ArrayList<Pair<String, String>>()
    for ((k, v) in up.headers) {
        if (k.lowercase() in HOP) continue
        if (contentType != null && k.equals("content-type", ignoreCase = true)) continue
        headers.add(k to v)
    }
    if (contentType != null) headers.add("Content-Type" to contentType)
    headers.add("X-Ph-Url" to enc(up.url))
    if (up.setCookies.isNotEmpty()) headers.add("X-Ph-Set-Cookie" to enc(JSONArray(up.setCookies).toString()))
    headers.add("Access-Control-Expose-Headers" to "*")
    val noBody = headOnly || ex.req.method == "HEAD" || up.status == 204 || up.status == 304
    // A body the connection decoded itself (gzip) has no length any more:
    // then the end of the connection marks the end of it.
    val length = up.length
    return when {
        noBody -> {
            headers.add("Content-Length" to (if (ex.req.method == "HEAD" && length >= 0) length.toString() else "0"))
            if (length >= 0) headers.add("X-Ph-Content-Length" to length.toString())
            ex.head(up.status, headers)
            ex.out.flush()
            true
        }
        length >= 0 -> {
            headers.add("Content-Length" to length.toString())
            ex.head(up.status, headers)
            ex.copy(up.body, length)
            true
        }
        else -> {
            headers.add("Connection" to "close")
            ex.head(up.status, headers)
            ex.copy(up.body, Long.MAX_VALUE)
            false
        }
    }
}

private fun failed(ex: Exchange, status: Int, message: String): Boolean {
    val body = JSONObject().put("error", message).toString().toByteArray(Charsets.UTF_8)
    ex.head(status, listOf("Content-Type" to "application/json", "Content-Length" to body.size.toString(), "X-Ph-Error" to "1", "Access-Control-Expose-Headers" to "*"))
    ex.out.write(body)
    ex.out.flush()
    return true
}

/** Why a request did not get through, in words. */
private fun why(e: Exception): String = when (e) {
    is java.net.UnknownHostException -> "Could not find ${e.message ?: "the server"} (no internet, or the name is blocked)"
    is java.net.SocketTimeoutException -> "The server took too long to answer"
    is java.net.ConnectException -> "Could not connect: ${e.message}"
    is javax.net.ssl.SSLException -> "The secure connection failed: ${e.message}"
    else -> e.message ?: e.javaClass.simpleName
}

/**
 * "p?u=<url>": the request as the page describes it. Method in X-Ph-Method
 * (else the request's own), headers in X-Ph-Headers, the body as sent,
 * X-Ph-Jar: 1 to use and update the cookie store. A Range header of the
 * request itself goes along too, so a <video> can play a "p" URL.
 */
class ProxyRoute(private val fetcher: Fetcher, private val maxBody: Int = 32 * 1024 * 1024) : Route {
    override fun serve(ex: Exchange): Boolean {
        val target = ex.req.query("u")?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
            ?: return failed(ex, 400, "Only http(s) links")
        val method = (ex.req.headers["x-ph-method"] ?: ex.req.method).uppercase()
        if (method !in METHODS) return failed(ex, 405, "Method not allowed")
        val headers = try {
            LinkedHashMap(parseHeaderJson(ex.req.headers["x-ph-headers"]))
        }
        catch (e: Exception) {
            return failed(ex, 400, "Bad X-Ph-Headers: ${e.message}")
        }
        ex.req.headers["range"]?.let { r -> if (headers.keys.none { it.equals("range", ignoreCase = true) }) headers["Range"] = r }
        val body = try {
            ex.readBody(maxBody).takeIf { it.isNotEmpty() }
        }
        catch (e: IOException) {
            return failed(ex, 413, e.message ?: "Body too large")
        }
        val up = try {
            fetcher.open(target, method, headers, body, useJar = ex.req.headers["x-ph-jar"] == "1")
        }
        catch (e: Exception) {
            return failed(ex, 502, why(e))
        }
        return up.use { relay(ex, it, headOnly = method == "HEAD") }
    }

    private companion object {
        val METHODS = setOf("GET", "HEAD", "POST", "PUT", "DELETE")
    }
}

/** What a registered stream plays from. */
sealed class StreamTarget {
    abstract val name: String

    /** A file (or, with hls, a playlist) fetched with these headers. */
    data class Http(val url: String, val headers: Map<String, String>, override val name: String, val hls: Boolean = false) : StreamTarget()

    /**
     * A MEGA file: its 32-byte node key and its size, and either its
     * download URL or the API request that gives one ({"a":"g",…}, with
     * the folder handle a file in a shared folder is asked for under).
     * The URL is asked for when it is first played, and again if it stops
     * working. The content is AES-128-CTR, key = k[0..16] xor k[16..32],
     * counter starting at k[16..24] followed by the block number.
     */
    class Mega(
        url: String?,
        val request: String?,
        val folder: String?,
        val key: ByteArray,
        val size: Long,
        override val name: String,
    ) : StreamTarget() {
        @Volatile
        var url: String? = url
    }
}

/** Streams by random key, kept for six hours: long enough to watch, short enough for signed URLs. */
class StreamRegistry(private val ttlMs: Long = 6 * 60 * 60 * 1000L, private val now: () -> Long = System::currentTimeMillis) {
    private class Entry(val target: StreamTarget, val at: Long)

    private val map = ConcurrentHashMap<String, Entry>()
    private val random = SecureRandom()

    fun register(t: StreamTarget): String {
        val t0 = now()
        map.entries.removeIf { t0 - it.value.at > ttlMs }
        val bytes = ByteArray(9).also { random.nextBytes(it) }
        val key = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
        map[key] = Entry(t, t0)
        return key
    }

    fun get(key: String): StreamTarget? {
        val e = map[key] ?: return null
        if (now() - e.at > ttlMs) {
            map.remove(key)
            return null
        }
        return e.target
    }
}

private val TYPES = mapOf(
    "mp4" to "video/mp4", "m4v" to "video/mp4", "webm" to "video/webm", "mkv" to "video/x-matroska",
    "mov" to "video/quicktime", "ts" to "video/mp2t", "mp3" to "audio/mpeg", "m4a" to "audio/mp4",
    "aac" to "audio/aac", "ogg" to "audio/ogg", "opus" to "audio/ogg", "flac" to "audio/flac", "wav" to "audio/wav",
)

/** The type a <video> will take for a file of this name (some hosts call video octet-stream). */
fun mediaTypeFor(name: String): String = TYPES[name.substringBefore('?').substringAfterLast('.', "").lowercase()] ?: "video/mp4"

/** Every URI in a playlist, absolute, through `via` (server/media.mjs rewritePlaylist). */
fun rewritePlaylist(text: String, base: String, via: (String) -> String): String {
    val baseUrl = URL(base)
    fun abs(u: String) = URL(baseUrl, u).toString()
    return text.split(Regex("\r?\n")).joinToString("\n") { line ->
        when {
            line.isEmpty() -> line
            line.startsWith("#") -> Regex("URI=\"([^\"]+)\"").replace(line) { m -> "URI=\"${via(abs(m.groupValues[1]))}\"" }
            else -> via(abs(line.trim()))
        }
    }
}

/** The MEGA cipher, positioned at the 16-byte block `block`. */
fun megaCipher(key: ByteArray, block: Long): Cipher {
    require(key.size == 32) { "A MEGA file key is 32 bytes" }
    val aes = ByteArray(16) { (key[it].toInt() xor key[it + 16].toInt()).toByte() }
    val iv = ByteArray(16)
    System.arraycopy(key, 16, iv, 0, 8)
    for (i in 0 until 8) iv[15 - i] = (block ushr (8 * i)).toByte()
    return Cipher.getInstance("AES/CTR/NoPadding").apply { init(Cipher.DECRYPT_MODE, SecretKeySpec(aes, "AES"), IvParameterSpec(iv)) }
}

private fun skipFully(input: InputStream, n: Long) {
    var left = n
    val buf = ByteArray(16)
    while (left > 0) {
        val r = input.read(buf, 0, minOf(16L, left).toInt())
        if (r < 0) throw IOException("Stream ended early")
        left -= r
    }
}

/** "m/<key>" and "m/<key>/seg?u=…": a registered stream (see StreamTarget). */
class StreamRoute(private val fetcher: Fetcher, private val registry: StreamRegistry) : Route {
    override fun serve(ex: Exchange): Boolean {
        if (ex.req.method != "GET" && ex.req.method != "HEAD") return failed(ex, 405, "GET only")
        val key = ex.sub.substringBefore('/')
        val seg = ex.sub.substringAfter('/', "") == "seg"
        val t = registry.get(key) ?: return failed(ex, 410, "This stream has expired; open the link again")
        return try {
            when (t) {
                is StreamTarget.Mega -> mega(ex, t)
                is StreamTarget.Http -> if (t.hls) hls(ex, t, key, if (seg) ex.req.query("u") else null) else http(ex, t, t.url)
            }
        }
        catch (e: IOException) {
            throw e
        }
        catch (e: Exception) {
            failed(ex, 502, why(e))
        }
    }

    private fun withRange(ex: Exchange, headers: Map<String, String>): Map<String, String> {
        val range = ex.req.headers["range"] ?: return headers
        return headers.filterKeys { !it.equals("range", ignoreCase = true) } + ("Range" to range)
    }

    private fun http(ex: Exchange, t: StreamTarget.Http, url: String): Boolean {
        val up = try {
            fetcher.open(url, "GET", withRange(ex, t.headers))
        }
        catch (e: Exception) {
            return failed(ex, 502, why(e))
        }
        return up.use {
            val given = it.header("content-type")
            val type = if (given == null || Regex("octet-stream|text/plain").containsMatchIn(given)) mediaTypeFor(t.name.ifEmpty { URL(url).path }) else null
            relay(ex, it, type)
        }
    }

    private fun hls(ex: Exchange, t: StreamTarget.Http, key: String, sub: String?): Boolean {
        val url = sub ?: t.url
        val path = URL(url).path
        val up = try {
            fetcher.open(url, "GET", t.headers)
        }
        catch (e: Exception) {
            return failed(ex, 502, why(e))
        }
        up.use {
            val type = it.header("content-type") ?: ""
            if (!Regex("mpegurl", RegexOption.IGNORE_CASE).containsMatchIn(type) && !path.endsWith(".m3u8")) {
                // A segment, key or init section: as it is.
                return relay(ex, it)
            }
            val text = it.body.readBytes().toString(Charsets.UTF_8)
            val prefix = ex.req.path.substringBefore("/m/") + "/m/$key/seg?u="
            val body = rewritePlaylist(text, url) { u -> prefix + enc(u) }.toByteArray(Charsets.UTF_8)
            ex.head(it.status, listOf("Content-Type" to "application/vnd.apple.mpegurl", "Content-Length" to body.size.toString(), "Cache-Control" to "no-store"))
            if (ex.req.method == "GET") ex.out.write(body)
            ex.out.flush()
            return true
        }
    }

    /** The file's download address: as registered, or from MEGA's API (once, or again with fresh). */
    private fun megaUrl(t: StreamTarget.Mega, fresh: Boolean): String {
        if (!fresh) t.url?.let { return it }
        val request = t.request ?: throw IOException("No way to ask MEGA for this file")
        val q = "id=" + (System.nanoTime() % 1_000_000_000) + (t.folder?.let { "&n=" + enc(it) } ?: "")
        val body = "[$request]".toByteArray(Charsets.UTF_8)
        val answer = fetcher.open("https://g.api.mega.co.nz/cs?$q", "POST", mapOf("Content-Type" to "application/json"), body).use {
            it.body.readBytes().toString(Charsets.UTF_8).trim()
        }
        val first = if (answer.startsWith("[")) JSONArray(answer).opt(0) else answer.toIntOrNull()
        val url = (first as? JSONObject)?.optString("g")?.takeIf { it.startsWith("http") }
            ?: throw IOException("MEGA refused the file (error $first)")
        t.url = url
        return url
    }

    private fun mega(ex: Exchange, t: StreamTarget.Mega): Boolean {
        val size = t.size
        val type = mediaTypeFor(t.name)
        val (start, end, partial) = when (val r = parseRange(ex.req.headers["range"], size)) {
            is RangeAnswer.Unsatisfiable -> {
                ex.head(416, listOf("Content-Range" to "bytes */$size", "Content-Length" to "0"))
                ex.out.flush()
                return true
            }
            is RangeAnswer.Part -> Triple(r.range.start, r.range.end, true)
            is RangeAnswer.Whole -> Triple(0L, size - 1, false)
        }
        val length = end - start + 1
        val head = listOf("Content-Type" to type, "Accept-Ranges" to "bytes", "Content-Length" to length.toString()) +
            if (partial) listOf("Content-Range" to "bytes $start-$end/$size") else emptyList()
        if (ex.req.method == "HEAD" || size == 0L) {
            ex.head(if (partial) 206 else 200, head)
            ex.out.flush()
            return true
        }
        val aligned = start - start % 16
        var up: Upstream? = null
        try {
            for (attempt in 0..1) {
                val base = megaUrl(t, fresh = attempt > 0)
                val u = fetcher.open("$base/$aligned-$end")
                // An old address stops working after a while: ask for a new one, once.
                if (u.status in 200..299 || attempt == 1 || t.request == null) {
                    up = u
                    break
                }
                u.close()
            }
        }
        catch (e: Exception) {
            return failed(ex, 502, why(e))
        }
        up!!.use {
            if (it.status !in 200..299) return failed(ex, 502, "MEGA answered ${it.status}")
            ex.head(if (partial) 206 else 200, head)
            val plain = CipherInputStream(it.body, megaCipher(t.key, aligned / 16))
            skipFully(plain, start - aligned)
            ex.copy(plain, length)
        }
        return true
    }
}
