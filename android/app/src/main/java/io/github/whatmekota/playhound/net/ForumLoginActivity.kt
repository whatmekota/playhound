package io.github.whatmekota.playhound.net

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * EroScripts' own login page, in a WebView of the app (the Android side of
 * the desktop app's sign-in window). It ends by itself once the forum has
 * set its session cookie (_t) and moved on from the login page; the cookie
 * stays in the WebView's cookie store, private to the app, where the net
 * proxy's forum requests find it (X-Ph-Jar).
 *
 * Any session from before is cleared first, so an expired one cannot count
 * as signed in.
 */
class ForumLoginActivity : Activity() {
    private lateinit var web: WebView
    private val handler = Handler(Looper.getMainLooper())
    private var finished = false

    private val poll = object : Runnable {
        override fun run() {
            if (check()) return
            handler.postDelayed(this, 1000)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) clearForumCookies()
        val dp = { v: Int -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt() }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(8, 8, 10))
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(4), dp(4), dp(4))
        }
        bar.addView(TextView(this).apply {
            text = "Sign in to EroScripts"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(Button(this).apply {
            text = "Close"
            setOnClickListener { done(false) }
        })
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.setSupportMultipleWindows(false)
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    check()
                }
            }
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        root.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        // Edge to edge on new Androids: keep clear of the status and navigation bars.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            insets
        }
        setContentView(root)
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl("$FORUM/login")
        handler.postDelayed(poll, 1000)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    /** Signed in, and past the login page: done. */
    private fun check(): Boolean {
        if (finished) return true
        val url = web.url ?: ""
        if (signedIn() && url.startsWith(FORUM) && !url.contains("/login") && !url.contains("/session")) {
            done(true)
            return true
        }
        return false
    }

    private fun done(ok: Boolean) {
        if (finished) return
        finished = true
        CookieManager.getInstance().flush()
        setResult(if (ok) RESULT_OK else RESULT_CANCELED)
        finish()
    }

    @Deprecated("The back button goes back in the page first")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else done(false)
    }

    override fun onDestroy() {
        handler.removeCallbacks(poll)
        web.stopLoading()
        web.destroy()
        super.onDestroy()
    }

    companion object {
        const val FORUM = "https://discuss.eroscripts.com"

        /** Whether the cookie store holds a forum session. */
        fun signedIn(): Boolean = (CookieManager.getInstance().getCookie(FORUM) ?: "")
            .split(';').any { it.trim().startsWith("_t=") && it.trim().length > 3 }

        /** Forget the forum's cookies (all of them: the session and what goes with it). */
        fun clearForumCookies() {
            val cm = CookieManager.getInstance()
            val raw = cm.getCookie(FORUM) ?: return
            for (name in raw.split(';').map { it.substringBefore('=').trim() }.filter { it.isNotEmpty() }) {
                cm.setCookie(FORUM, "$name=; Max-Age=0; Path=/; Secure")
                cm.setCookie(FORUM, "$name=; Max-Age=0; Path=/")
            }
            cm.flush()
        }

        fun signOut() = clearForumCookies()
    }
}
