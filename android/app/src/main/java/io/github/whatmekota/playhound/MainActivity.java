package io.github.whatmekota.playhound;

import android.content.ComponentCallbacks2;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import io.github.whatmekota.playhound.crash.CrashLog;
import io.github.whatmekota.playhound.crash.CrashPlugin;
import io.github.whatmekota.playhound.folders.FoldersPlugin;
import io.github.whatmekota.playhound.net.NetPlugin;
import io.github.whatmekota.playhound.app.AppPlugin;
import java.util.ArrayDeque;

public class MainActivity extends BridgeActivity {

    /** Renderer losses within RECOVERY_WINDOW_MS; more than MAX_RECOVERIES and it stops trying. */
    private static final ArrayDeque<Long> recoveries = new ArrayDeque<>();
    private static final long RECOVERY_WINDOW_MS = 2 * 60 * 1000;
    private static final int MAX_RECOVERIES = 3;
    private static long lastTrimLog = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // First: a crash anywhere from here on is written down for the next launch.
        CrashLog.INSTANCE.install(getApplicationContext());
        // The app's own plugins, before the bridge starts.
        registerPlugin(FoldersPlugin.class);
        registerPlugin(CrashPlugin.class);
        registerPlugin(NetPlugin.class);
        registerPlugin(AppPlugin.class);
        // Capacitor answers "renderer gone" with false unless a listener says
        // otherwise, and then the WebView takes the whole app down with it.
        bridgeBuilder.addWebViewListener(
            new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    return recoverFromRendererLoss(view, detail);
                }
            }
        );
        super.onCreate(savedInstanceState);
    }

    /**
     * The renderer crashed or was killed (on a phone, usually for memory). The
     * WebView is dead and cannot be reused: take it out and start the activity
     * again with a fresh one, instead of a blank screen or the app closing.
     * Several in a row means something keeps killing it: then stop.
     */
    private boolean recoverFromRendererLoss(WebView view, RenderProcessGoneDetail detail) {
        long now = SystemClock.elapsedRealtime();
        while (!recoveries.isEmpty() && now - recoveries.peekFirst() > RECOVERY_WINDOW_MS) recoveries.pollFirst();
        boolean retry = recoveries.size() < MAX_RECOVERIES;
        recoveries.addLast(now);
        CrashLog.INSTANCE.rendererGone(
            this,
            detail,
            retry ? "Recovered: the page was started again." : "Gave up after " + MAX_RECOVERIES + " restarts in two minutes: the app closed."
        );
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
        if (retry) recreate();
        else finish();
        return true;
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        // Only the serious ones, and not more than one every half minute.
        boolean serious =
            level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW ||
            level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL ||
            level == ComponentCallbacks2.TRIM_MEMORY_COMPLETE;
        long now = SystemClock.elapsedRealtime();
        if (serious && now - lastTrimLog > 30_000) {
            lastTrimLog = now;
            CrashLog.INSTANCE.trim(this, level);
        }
    }
}
