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
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

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
 *
 * Every connection is cleaned up whatever happens to it: a <video> drops one
 * on every seek, and nothing that goes wrong in one may reach the thread's
 * uncaught-exception handler (on Android that ends the app). A connection
 * whose reader stopped reading without closing (a paused or forgotten
 * <video>) is closed after STALL_MS, so its thread and file descriptor do not
 * pile up; a socket has a read timeout but no write timeout.
 *
 * Besides files ("f"), other parts of the app serve their own paths through
 * `routes` (the net proxy, registered streams, writes into picked folders):
 * "<token>/<name>/…" goes to the route of that name. Those may have a body
 * (Content-Length only; the WebView never sends a chunked one).
 */
class MediaServer(
    private val source: MediaSource,
    private val stallMs: Long = STALL_MS,
    private val log: (String) -> Unit = {},
    private val routes: Map<String, Route> = emptyMap(),
) : Closeable {
    val token: String = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private val server = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
    private val pool: ExecutorService = Executors.newCachedThreadPool { r ->
        Thread(r, "ph-media").apply { isDaemon = true }
    }

    @Volatile
    private var closed = false

    /** A connection being served, and when its last write got through (0: not writing). */
    private class Conn(val socket: Socket) {
        @Volatile
        var writingSince = 0L
    }

    private val conns = ConcurrentHashMap.newKeySet<Conn>()

    /** Connections open right now (tests, and the page's checks). */
    val openConnections: Int get() = conns.size

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
                try {
                    pool.execute { serve(s) }
                }
                catch (_: RejectedExecutionException) {
                    // Closing down while a connection came in.
                    quietly { s.close() }
                }
            }
        }, "ph-media-accept").apply { isDaemon = true }.start()
        Thread({
            while (!closed) {
                try {
                    Thread.sleep(minOf(10_000L, maxOf(50L, stallMs / 4)))
                }
                catch (_: InterruptedException) {
                    break
                }
                reapStalled()
            }
        }, "ph-media-reaper").apply { isDaemon = true }.start()
    }

    /** Close connections whose writes have not moved for stallMs. */
    private fun reapStalled() {
        val now = System.nanoTime()
        for (c in conns) {
            val since = c.writingSince
            if (since != 0L && (now - since) / 1_000_000 > stallMs) {
                log("closing a stalled connection")
                quietly { c.socket.close() }
            }
        }
    }

    private inline fun quietly(f: () -> Unit) {
        try {
            f()
        }
        catch (_: Exception) {
        }
    }

    override fun close() {
        closed = true
        try {
            server.close()
        }
        catch (_: IOException) {
        }
        pool.shutdownNow()
        for (c in conns) quietly { c.socket.close() }
    }

    private fun serve(socket: Socket) {
        val conn = Conn(socket)
        conns.add(conn)
        socket.use { s ->
            try {
                s.soTimeout = 30_000
                s.tcpNoDelay = true
                val input = BufferedInputStream(s.getInputStream())
                val out = BufferedOutputStream(s.getOutputStream(), 64 * 1024)
                while (!closed) {
                    val req = readRequest(input) ?: break
                    if (req.headers.containsKey("transfer-encoding")) {
                        // No chunked bodies: the next request would be lost in it.
                        plain(out, 411, "Length Required")
                        break
                    }
                    val length = req.headers["content-length"]?.toLongOrNull()?.coerceAtLeast(0) ?: 0L
                    val body = LimitedInput(input, length)
                    val keep = answer(req, body, out, conn)
                    // Whatever of the body was not read, so the next request
                    // starts where it should.
                    if (keep && req.keepAlive) body.drain() else break
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
            catch (e: Throwable) {
                // Anything else (a provider's SecurityException, a bad escape
                // in a URL, even running out of memory) ends this connection,
                // never the app.
                log("serve: ${e.javaClass.simpleName}: ${e.message}")
            }
            finally {
                conns.remove(conn)
            }
        }
    }

    /** The route after the token ("f" for a file, "ping" for a health check), or null for a wrong token. */
    private fun routeOf(path: String): String? {
        val parts = path.trimStart('/').split('/', limit = 2)
        if (parts.size != 2 || !MessageDigest.isEqual(parts[0].toByteArray(), token.toByteArray())) return null
        return parts[1]
    }

    /** Answer one request; false when the connection must close after it. */
    private fun answer(req: HttpRequest, body: InputStream, out: OutputStream, conn: Conn): Boolean {
        if (req.method == "OPTIONS") {
            // A preflight: whatever headers the page means to send (the net
            // proxy's carry its own), and the methods the routes take.
            val asked = req.headers["access-control-request-headers"]?.takeIf { it.isNotBlank() } ?: "Range"
            head(out, 204, "No Content", listOf("Content-Length" to "0", "Access-Control-Allow-Headers" to asked))
            out.flush()
            return true
        }
        val route = routeOf(req.path)
        val handler = route?.let { routes[it.substringBefore('/')] }
        if (route != null && handler != null) {
            return handler.serve(Exchange(req, route.substringAfter('/', ""), body, out) { conn.writingSince = it })
        }
        if (req.method != "GET" && req.method != "HEAD") {
            plain(out, 405, "Method Not Allowed")
            return true
        }
        if (route == "ping") {
            plain(out, 200, "OK")
            return true
        }
        val id = if (route == "f") req.query("u")?.takeIf { it.isNotEmpty() } else null
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
                    if (req.method == "GET") f.streamFrom(r.range.start).use { copy(it, out, r.range.length, conn) }
                    out.flush()
                    return true
                }
                is RangeAnswer.Whole -> {
                    // Size unknown: no length to promise, so the end of the
                    // body is the end of the connection.
                    val known = size >= 0
                    head(out, 200, "OK", common + if (known) listOf("Content-Length" to size.toString()) else listOf("Connection" to "close"))
                    if (req.method == "GET") f.streamFrom(0).use { copy(it, out, if (known) size else Long.MAX_VALUE, conn) }
                    out.flush()
                    return known
                }
            }
        }
    }

    private fun head(out: OutputStream, status: Int, reason: String, headers: List<Pair<String, String>>) =
        writeHead(out, status, reason, headers)

    private fun plain(out: OutputStream, status: Int, reason: String) = writePlain(out, status, reason)

    private fun copy(input: InputStream, out: OutputStream, length: Long, conn: Conn) =
        copyCounted(input, out, length) { conn.writingSince = it }

    companion object {
        /** A connection that has taken no data for this long is given up. */
        const val STALL_MS = 90_000L
    }
}

