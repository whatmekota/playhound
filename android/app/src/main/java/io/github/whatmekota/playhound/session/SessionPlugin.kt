package io.github.whatmekota.playhound.session

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * The session service for the page (src/lib/android/session.ts).
 *
 * - update: what is connected and playing; starts, updates or stops the
 *   foreground service, and keeps the page running behind it (PhWebView)
 * - status: for Settings → Android app
 * - requestNotifications: Android 13+'s notification permission, without
 *   which the service runs but its notification (and Panic) stays hidden
 * - openBatterySettings / openNotificationSettings
 * - panicDone: the page has stopped everything after a "panic" event
 * - events: "panic" { reason: "notification" | "closing" },
 *   "appState" { foreground }
 */
@CapacitorPlugin(
    name = "PhSession",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])],
)
class SessionPlugin : Plugin() {
    @Volatile private var foreground = true

    override fun load() {
        SessionBus.attach(this)
        SessionService.ensureChannel(context)
    }

    override fun handleOnDestroy() {
        SessionBus.detach(this)
    }

    override fun handleOnStart() {
        foreground = true
        notifyListeners("appState", JSObject().put("foreground", true))
    }

    override fun handleOnStop() {
        foreground = false
        notifyListeners("appState", JSObject().put("foreground", false))
    }

    fun firePanic(reason: String) {
        notifyListeners("panic", JSObject().put("reason", reason))
    }

    @PluginMethod
    fun update(call: PluginCall) {
        val s = SessionState(
            active = call.getBoolean("active", false)!!,
            playing = call.getBoolean("playing", false)!!,
            network = call.getBoolean("network", false)!!,
            title = call.getString("title") ?: "playhound",
            text = call.getString("text") ?: "",
        )
        activity.runOnUiThread {
            SessionService.sync(context, s)
            (bridge.webView as? PhWebView)?.refreshVisibility()
            call.resolve(status())
        }
    }

    @PluginMethod
    fun status(call: PluginCall) {
        call.resolve(status())
    }

    private fun status(): JSObject {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return JSObject()
            .put("sdk", Build.VERSION.SDK_INT)
            .put("running", SessionService.running)
            .put("keepRunning", SessionBus.keepRunning)
            .put("webViewKept", bridge.webView is PhWebView)
            .put("foreground", foreground)
            .put("notifications", NotificationManagerCompat.from(context).areNotificationsEnabled())
            .put("batteryUnrestricted", pm.isIgnoringBatteryOptimizations(context.packageName))
            .put("error", SessionService.lastError)
    }

    @PluginMethod
    fun requestNotifications(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsAnswered")
        }
        else {
            call.resolve(status())
        }
    }

    @PermissionCallback
    private fun notificationsAnswered(call: PluginCall) {
        call.resolve(status())
    }

    @PluginMethod
    fun openNotificationSettings(call: PluginCall) {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        }
        else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
        }
        start(call, intent)
    }

    /** The phone's list of apps and their battery limits (there is no direct switch to send people to). */
    @PluginMethod
    fun openBatterySettings(call: PluginCall) {
        start(call, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }

    private fun start(call: PluginCall, intent: Intent) {
        try {
            activity.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            call.resolve()
        }
        catch (e: Exception) {
            try {
                activity.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                call.resolve()
            }
            catch (e2: Exception) {
                call.reject("This phone has no such settings page")
            }
        }
    }

    @PluginMethod
    fun panicDone(call: PluginCall) {
        SessionBus.panicDone()
        call.resolve()
    }
}
