# Upgrading Sleeping Aid on Android

## The one last uninstall

Moving from the debug-signed 0.1.0 or 0.1.1 to 0.1.2 requires ONE last uninstall (phone and watch). From 0.1.2 on, new versions install over the top and keep your data.

Why: 0.1.0 and 0.1.1 were signed with a throwaway debug key. Android refuses to install an app over a copy signed with a different key, and reports `INSTALL_FAILED_UPDATE_INCOMPATIBLE` or "App not installed as package conflicts with an existing package". From 0.1.2 on every release is signed with one permanent release key, so this cannot happen again.

## Steps for 0.1.0 or 0.1.1 users

1. Optional: open the app and note anything you want to keep. Uninstalling deletes the night history, which only lives on the phone.
2. Uninstall Sleeping Aid on the phone (Settings > Apps > Sleeping Aid > Uninstall) and on the watch (`adb uninstall io.github.ivanescuchristian.sleepingaid` with the watch connected, see WATCH_SETUP.md).
3. Install the 0.1.2 phone APK and the 0.1.2 watch APK from the same release (ANDROID_INSTALL.md, WATCH_SETUP.md).
4. Grant the permissions again (they are cleared by the uninstall) and start a night as usual.

## Steps from 0.1.2 on

Just install the new APK over the old one: open it on the phone, or `adb install -r <file>` for phone and watch. Settings and night history are kept. Install the phone and watch APKs from the same release. Do not uninstall first; that would delete your data for no reason.

## Who holds the key

The release key is kept by the maintainer, outside this repository and outside GitHub. Releases are signed on the maintainer's machine and uploaded by hand. If that key is lost, no release can install over existing copies again and everyone would have to uninstall once more, so the maintainer keeps backups. See SIGNING.md.
