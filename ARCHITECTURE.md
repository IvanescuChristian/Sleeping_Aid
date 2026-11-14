# Architecture

## Modules

Engine (`src/engine`, no browser APIs):

- `config.ts`: every tunable constant in one place.
- `epochs.ts`: `EpochAggregator`; removes gravity, groups motion and heart-rate samples into 30 s epochs, fills gaps.
- `stager.ts`: `Stager`; causal rule-based classifier, epoch to stage plus confidence.
- `smartAlarm.ts`: `SmartAlarm` and `validateWindow`; smart trigger and hard fallback.
- `pipeline.ts`: wires the three together; each sensor-side step is fenced with try/catch and `tick()` always reaches the alarm.
- `summary.ts`: night summary and transparent quality score; `suggest.ts`: bedtime and window suggestions.

Simulation (`src/sim`): seeded synthetic nights and a replay harness (used by tests and by the demo mode).

App (`src/app`, vanilla TypeScript and DOM):

- `main.ts` entry and service worker registration (skipped inside the Android app, whose files are bundled in the APK); `app.ts` screens and navigation (setup, night, alarm, summary).
- `night.ts` `NightSession`: owns sensors, pipeline and scheduler for one night.
- `scheduler.ts` `AlarmScheduler`; `sensors.ts` motion, Web Bluetooth heart rate, Wake Lock; `hr.ts` 0x2A37 parser.
- `audio.ts` generated alarm tone and vibration; `storage.ts` localStorage wrapper; `window.ts` time inputs to a validated window; `demo.ts` synthetic night feeder; `hypnogram.ts` SVG chart.
- `public/sw.js` offline shell; `vite.config.ts` fills its precache list at build time.

## Data flow

```
DeviceMotion / BLE heart rate --> pipeline.ingest*  (append only)
                                   |
1 s tick (AlarmScheduler) -> pipeline.tick(now) -> aggregator -> stager -> SmartAlarm
                                   |                                        |
                         status line (1 s)                      decision -> alarm screen
                                                                          -> summary -> localStorage
```

Sensor handlers only append to the aggregator. Staging and alarm evaluation run on the 1 s tick; the UI is refreshed from the same tick, at most once per second.

## Stage heuristic and parameters

Per epoch (30 s): activity is the mean absolute deviation of the acceleration magnitude from a slowly tracked gravity estimate (time constant 4 s). A causal Cole-Kripke-style weighted sum of the last 5 epochs (weights 0.5, 0.25, 0.12, 0.08, 0.05) above 0.04 m/s^2 means wake. Otherwise:

- deep: at least 6 still epochs (activity below 0.006), and, once a personal baseline exists (20 heart-rate epochs), heart rate within 0.5 bpm of the personal 25th percentile and within-epoch HR SD at most the personal median;
- REM: at least 2 still epochs and HR SD at least 1.5 times the personal median (heart rate required);
- light: everything else that is asleep.

Smart trigger: 4 consecutive light or wake epochs, no deep in the last 10 epochs, last epoch no older than 2 epochs, mean confidence at least 0.45. Window length 20 min to 3 h (default 30 min).

### Measured accuracy (synthetic nights, unit-test output)

| Setup | Result |
| --- | --- |
| With heart rate | deep precision 0.824; light or wake at trigger 93.8%; deep at trigger 2.1%; 48 of 50 nights woken smartly |
| Without heart rate (motion only) | 33 of 50 smart; light or wake at trigger 90.9%; deep at trigger 3.0% |

These come from generated data whose generator shares assumptions with the stager. They are optimistic and say nothing yet about real sleepers; thresholds will need calibration on real nights.

## Alarm reliability design

- `AlarmScheduler` ticks every second and compares `Date.now()` to the window end, so a late or throttled tick fires immediately instead of being missed.
- It also arms a `setTimeout` at the window end, and ticks on `visibilitychange` and `pageshow`.
- It fires exactly once (a stored decision plus stopped timers).
- Pipeline errors are caught separately from scheduling: if staging throws, the scheduler still produces the fallback at the window end. UI errors and alarm-callback errors are also isolated.
- The active night (window, start, fired state) is stored in localStorage; after a reload it resumes and, if the end has passed (up to 3 h), fires at once. A ringing alarm survives a reload.
- Audio context is created and resumed on the Start night tap so autoplay rules allow the alarm; if the browser still holds it suspended (for example after a reload), the screen asks for one tap. Vibration runs alongside.
- The Screen Wake Lock is re-acquired on `visibilitychange`; a banner shows when it is unavailable or lost. Not used in the Android app, whose engine is native and does not need the screen.
- Limits that code cannot remove: the OS may kill the browser, the battery may die, iOS suspends JavaScript with the screen off. Hence the instruction to set a regular system alarm too.

