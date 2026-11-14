# Real-device night test checklist

Nothing in the Android or watch apps has yet been run over a real night. This checklist is how to find out. Do the nap test first, then one full night, and write down the numbers as you go. Keep your normal phone alarm as a backup for the whole test.

## Before you start

- [ ] Installed per ANDROID_INSTALL.md; notifications, exact alarms, full-screen notifications granted; battery set to "Unrestricted".
- [ ] Watch (the primary sensor, wear it all night): installed per WATCH_SETUP.md, permissions granted, watch charged. The setup screen says it is connected and "Use Wear OS watch" is checked.
- [ ] Record: app version, phone model and Android version, watch model.
- [ ] Record phone battery % at start. Record watch battery % at start.
- [ ] Note whether the phone is on the charger or not. Do the first test on the charger, and a later night off the charger to measure drain.

## Test 1: 20-minute nap (do this first)

1. Set a wake window of 20 minutes, starting a few minutes from now (the minimum window length is 20 minutes).
2. Start the night. Press the power button to turn the screen off and swipe the app away from recent apps. Put it on the mattress.
3. Lie down in the dark. The window is too short to learn much about sleep; the goal is the alarm path.
4. Check:
   - [ ] The alarm rang at or before the window end with the phone locked and the screen off.
   - [ ] The alarm screen appeared over the lock screen, with sound and vibration.
   - [ ] Stop and snooze both work.
   - [ ] The notification on the phone while tracking was visible.
5. Record the time the alarm fired and whether it was a smart wake (before the window end) or the window end. The alarm screen and the summary say which.

Repeat once with the phone in Doze: start the night, leave the phone untouched and screen off for at least 30 minutes before the window end.

## Test 2: full night

1. Choose a normal window (for example 30 minutes before your usual wake time). Start the night, let the screen turn off and leave the phone alone.
2. Phone on the charger for the first full night.
   - [ ] Smart wake rang inside the window with the screen off (note the time and the stage the summary reports).
   - [ ] The hypnogram covers the whole night, not only the last minutes.
   - [ ] Optional second night: unplugged, to measure battery drain and whether Android paused tracking in Doze.
   - [ ] Optional: tick "Keep the screen on" on the setup screen and compare.
3. In the morning, before touching anything, note the time the alarm rang.

Check and record:

- [ ] Alarm sound at the window end with the phone locked and in Doze (rang on time? how late?).
- [ ] Smart-wake firing time compared with the window (start, end, actual).
- [ ] Phone battery % at end, and the drop over the night. Phone on charger or not.
- [ ] Did the night service notification stay all night?
- [ ] Watch connection status during the night, shown in the app, and whether the watch's tracking notification was still there in the morning.
- [ ] Watch battery % at end and the drop.
- [ ] Did the app show "Source: Watch" the whole night, or "Source: Phone fallback"? When, and for how long? The summary lists the share per source.
- [ ] Optional watch-first checks: with the app open, take the watch off Bluetooth range (or switch its Bluetooth off) for about 5 minutes and confirm the status moves to "Phone fallback" after about 2.5 minutes, then bring it back and confirm the status returns to "Watch" within about 1.5 minutes.
- [ ] Did a gap in the hypnogram match a watch dropout? Did any epoch look wrong right after a source change?
- [ ] Phone sensor fallback: was the phone on the mattress, and did it cover the night when the watch was silent?
- [ ] Any unexpected notifications, restarts, or the app being closed by Android.
- [ ] Optionally compare against the sleep stages from the watch's own app.

## What to send back

- Version, device models, Android and Wear OS versions.
- Window start and end, time the alarm actually fired, smart or fallback.
- Battery start and end for phone and watch, charger yes or no.
- Anything that looked wrong, with the time it happened, and a screenshot of the summary screen.
- Whether you had to rely on your backup alarm.

Do not send anything you do not want shared: night summaries contain your sleep times.
