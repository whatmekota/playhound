package io.github.whatmekota.playhound.folders

import android.content.ContentResolver
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream

/**
 * Files in picked folders, by their content:// document URI, for the media
 * server. Reading goes through the app's persisted grant on the folder, so
 * a URI from anywhere else simply fails to open.
 */
class ContentSource(private val resolver: ContentResolver) : MediaSource {
    override fun open(id: String): MediaFile? {
        val uri = Uri.parse(id)
        if (uri.scheme != ContentResolver.SCHEME_CONTENT) return null
        val pfd = resolver.openFileDescriptor(uri, "r") ?: return null
        val size = pfd.statSize.takeIf { it >= 0 } ?: querySize(uri)
        val mime = mimeOf(uri)
        return ContentFile(pfd, size, mime)
    }

    private fun querySize(uri: Uri): Long = try {
        resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else -1L
        } ?: -1L
    }
    catch (_: Exception) {
        -1L
    }

    private fun mimeOf(uri: Uri): String {
        val given = try {
            resolver.getType(uri)
        }
        catch (_: Exception) {
            null
        }
        if (given != null && given != "application/octet-stream") return given
        // Providers often have no type for .mkv or .funscript; go by the name.
        val name = uri.lastPathSegment ?: ""
        val ext = name.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "mkv" -> "video/x-matroska"
            "funscript", "json" -> "application/json"
            "srt" -> "text/plain"
            "vtt" -> "text/vtt"
            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
        }
    }
}

private class ContentFile(
    private val pfd: ParcelFileDescriptor,
    override val size: Long,
    override val mime: String,
) : MediaFile {
    override fun streamFrom(offset: Long): InputStream {
        val input = FileInputStream(pfd.fileDescriptor)
        if (offset <= 0) return input
        try {
            // A real file (or a provider's proxy descriptor) seeks at once.
            input.channel.position(offset)
            return input
        }
        catch (_: IOException) {
            // A pipe cannot seek: read our way there. Slow for a far seek, but
            // only providers that stream through a pipe end up here.
        }
        var left = offset
        val buf = ByteArray(256 * 1024)
        while (left > 0) {
            val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (n < 0) throw IOException("Seek past the end")
            left -= n
        }
        return input
    }

    // The stream shares this descriptor and does not own it.
    override fun close() = pfd.close()
}
