package io.github.ivanescuchristian.sleepingaid;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins must be registered before super.onCreate() creates the bridge.
        registerPlugin(SleepAidNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
