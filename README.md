# Sleeping_Aid

Sleeping_Aid is an installable web app (PWA) that wakes you with a smart alarm.
You choose a wake window, for example 06:30 to 07:00. During the night the app
estimates your sleep stage from the phone's motion sensor (lying on the mattress)
and, optionally, a Bluetooth heart-rate sensor. It rings the alarm at the first
moment inside the window when you are in light sleep, and at the window end at
the latest.

Status: working MVP (version 0.1.0), Android Chrome first. Read the status table
and the reliability limits below before relying on it for something important.

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

- Android with Chrome (or an installed Chrome PWA) is the target. iOS is not
  supported for live nights: iOS suspends JavaScript when the screen is off, so
  the alarm could not run.
- The web platform cannot schedule a reliable alarm in the background. Keep the
  phone charging and the app open on screen. The app holds a Screen Wake Lock
  and warns you if it is lost.
- As a fail-safe, also set your phone's regular alarm for the window end.
- If the page reloads during the night, the night resumes from the stored window
  and still fires, but sensor history from before the reload is lost, and sound
  may need one tap to be allowed by the browser.
- Do not rely on this app alone for flights, exams or shifts.

## Which watches can feed heart rate

The app reads the standard Bluetooth Low Energy Heart Rate Service (Web
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

All data stays on your device in browser localStorage. There is no network
traffic, no account and no analytics. Only night summaries and a coarse
hypnogram are stored; raw sensor streams are never saved. "Delete all data" on
the summary screen removes everything.

## Install, run, build, test

Requires Node 24.

```
npm install
npm run dev          # development server
npm run build        # production build into dist/
npm run preview      # serve the production build (http://localhost:4173)
npm test             # unit tests (engine, simulation, app logic)
npm run typecheck
npm run test:e2e     # Playwright end-to-end tests against the preview build
```

The end-to-end tests need a Chromium. They use Playwright's own build if
installed, otherwise the newest Chromium found in the local Playwright cache, or
the path in `PW_CHROMIUM_PATH`. On a machine without a display run them under a
virtual display.

To install on a phone, open the served app in Chrome on Android over HTTPS and
choose "Install app" (Web Bluetooth, Wake Lock and service workers need HTTPS or
localhost).

## Status

| Area | Status |
| --- | --- |
| Engine unit tests (staging, alarm, summary, suggestions) | Verified (synthetic data) |
| Alarm scheduler: late tick, fire once, pipeline errors | Verified (unit and browser tests, fake timers) |
| Setup validation, fallback alarm, reload resume, demo, history, delete | Verified (Playwright, desktop Chromium emulating a phone) |
| Offline service worker and manifest | Verified (Playwright) |
| Stage accuracy on real sleepers | Not verified |
| Real Android phone: motion, Wake Lock, audio over a night | Not verified |
| Bluetooth heart rate with real watches or straps | Not verified |
| iOS | Not supported |

## License

Sleeping_Aid is **source-available**, not open source. It is licensed under
the PolyForm Strict License 1.0.0 with Additional Terms (see `LICENSE`):
attribution is required; modifications, derivative works and redistribution
are not permitted; commercial use is allowed only under a prior written
agreement with the licensor (including revenue share); all rights not granted
are reserved. For commercial licensing contact christian.ivanescu@isoskills.fi.
The full terms are in the `LICENSE` file, which governs.
