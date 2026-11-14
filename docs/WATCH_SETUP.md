# Wear OS watch setup (Galaxy Watch4 Classic)

**NOT yet tested on a real Galaxy Watch4.** The watch app has been built and its protocol is unit-tested, but it has never run on a real watch. Expect problems and report them.

The watch app is only a sensor relay. It records heart rate and wrist motion at night and sends them to the phone app, which makes all decisions and rings the alarm. It does nothing useful without the phone app.

The watch app and the phone app have the same package name and must be signed with the same key. Install the phone and watch APKs from the same release (see SIGNING.md), and uninstall the previous version before installing a new one.

## Why a manual install

The watch app is not on Google Play, so it is installed over Wi-Fi debugging from a PC with Android platform-tools (`adb`). Menu names below are for One UI Watch on a Galaxy Watch4 Classic; where a path could not be confirmed it says "may differ by version".

## 1. Developer options on the watch

1. Settings > About watch > Software information.
2. Tap "Software version" several times until it says Developer mode is on (may differ by version).
3. Back in Settings, open Developer options (near the bottom; may differ by version).
4. Turn on ADB debugging.
5. Turn on Wireless debugging. Keep the watch on the same Wi-Fi network as the PC.

## 2. Pair and connect from the PC

Install Android platform-tools on the PC. Then:

1. On the watch: Developer options > Wireless debugging > Pair new device. The watch shows an IP address, a port and a six-digit pairing code.
2. On the PC: `adb pair <ip>:<pairing-port>` and enter the code.
3. Go back to the Wireless debugging screen. It shows a different IP:port for connecting. On the PC: `adb connect <ip>:<connect-port>`.
4. `adb devices` should list the watch.

## 3. Install the watch APK

```
adb install SleepingAid-<version>-watch-mvp-debugsigned.apk
```

If more than one device is connected, add `-s <ip>:<port>`. Check the file against `SHA256SUMS.txt` first (see ANDROID_INSTALL.md). Afterwards you can turn Wireless debugging and ADB debugging off again.

Install the phone APK on the phone as described in ANDROID_INSTALL.md.

## 4. Permissions on the watch

Open the Sleeping Aid app once on the watch. Allow when asked:

- Body sensors (heart rate), and "all the time" if offered, so the phone can start a night while the watch screen is off.
- Physical activity.
- Notifications.

If a prompt does not appear: Settings > Apps > Permissions > Sleeping Aid (may differ by version).

Also open the Sleeping Aid phone app once so the watch finds it.

## 5. How the phone starts tracking

1. In the phone app, the setup screen shows whether a watch with the watch app is connected, and a "Use Wear OS watch" checkbox (on by default).
2. When you start a night the phone sends a start message to the watch. The watch starts recording as a foreground service with an ongoing notification.
3. When the night ends or you stop it, the phone sends a stop message. The watch also stops itself after 14 hours.
4. If the watch stays silent for a few minutes, the phone switches to its own motion sensor.

## 6. If the watch does not start by itself

Android sometimes refuses to start a recording service from the background. The watch then shows a "tap to start" notification. Tap it and tracking starts. Wear the watch to bed after checking for this notification.

## Things to know

- Heart rate and motion reach the phone about 60 seconds late. The phone allows for this.
- Battery use of the watch over a full night is unknown. Start the night with a good charge and record the battery before and after (see NIGHT_TEST_CHECKLIST.md).
- Samsung Health may show a session while the watch records, because heart-rate recording uses an Android exercise session.
- The Samsung Health Sensor SDK is not used. It gives access to extra Samsung sensors, but it needs Samsung partner approval for normal use and otherwise only works in a developer mode that is unsuitable for a sideloaded app. The app uses the standard Wear OS Health Services and accelerometer instead.
- Wrist motion thresholds are not validated; stages from the watch may differ from stages from the phone.
