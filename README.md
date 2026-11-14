# Sleeping_Aid

Sleeping_Aid is a smart alarm: an installable web app (PWA), an Android phone app
and an optional Wear OS watch companion.
You choose a wake window, for example 06:30 to 07:00. During the night the app
estimates your sleep stage. On Android the primary source is a Wear OS watch worn
all night (heart rate and wrist motion); the phone's motion sensor (lying on the
mattress) is the fallback when the watch is absent or silent. In the web app, the
phone's motion sensor and, optionally, a Bluetooth heart-rate sensor are used. It rings the alarm at the first
moment inside the window when you are in light sleep, and at the window end at
the latest.

Status: version 0.1.1, not yet validated on real sleepers or a real night. Read
the platform status, the status table and the known limits below before relying
on it for something important.

## Platforms

| Platform | Status |
| --- | --- |
| Web app (PWA, Chrome on Android) | Working; verified in a desktop browser emulating a phone. Cannot ring reliably with the screen off. |
| Android phone app (sideloaded APK) | Built and unit-tested. Has a native hard alarm (system alarm clock) that rings at the window end with the screen off. The smart wake runs natively (Kotlin port of the engine), so it works with the screen off, the app in the background or swiped away. Verified on an Android 35 emulator (screen off, Doze, app removed, process killed); not yet tested on a real phone night. |
| Wear OS watch companion (Galaxy Watch4 and other Wear OS 3+ watches) | Built, **not tested on a real watch**. The primary sensor on Android: streams heart rate and wrist motion to the phone app all night; the phone sensor takes over only while the watch is silent. |
| iOS | Not supported. |

## How the smart wake works

1. Sensor samples are grouped into 30 second epochs (movement level, heart-rate
   mean and variability).
2. A rule-based stager labels each epoch wake, light, deep or REM. Movement
   gives wake versus sleep; stillness plus a low, steady heart rate gives deep
   sleep; a variable heart rate with no movement gives REM.
3. Inside the window the alarm fires when about 2 minutes in a row are light or
   awake, no deep sleep was seen in the last 5 minutes, and the data is fresh.
4. If that never happens, the alarm fires at the window end. This fallback only
   reads the clock, so no sensor or staging problem can block it.

Stage estimates are not a medical measurement. They are tuned on synthetic nights
only (see ARCHITECTURE.md) and are not yet validated on real sleepers.

## Reliability limits (read this)

Android phone app:

- The hard alarm at the window end is a native system alarm clock (`AlarmManager.setAlarmClock`). It rings with the screen off and the phone locked, and does not need the app on screen. It needs the "Alarms & reminders" permission; without it the night will not start.
- The smart wake (ringing early, in light sleep) is decided by a native Kotlin port of the engine, run by a foreground "night" service. It needs neither the screen nor the app: motion and heart rate come from the watch whenever it is delivering, and from the phone accelerometer only while the watch is silent or absent (never both for the same epoch, see ARCHITECTURE.md), staging and the decision happen natively, and the epochs are stored so the app can draw the night when you open it. If the smart rule never fires, the exact backup alarm at the window end rings. Both go through the same alarm path, and the night records which one woke you.
- Power: where the phone has a wake-up accelerometer the CPU is woken only to deliver batches (about every 20 s) and no wake lock is held. Without one, a bounded partial wake lock keeps the CPU up until shortly after the window end. In deep Doze (phone unplugged and motionless for a long time) Android may still pause tracking on such phones; the backup alarm is unaffected. Setting the battery to "Unrestricted" (docs/ANDROID_INSTALL.md) avoids that.
- If Android kills the process the service restarts itself and continues from its stored epochs. After a reboot the backup alarm is re-armed and tracking restarts if Android allows it; otherwise a "Tap to resume night tracking" notification appears.
- Heart rate on the phone app comes from the Wear OS watch only: Bluetooth heart rate through the web view cannot run reliably with the screen off.
- As a fail-safe, still set your phone's regular alarm for the window end.

Web app (PWA):

- iOS is not supported for live nights: iOS suspends JavaScript when the screen is off, so the alarm could not run.
- The web platform cannot schedule a reliable alarm in the background. Keep the phone charging and the app open on screen. The app holds a Screen Wake Lock and warns you if it is lost. (The Android app does not need this: its engine is native.)
- If the page reloads during the night, the night resumes from the stored window and still fires, but sensor history from before the reload is lost, and sound may need one tap to be allowed by the browser.

Both: do not rely on this app alone for flights, exams or shifts.

## Known limits

- Wrist (watch) motion uses the same activity formula as the phone, and its wake and stillness thresholds currently equal the phone-on-mattress values because no real wrist night has been recorded to calibrate on. A wrist moves more than a mattress, so staging from the watch is unvalidated and may be too sensitive. The thresholds are separate settings (`WAKE_THRESHOLD_WATCH`, `STILL_ACTIVITY_WATCH`) so they can be tuned once real data exists.
- Watch data reaches the phone about 60 seconds late (every watch timestamp is shifted by 60 s so epochs line up). Hypnogram times and smart-wake decisions lag by that much.
- The Wear OS Data Layer is best effort: messages can be delayed or lost if the watch is out of range or its Bluetooth link drops. If the watch delivers nothing for 2.5 minutes the phone sensor takes over (those minutes before the takeover show as no data), and the watch becomes the source again after it has delivered 3 consecutive fresh epochs spanning at least 60 seconds. Epochs the watch buffered while it was out of reach are not back-filled.
- There is no correction for clock differences between the watch and the phone.
- Stage accuracy has only been measured on synthetic nights, whose generator shares assumptions with the stager. The numbers are optimistic.
- Samsung One UI battery optimisation can stop background apps. Set Sleeping Aid to "Unrestricted" (see docs/ANDROID_INSTALL.md).
- Samsung Health may show an exercise or meditation-like session on the watch while it records, because heart-rate recording uses an Android exercise session. Battery use of the watch over a night is not yet measured.

