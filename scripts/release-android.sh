#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
# Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
#
# Maintainer script: builds the release-signed phone and watch APKs locally and stages them for a GitHub Release.
# It never publishes anything; it prints the `gh` commands for you to run.
#
# Usage:  scripts/release-android.sh <path-to-signing-env-file>
#    or:  SA_SIGNING_ENV=<path-to-signing-env-file> scripts/release-android.sh
#
# The env file exports SA_KEYSTORE_FILE, SA_KEYSTORE_PASSWORD, SA_KEY_ALIAS and SA_KEY_PASSWORD. It lives with the
# keystore, outside this repository (see docs/SIGNING.md). Passwords are never printed.
#
# Checks before it stages anything: the phone and watch APKs carry the same signing certificate, and that
# certificate is not the Android debug certificate.
#
# Output: dist-android/release-<version>/SleepingAid-<version>-phone.apk, ...-watch.apk, SHA256SUMS.txt
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENV_FILE="${1:-${SA_SIGNING_ENV:-}}"
if [ -z "$ENV_FILE" ]; then
  echo "usage: scripts/release-android.sh <signing-env-file>   (or set SA_SIGNING_ENV)" >&2
  exit 2
fi
[ -f "$ENV_FILE" ] || { echo "error: signing env file not found" >&2; exit 2; }

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
for v in SA_KEYSTORE_FILE SA_KEYSTORE_PASSWORD SA_KEY_ALIAS SA_KEY_PASSWORD; do
  [ -n "${!v:-}" ] || { echo "error: $v is not set by the signing env file" >&2; exit 2; }
done
[ -f "$SA_KEYSTORE_FILE" ] || { echo "error: SA_KEYSTORE_FILE does not point to a file" >&2; exit 2; }

if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  echo "error: set ANDROID_HOME to your Android SDK directory" >&2
  exit 1
fi
export ANDROID_HOME="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"

VERSION="$(node -p "require('./package.json').version")"
scripts/build-android.sh

APKSIGNER="$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -n 1)"
cert() { "$APKSIGNER" verify --print-certs "$1" | grep -m1 'certificate SHA-256 digest:' | sed 's/.*digest: *//'; }

PHONE_SRC="dist-android/SleepingAid-${VERSION}.apk"
WATCH_SRC="dist-android/SleepingAid-Watch-${VERSION}.apk"
PHONE_CERT="$(cert "$PHONE_SRC")"
WATCH_CERT="$(cert "$WATCH_SRC")"
DEBUG_CERT="$(cert "dist-android/SleepingAid-${VERSION}-debug.apk")"

[ -n "$PHONE_CERT" ] && [ "$PHONE_CERT" = "$WATCH_CERT" ] || { echo "error: phone and watch APKs are not signed by one certificate" >&2; exit 1; }
[ "$PHONE_CERT" != "$DEBUG_CERT" ] || { echo "error: the release APKs are signed with the debug certificate" >&2; exit 1; }
# Also compare with the well-known Android debug key in ~/.android, when present.
if [ -f "$HOME/.android/debug.keystore" ] && command -v keytool >/dev/null; then
  KNOWN="$(keytool -list -v -keystore "$HOME/.android/debug.keystore" -storepass android 2>/dev/null | grep -m1 'SHA256:' | sed 's/.*SHA256: *//; s/://g' | tr 'A-F' 'a-f' || true)"
  [ -z "$KNOWN" ] || [ "$KNOWN" != "$PHONE_CERT" ] || { echo "error: the release APKs are signed with the Android debug key" >&2; exit 1; }
fi

OUT="dist-android/release-${VERSION}"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$PHONE_SRC" "$OUT/SleepingAid-${VERSION}-phone.apk"
cp "$WATCH_SRC" "$OUT/SleepingAid-${VERSION}-watch.apk"
(cd "$OUT" && sha256sum "SleepingAid-${VERSION}-phone.apk" "SleepingAid-${VERSION}-watch.apk" > SHA256SUMS.txt)

echo
echo "Signing certificate SHA-256 (phone == watch, not the debug key): $PHONE_CERT"
cat "$OUT/SHA256SUMS.txt"
cat <<MSG

Staged in $OUT. Nothing has been published. When the tag v${VERSION} exists on GitHub and CI is green, run:

  gh release create v${VERSION} --title "v${VERSION}" --notes-file <notes.md> \\
    "$OUT/SleepingAid-${VERSION}-phone.apk" "$OUT/SleepingAid-${VERSION}-watch.apk" "$OUT/SHA256SUMS.txt"

Or, if the release already exists, replace its files:

  gh release upload v${VERSION} --clobber \\
    "$OUT/SleepingAid-${VERSION}-phone.apk" "$OUT/SleepingAid-${VERSION}-watch.apk" "$OUT/SHA256SUMS.txt"
MSG
