package io.github.whatmekota.playhound.folders

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import io.github.whatmekota.playhound.net.LocalServer
import java.util.concurrent.Executors

/**
 * Library folders on Android (src/lib/android/folders.ts is the page's side).
 *
 * - pick: the system folder picker (Storage Access Framework), keeping the
 *   permission across restarts.
 * - trees / forget: the folders kept, and letting one go.
 * - scan: every relevant file in one, recursively, sent back in batches as
 *   "scanBatch" events.
 * - server: the local media server's address, for streaming them.
 * - readText: a small file's text over the bridge (the server does it too).
 * - list / child / stat / create / rename / remove, and beginWrite /
 *   endWrite / abortWrite: saving into a picked folder (scripts beside the
 *   video, downloads, the Organizer's renames). The bytes of a write go to
 *   the media server ("w", see WriteSessions), not over the bridge.
 */
@CapacitorPlugin(name = "PhFolders")
class FoldersPlugin : Plugin() {
    private val work = Executors.newCachedThreadPool { r -> Thread(r, "ph-folders").apply { isDaemon = true } }

    /** The app's loopback server, shared with the net plugin (net/LocalServer.kt). */
    private fun mediaServer(): MediaServer = LocalServer.get(context)

    override fun handleOnDestroy() {
        LocalServer.close()
        work.shutdownNow()
    }

    @PluginMethod
    fun pick(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
        startActivityForResult(call, intent, "picked")
    }

    @ActivityCallback
    private fun picked(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            call.resolve(JSObject().put("cancelled", true))
            return
        }
        val resolver = context.contentResolver
        val granted = result.data!!.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        try {
            resolver.takePersistableUriPermission(uri, granted)
        }
        catch (_: SecurityException) {
            try {
                resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            catch (e: SecurityException) {
                call.reject("Android would not let playhound keep access to that folder: ${e.message}")
                return
            }
        }
        call.resolve(treeJson(uri))
    }

    private fun treeJson(uri: Uri): JSObject {
        val perm = context.contentResolver.persistedUriPermissions.firstOrNull { it.uri == uri }
        return JSObject()
            .put("uri", uri.toString())
            .put("name", TreeScanner.nameOf(context.contentResolver, uri) ?: uri.lastPathSegment?.substringAfterLast(':')?.substringAfterLast('/') ?: "Folder")
            .put("read", perm?.isReadPermission == true)
            .put("write", perm?.isWritePermission == true)
    }

    /** The folders this app still has access to. */
    @PluginMethod
    fun trees(call: PluginCall) {
        background(call) {
            val list = JSArray()
            for (p in context.contentResolver.persistedUriPermissions) {
                if (p.isReadPermission) list.put(treeJson(p.uri))
            }
            call.resolve(JSObject().put("trees", list))
        }
    }

    /**
     * Work off the bridge's thread. Whatever it throws is the call's error:
     * an exception escaping a pool thread would end the app.
     */
    private fun background(call: PluginCall, body: () -> Unit) {
        try {
            work.execute {
                try {
                    body()
                }
                catch (e: Throwable) {
                    Log.w(TAG, "${call.methodName}: $e")
                    call.reject(e.message ?: e.javaClass.simpleName)
                }
            }
        }
        catch (e: java.util.concurrent.RejectedExecutionException) {
            call.reject("The app is closing")
        }
    }

