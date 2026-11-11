package io.github.whatmekota.playhound.session

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import io.github.whatmekota.playhound.R

/**
 * The foreground service that keeps playhound running with the screen off
 * or another app in front, while a device or output is connected or
 * something is playing (the page decides: SessionPlugin.update).
 *
 * - its notification says what is playing, with Panic and Open
 * - a partial wake lock while playing, so the CPU does not sleep mid-script
 * - a Wi-Fi lock while a network device is in use (the Handy over WiFi,
 *   Intiface on the PC, TCode over the network), so the radio does not doze
 * - swiping the app away panics first (onTaskRemoved), then it stops
 *
 * Type mediaPlayback: it plays a video or sound and drives a device in time
 * with it, which is what that type is for.
 */
class SessionService : Service() {
    private var wake: PowerManager.WakeLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private var inForeground = false
    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        ensureChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PANIC -> {
                SessionBus.panicFromNotification()
                // Started only for this (a notification left behind): nothing to keep running.
                if (!SessionBus.state.active) stopSelf()
            }
            ACTION_STOP -> stopNow()
            // Started with startForegroundService: it must come to the
            // foreground even if the session ended on the way here.
            else -> apply(SessionBus.state, foregroundFirst = true)
        }
        return START_NOT_STICKY
    }

    /**
     * Show the notification and hold the locks the state asks for. Without the
     * notification permission (Android 13+) the service still runs; Android
     * just keeps its notification out of sight.
     */
    @SuppressLint("MissingPermission")
    fun apply(s: SessionState, foregroundFirst: Boolean = false) {
        if (!s.active && !foregroundFirst) {
            stopNow()
            return
        }
        try {
            if (inForeground && s.active) {
                // Already in the foreground: only the words change.
                NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, notification(s))
            }
            else {
                ServiceCompat.startForeground(
                    this,
                    NOTIFICATION_ID,
                    notification(s),
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0,
                )
                inForeground = true
            }
            lastError = null
        }
        catch (e: Exception) {
            // Android 12+ refuses a foreground service started from the background.
            Log.w(TAG, "startForeground: $e")
            lastError = e.message ?: e.javaClass.simpleName
        }
        if (!s.active) {
            stopNow()
            return
        }
        holdLocks(s)
    }

    private fun holdLocks(s: SessionState) {
        if (s.wakeLock) {
            val w = wake ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "playhound:playback")
                .apply { setReferenceCounted(false) }
                .also { wake = it }
            // Renewed with every update from the page; one that stops talking lets it lapse.
            w.acquire(WAKE_TIMEOUT_MS)
        }
        else {
            wake?.let { if (it.isHeld) it.release() }
        }
        if (s.wifiLock) {
            val l = wifi ?: run {
                val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
                @Suppress("DEPRECATION")
                val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
                wm.createWifiLock(mode, "playhound:devices").apply { setReferenceCounted(false) }
            }.also { wifi = it }
            if (!l.isHeld) l.acquire()
        }
        else {
            wifi?.let { if (it.isHeld) it.release() }
        }
    }

    private fun releaseLocks() {
        wake?.let { if (it.isHeld) it.release() }
        wifi?.let { if (it.isHeld) it.release() }
    }

    private fun stopNow() {
        releaseLocks()
        inForeground = false
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiped away from the recent apps. Stop every output (the activity
        // usually got there first, in MainActivity.onDestroy), then go: with
        // the app closed there is nothing left to keep running.
        SessionBus.panicOnTaskRemoved()
        SessionBus.update(SessionState())
        main.postDelayed({ stopNow() }, 1500)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        releaseLocks()
        if (instance === this) instance = null
        super.onDestroy()
    }

    private fun notification(s: SessionState): Notification {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val launch = (packageManager.getLaunchIntentForPackage(packageName) ?: Intent())
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
        val open = PendingIntent.getActivity(this, 1, launch, flags)
        val panic = PendingIntent.getService(this, 2, Intent(this, SessionService::class.java).setAction(ACTION_PANIC), flags)
        // What is playing is nobody else's business on the lock screen.
        val public = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_playhound)
            .setContentTitle("playhound")
            .setContentText(if (s.playing) "Playing" else "Running")
            .build()
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_playhound)
            .setContentTitle(s.title)
            .setContentText(s.text)
            .setContentIntent(open)
            .addAction(0, "Panic", panic)
            .addAction(0, "Open", open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        private const val TAG = "PhSession"
        const val CHANNEL = "session"
        const val NOTIFICATION_ID = 7150
        const val ACTION_PANIC = "io.github.whatmekota.playhound.PANIC"
        const val ACTION_STOP = "io.github.whatmekota.playhound.STOP"
        private const val WAKE_TIMEOUT_MS = 30 * 60 * 1000L

        @Volatile var instance: SessionService? = null
            private set

        /** Why the service last failed to come to the foreground, for Settings → Android app. */
        @Volatile var lastError: String? = null

        val running: Boolean get() = instance != null

        fun ensureChannel(ctx: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = ctx.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL) != null) return
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Playing and devices", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while playhound plays or a device is connected, with a Panic button"
                    setShowBadge(false)
                },
            )
        }

        /** The page's latest state: start, update or stop the service. Main thread. */
        fun sync(ctx: Context, s: SessionState) {
            SessionBus.update(s)
            val svc = instance
            if (svc != null) {
                svc.apply(s)
                return
            }
            if (!s.active) return
            try {
                ContextCompat.startForegroundService(ctx, Intent(ctx, SessionService::class.java))
            }
            catch (e: Exception) {
                Log.w(TAG, "start: $e")
                lastError = e.message ?: e.javaClass.simpleName
            }
        }
    }
}