## Which watches can feed heart rate

Wear OS watches (for example Galaxy Watch4 Classic) use the Sleeping Aid watch app
described in docs/WATCH_SETUP.md; this is untested on real hardware.

In the web app, and as an alternative in the Android app, the app reads the standard Bluetooth Low Energy Heart Rate Service (Web
Bluetooth, Chrome on Android). Devices that broadcast standard BLE heart rate can
work, for example:

- Garmin watches with "Broadcast Heart Rate"
- Amazfit watches with "Heart Rate Push"
- Polar heart-rate sensors and chest straps

Other devices are not verified. Sleep stages computed by a watch are only
available to apps after the night (via Health Connect or HealthKit), so this app
estimates stages live itself. Heart rate is optional; motion alone still works,
with fewer smart wakes.

## Privacy

All data stays on your device (browser localStorage; in the Android app, the app's
own storage). The Android app does not even request the INTERNET permission. The
phone and watch talk to each other directly over the Wear OS Data Layer. There is
no account and no analytics. Only night summaries and a coarse
hypnogram are stored; raw sensor streams are never saved. "Delete all data" on
the summary screen removes everything.

## Install

- **Web:** open the served app in Chrome on Android over HTTPS and choose "Install app" (Web Bluetooth, Wake Lock and service workers need HTTPS or localhost).
- **Android phone app:** download `SleepingAid-0.1.1-phone-mvp-debugsigned.apk` from the [v0.1.1 release](https://github.com/IvanescuChristian/Sleeping_Aid/releases/tag/v0.1.1) (the checksums are in `SHA256SUMS.txt` there) and follow docs/ANDROID_INSTALL.md. The v0.1.1 MVP release (and local builds) are debug-signed; uninstall before installing a future version. See docs/SIGNING.md.
- **Watch (Wear OS):** download `SleepingAid-0.1.1-watch-mvp-debugsigned.apk` from the same release and sideload it: `adb pair`, `adb connect`, `adb install` (see docs/WATCH_SETUP.md). Not yet tested on a real Galaxy Watch4.
- **Before the first real night:** work through docs/NIGHT_TEST_CHECKLIST.md, starting with a 20-minute nap test.

## What you must test on real hardware

The app has been verified on Android and Wear OS emulators only. On a Galaxy S24 FE and a Galaxy Watch4 Classic, test in this order:

1. A 20-minute nap test first.
2. A full night, on and off the charger.
3. The alarm with the screen off, locked, in Doze and after swiping the app away.
4. A reboot with an armed alarm.
5. The watch link and permissions.
6. Phone and watch battery use.
7. Samsung battery settings (set the app to "Unrestricted").

Details are in docs/NIGHT_TEST_CHECKLIST.md.

## Run, build, test

Requires Node 24.

```
npm install
npm run dev          # development server
npm run build        # production build into dist/
npm run preview      # serve the production build (http://localhost:4173)
npm test             # unit tests (engine, simulation, app logic, native glue)
npm run typecheck
npm run test:e2e     # Playwright end-to-end tests against the preview build
scripts/build-android.sh   # phone and watch APKs into dist-android/ (needs JDK 21 and the Android SDK)
```

The end-to-end tests need a Chromium. They use Playwright's own build if
installed, otherwise the newest Chromium found in the local Playwright cache, or
the path in `PW_CHROMIUM_PATH`. On a machine without a display run them under a
virtual display. Continuous integration (`.github/workflows/android.yml`) runs
the tests and builds both APKs; a `v*` tag publishes a GitHub Release.

## Status

| Area | Status |
| --- | --- |
| Engine unit tests (staging, alarm, summary, suggestions) | Verified (synthetic data) |
| Alarm scheduler: late tick, fire once, pipeline errors | Verified (unit and browser tests, fake timers) |
| Setup validation, fallback alarm, reload resume, demo, history, delete | Verified (Playwright, desktop Chromium emulating a phone) |
| Offline service worker and manifest | Verified (Playwright) |
| Stage accuracy on real sleepers | Not verified |
| Native hard alarm, boot re-arm (Android) | Verified on an Android 35 emulator (screen off, Doze, reboot) |
| Native smart-wake engine: JVM unit tests plus parity with the JS engine on shared synthetic nights | Verified (`./gradlew :app:testDebugUnitTest`) |
| Native smart wake with the screen off, in Doze, app swiped away, process killed | Verified on an Android 35 emulator (synthetic accelerometer); wake-up-sensor path and a real night not verified |
| Real Android phone: motion, hard alarm, battery over a night | Not verified |
| Wear OS watch app and Data Layer link on a real watch | Not verified |
| Bluetooth heart rate with real watches or straps | Not verified |
| iOS | Not supported |

## License

Sleeping_Aid is **source-available**, not open source. It is licensed under
the PolyForm Strict License 1.0.0 with Additional Terms (see `LICENSE`):
attribution is required; modifications, derivative works and redistribution
are not permitted; commercial use is allowed only under a prior written
agreement with the licensor (including revenue share); all rights not granted
are reserved. For commercial licensing contact massini.christian@gmail.com.
The full terms are in the `LICENSE` file, which governs.
