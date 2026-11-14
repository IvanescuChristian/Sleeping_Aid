# Update tracking

## 2026-11-13 checkpoint 1: engine

- TypeScript engine: epoch aggregation, rule-based stager, smart alarm with a clock-only hard fallback, pipeline with error fences, night summary, bedtime suggestions.
- Seeded synthetic night generator and replay harness.
- 42 unit tests passing; measured synthetic accuracy recorded in ARCHITECTURE.md.

## 2026-11-13 checkpoint 2: PWA MVP

- Installable PWA (manifest, icons, offline service worker), Vite build.
- Screens: setup, night, alarm, summary and history, demo night.
- `AlarmScheduler` with interval, timeout, late-tick handling, once-only firing and reload resume.
- Motion sensor, Web Bluetooth heart rate (0x2A37 parser), Screen Wake Lock, generated alarm sound and vibration.
- Local-only storage with delete-all.
- Unit tests for the heart-rate parser, scheduler and window logic; Playwright end-to-end tests.
- Not yet done: real-device validation (see HANDOFF.md).

## 2026-11-13 reliability hardening

- The Screen Wake Lock now stays held while the alarm rings and through a snooze; it is released on Dismiss or when a snooze is cancelled. Sensors and the scheduler still stop at fire time.
- Stop night and Dismiss disconnect the Bluetooth heart-rate device so the link does not stay live; reconnect next night.
- A wake-lock request that resolves after the night was stopped is released immediately instead of being held.
- `NightSession.start()` arms the scheduler first and fences every sensor setup step, so no sensor failure can stop the alarm from being armed.
- The wake window start is computed from the wall-clock start time, so DST-change nights keep the times the user typed (validation still uses the real duration).
- Added `engines.node >= 24` to package.json.
- Tests: exact window timestamps (including a Europe/Helsinki DST night), wake-lock race, wake lock held while ringing, and the fenced start.

## 2026-11-14 checkpoint 3: Android phone app (phase A)

- Capacitor 8 Android app wrapping the web build; custom `SleepAidNative` plugin.
- Native hard alarm with `AlarmManager.setAlarmClock`, ringing foreground service, full-screen alarm screen over the lock screen, re-arm after boot, app update and exact-alarm permission change, device-protected storage for the stored alarm. No inexact fallback: without exact alarms the night does not start.
- Night foreground service; JS smart wake rings through the native alarm; service worker not registered inside the app.
- Versioning from package.json with a deterministic versionCode; env-based release signing with a debug-key fallback; `scripts/build-android.sh`.
- Unit tests for the native glue. The hard alarm was verified on an Android 35 emulator (screen off, Doze, reboot); not yet on a real phone.

## 2026-11-14 checkpoint 3b: native night screen

- Emulator finding: with the screen off the WebView page is hidden after about a minute and JS timers drop to one per minute, so the JS smart wake starves (the native hard alarm still fires).
- Fix: `setNightScreen` keeps the screen on at minimum brightness during a night (the Screen Wake Lock API is not used in the app); a notice appears if the screen was turned off; `getAlarmState` closes a stale JS alarm screen after a native Stop.
- Model: smart wake needs the app open with the screen on; the backup alarm is native. After a reboot tracking resumes only when the app is opened. Native smart wake is possible future work.

## 2026-11-14 checkpoint 4: Wear OS watch companion (phase B)

- `android/wear` module: heart rate through Health Services, wrist activity through the accelerometer, batches to the phone over the Data Layer, tap-to-start fallback.
- Phone side: `WatchMessageService`, durable batch store, JS decoder, dedupe, 60 s timestamp shift, automatic fall-back to the phone sensor when the watch goes silent.
- Protocol schema v1 pinned by a fixture shared by the Kotlin encoder and the TypeScript decoder tests.
- Not tested on a real watch.

## 2026-11-14 checkpoint 5: CI and documentation

- GitHub Actions workflow: typecheck, unit and end-to-end tests, APK build, same-certificate check for phone and watch, GitHub Release with checksums on `v*` tags (fails without a release key).
- Docs: Android install, watch setup, night test checklist, signing. README platform status and known limits; ARCHITECTURE native layer, watch module and protocol.
- Release signing key not yet decided; current local APKs are debug-signed and not for release.

## 2026-11-14 checkpoint 6: native smart wake

- Owner decision: the smart wake works like a real alarm (screen off, app in the background or closed). The engine is ported to Kotlin (`engine` package, no Android imports) and runs in `NightService` (START_STICKY); the exact backup alarm stays the guarantee.
- Tests: JUnit 4 (already declared as `junitVersion`, plain `testImplementation`, no extra plugin) for the aggregator, stager, alarm rules, restart replay and watch feed, plus a parity test on shared synthetic nights (`tests/fixtures/engine-parity`, generated by `npm run fixtures:engine`, checked by Vitest and by the Kotlin `ParityTest`): identical stages and wake decision.
- Native state: `NightStore` (device-protected) keeps the night, the outcome (smart or fallback, time) and per-epoch input and stage; a restart replays them. `getNightStatus` and `getNightEpochs` feed the JS night screen and summary.
- JS on Android runs no pipeline any more and the screen-on default and its notice are gone (keep-screen-on is an optional setting). The web app is unchanged.
- Smart ring goes through the same `setAlarmClock` path as the backup (re-armed about a second ahead), because a foreground-service start from the night service is not guaranteed to be allowed.
- Watch batches are decoded and fed natively (the 60 s shift is kept so JS and Kotlin see the same timeline). Heart rate on the phone app comes from the watch only; the Web Bluetooth button is hidden there.
- Emulator check (Android 35, synthetic accelerometer): smart wake fired at the window opening with the screen off, deep Doze forced and the task removed; see the report for the run evidence. Not verified on a real phone.
