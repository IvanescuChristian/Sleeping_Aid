# Continuing development

## State

Working MVP, version 0.1.0: engine, simulation and a vanilla TypeScript PWA (see ARCHITECTURE.md). No framework; the app builds to `dist/` with Vite.

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

- Any real Android phone over a full night: motion sensor rates and noise on a mattress, Wake Lock stability, audio and vibration behaviour with the screen dimmed, battery drain, Chrome killing the page.
- Bluetooth heart rate with real watches and straps (pairing, reconnection, packet formats beyond the standard).
- Stage accuracy on real sleepers; all thresholds were tuned on synthetic data.
- iOS (not supported by design for live nights).

## Next steps

1. Run overnight tests on one or two Android phones with the phone charging; record the stages and alarm times.
2. Test with a Garmin (Broadcast Heart Rate), an Amazfit (Heart Rate Push) and a Polar sensor.
3. Compare estimates with the watch's own stages (Health Connect import) and calibrate `src/engine/config.ts`.
4. Consider the native Android app (system alarm via `AlarmManager.setAlarmClock`) and an on-watch estimator for a more reliable product.
5. Add app icons for maskable purposes and a proper install prompt if wanted.
