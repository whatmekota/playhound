package io.github.whatmekota.playhound.crash

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.os.Process
import android.webkit.RenderProcessGoneDetail
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * What went wrong last time, kept in the app's private storage (files/crash/)
 * so the page can offer it as a report on the next launch. Nothing leaves the
 * phone unless the user copies it.
 *
 * - journal.txt: the events, newest last, trimmed to the last JOURNAL_MAX bytes:
 *   a Java crash (any thread), the WebView's renderer gone (crashed, or killed
 *   for memory), what Android says ended the last run (ApplicationExitInfo,
 *   API 30+: low-memory kills, ANRs, native crashes), memory warnings.
 * - unseen: present while there is a bad end the user has not been shown.
 */
object CrashLog {
    private const val JOURNAL_MAX = 96 * 1024
    private const val TRACE_MAX = 24 * 1024
    private const val PREFS = "ph-crash"

    @Volatile
    private var dir: File? = null

    @Volatile
    private var appInfo = ""

    /** Before anything else runs: the folder, the version, the crash handler. */
    @Synchronized
    fun install(context: Context) {
        if (dir != null) return
        val d = File(context.filesDir, "crash").apply { mkdirs() }
        dir = d
        appInfo = describeApp(context)
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            try {
                record("Java crash", "Thread \"${thread.name}\"\n${stackOf(e)}\n${memoryLine(context)}", bad = true)
            }
            catch (_: Throwable) {
                // Never let the report get in the way of the crash itself.
            }
            if (previous != null) previous.uncaughtException(thread, e)
            else {
                Process.killProcess(Process.myPid())
                System.exit(10)
            }
        }
        readExitReasons(context)
    }

    /** The WebView's renderer is gone: whether it crashed or Android took it back for memory. */
    fun rendererGone(context: Context, detail: RenderProcessGoneDetail?, action: String) {
        val crashed = if (Build.VERSION.SDK_INT >= 26) detail?.didCrash() else null
        val priority = if (Build.VERSION.SDK_INT >= 26 && detail != null) priorityName(detail.rendererPriorityAtExit()) else "?"
        val why = when (crashed) {
            true -> "it crashed"
            false -> "Android killed it to free memory"
            null -> "no detail"
        }
        record("WebView renderer gone", "$why (didCrash=$crashed, rendererPriorityAtExit=$priority)\n$action\n${memoryLine(context)}", bad = true)
    }

    /** Memory warnings from the system: what was happening just before a kill. */
    fun trim(context: Context, level: Int) {
        record("Memory warning", "onTrimMemory level $level\n${memoryLine(context)}", bad = false)
    }

    fun hasUnseen(): Boolean = dir?.let { File(it, "unseen").exists() } ?: false

    fun markSeen() {
        dir?.let { File(it, "unseen").delete() }
    }

    fun journal(): String = dir?.let { d ->
        val f = File(d, "journal.txt")
        if (f.exists()) f.readText() else ""
    } ?: ""

    fun clear() {
        dir?.let { d ->
            File(d, "journal.txt").delete()
            File(d, "unseen").delete()
        }
    }

    fun describeApp(context: Context): String {
        val version = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        }
        catch (_: Exception) {
            "?"
        }
        return "playhound $version · Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) · ${Build.MANUFACTURER} ${Build.MODEL}"
    }

    fun memoryLine(context: Context): String = try {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val rt = Runtime.getRuntime()
        "Memory: device ${mb(mi.availMem)} free of ${mb(mi.totalMem)}${if (mi.lowMemory) " (low)" else ""}, " +
            "app heap ${mb(rt.totalMemory() - rt.freeMemory())} of ${mb(rt.maxMemory())}"
    }
    catch (_: Exception) {
        "Memory: ?"
    }

    @Synchronized
    fun record(kind: String, text: String, bad: Boolean) {
        val d = dir ?: return
        val entry = "── ${stamp(System.currentTimeMillis())} · $kind ──\n${appInfo}\n${text.trimEnd()}\n\n"
        val f = File(d, "journal.txt")
        f.appendText(entry)
        if (f.length() > JOURNAL_MAX) {
            val keep = f.readText().takeLast(JOURNAL_MAX * 3 / 4)
            // Start at an entry, not halfway through one.
            val at = keep.indexOf("── ").takeIf { it >= 0 } ?: 0
            f.writeText(keep.substring(at))
        }
        if (bad) File(d, "unseen").writeText(kind)
    }

    /**
     * What Android recorded about the app's earlier ends (API 30+), each only
     * once. A low-memory kill or a signal only counts as a bad end when the
     * app was on screen: in the background Android may close any app.
     */
    private fun readExitReasons(context: Context) {
        if (Build.VERSION.SDK_INT < 30) return
        try {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val seen = prefs.getLong("exitSeen", 0L)
            val infos = am.getHistoricalProcessExitReasons(context.packageName, 0, 8)
                .filter { it.timestamp > seen }
                .sortedBy { it.timestamp }
            for (info in infos) {
                val onScreen = info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_PERCEPTIBLE
                val bad = when (info.reason) {
                    ApplicationExitInfo.REASON_CRASH,
                    ApplicationExitInfo.REASON_CRASH_NATIVE,
                    ApplicationExitInfo.REASON_ANR,
                    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE,
                    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE,
                    -> true
                    ApplicationExitInfo.REASON_LOW_MEMORY,
                    ApplicationExitInfo.REASON_SIGNALED,
                    -> onScreen
                    else -> false
                }
                // A user closing the app, an update, a permission change: nothing to report.
                if (!bad && info.reason != ApplicationExitInfo.REASON_LOW_MEMORY) continue
                val sb = StringBuilder()
                sb.append("Last run ended at ${stamp(info.timestamp)}: ${exitReasonName(info.reason)}")
                if (info.description != null) sb.append(" (${info.description})")
                sb.append("\nImportance ${info.importance}${if (onScreen) " (on screen)" else " (in the background)"}, status ${info.status}")
                sb.append("\nMemory then: pss ${mb(info.pss * 1024)}, rss ${mb(info.rss * 1024)}")
                if (info.reason == ApplicationExitInfo.REASON_ANR || info.reason == ApplicationExitInfo.REASON_CRASH_NATIVE) {
                    val trace = try {
                        info.traceInputStream?.use { s ->
                            val buf = ByteArray(TRACE_MAX)
                            var n = 0
                            while (n < buf.size) {
                                val r = s.read(buf, n, buf.size - n)
                                if (r < 0) break
                                n += r
                            }
                            String(buf, 0, n, Charsets.UTF_8)
                        }
                    }
                    catch (_: Exception) {
                        null
                    }
                    if (!trace.isNullOrBlank()) sb.append("\nTrace (first ${TRACE_MAX / 1024} KB):\n").append(trace)
                }
                record("Exit reason", sb.toString(), bad)
            }
            infos.lastOrNull()?.let { prefs.edit().putLong("exitSeen", it.timestamp).apply() }
        }
        catch (_: Exception) {
            // Best effort: an older or unusual system just has less to say.
        }
    }

    private fun exitReasonName(r: Int): String = when (r) {
        ApplicationExitInfo.REASON_ANR -> "not responding (ANR)"
        ApplicationExitInfo.REASON_CRASH -> "crash (Java)"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash (native)"
        ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "a dependency died"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive resource use"
        ApplicationExitInfo.REASON_EXIT_SELF -> "exited itself"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "failed to start"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "killed for low memory"
        ApplicationExitInfo.REASON_OTHER -> "other"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "a permission changed"
        ApplicationExitInfo.REASON_SIGNALED -> "killed by a signal"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "closed by the user"
        ApplicationExitInfo.REASON_USER_STOPPED -> "stopped by the user"
        else -> "reason $r"
    }

    private fun priorityName(p: Int): String = when (p) {
        android.webkit.WebView.RENDERER_PRIORITY_WAIVED -> "waived"
        android.webkit.WebView.RENDERER_PRIORITY_BOUND -> "bound"
        android.webkit.WebView.RENDERER_PRIORITY_IMPORTANT -> "important"
        else -> p.toString()
    }

    private fun stackOf(e: Throwable): String = StringWriter().also { e.printStackTrace(PrintWriter(it)) }.toString().take(TRACE_MAX)

    private fun mb(bytes: Long): String = "${bytes / (1024 * 1024)} MB"

    private fun stamp(ms: Long): String = SimpleDateFormat("yyyy-MM-dd HH:mm:ss 'UTC'", Locale.ROOT)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }
        .format(Date(ms))
}
