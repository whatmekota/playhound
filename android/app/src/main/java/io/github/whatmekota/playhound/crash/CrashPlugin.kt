package io.github.whatmekota.playhound.crash

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * The crash journal (CrashLog) for the page: src/lib/android/crashReport.ts.
 *
 * - status: whether the last run ended badly and the user has not seen it yet
 * - journal: the native events, with this phone's memory right now
 * - seen: the banner was shown or dismissed
 * - clear: forget everything
 */
@CapacitorPlugin(name = "PhCrash")
class CrashPlugin : Plugin() {
    @PluginMethod
    fun status(call: PluginCall) {
        call.resolve(JSObject().put("unseen", CrashLog.hasUnseen()))
    }

    @PluginMethod
    fun journal(call: PluginCall) {
        val ctx = context
        call.resolve(
            JSObject()
                .put("app", CrashLog.describeApp(ctx))
                .put("memory", CrashLog.memoryLine(ctx))
                .put("journal", CrashLog.journal()),
        )
    }

    @PluginMethod
    fun seen(call: PluginCall) {
        CrashLog.markSeen()
        call.resolve()
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        CrashLog.clear()
        call.resolve()
    }
}
