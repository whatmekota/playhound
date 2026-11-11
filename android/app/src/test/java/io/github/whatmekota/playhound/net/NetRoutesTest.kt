package io.github.whatmekota.playhound.net

import io.github.whatmekota.playhound.folders.MediaServer
import io.github.whatmekota.playhound.folders.Route
import io.github.whatmekota.playhound.folders.WriteSessions
import org.json.JSONArray
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

class NetRoutesTest {
    private val seen = ConcurrentHashMap<String, Map<String, String>>()
    private val video = ByteArray(200_000) { (it * 7 % 253).toByte() }
    private val megaKey = ByteArray(32) { (it * 13 + 5).toByte() }
    private val megaPlain = ByteArray(100_000) { (it % 241).toByte() }
    private val megaCipherText: ByteArray = run {
        val aes = ByteArray(16) { (megaKey[it].toInt() xor megaKey[it + 16].toInt()).toByte() }
        val iv = ByteArray(16).also { System.arraycopy(megaKey, 16, it, 0, 8) }
        Cipher.getInstance("AES/CTR/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(aes, "AES"), IvParameterSpec(iv)) }.doFinal(megaPlain)
    }

    /** A stand-in for the internet: another loopback server, with one route that plays each part. */
    private val upstream: MediaServer = MediaServer({ null }, routes = mapOf("u" to Route { x ->
        seen[x.sub] = x.req.headers
        val body = x.readBody(1 shl 20)
        when {
            x.sub == "echo" -> {
                val out = "${x.req.method} ${String(body)}".toByteArray()
                x.head(200, listOf("Set-Cookie" to "a=1; Path=/", "Set-Cookie" to "b=2; Path=/", "Content-Type" to "text/plain", "Content-Length" to out.size.toString()))
                x.out.write(out)
            }
            x.sub == "away" -> {
                // To another host name for the same server: credentials stay behind.
                x.head(302, listOf("Location" to "http://localhost:${portOf()}/${tokenOf()}/u/landed", "Content-Length" to "0"))
            }
            x.sub == "landed" -> {
                x.head(200, listOf("Content-Length" to "2"))
                x.out.write("ok".toByteArray())
            }
            x.sub == "video.bin" -> {
                val range = x.req.headers["range"]
                if (range != null) {
                    val (a, b) = range.removePrefix("bytes=").split('-').map { it.toInt() }
                    x.head(206, listOf("Content-Type" to "application/octet-stream", "Content-Range" to "bytes $a-$b/${video.size}", "Content-Length" to (b - a + 1).toString()))
                    x.out.write(video, a, b - a + 1)
                }
                else {
                    x.head(200, listOf("Content-Type" to "application/octet-stream", "Content-Length" to video.size.toString()))
                    x.out.write(video)
                }
            }
            x.sub.startsWith("mega/") -> {
                val (a, b) = x.sub.substringAfterLast('/').split('-').map { it.toInt() }
                x.head(200, listOf("Content-Length" to (b - a + 1).toString()))
                x.out.write(megaCipherText, a, b - a + 1)
            }
            else -> x.head(404, listOf("Content-Length" to "0"))
        }
        x.out.flush()
        true
    }))
    private fun portOf(): Int = upstream.port
    private fun tokenOf(): String = upstream.token
    private val up = upstream.base + "u"

    private val jar = object : CookieJar {
        val kept = ConcurrentHashMap<String, String>()
        override fun cookieFor(url: String) = kept.values.joinToString("; ").ifEmpty { null }
        override fun store(url: String, setCookies: List<String>) {
            for (c in setCookies) c.substringBefore(';').let { kept[it.substringBefore('=')] = it }
        }
    }
    private val fetcher = Fetcher(jar)
    private val registry = StreamRegistry()
    private val written = ByteArrayOutputStream()
    private val writes = WriteSessions({ written })
    private val server = MediaServer({ null }, routes = mapOf("p" to ProxyRoute(fetcher), "m" to StreamRoute(fetcher, registry), "w" to writes.route))

    @After
    fun stop() {
        server.close()
        upstream.close()
    }

    private fun proxied(url: String) = server.base + "p?u=" + URLEncoder.encode(url, "UTF-8")

    private fun open(url: String, block: HttpURLConnection.() -> Unit = {}) =
        (URL(url).openConnection() as HttpURLConnection).apply(block)

    @Test
    fun forwardsTheNamedHeadersAndBody() {
        val headers = URLEncoder.encode("""{"Referer":"https://example.com/","Cookie":"s=1","X-Custom":"yes"}""", "UTF-8")
        open(proxied("$up/echo")) {
            requestMethod = "POST"
            setRequestProperty("X-Ph-Headers", headers)
            doOutput = true
            outputStream.use { it.write("hello".toByteArray()) }
        }.run {
            assertEquals(200, responseCode)
            assertEquals("POST hello", inputStream.readBytes().toString(Charsets.UTF_8))
            assertEquals("*", getHeaderField("Access-Control-Allow-Origin"))
            val cookies = JSONArray(URLDecoder.decode(getHeaderField("X-Ph-Set-Cookie"), "UTF-8"))
            assertEquals(2, cookies.length())
            assertNull(getHeaderField("Set-Cookie"))
        }
        val got = seen["echo"]!!
        assertEquals("https://example.com/", got["referer"])
        assertEquals("s=1", got["cookie"])
        assertEquals("yes", got["x-custom"])
        assertEquals(DEFAULT_UA, got["user-agent"])
        // The connection is still good for another request (the body was read to its end).
        assertEquals(200, open(server.base + "ping").responseCode)
    }

    @Test
    fun keepsAndSendsCookiesOnlyWhenAskedTo() {
        open(proxied("$up/echo")) { setRequestProperty("X-Ph-Jar", "1") }.run {
            assertEquals(200, responseCode)
            inputStream.readBytes()
        }
        assertEquals("1", jar.kept["a"]?.substringAfter('='))
        open(proxied("$up/echo")) { setRequestProperty("X-Ph-Jar", "1") }.inputStream.readBytes()
        assertTrue(seen["echo"]!!["cookie"]!!.contains("a=1"))
        open(proxied("$up/echo")).inputStream.readBytes()
        assertNull(seen["echo"]!!["cookie"])
    }

    @Test
    fun followsRedirectsAndDropsCredentialsOnTheWay() {
        val headers = URLEncoder.encode("""{"Cookie":"secret=1","Range":"bytes=0-1"}""", "UTF-8")
        open(proxied("$up/away")) { setRequestProperty("X-Ph-Headers", headers) }.run {
            assertEquals(200, responseCode)
            assertEquals("ok", inputStream.readBytes().toString(Charsets.UTF_8))
            assertTrue(URLDecoder.decode(getHeaderField("X-Ph-Url"), "UTF-8").endsWith("/landed"))
        }
        assertNull(seen["landed"]!!["cookie"])
        assertEquals("bytes=0-1", seen["landed"]!!["range"])
    }

    @Test
    fun saysWhenTheServerCannotBeReached() {
        open(proxied("http://127.0.0.1:1/nothing")).run {
            assertEquals(502, responseCode)
            assertEquals("1", getHeaderField("X-Ph-Error"))
        }
    }

    @Test
    fun streamsARegisteredFileWithRangesAndAPlayableType() {
        val key = registry.register(StreamTarget.Http("$up/video.bin", mapOf("Referer" to "https://host/"), "clip.mp4"))
        open(server.base + "m/$key") { setRequestProperty("Range", "bytes=100-199") }.run {
            assertEquals(206, responseCode)
            assertEquals("video/mp4", getHeaderField("Content-Type"))
            assertEquals("bytes 100-199/${video.size}", getHeaderField("Content-Range"))
            assertArrayEquals(video.copyOfRange(100, 200), inputStream.readBytes())
        }
        assertEquals("https://host/", seen["video.bin"]!!["referer"])
        assertEquals(410, open(server.base + "m/unknown").responseCode)
    }

    @Test
    fun decryptsMegaFromAnyByte() {
        val key = registry.register(StreamTarget.Mega("$up/mega/x", null, null, megaKey, megaPlain.size.toLong(), "clip.mp4"))
        open(server.base + "m/$key") { setRequestProperty("Range", "bytes=1003-5010") }.run {
            assertEquals(206, responseCode)
            assertEquals("bytes 1003-5010/${megaPlain.size}", getHeaderField("Content-Range"))
            assertArrayEquals(megaPlain.copyOfRange(1003, 5011), inputStream.readBytes())
        }
        open(server.base + "m/$key").run {
            assertEquals(200, responseCode)
            assertArrayEquals(megaPlain, inputStream.readBytes())
        }
    }

    @Test
    fun writesInPieces() {
        val id = writes.begin("content://x/file")
        for (part in listOf("abc", "def")) {
            open(server.base + "w/$id") {
                requestMethod = "PUT"
                doOutput = true
                outputStream.use { it.write(part.toByteArray()) }
            }.run {
                assertEquals(200, responseCode)
                inputStream.readBytes()
            }
        }
        assertEquals(6L, writes.finish(id))
        assertEquals("abcdef", written.toString())
        assertEquals(410, open(server.base + "w/$id") { requestMethod = "PUT"; doOutput = true; outputStream.close() }.responseCode)
    }

    @Test
    fun rewritesPlaylists() {
        val text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\nseg1.ts\nhttps://cdn.example/seg2.ts\n"
        val out = rewritePlaylist(text, "https://host.example/a/list.m3u8") { "V($it)" }
        assertEquals(
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"V(https://host.example/a/key.bin)\"\nV(https://host.example/a/seg1.ts)\nV(https://cdn.example/seg2.ts)\n",
            out,
        )
    }

    @Test
    fun readsProxyAddresses() {
        assertNull(parseProxy(""))
        assertEquals("http://127.0.0.1:8080", parseProxy("127.0.0.1:8080")!!.first)
        assertEquals("http://proxy.lan:3128", parseProxy("http://proxy.lan:3128/")!!.first)
        for (bad in listOf("socks5://h:1", "http://h", "http://u:p@h:1")) {
            try {
                parseProxy(bad)
                throw AssertionError("$bad should be refused")
            }
            catch (_: IllegalArgumentException) {
            }
        }
        assertTrue(isLocalHost("192.168.1.4"))
        assertTrue(isLocalHost("localhost"))
        assertTrue(!isLocalHost("pixeldrain.com"))
    }
}