## Android native layer

The web app is wrapped with Capacitor 8 (`capacitor.config.ts`, app id `io.github.ivanescuchristian.sleepingaid`, minSdk 24, target and compile SDK 36). JavaScript reaches native code through one custom plugin, `SleepAidNative` (`src/native/plugin.ts` is the typed surface, `android/app/src/main/java` the Kotlin side). `src/native/nativeAlarm.ts` is the glue used by the night flow; every call is a no-op outside the Android app, so the web app behaves as before. A stock local-notifications plugin was rejected because it cannot use `setAlarmClock` and silently falls back to inexact alarms.

- Hard alarm: `AlarmManager.setAlarmClock` for the window end (never an inexact fallback). If exact alarms are not allowed the night does not start and the user is sent to the settings screen. `AlarmReceiver` starts `AlarmService`, a foreground service of type mediaPlayback that rings the system alarm sound with vibration independently of the WebView, and posts a full-screen notification for `AlarmActivity`, which shows over the lock screen.
- Smart wake: decided natively, by a Kotlin port of the engine (`android/app/src/main/java/.../engine`, no Android imports: `EngineConfig`, `EpochAggregator`, `Stager`, `SmartAlarm`, `Pipeline`, `SourceSelector`, `WatchFeed`). Constants are copied one to one from `src/engine/config.ts` into `EngineConfig.kt`. The JS engine stays the reference and still runs the web app. Parity is enforced twice: `tests/unit/engineParity.test.ts` runs the JS engine over seeded synthetic nights and compares with `tests/fixtures/engine-parity/*.json` (regenerate with `npm run fixtures:engine`), and the Kotlin `ParityTest` feeds the same files to the Kotlin engine and demands identical stages and the identical wake decision (floating values to 1e-9, because V8 and the JVM may differ in the last bit of `hypot`/`exp`).
- `NightService` (foreground, type health, `START_STICKY`) is the runtime: it registers the accelerometer with batching, feeds `NightTracker` and ticks it. `WatchMessageService` feeds watch batches to the same tracker, through `WatchFeed`, with the 60 s shift and the source rules below. `NightStore` (device-protected storage) persists the night parameters, the outcome (`TRACKING`, `WOKE` with reason smart or fallback and time, `ENDED`) and one CSV line per closed epoch. A line holds the stager's aggregated input and its label, so a restarted process (sticky restart, or `BootReceiver` after a reboot) replays the inputs and rebuilds the stager exactly (the stager is causal); only the open epoch and the gravity estimate restart. If Android refuses the restart (for example a background start), a "Tap to resume night tracking" notification is posted and the app resumes tracking when opened (`getNightStatus().needsResume`).
- CPU: with a wake-up accelerometer the sensor hub wakes the CPU for a batch about every 20 s and no wake lock is held. Without one (the emulator), non-wake-up events are lost while the CPU sleeps, so a partial wake lock bounded to the window end plus 10 minutes is held. Not covered: a phone without a wake-up sensor, unplugged and motionless in deep Doze, may pause tracking; the backup alarm is unaffected.
- Batched sensor events: samples are timestamped by the sensor (`SensorEvent.timestamp`, elapsed-realtime based, converted to wall time) and reach the engine up to 20 s late. The aggregator is therefore only advanced by the clock to `now - SENSOR_ADVANCE_LAG_MS` (25 s), so a later batch can never land in an epoch that was already closed; the window rules keep using the real clock. Cost: a smart decision (or a gap epoch) can lag by up to about 25 s. `BatchingTest` covers it.
- Decision and ring: a smart decision is persisted first, then `HardAlarm.fireNow` re-arms the same `setAlarmClock` PendingIntent about a second ahead (and stores that time, so a reboot in between still rings; a restarted service finishes a persisted smart wake that never rang), so the ring goes through `AlarmReceiver` like the backup (an alarm-clock alarm is exempt from the background foreground-service-start limits, which a start from the night service is not guaranteed to be) and replaces the window-end alarm in one step. A fallback decision (window end reached) is only recorded; the exact alarm rings it. `HardAlarm.onFired` records "fallback" when nothing was recorded yet, so the reason is right whether or not the engine was alive.
- JavaScript on Android runs no pipeline: `NativeNightSession` (`src/app/nativeNight.ts`) polls `getNightStatus` while the page is visible, notices `state: "woke"` and then reads `getNightEpochs` to build the stored summary. Plugin surface: `startNightService(params)`, `stopNightService`, `clearNight`, `getNightStatus`, `getNightEpochs`. `startNightService` with the same `startedAt` resumes the night and never restarts one that already woke or ended.
- Keeping the screen on is an optional setting (`setNightScreen`, off by default); the engine does not need it.
- `getAlarmState` tells JS whether the native alarm is none, pending, ringing or ended, so a JS alarm screen whose alarm was already stopped natively is closed instead of shown silent.
- Boot re-arm: `BootReceiver` (LOCKED_BOOT_COMPLETED, BOOT_COMPLETED, MY_PACKAGE_REPLACED and the exact-alarm permission change) re-arms the stored alarm, because `AlarmManager` forgets alarms in all those cases. The alarm record lives in device-protected storage (`AlarmStore`), and `AlarmService`, `AlarmReceiver` and `AlarmActivity` are direct-boot aware, so the alarm can ring before the first unlock after a reboot.
- No INTERNET permission. Permissions are each justified by a comment in the manifest.