/** On every answer; a route's own headers of the same name win. */
internal val CORS = listOf(
    "Access-Control-Allow-Origin" to "*",
    "Access-Control-Allow-Methods" to "GET, HEAD, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers" to "Range",
    "Access-Control-Expose-Headers" to "Content-Range, Content-Length, Accept-Ranges",
    "Access-Control-Max-Age" to "86400",
)

internal fun writeHead(out: OutputStream, status: Int, reason: String, headers: List<Pair<String, String>>) {
    val sb = StringBuilder("HTTP/1.1 $status $reason\r\n")
    val own = headers.map { it.first.lowercase() }.toSet()
    for ((k, v) in headers + CORS.filter { it.first.lowercase() !in own }) {
        // A header value is one line of Latin-1: anything else is dropped from it.
        val clean = v.filter { it != '\r' && it != '\n' && it.code < 256 }
        sb.append(k).append(": ").append(clean).append("\r\n")
    }
    sb.append("\r\n")
    out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
}

internal fun writePlain(out: OutputStream, status: Int, text: String, type: String = "text/plain; charset=utf-8") {
    val body = text.toByteArray(Charsets.UTF_8)
    writeHead(out, status, reasonOf(status), listOf("Content-Type" to type, "Content-Length" to body.size.toString()))
    out.write(body)
    out.flush()
}

/**
 * Copy `length` bytes (Long.MAX_VALUE: to the end), telling `writing` when
 * each write starts (System.nanoTime) and 0 when done, for the stall reaper.
 */
internal fun copyCounted(input: InputStream, out: OutputStream, length: Long, writing: (Long) -> Unit) {
    val buf = ByteArray(64 * 1024)
    var left = length
    try {
        while (left > 0) {
            val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (n < 0) {
                if (length != Long.MAX_VALUE) throw IOException("File ended early")
                break
            }
            // A write blocks while the reader is not reading: the reaper
            // watches how long since the last one got through.
            writing(System.nanoTime())
            out.write(buf, 0, n)
            left -= n
        }
        out.flush()
    }
    finally {
        writing(0L)
    }
}

fun reasonOf(status: Int): String = when (status) {
    200 -> "OK"
    201 -> "Created"
    204 -> "No Content"
    206 -> "Partial Content"
    301 -> "Moved Permanently"
    302 -> "Found"
    304 -> "Not Modified"
    400 -> "Bad Request"
    403 -> "Forbidden"
    404 -> "Not Found"
    405 -> "Method Not Allowed"
    410 -> "Gone"
    411 -> "Length Required"
    413 -> "Content Too Large"
    416 -> "Range Not Satisfiable"
    500 -> "Internal Server Error"
    502 -> "Bad Gateway"
    504 -> "Gateway Timeout"
    else -> "Status"
}

/** A path of its own on the server: "<token>/<name>/…" (see MediaServer's routes). */
fun interface Route {
    /** Answer one request; false when the connection must close after it. */
    fun serve(ex: Exchange): Boolean
}

/**
 * One request to a route: what came in (`sub` is the path after the route's
 * name, `body` exactly the request's body), and how to answer.
 */
class Exchange(
    val req: HttpRequest,
    val sub: String,
    val body: InputStream,
    val out: OutputStream,
    private val writing: (Long) -> Unit = {},
) {
    fun head(status: Int, headers: List<Pair<String, String>>) = writeHead(out, status, reasonOf(status), headers)

    fun plain(status: Int, text: String) = writePlain(out, status, text)

    fun json(status: Int, text: String) = writePlain(out, status, text, "application/json")

    /** Send `length` bytes of `input` (Long.MAX_VALUE: all of it), watched for stalls. */
    fun copy(input: InputStream, length: Long) = copyCounted(input, out, length, writing)

    /** The whole body, refused past `max` bytes. */
    fun readBody(max: Int): ByteArray {
        val buf = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(64 * 1024)
        while (true) {
            val n = body.read(chunk)
            if (n < 0) break
            if (buf.size() + n > max) throw IOException("Body too large")
            buf.write(chunk, 0, n)
        }
        return buf.toByteArray()
    }
}

/** Exactly `length` bytes of `input`, then the end; drain() skips what is left. */
class LimitedInput(private val input: InputStream, length: Long) : InputStream() {
    private var left = length

    override fun read(): Int {
        if (left <= 0) return -1
        val c = input.read()
        if (c >= 0) left-- else left = 0
        return c
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (left <= 0) return -1
        val n = input.read(b, off, minOf(len.toLong(), left).toInt())
        if (n < 0) {
            left = 0
            throw IOException("Body cut short")
        }
        left -= n
        return n
    }

    override fun available(): Int = minOf(input.available().toLong(), left).toInt()

    fun drain() {
        val buf = ByteArray(16 * 1024)
        while (left > 0 && read(buf, 0, buf.size) >= 0) Unit
    }

    // The connection's stream outlives the request.
    override fun close() {}
}
