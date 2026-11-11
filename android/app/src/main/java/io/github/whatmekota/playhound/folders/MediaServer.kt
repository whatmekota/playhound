package io.github.whatmekota.playhound.folders

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Something the server streams: a file in a picked folder, by its id (a
 * content:// document URI on Android).
 */
fun interface MediaSource {
    /** Null when there is no such file or it cannot be read. */
    fun open(id: String): MediaFile?
}

interface MediaFile : Closeable {
    /** In bytes; -1 when the provider cannot say. */
    val size: Long
    val mime: String

    /** The bytes from `offset` on. Closed by the caller, before the file. */
    fun streamFrom(offset: Long): InputStream
}

/** Bytes `start` to `end`, both included, as HTTP counts them. */
data class ByteRange(val start: Long, val end: Long) {
    val length: Long get() = end - start + 1
}

sealed interface RangeAnswer {
    /** No range asked for, or one we may ignore: send it all (200). */
    data object Whole : RangeAnswer

    /** Send this part (206). */
    data class Part(val range: ByteRange) : RangeAnswer

    /** It starts past the end (416). */
    data object Unsatisfiable : RangeAnswer
}

/**
 * The Range header, as a media element sends it: "bytes=a-", "bytes=a-b" or
 * "bytes=-n" (the last n). Several ranges at once, or anything malformed, may
 * be ignored by the spec (RFC 9110 §14.2), and are: the whole file is sent.
 */
fun parseRange(header: String?, size: Long): RangeAnswer {
    if (header == null || size < 0) return RangeAnswer.Whole
    val h = header.trim()
    if (!h.startsWith("bytes=", ignoreCase = true)) return RangeAnswer.Whole
    val spec = h.substring(6).trim()
    if (spec.contains(',')) return RangeAnswer.Whole
    val dash = spec.indexOf('-')
    if (dash < 0) return RangeAnswer.Whole
    val a = spec.substring(0, dash).trim()
    val b = spec.substring(dash + 1).trim()
    if (a.isEmpty()) {
        // The last n bytes.
        val n = b.toLongOrNull() ?: return RangeAnswer.Whole
        if (n <= 0 || size == 0L) return RangeAnswer.Unsatisfiable
        return RangeAnswer.Part(ByteRange(maxOf(0, size - n), size - 1))
    }
    val start = a.toLongOrNull() ?: return RangeAnswer.Whole
    if (start < 0) return RangeAnswer.Whole
    if (start >= size) return RangeAnswer.Unsatisfiable
    val end = if (b.isEmpty()) size - 1 else (b.toLongOrNull() ?: return RangeAnswer.Whole)
    if (end < start) return RangeAnswer.Whole
    return RangeAnswer.Part(ByteRange(start, minOf(end, size - 1)))
}

/** One request's first line and headers (names lower-cased). */
data class HttpRequest(val method: String, val target: String, val version: String, val headers: Map<String, String>) {
    val path: String get() = target.substringBefore('?')
    fun query(name: String): String? = target.substringAfter('?', "").split('&').firstNotNullOfOrNull { kv ->
        val k = kv.substringBefore('=')
        if (k == name) URLDecoder.decode(kv.substringAfter('=', ""), "UTF-8") else null
    }
    val keepAlive: Boolean
        get() {
            val c = headers["connection"]?.lowercase()
            return if (version == "HTTP/1.0") c == "keep-alive" else c != "close"
        }
}

private const val MAX_HEAD = 16 * 1024

/** Read a request's head; null at the end of the stream (the client closed it). */
fun readRequest(input: InputStream): HttpRequest? {
    val lines = ArrayList<String>()
    val line = StringBuilder()
    var total = 0
    while (true) {
        val c = input.read()
        if (c < 0) {
            if (total == 0) return null
            throw IOException("Request cut short")
        }
        if (++total > MAX_HEAD) throw IOException("Request head too long")
        if (c == '\n'.code) {
            val s = line.toString().trimEnd('\r')
            line.setLength(0)
            if (s.isEmpty()) {
                if (lines.isEmpty()) continue // a stray blank line between requests
                break
            }
            lines.add(s)
        }
        else {
            line.append(c.toChar())
        }
    }
    val first = lines[0].split(' ')
    if (first.size < 3) throw IOException("Bad request line")
    val headers = HashMap<String, String>()
    for (h in lines.drop(1)) {
        val i = h.indexOf(':')
        if (i > 0) headers[h.substring(0, i).trim().lowercase()] = h.substring(i + 1).trim()
    }
    return HttpRequest(first[0].uppercase(), first[1], first[2].uppercase(), headers)
}

/**
 * A tiny HTTP/1.1 server on 127.0.0.1 that streams picked files to the
 * WebView with byte ranges, so a <video> can seek in a file of any size.
 *
 * Why not the WebView's own request interception (Capacitor's
 * convertFileSrc): Android WebView answers Range requests on intercepted
 * responses itself, sizing the file with InputStream.available(), an int, so
 * anything past 2 GB plays wrong or not at all. A socket has no such limit.
 *
 * Only this app can use it: it listens on loopback, and every path starts
 * with a random token the page learns over the plugin bridge. The page is on
 * http://localhost, another origin, so answers carry CORS headers (canvas
 * thumbnails need them, with crossorigin="anonymous" on the <video>).
 */
class MediaServer(
    private val source: MediaSource,
    private val log: (String) -> Unit = {},
) : Closeable {
    val token: String = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private val server = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
    private val pool: ExecutorService = Executors.newCachedThreadPool { r ->
        Thread(r, "ph-media").apply { isDaemon = true }
    }

    @Volatile
    private var closed = false

    val port: Int get() = server.localPort

    /** Where the page asks for files: base + "f?u=" + the file's id. */
    val base: String get() = "http://127.0.0.1:$port/$token/"

    fun urlFor(id: String): String = base + "f?u=" + URLEncoder.encode(id, "UTF-8")

    init {
        Thread({
            while (!closed) {
                val s = try {
                    server.accept()
                }
                catch (e: IOException) {
                    if (!closed) log("accept: ${e.message}")
                    break
                }
                pool.execute { serve(s) }
            }
        }, "ph-media-accept").apply { isDaemon = true }.start()
    }

    override fun close() {
        closed = true
        try {
            server.close()
        }
        catch (_: IOException) {
        }
        pool.shutdownNow()
    }

    private fun serve(socket: Socket) {
        socket.use { s ->
            try {
                s.soTimeout = 30_000
                s.tcpNoDelay = true
                val input = BufferedInputStream(s.getInputStream())
                val out = BufferedOutputStream(s.getOutputStream(), 64 * 1024)
                while (!closed) {
                    val req = readRequest(input) ?: break
                    // Requests here have no body (GET, HEAD, OPTIONS), so the
                    // next one starts right after this head.
                    if (!answer(req, out) || !req.keepAlive) break
                }
            }
            catch (_: SocketTimeoutException) {
            }
            catch (_: SocketException) {
                // The <video> closed it, usually for a seek: normal.
            }
            catch (e: IOException) {
                log("serve: ${e.message}")
            }
        }
    }

    private fun tokenOk(path: String): Boolean {
        val parts = path.trimStart('/').split('/', limit = 2)
        return parts.size == 2 && MessageDigest.isEqual(parts[0].toByteArray(), token.toByteArray()) && parts[1] == "f"
    }

    /** Answer one request; false when the connection must close after it. */
    private fun answer(req: HttpRequest, out: OutputStream): Boolean {
        if (req.method == "OPTIONS") {
            head(out, 204, "No Content", listOf("Content-Length" to "0"))
            out.flush()
            return true
        }
        if (req.method != "GET" && req.method != "HEAD") {
            plain(out, 405, "Method Not Allowed")
            return true
        }
        val id = if (tokenOk(req.path)) req.query("u") else null
        if (id == null) {
            plain(out, 404, "Not Found")
            return true
        }
        val file = try {
            source.open(id)
        }
        catch (e: Exception) {
            log("open: ${e.message}")
            null
        }
        if (file == null) {
            plain(out, 404, "Not Found")
            return true
        }
        file.use { f ->
            val size = f.size
            val common = listOf("Content-Type" to f.mime, "Accept-Ranges" to "bytes", "Cache-Control" to "no-store")
            when (val r = parseRange(req.headers["range"], size)) {
                is RangeAnswer.Unsatisfiable -> {
                    head(out, 416, "Range Not Satisfiable", listOf("Content-Range" to "bytes */$size", "Content-Length" to "0"))
                    out.flush()
                    return true
                }
                is RangeAnswer.Part -> {
                    head(out, 206, "Partial Content", common + listOf(
                        "Content-Range" to "bytes ${r.range.start}-${r.range.end}/$size",
                        "Content-Length" to r.range.length.toString(),
                    ))
                    if (req.method == "GET") f.streamFrom(r.range.start).use { copy(it, out, r.range.length) }
                    out.flush()
                    return true
                }
                is RangeAnswer.Whole -> {
                    // Size unknown: no length to promise, so the end of the
                    // body is the end of the connection.
                    val known = size >= 0
                    head(out, 200, "OK", common + if (known) listOf("Content-Length" to size.toString()) else listOf("Connection" to "close"))
                    if (req.method == "GET") f.streamFrom(0).use { copy(it, out, if (known) size else Long.MAX_VALUE) }
                    out.flush()
                    return known
                }
            }
        }
    }

    private fun head(out: OutputStream, status: Int, reason: String, headers: List<Pair<String, String>>) {
        val sb = StringBuilder("HTTP/1.1 $status $reason\r\n")
        for ((k, v) in headers + CORS) sb.append(k).append(": ").append(v).append("\r\n")
        sb.append("\r\n")
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
    }

    private fun plain(out: OutputStream, status: Int, reason: String) {
        val body = reason.toByteArray()
        head(out, status, reason, listOf("Content-Type" to "text/plain", "Content-Length" to body.size.toString()))
        out.write(body)
        out.flush()
    }

    private fun copy(input: InputStream, out: OutputStream, length: Long) {
        val buf = ByteArray(64 * 1024)
        var left = length
        while (left > 0) {
            val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (n < 0) {
                if (length != Long.MAX_VALUE) throw IOException("File ended early")
                break
            }
            out.write(buf, 0, n)
            left -= n
        }
    }

    private companion object {
        val CORS = listOf(
            "Access-Control-Allow-Origin" to "*",
            "Access-Control-Allow-Methods" to "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers" to "Range",
            "Access-Control-Expose-Headers" to "Content-Range, Content-Length, Accept-Ranges",
            "Access-Control-Max-Age" to "86400",
        )
    }
}
