package io.github.whatmekota.playhound.folders

import java.io.IOException
import java.io.OutputStream
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/**
 * Writing a file in a picked folder, in pieces: the plugin opens a session
 * (begin), the page PUTs the bytes to "w/<id>" on the media server, in order,
 * one request after the other, and the plugin closes it (finish) or gives up
 * (abort). Bytes go over loopback, not the plugin bridge, which carries
 * strings: a video saved from a post is gigabytes.
 *
 * A session nobody has written to for IDLE_MS is closed, so a page that went
 * away does not keep a file open for good.
 */
class WriteSessions(
    private val open: (uri: String) -> OutputStream,
    private val idleMs: Long = IDLE_MS,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private class Session(val uri: String, val out: OutputStream) {
        var written = 0L
        var touched = 0L
        var done = false
    }

    private val sessions = ConcurrentHashMap<String, Session>()
    private val random = SecureRandom()

    /** Open `uri` for writing, from empty. Returns the session's id. */
    fun begin(uri: String): String {
        reap()
        val out = open(uri)
        val id = ByteArray(12).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
        sessions[id] = Session(uri, out).also { it.touched = now() }
        return id
    }

    fun uriOf(id: String): String? = sessions[id]?.uri

    /** Close it; returns how many bytes it wrote. */
    fun finish(id: String): Long {
        val s = sessions.remove(id) ?: throw IOException("No such write (it may have timed out)")
        synchronized(s) {
            s.done = true
            s.out.flush()
            s.out.close()
            return s.written
        }
    }

    /** Stop writing; what is written so far stays (the page removes the file if it wants). */
    fun abort(id: String) {
        val s = sessions.remove(id) ?: return
        synchronized(s) {
            s.done = true
            try {
                s.out.close()
            }
            catch (_: IOException) {
            }
        }
    }

    private fun reap() {
        val t = now()
        for ((id, s) in sessions) {
            if (t - s.touched > idleMs) abort(id)
        }
    }

    /** PUT w/<id>: append the body. Answers {"written": total so far}. */
    val route = Route { ex ->
        if (ex.req.method != "PUT" && ex.req.method != "POST") {
            ex.plain(405, "PUT only")
            return@Route true
        }
        val s = sessions[ex.sub.substringBefore('/')]
        if (s == null) {
            ex.plain(410, "No such write (it may have timed out)")
            return@Route true
        }
        val total = synchronized(s) {
            if (s.done) {
                ex.plain(410, "That write is closed")
                return@Route true
            }
            val buf = ByteArray(256 * 1024)
            try {
                while (true) {
                    val n = ex.body.read(buf)
                    if (n < 0) break
                    s.out.write(buf, 0, n)
                    s.written += n
                    s.touched = now()
                }
            }
            catch (e: IOException) {
                // The disk is full, the card went, the share dropped: say so,
                // and close (the rest of the body is not read).
                abort(ex.sub.substringBefore('/'))
                ex.plain(500, "Could not write the file: ${e.message}")
                return@Route false
            }
            s.written
        }
        ex.json(200, "{\"written\":$total}")
        true
    }

    companion object {
        const val IDLE_MS = 10 * 60 * 1000L
    }
}