## Wear OS watch module

`android/wear` is a separate Gradle module with the same application id and signing key as the phone app (required by the Data Layer). It is a relay, not a standalone app (`com.google.android.wearable.standalone` is false). Wear OS 3 or newer (minSdk 30).

- `TrackingService` (foreground, health type) records heart rate through Health Services (an exercise session) and the accelerometer. Wrist activity per 30 s epoch is computed exactly like the phone (`ActivityAccumulator` in `Protocol.kt`: gravity high-pass with a 4 s time constant, mean absolute deviation).
- `CommandService` receives `/sleepaid/start` and `/sleepaid/stop`. If Android refuses to start the recording from the background, it posts a tap-to-start notification.
- The Samsung Health Sensor SDK is deliberately not used (partner approval, developer mode only).

### Data Layer protocol

Capabilities: `sleepaid_phone` (phone), `sleepaid_watch` (watch), used to find the peer node. Paths, sent as Data Layer messages:

| Path | Direction | Payload |
| --- | --- | --- |
| `/sleepaid/start` | phone to watch | start recording; `reset` drops buffered batches of earlier nights |
| `/sleepaid/stop` | phone to watch | stop recording |
| `/sleepaid/epochs` | watch to phone | one JSON batch |

Batch schema v1 (pinned by `tests/fixtures/watch-batch.json`, decoded in `src/native/watch.ts`):

```
{"v":1,"session":"<id>","seq":7,"sentAt":<ms>,"epochMs":30000,
 "epochs":[{"t":<epoch start ms>,"act":<mean abs deviation m/s^2>,"n":<samples>}],
 "hr":[[<ms>,<bpm>]]}
```

- Dedupe: `(session, seq)` identifies a batch. The session is random per tracking run, seq counts from 1. The watch re-sends what it could not confirm; the native `WatchBatchStore` drops repeats (the JS `WatchDedup` remains for its own tests).
- `WatchMessageService` hands each accepted batch straight to the native engine, also while the app is closed. Nothing is stored raw; the engine persists its own epochs. `drainWatchEpochs` always returns an empty list now (kept for older JS).
- 60 s shift: the watch closes an epoch with its next sensor event and Bluetooth adds delay, so unshifted data would arrive after the phone stager closed the epoch. Every watch timestamp is moved `WATCH_SHIFT_MS` (two epochs, 60 s) later. Cost: hypnogram times and smart-wake decisions lag by 60 s.
- Source selection: see "Source priority" below.
- No clock-skew correction between watch and phone.

### Source priority (watch first, phone fallback)

Owner requirement: the watch is the primary sensor (heart rate and wrist motion) whenever it is live; the phone accelerometer is used only when watch data is absent or stale. The logic is `SourceSelector` (pure, `src/engine/sourceSelector.ts`, mirrored in `engine/SourceSelector.kt`); the constants are in `src/engine/config.ts` and `EngineConfig.kt` and are checked by `tests/fixtures/engine-parity/config.json`.

