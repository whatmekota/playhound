package io.github.whatmekota.playhound.session

import android.content.Context
import android.util.AttributeSet
import android.view.View
import com.getcapacitor.CapacitorWebView

/**
 * The app's WebView (res/layout/capacitor_bridge_layout_main.xml puts it in
 * place of Capacitor's own). One difference: while a session is running
 * (SessionBus.keepRunning), it does not tell the page it went out of sight
 * when the screen goes off or another app comes to the front.
 *
 * A page that thinks it is hidden gets its timers slowed to once a second,
 * its video paused and its animation frames stopped; the device loops
 * (script sync, the motion generator, TCode out) would stall with it. Kept
 * "visible", it carries on behind the session service's notification. When
 * the session ends, the page learns the truth at once.
 */
class PhWebView(context: Context, attrs: AttributeSet?) : CapacitorWebView(context, attrs) {
    private var actual = View.VISIBLE

    override fun onWindowVisibilityChanged(visibility: Int) {
        actual = visibility
        tell()
    }

    /**
     * SessionBus.keepRunning may have changed: say the right thing now. Main
     * thread. (The renderer's priority needs nothing: by default it is as
     * important as the app, which the session service keeps in the foreground.)
     */
    fun refreshVisibility() {
        tell()
    }

    private fun tell() {
        super.onWindowVisibilityChanged(if (SessionBus.keepRunning) View.VISIBLE else actual)
    }
}
