#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
# Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
#
# Builds the Android apps: web build -> Capacitor sync -> Gradle (release and debug, phone and Wear OS watch)
# -> dist-android/.
#
# Needs: Node 24, JDK 21 (javac), and the Android SDK (platform 36, build-tools 36.x) found through
# ANDROID_HOME (or ANDROID_SDK_ROOT).
#
# Two APKs come out of one Gradle build: the phone app (module :app) and the Wear OS watch app (module :wear).
# They share applicationId and signing key on purpose: Wear OS only delivers Data Layer messages between
# apps that match on both. Install the watch APK on the watch (adb -s <watch> install) and the phone APK on
# the phone.
#
# Version: versionName is the "version" in package.json. versionCode is derived from it deterministically:
#   phone versionCode = MAJOR * 1000000 + MINOR * 1000 + PATCH   (0.1.0 -> 1000, 0.1.1 -> 1001, 1.0.0 -> 1000000)
#   watch versionCode = 100000000 + phone versionCode            (differs from the phone's; see android/sa-common.gradle)
# so both grow with every version bump (MINOR and PATCH must stay below 1000, MAJOR below 100). The formulas
# live in android/sa-common.gradle, which is the one Gradle uses.
#
# Release signing (optional): set all of SA_KEYSTORE_FILE, SA_KEYSTORE_PASSWORD, SA_KEY_ALIAS and
# SA_KEY_PASSWORD. Without them both release APKs are signed with the debug key and a warning is printed.
#
# Output in dist-android/ (each with a .sha256):
#   SleepingAid-<version>.apk               phone, release        SleepingAid-<version>-debug.apk        phone, debug
#   SleepingAid-Watch-<version>.apk         watch, release        SleepingAid-Watch-<version>-debug.apk  watch, debug
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  echo "error: set ANDROID_HOME to your Android SDK directory" >&2
  exit 1
fi
export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
command -v javac >/dev/null || { echo "error: a JDK 21 (javac) is required on PATH or JAVA_HOME" >&2; exit 1; }

VERSION="$(node -p "require('./package.json').version")"
echo "Building Sleeping Aid ${VERSION} (phone and watch)"

npm ci
npm run build
npx cap sync android

if [ -z "${SA_KEYSTORE_FILE:-}" ]; then
  echo "WARNING: no release keystore configured; the release APKs will be signed with the debug key." >&2
fi

(cd android && ./gradlew --no-daemon assembleRelease assembleDebug)

OUT=dist-android
rm -rf "$OUT"
mkdir -p "$OUT"
cp android/app/build/outputs/apk/release/app-release.apk "$OUT/SleepingAid-${VERSION}.apk"
cp android/app/build/outputs/apk/debug/app-debug.apk "$OUT/SleepingAid-${VERSION}-debug.apk"
cp android/wear/build/outputs/apk/release/wear-release.apk "$OUT/SleepingAid-Watch-${VERSION}.apk"
cp android/wear/build/outputs/apk/debug/wear-debug.apk "$OUT/SleepingAid-Watch-${VERSION}-debug.apk"
(cd "$OUT" && for f in *.apk; do sha256sum "$f" > "$f.sha256"; done)

echo
ls -l "$OUT"
cat "$OUT"/*.sha256
