package io.github.whatmekota.playhound.session

import android.util.Log
import android.webkit.WebView
import io.github.whatmekota.playhound.usb.SerialPanic
import java.lang.ref.WeakReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * What the page said about the session (SessionPlugin.update), and the way
 * panic travels between the notification, the service, the activity and
 * the page. Process-wide: the service outlives the activity.
 */
object SessionBus {
    private const val TAG = "PhSession"
    private const val CLOSE_WAIT_MS = 500L

    /** Something is connected or playing: the service runs and the page is kept awake. */
    @Volatile var state = SessionState()
        private set

    /** Whether the WebView should behave as if it stayed on screen (PhWebView). */
    val keepRunning: Boolean get() = state.active

    private var plugin = WeakReference<SessionPlugin>(null)

    @Volatile private var acked: CountDownLatch? = null

    /** The last panic's time, so the activity closing and the task going don't both do it. */
    @Volatile private var lastPanicAt = 0L

    fun attach(p: SessionPlugin) {
        plugin = WeakReference(p)
    }

    fun detach(p: SessionPlugin) {
        if (plugin.get() === p) plugin = WeakReference(null)
    }

    fun update(s: SessionState) {
        state = s
    }

    /** The page has done its panic (stopped every output). */
    fun panicDone() {
        acked?.countDown()
    }

    /**
     * The notification's Panic: the page stops everything, exactly as Esc
     * does. If it has not said so within a second and a half, the USB ports
     * get their home command from here.
     */
    fun panicFromNotification() {
        val latch = CountDownLatch(1)
        acked = latch
        val p = plugin.get()
        if (p == null) {
            SerialPanic.fire()
            return
        }
        p.firePanic("notification")
        Thread({
            if (!latch.await(1500, TimeUnit.MILLISECONDS)) {
                Log.w(TAG, "The page did not answer the panic: stopping the USB ports from here")
                SerialPanic.fire()
            }
        }, "ph-panic-watch").apply { isDaemon = true }.start()
    }

    /**
     * The app is being closed (swiped away, or its last screen finished) with
     * a session running. The USB ports are homed from here at once; the page
     * is asked to panic and given a moment to reach the rest (the Handy,
     * Intiface, the network) before the activity takes the WebView with it.
     *
     * Called on the main thread, from MainActivity.onDestroy, which is why the
     * page is reached with evaluateJavascript directly: the plugin's events
     * go through the main thread, which is busy waiting here.
     */
    fun panicBeforeClose(webView: WebView?) {
        if (!state.active) return
        lastPanicAt = System.currentTimeMillis()
        SerialPanic.fire()
        val latch = CountDownLatch(1)
        acked = latch
        try {
            webView?.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('ph:native-panic',{detail:{reason:'closing'}}))",
                null,
            )
            latch.await(CLOSE_WAIT_MS, TimeUnit.MILLISECONDS)
        }
        catch (e: Throwable) {
            Log.w(TAG, "panic before close: $e")
        }
    }

    /** The task was removed (SessionService.onTaskRemoved). */
    fun panicOnTaskRemoved() {
        if (System.currentTimeMillis() - lastPanicAt < 5000) return
        lastPanicAt = System.currentTimeMillis()
        SerialPanic.fire()
        plugin.get()?.firePanic("closing")
    }
}

/** What the page reports; see src/lib/android/session.ts. */
data class SessionState(
    val active: Boolean = false,
    val playing: Boolean = false,
    val network: Boolean = false,
    val title: String = "playhound",
    val text: String = "",
) {
    /** A partial wake lock while something plays. */
    val wakeLock: Boolean get() = active && playing

    /** A Wi-Fi lock while a network device is in use. */
    val wifiLock: Boolean get() = active && network
}
