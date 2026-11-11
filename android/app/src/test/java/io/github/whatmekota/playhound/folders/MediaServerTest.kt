package io.github.whatmekota.playhound.folders

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.Socket
import java.net.URL

class MediaServerTest {
    @Test
    fun rangeForms() {
        assertEquals(RangeAnswer.Whole, parseRange(null, 100))
        assertEquals(RangeAnswer.Part(ByteRange(0, 99)), parseRange("bytes=0-", 100))
        assertEquals(RangeAnswer.Part(ByteRange(10, 19)), parseRange("bytes=10-19", 100))
        assertEquals(RangeAnswer.Part(ByteRange(90, 99)), parseRange("bytes=90-500", 100))
        assertEquals(RangeAnswer.Part(ByteRange(80, 99)), parseRange("bytes=-20", 100))
        assertEquals(RangeAnswer.Part(ByteRange(0, 99)), parseRange("bytes=-500", 100))
        assertEquals(RangeAnswer.Unsatisfiable, parseRange("bytes=100-", 100))
        assertEquals(RangeAnswer.Unsatisfiable, parseRange("bytes=-0", 100))
        // Ignored, as the spec allows: several ranges, nonsense, another unit.
        assertEquals(RangeAnswer.Whole, parseRange("bytes=0-1,5-6", 100))
        assertEquals(RangeAnswer.Whole, parseRange("bytes=x-", 100))
        assertEquals(RangeAnswer.Whole, parseRange("bytes=20-10", 100))
        assertEquals(RangeAnswer.Whole, parseRange("items=0-1", 100))
        // Unknown size: no ranges.
        assertEquals(RangeAnswer.Whole, parseRange("bytes=0-", -1))
    }

    @Test
    fun rangesPastFourGigabytes() {
        val size = 6L * 1024 * 1024 * 1024
        assertEquals(RangeAnswer.Part(ByteRange(5_000_000_000, size - 1)), parseRange("bytes=5000000000-", size))
    }

    private val data = ByteArray(300_000) { (it * 31 % 251).toByte() }

    /** A file of `size` bytes that pretends to be big: the pattern repeats. */
    private class BigFile(override val size: Long) : MediaFile {
        override val mime = "video/mp4"
        override fun streamFrom(offset: Long): InputStream = object : InputStream() {
            var pos = offset
            override fun read(): Int = if (pos >= size) -1 else ((pos++ % 251).toInt())
        }
        override fun close() {}
    }

    private val server = MediaServer({ id ->
        when (id) {
            "content://x/small.mp4" -> object : MediaFile {
                override val size = data.size.toLong()
                override val mime = "video/mp4"
                override fun streamFrom(offset: Long): InputStream = ByteArrayInputStream(data, offset.toInt(), data.size - offset.toInt())
                override fun close() {}
            }
            "content://x/big.mkv" -> BigFile(5L * 1024 * 1024 * 1024)
            else -> null
        }
    })

    @After
    fun stop() = server.close()

    private fun get(url: String, range: String? = null): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            if (range != null) setRequestProperty("Range", range)
            setRequestProperty("Origin", "http://localhost")
        }

    @Test
    fun servesWholeAndRanges() {
        val url = server.urlFor("content://x/small.mp4")
        get(url).run {
            assertEquals(200, responseCode)
            assertEquals("bytes", getHeaderField("Accept-Ranges"))
            assertEquals("*", getHeaderField("Access-Control-Allow-Origin"))
            assertEquals(data.size.toLong(), contentLengthLong)
            assertArrayEquals(data, inputStream.readBytes())
        }
        get(url, "bytes=1000-1999").run {
            assertEquals(206, responseCode)
            assertEquals("bytes 1000-1999/${data.size}", getHeaderField("Content-Range"))
            assertArrayEquals(data.copyOfRange(1000, 2000), inputStream.readBytes())
        }
        get(url, "bytes=${data.size}-").run {
            assertEquals(416, responseCode)
            assertEquals("bytes */${data.size}", getHeaderField("Content-Range"))
        }
    }

    @Test
    fun seeksFarIntoABigFile() {
        val start = 4_500_000_000L
        get(server.urlFor("content://x/big.mkv"), "bytes=$start-${start + 9}").run {
            assertEquals(206, responseCode)
            assertEquals("bytes $start-${start + 9}/${5L * 1024 * 1024 * 1024}", getHeaderField("Content-Range"))
            val expected = ByteArray(10) { ((start + it) % 251).toByte() }
            assertArrayEquals(expected, inputStream.readBytes())
        }
    }

    @Test
    fun keepsTheConnectionForTheNextRequest() {
        Socket("127.0.0.1", server.port).use { s ->
            val path = server.urlFor("content://x/small.mp4").substringAfter(":${server.port}")
            val out = s.getOutputStream()
            val input = s.getInputStream().buffered()
            repeat(2) { i ->
                out.write("GET $path HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=$i-${i + 3}\r\n\r\n".toByteArray())
                out.flush()
                val head = generateSequence { readLine(input) }.takeWhile { it.isNotEmpty() }.toList()
                assertEquals("HTTP/1.1 206 Partial Content", head[0])
                val body = ByteArray(4)
                var got = 0
                while (got < 4) got += input.read(body, got, 4 - got)
                assertArrayEquals(data.copyOfRange(i, i + 4), body)
            }
        }
    }

    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val c = input.read()
            if (c < 0) return if (sb.isEmpty()) null else sb.toString()
            if (c == '\n'.code) return sb.toString().trimEnd('\r')
            sb.append(c.toChar())
        }
    }

    @Test
    fun refusesWithoutTheToken() {
        val wrong = "http://127.0.0.1:${server.port}/nottoken/f?u=content%3A%2F%2Fx%2Fsmall.mp4"
        assertEquals(404, get(wrong).responseCode)
        assertEquals(404, get(server.urlFor("content://x/missing.mp4")).responseCode)
    }

    @Test
    fun answersCorsPreflight() {
        get(server.urlFor("content://x/small.mp4")).run {
            requestMethod = "OPTIONS"
            assertEquals(204, responseCode)
            assertEquals("Range", getHeaderField("Access-Control-Allow-Headers"))
        }
    }

    @Test
    fun queryDecoding() {
        val req = HttpRequest("GET", "/t/f?u=content%3A%2F%2Fa%2Fb%20c&x=1", "HTTP/1.1", emptyMap())
        assertEquals("content://a/b c", req.query("u"))
        assertNull(req.query("missing"))
    }
}