- Staleness timeout `WATCH_FRESH_MS` = 150 s without a fresh watch epoch. The watch sends about every 30 s and data is shifted 60 s, so a healthy stream shows a fresh epoch at least every ~45 s; 150 s is five batch periods, so one or two lost Bluetooth messages (the watch re-sends them) do not flip the source, while a dead watch costs only a few epochs. At the start of a night the watch has `WATCH_GRACE_MS` = 240 s to deliver its first epoch.
- Fresh epoch: one the aggregator can still accept, i.e. it arrives less than `WATCH_SHIFT_MS + REORDER_GRACE_MS` (62 s) after its end. A reconnect that flushes buffered backlog therefore never counts as proof of life, and repeated epochs are counted once.
- Hysteresis: after a stale period the watch is the source again only after `WATCH_RECOVER_EPOCHS` = 3 consecutive fresh epochs delivered over at least `WATCH_RECOVER_MS` = 60 s (an arrival gap of 150 s restarts the count). A flapping watch can therefore change the source at most once per recovery plus one timeout (about every 3.5 min); this bound is a unit test.
- Gating, not mixing: one `Pipeline`, `Stager` and `SmartAlarm` per night. While the watch is the source, phone accelerometer samples are dropped; while the phone is the source, watch activity is dropped (`WatchFeed.apply`). As a backstop the aggregator gives each epoch to the first motion source that delivers (`source`), refuses motion from the other one and counts it (`crossSource`), so nothing is double-counted even at the seam, where the 60 s watch shift and the 20 s phone sensor batching could overlap.
- Heart rate has no phone counterpart, so watch heart rate is used whenever it arrives, whichever source supplies motion (a watch whose accelerometer is dead but whose heart-rate sensor works still contributes HR). It does not set the epoch source.
- Per epoch the aggregator records `source` (`watch`, `phone`, or none for a gap); it is persisted in the epoch CSV (a ninth column; lines from 0.1.0 without it are still read), returned by `getNightEpochs`, and summarised as `sourceEpochs` in the night summary. With neither source delivering, epochs are emitted as `unknown` with no source, never skipped or duplicated. The night status shows `watch`, `watch-waiting`, `phone` (no watch wanted), `phone-fallback` or `none`.
- After a process restart `NightTracker.start` creates a new selector; the grace period is long over, so the night continues on the phone and returns to the watch through the normal hysteresis.
- Wake/still thresholds: the watch computes activity with the same formula, gravity filter and unit as the phone (`ActivityAccumulator` in `Protocol.kt`), but a wrist probably moves more than a mattress. `WAKE_THRESHOLD_WATCH` and `STILL_ACTIVITY_WATCH` exist and the stager picks them by epoch source, but they equal the phone values because there is no recorded wrist night to calibrate on. This is a documented limitation, not a measured result. The causal stager window mixes epochs of both sources across a switch and applies the current epoch's thresholds to them.
- Not back-filled: epochs the watch buffered while out of reach are not used to replace minutes the phone already covered.
- Alarm path: untouched. The window-end backup is an AlarmManager alarm that does not depend on the engine or any sensor. Firing is idempotent at every layer: `SmartAlarm` makes one decision, `NightStore.recordWake` records only the first one for a night still tracked, `AlarmStore` keeps the FIRED state, and `NightTracker` serialises the phone and watch threads under one lock. Switching sources cannot cause a second ring.

## Versioning and signing

`package.json` `version` is the single source (`android/sa-common.gradle`). versionName is that string. Phone versionCode = MAJOR * 1,000,000 + MINOR * 1,000 + PATCH (0.1.1 gives 1001; MINOR and PATCH below 1000, MAJOR below 100). Watch versionCode = 100,000,000 + phone versionCode, so the two forms never collide and both grow with each bump.

Both modules are signed with one key chosen by environment variables (`SA_KEYSTORE_FILE`, `SA_KEYSTORE_PASSWORD`, `SA_KEY_ALIAS`, `SA_KEY_PASSWORD`); partly set fails the build, none set falls back to the debug key with a warning. See docs/SIGNING.md. `.github/workflows/android.yml` runs tests, builds, verifies that both release APKs carry the same certificate, and publishes a GitHub Release on `v*` tags (tag must equal the package.json version; the MVP release is debug-signed and labelled so).

## Battery considerations

One timer per second, no animation or render loops while the screen is static, motion samples limited to 10 Hz, tiny epoch state, no network, near-black night screen. In the web app keep the phone charging: the screen stays on all night. The Android app does not need the screen on; see the CPU note above.

## Research summary

- A sleep cycle is about 90 minutes (range roughly 70 to 120), which drives bedtime suggestions.
- Commercial smart alarms typically use windows of about 30 minutes.
- Watch sleep stages reach apps via Health Connect or HealthKit only after the night, so live staging must be estimated from raw streams.
- Web Bluetooth with the standard Heart Rate Service works in Chrome on Android, not on iOS.
- Screen Wake Lock is released when the page is hidden and must be re-acquired.
- The Notification Triggers API, which would have allowed scheduled notifications from a web app, was discontinued.
- iOS suspends JavaScript when the screen is off.

## Future work

- An on-watch estimator for Wear OS, so the phone is not needed on the mattress (today the watch only relays raw epochs).
- Health Connect after-night import to compare estimates with the watch's own stages and calibrate thresholds.
- Calibration on real nights, and an optional cloud-free export of history.
