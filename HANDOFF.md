# Continuing development

## State

Version 0.1.1: engine, simulation, a vanilla TypeScript PWA, an Android phone app with a native hard alarm (Capacitor) and a Wear OS watch companion (see ARCHITECTURE.md). No web framework; the app builds to `dist/` with Vite. Android APKs come from `scripts/build-android.sh`; CI is `.github/workflows/android.yml`. v0.1.0 is released (debug-signed MVP, phone and watch APKs plus SHA256SUMS.txt): https://github.com/IvanescuChristian/Sleeping_Aid/releases/tag/v0.1.0; 0.1.1 (watch-first sensing) is prepared and not yet released. Source priority: the watch is the primary sensor, the phone accelerometer only the fallback (ARCHITECTURE.md, Source priority). It is verified on Android 15 and Wear OS 5 emulators only; the real-hardware list below is still open.

## How to run

```
npm install
npm run dev            # dev server
npm run build && npm run preview
npm test               # unit tests
npm run typecheck
npm run test:e2e       # needs a Chromium; on a machine without a display, run it under a virtual display
```

Playwright finds Chromium in this order: the build it expects, the newest Chromium in the local Playwright cache, `PW_CHROMIUM_PATH`. Use the demo button to see the whole flow without sensors.

## Verified

- Engine behaviour and accuracy on synthetic nights (unit tests).
- Scheduler: late tick, single fire, errors in the pipeline, errors in callbacks (unit tests with fake timers).
- In desktop Chromium emulating a phone, with a controlled clock: window validation, fallback alarm fires once, reload mid-night resumes and fires, reload after the end fires immediately, demo night to alarm, summary and hypnogram, history storage, delete-all, Bluetooth button disabled without Web Bluetooth, manifest and offline service worker.

## Not verified

- Any real Android phone over a full night: motion sensor rates and noise on a mattress, Wake Lock stability (web), native alarm behaviour, battery drain, the OS or Chrome killing the app.
- Bluetooth heart rate with real watches and straps (pairing, reconnection, packet formats beyond the standard).
- Stage accuracy on real sleepers; all thresholds were tuned on synthetic data.
- iOS (not supported by design for live nights).

## Real-hardware test list

Follow docs/NIGHT_TEST_CHECKLIST.md. In short:

1. 20-minute nap test on a real phone: hard alarm rings with the screen off, locked and in Doze; alarm screen over the lock screen.
2. Reboot the phone with an armed alarm: it must still ring (boot re-arm, before first unlock).
3. Full night on the charger, then off the charger: smart-wake time, JS liveness under Samsung One UI battery management, battery drain.
4. Galaxy Watch4 Classic: install per docs/WATCH_SETUP.md, permissions, start from the phone, tap-to-start fallback, data lag, watch battery over a night, Samsung Health session display.
5. Compare watch-based staging with the phone's and the watch's own stages; the wrist thresholds (`WAKE_THRESHOLD_WATCH`, `STILL_ACTIVITY_WATCH`) equal the phone-on-mattress values because no wrist night has been recorded yet. Also check watch-first behaviour: Watch shown all night, Phone fallback after ~2.5 min without the watch, back to Watch ~1.5 min after it returns, no gap or duplicate in the hypnogram.

## Open items

- Release signing key decision (docs/SIGNING.md): the MVP release is debug-signed and says so in its notes; later generate a keystore before any update path is promised.
- Model: the smart wake is native (Kotlin port of the JS engine, parity-tested on shared synthetic nights) and runs in the night foreground service with the screen off, the app swiped away or the process killed (sticky restart from persisted epochs). The exact backup alarm stays the guarantee. Verified on an Android 35 emulator with a synthetic accelerometer (screen off, deep Doze forced, task removed, process killed); not on a real phone. The wake-up-accelerometer path (no wake lock) could not be exercised on the emulator. Not covered: heart rate over Web Bluetooth on the phone app (the watch is the only HR source there); deep Doze on a phone without a wake-up sensor, unplugged and motionless.
- Everything about the watch is untested on real hardware, including the watch-first source switching (verified by JVM and Vitest tests and a synthetic parity night only).
- Calibration of thresholds on real nights.

## Next steps

1. Run overnight tests on one or two Android phones with the phone charging; record the stages and alarm times.
2. Test with a Garmin (Broadcast Heart Rate), an Amazfit (Heart Rate Push) and a Polar sensor.
3. Compare estimates with the watch's own stages (Health Connect import) and calibrate `src/engine/config.ts`.
4. Consider an on-watch estimator so the phone is not needed on the mattress.
5. Add app icons for maskable purposes and a proper install prompt if wanted.
