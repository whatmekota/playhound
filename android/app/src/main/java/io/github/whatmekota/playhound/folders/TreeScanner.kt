package io.github.whatmekota.playhound.folders

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** A file found in a picked folder. */
data class FoundFile(
    /** Its content:// document URI: what the media server and readText take. */
    val uri: String,
    /** From the library folder's label down: "Videos/sub/clip.mp4". */
    val path: String,
    val name: String,
    val size: Long,
    /** Milliseconds since the epoch; 0 when the provider does not say. */
    val modified: Long,
    val mime: String,
)

/**
 * Lists a picked folder (an SAF tree) recursively, fast: one provider query
 * per directory with just the columns needed (DocumentFile.listFiles queries
 * once per file, which is what makes SAF slow), several directories at a
 * time, which is what matters on a network share where every query is a
 * round trip. Results are handed over in batches as they come.
 *
 * Directories starting with "." are skipped (Android's hidden folders:
 * .thumbnails, .trashed-…), and only files with one of `extensions`.
 */
class TreeScanner(
    private val resolver: ContentResolver,
    private val tree: Uri,
    private val label: String,
    private val extensions: Set<String>,
    private val onBatch: (List<FoundFile>) -> Unit,
) {
    private val failed = AtomicInteger(0)

    /** Directories that could not be listed (the rest of the tree still is). */
    val failedDirs: Int get() = failed.get()

    private val batch = ConcurrentLinkedQueue<FoundFile>()
    private val found = AtomicInteger(0)
    private val stop = AtomicBoolean(false)

    @Volatile
    private var lastFlush = System.nanoTime()

    /**
     * Blocks until the whole tree is listed; returns how many files were
     * found. Throws when the folder itself cannot be read (the grant is
     * gone, the share is offline, the card is out).
     */
    fun run(): Int {
        val root = DocumentsContract.getTreeDocumentId(tree)
        // The top level on this thread, so a folder that is gone fails the scan.
        val top = ArrayList<Pair<String, String>>()
        listDir(root, label) { id, path -> top.add(id to path) }
        if (top.isEmpty() || stop.get()) {
            flush(force = true)
            return found.get()
        }
        val pool = Executors.newFixedThreadPool(PARALLEL)
        // Starts at 1 for this thread, so the count cannot reach 0 while the
        // top-level directories are still being handed out.
        val pending = AtomicInteger(1)
        val done = CountDownLatch(1)
        fun visit(docId: String, path: String, depth: Int) {
            pending.incrementAndGet()
            pool.execute {
                try {
                    if (!stop.get()) {
                        listDir(docId, path) { id, p ->
                            if (depth < MAX_DEPTH) visit(id, p, depth + 1)
                        }
                    }
                }
                catch (_: Exception) {
                    failed.incrementAndGet()
                }
                finally {
                    if (pending.decrementAndGet() == 0) done.countDown()
                }
            }
        }
        for ((id, path) in top) visit(id, path, 1)
        if (pending.decrementAndGet() == 0) done.countDown()
        done.await()
        pool.shutdown()
        pool.awaitTermination(5, TimeUnit.SECONDS)
        flush(force = true)
        return found.get()
    }

    private fun listDir(docId: String, path: String, onDir: (String, String) -> Unit) {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
        val cursor = resolver.query(children, COLUMNS, null, null, null)
            ?: throw IllegalStateException("No listing for $path")
        cursor.use { c ->
            while (c.moveToNext()) {
                val id = c.getString(0) ?: continue
                val name = c.getString(1) ?: continue
                val mime = c.getString(2) ?: ""
                if (mime == Document.MIME_TYPE_DIR) {
                    if (!name.startsWith(".")) onDir(id, "$path/$name")
                    continue
                }
                val ext = name.substringAfterLast('.', "").lowercase()
                if (ext !in extensions) continue
                val size = if (c.isNull(3)) -1L else c.getLong(3)
                val modified = if (c.isNull(4)) 0L else c.getLong(4)
                batch.add(FoundFile(DocumentsContract.buildDocumentUriUsingTree(tree, id).toString(), "$path/$name", name, size, modified, mime))
                if (found.incrementAndGet() > MAX_FILES) {
                    stop.set(true)
                    break
                }
            }
        }
        flush(force = false)
    }

    @Synchronized
    private fun flush(force: Boolean) {
        val due = batch.size >= BATCH || System.nanoTime() - lastFlush > FLUSH_NS
        if (!force && !due) return
        val out = ArrayList<FoundFile>(batch.size)
        while (true) out.add(batch.poll() ?: break)
        lastFlush = System.nanoTime()
        if (out.isNotEmpty()) onBatch(out)
    }

    companion object {
        private val COLUMNS = arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE,
            Document.COLUMN_LAST_MODIFIED,
        )
        /** Directories listed at once. */
        const val PARALLEL = 4
        const val BATCH = 400
        private const val FLUSH_NS = 300_000_000L
        const val MAX_DEPTH = 32
        const val MAX_FILES = 200_000

        /** A picked tree's own name, as the folder picker showed it. */
        fun nameOf(resolver: ContentResolver, tree: Uri): String? = try {
            val doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
            resolver.query(doc, arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }
        catch (_: Exception) {
            null
        }
    }
}
