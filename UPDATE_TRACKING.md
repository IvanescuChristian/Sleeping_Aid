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
