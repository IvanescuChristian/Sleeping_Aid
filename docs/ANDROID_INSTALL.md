# Installing Sleeping Aid on Android

Sleeping Aid for Android is installed from an APK file (sideloading). It is not on Google Play. These steps are written for Samsung phones with One UI; other phones are similar but the menu names differ.

Status: the app is built and unit-tested. It has not yet been used for a full night on a real phone. Treat the first nights as a test and keep your normal alarm as a backup.

## 1. Download

1. On the phone, open the project's GitHub Releases page and pick the newest release.
2. Download `SleepingAid-<version>-phone-mvp-debugsigned.apk` (the phone app). You do not need the `watch` file unless you also have a Wear OS watch (see WATCH_SETUP.md); if you do, install both from the same release.
3. Also download `SHA256SUMS.txt`.

## 2. Check the download (recommended)

The checksum file lists a SHA-256 value for each APK. Compare it with the file you downloaded:

- On a PC: `sha256sum SleepingAid-<version>-phone-mvp-debugsigned.apk` (Linux, macOS) or `certutil -hashfile SleepingAid-<version>-phone-mvp-debugsigned.apk SHA256` (Windows). The value must equal the line in `SHA256SUMS.txt`.
- On the phone, any file-hash app can do the same. If the values differ, delete the file and download again.

## 3. Allow installing from your browser or Files app

1. Open the downloaded file (Chrome downloads, or My Files > Downloads).
2. Android says it is blocked for security. Tap Settings, then turn on "Allow from this source" for the app you opened the file with (Chrome, Samsung Internet or My Files).
3. Go back and tap Install.

On One UI the same switch lives under Settings > Apps > Special access > Install unknown apps. You can turn it off again after installing.

## 4. Play Protect

Google Play Protect may show "App not scanned" or "Blocked by Play Protect". The app is not signed through Google Play, so this is expected. Tap "More details" then "Install anyway" (or "Scan app" first if you prefer). Do not turn Play Protect off.

## 5. Permissions after install

Open the app once, then set these. The night will not start without exact alarms.

1. Notifications: allow when asked. Without it the alarm still rings, but its on-screen buttons may not appear. (Settings > Apps > Sleeping Aid > Notifications.)
2. Alarms & reminders (exact alarms): Settings > Apps > Special access > Alarms & reminders > Sleeping Aid on. The app also opens this screen for you when it is missing.
3. Full-screen notifications (Android 14 and newer): Settings > Apps > Sleeping Aid > Notifications > Full screen notifications on, so the alarm screen can appear over the lock screen. Menu names may differ by version.
4. Battery, the important one on Samsung (see next section).

## 6. Battery settings (Samsung One UI)

Samsung stops background apps aggressively. The hard alarm at the window end is a system alarm clock and is not affected, but the smart wake (waking you early, in light sleep) runs in the night tracking service, which must be allowed to keep running all night. The screen and the app do not have to stay on.

1. Settings > Apps > Sleeping Aid > Battery > choose "Unrestricted".
2. Settings > Battery > Background usage limits (names vary by version):
   - turn off "Put unused apps to sleep" or add Sleeping Aid to "Never sleeping apps";
   - make sure Sleeping Aid is not in "Sleeping apps" or "Deep sleeping apps".
3. Swiping the app away from recent apps is fine: the night service keeps tracking. Do not use Force stop: a force-stopped app cannot ring.

## 7. Your first night

1. Run the 20-minute nap test from NIGHT_TEST_CHECKLIST.md before a real night.
2. In the evening choose the wake window (for example 06:30 to 07:00) and tap Start night.
3. Put the phone on the mattress next to you (on the charger is best) and let the screen turn off. Smart wake runs natively, with the screen off and the app closed. Keeping the screen on is an optional checkbox on the setup screen. Set your normal phone alarm as a backup for a little after the window end.
4. In the morning the alarm rings at the first light-sleep moment in the window, or at the window end at the latest, with the screen off and the phone locked. After a reboot the backup alarm is re-armed and tracking restarts if Android allows it; otherwise tap the "Tap to resume night tracking" notification. Dismiss or snooze the alarm on the alarm screen; the night summary appears when you open the app.
5. If you have not granted exact alarms, the app tells you it is not armed and refuses to start the night. That is intended.

## Updating

This MVP release is signed with a debug key and has no update path. A later version may not install over it. Uninstall the previous version before installing a new one; this deletes the app's data. Install the phone and watch APKs from the same release. See SIGNING.md.

## Uninstalling

Settings > Apps > Sleeping Aid > Uninstall. This deletes the night history, which only ever lived on the phone. Use "Delete all data" in the app first if you only want to clear history.
