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

- `main.ts` entry and service worker registration; `app.ts` screens and navigation (setup, night, alarm, summary).
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
- The Screen Wake Lock is re-acquired on `visibilitychange`; a banner shows when it is unavailable or lost.
- Limits that code cannot remove: the OS may kill the browser, the battery may die, iOS suspends JavaScript with the screen off. Hence the instruction to set a regular system alarm too.

## Battery considerations

One timer per second, no animation or render loops while the screen is static, motion samples limited to 10 Hz, tiny epoch state, no network, near-black night screen. Keep the phone charging: the screen stays on all night.

## Research summary

- A sleep cycle is about 90 minutes (range roughly 70 to 120), which drives bedtime suggestions.
- Commercial smart alarms typically use windows of about 30 minutes.
- Watch sleep stages reach apps via Health Connect or HealthKit only after the night, so live staging must be estimated from raw streams.
- Web Bluetooth with the standard Heart Rate Service works in Chrome on Android, not on iOS.
- Screen Wake Lock is released when the page is hidden and must be re-acquired.
- The Notification Triggers API, which would have allowed scheduled notifications from a web app, was discontinued.
- iOS suspends JavaScript when the screen is off.

## Future work

- A native Android app using `AlarmManager.setAlarmClock` for a system-grade alarm.
- On-watch estimator for Wear OS or the Samsung Health Sensor SDK, so the phone is not needed on the mattress.
- Health Connect after-night import to compare estimates with the watch's own stages and calibrate thresholds.
- Calibration on real nights, and an optional cloud-free export of history.
