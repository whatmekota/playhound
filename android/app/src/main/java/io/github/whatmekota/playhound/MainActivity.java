package io.github.whatmekota.playhound;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import io.github.whatmekota.playhound.folders.FoldersPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins, before the bridge starts.
        registerPlugin(FoldersPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