    @PluginMethod
    fun forget(call: PluginCall) {
        val uri = call.getString("uri") ?: return call.reject("No uri")
        try {
            context.contentResolver.releasePersistableUriPermission(
                Uri.parse(uri),
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        }
        catch (_: SecurityException) {
            // Not held (any more): nothing to let go.
        }
        call.resolve()
    }

    @PluginMethod
    fun scan(call: PluginCall) {
        val uri = call.getString("uri") ?: return call.reject("No uri")
        val id = call.getString("id") ?: ""
        val label = call.getString("label") ?: "Folder"
        val exts = try {
            call.getArray("extensions")?.toList<String>()?.map { it.lowercase() }?.toSet() ?: emptySet()
        }
        catch (_: Exception) {
            return call.reject("extensions must be a list of strings")
        }
        background(call) {
            val started = System.nanoTime()
            try {
                val scanner = TreeScanner(context.contentResolver, Uri.parse(uri), label, exts) { files ->
                    val arr = JSArray()
                    for (f in files) {
                        arr.put(
                            JSObject()
                                .put("uri", f.uri)
                                .put("path", f.path)
                                .put("name", f.name)
                                .put("size", f.size)
                                .put("modified", f.modified)
                                .put("mime", f.mime),
                        )
                    }
                    notifyListeners("scanBatch", JSObject().put("id", id).put("files", arr))
                }
                val count = scanner.run()
                call.resolve(
                    JSObject()
                        .put("count", count)
                        .put("failedDirs", scanner.failedDirs)
                        .put("ms", (System.nanoTime() - started) / 1_000_000),
                )
            }
            catch (e: Exception) {
                call.reject(e.message ?: "The folder could not be read", "UNREADABLE")
            }
        }
    }

    @PluginMethod
    fun server(call: PluginCall) {
        background(call) {
            try {
                call.resolve(JSObject().put("base", mediaServer().base))
            }
            catch (e: Exception) {
                call.reject("The media server did not start: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun readText(call: PluginCall) {
        val uri = call.getString("uri") ?: return call.reject("No uri")
        background(call) {
            try {
                // Scripts and subtitles: a few MB at most. Anything bigger is
                // not what this is for, and would not fit through the bridge.
                val text = context.contentResolver.openInputStream(Uri.parse(uri))?.use { input ->
                    val out = java.io.ByteArrayOutputStream()
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        if (out.size() + n > MAX_TEXT_BYTES) throw java.io.IOException("Too big to read as text")
                        out.write(buf, 0, n)
                    }
                    out.toString(Charsets.UTF_8.name())
                }
                if (text == null) call.reject("Could not open it") else call.resolve(JSObject().put("text", text))
            }
            catch (e: Exception) {
                call.reject(e.message ?: "Could not read it")
            }
        }
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    /** The document id of `doc` in `tree`, or of the tree's own folder when `doc` is empty. */
    private fun docIdOf(tree: Uri, doc: String?): String =
        if (doc.isNullOrEmpty()) DocumentsContract.getTreeDocumentId(tree) else DocumentsContract.getDocumentId(Uri.parse(doc))

    private fun entryJson(uri: Uri, name: String, mime: String, size: Long, modified: Long): JSObject = JSObject()
        .put("uri", uri.toString())
        .put("name", name)
        .put("dir", mime == Document.MIME_TYPE_DIR)
        .put("size", size)
        .put("modified", modified)
        .put("mime", mime)

    /** Every entry in a folder (files and folders, hidden ones too). */
    private fun children(tree: Uri, parentId: String): List<JSObject> {
        val out = ArrayList<JSObject>()
        val q = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
        context.contentResolver.query(q, ENTRY_COLUMNS, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val id = c.getString(0) ?: continue
                val name = c.getString(1) ?: continue
                out.add(entryJson(
                    DocumentsContract.buildDocumentUriUsingTree(tree, id),
                    name,
                    c.getString(2) ?: "",
                    if (c.isNull(3)) -1L else c.getLong(3),
                    if (c.isNull(4)) 0L else c.getLong(4),
                ))
            }
        } ?: throw java.io.IOException("That folder could not be listed")
        return out
    }

    /**
     * The entry called `name`: spelled exactly so, else in another case
     * (shared storage on Android ignores case, as Windows does, and making
     * "clip.funscript" beside "Clip.funscript" would give "clip (1).funscript").
     */
    private fun named(list: List<JSObject>, name: String): JSObject? =
        list.firstOrNull { it.getString("name") == name } ?: list.firstOrNull { it.getString("name")?.equals(name, ignoreCase = true) == true }

    private fun stat(uri: Uri): JSObject? =
        context.contentResolver.query(uri, ENTRY_COLUMNS, null, null, null)?.use { c ->
            if (!c.moveToFirst()) null
            else entryJson(uri, c.getString(1) ?: "", c.getString(2) ?: "", if (c.isNull(3)) -1L else c.getLong(3), if (c.isNull(4)) 0L else c.getLong(4))
        }

    private fun treeArg(call: PluginCall): Uri? = call.getString("tree")?.let(Uri::parse)

    @PluginMethod
    fun list(call: PluginCall) {
        val tree = treeArg(call) ?: return call.reject("No tree")
        val doc = call.getString("doc")
        background(call) {
            val arr = JSArray()
            for (e in children(tree, docIdOf(tree, doc))) arr.put(e)
            call.resolve(JSObject().put("entries", arr))
        }
    }

    /** The entry called `name` in a folder (names compared as the provider spells them), or { missing: true }. */
    @PluginMethod
    fun child(call: PluginCall) {
        val tree = treeArg(call) ?: return call.reject("No tree")
        val doc = call.getString("doc")
        val name = call.getString("name") ?: return call.reject("No name")
        background(call) {
            val found = named(children(tree, docIdOf(tree, doc)), name)
            call.resolve(found ?: JSObject().put("missing", true))
        }
    }

    @PluginMethod
    fun stat(call: PluginCall) {
        val uri = call.getString("uri") ?: return call.reject("No uri")
        background(call) {
            val e = stat(Uri.parse(uri))
            if (e == null) call.reject("Not found", "NOT_FOUND") else call.resolve(e)
        }
    }

    /**
     * Make a file (or with dir, a folder) called `name` in a folder; one that
     * is there already is answered as it is. Files are made as
     * application/octet-stream, which providers take as "keep the name as
     * given" (with a typed one they may add an extension of their own).
     */
    @PluginMethod
    fun create(call: PluginCall) {
        val tree = treeArg(call) ?: return call.reject("No tree")
        val doc = call.getString("doc")
        val name = call.getString("name")?.takeIf { it.isNotBlank() && !it.contains('/') && it != "." && it != ".." }
            ?: return call.reject("Not a file name")
        val dir = call.getBoolean("dir", false) == true
        background(call) {
            val parentId = docIdOf(tree, doc)
            val existing = named(children(tree, parentId), name)
            if (existing != null) {
                if (existing.getBoolean("dir") != dir) {
                    call.reject(if (dir) "A file of that name is in the way" else "A folder of that name is in the way", "TYPE_MISMATCH")
                }
                else {
                    call.resolve(existing)
                }
                return@background
            }
            val parent = DocumentsContract.buildDocumentUriUsingTree(tree, parentId)
            val made = DocumentsContract.createDocument(
                context.contentResolver,
                parent,
                if (dir) Document.MIME_TYPE_DIR else "application/octet-stream",
                name,
            ) ?: return@background call.reject("Android would not make $name there (is the folder read-only?)")
            call.resolve(stat(made) ?: entryJson(made, name, if (dir) Document.MIME_TYPE_DIR else "application/octet-stream", 0, System.currentTimeMillis()))
        }
    }

    @PluginMethod
    fun rename(call: PluginCall) {
        val uri = call.getString("uri") ?: return call.reject("No uri")
        val name = call.getString("name")?.takeIf { it.isNotBlank() && !it.contains('/') } ?: return call.reject("Not a file name")
        background(call) {
            val from = Uri.parse(uri)
            // The id can change with the name; null means it did not.
            val to = DocumentsContract.renameDocument(context.contentResolver, from, name) ?: from
            call.resolve(stat(to) ?: entryJson(to, name, "", -1, 0))
        }
    }

    /** Delete one file. Folders are refused: nothing in the app needs that, and it is not undoable. */
    @PluginMethod
    fun remove(call: PluginCall) {
        val uri = call.getString("uri") ?: return call.reject("No uri")
        background(call) {
            val u = Uri.parse(uri)
            val e = stat(u)
            if (e == null) return@background call.resolve()
            if (e.getBoolean("dir") == true) return@background call.reject("Folders are not deleted from the app")
            if (!DocumentsContract.deleteDocument(context.contentResolver, u)) call.reject("Android would not delete it")
            else call.resolve()
        }
    }

    /** Start writing a file from empty; the page then PUTs its bytes to `url`, in order. */
    @PluginMethod
    fun beginWrite(call: PluginCall) {
        val uri = call.getString("uri") ?: return call.reject("No uri")
        background(call) {
            val id = LocalServer.writes(context).begin(uri)
            call.resolve(JSObject().put("id", id).put("url", mediaServer().base + "w/" + id))
        }
    }

    @PluginMethod
    fun endWrite(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("No id")
        background(call) {
            val writes = LocalServer.writes(context)
            val uri = writes.uriOf(id) ?: return@background call.reject("No such write (it may have timed out)")
            val written = writes.finish(id)
            call.resolve((stat(Uri.parse(uri)) ?: JSObject().put("uri", uri)).put("written", written))
        }
    }

    @PluginMethod
    fun abortWrite(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("No id")
        background(call) {
            LocalServer.writes(context).abort(id)
            call.resolve()
        }
    }

    private companion object {
        const val TAG = "PhFolders"
        const val MAX_TEXT_BYTES = 32 * 1024 * 1024
        val ENTRY_COLUMNS = arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE,
            Document.COLUMN_LAST_MODIFIED,
        )
    }
}
