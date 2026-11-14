# Signing the Android apps

Status: from 0.1.2 on, the phone and watch APKs of every release are signed with one permanent release key, so new versions install over old ones and keep your data. Versions 0.1.0 and 0.1.1 were signed with the Android debug key; moving from them to 0.1.2 needs ONE last uninstall (phone and watch), see UPGRADING.md.

## What this means for you

- Release assets are named `SleepingAid-<version>-phone.apk` and `SleepingAid-<version>-watch.apk`, with a combined `SHA256SUMS.txt`.
- From 0.1.2 on, install a new version over the top. Android only accepts an update signed by the same key, so a lookalike app signed by someone else cannot replace yours.
- Check the SHA-256 value against the release page and only download from this project's Releases.
- Install the phone and watch APKs from the same release.

## Why phone and watch must match

The phone and watch apps share a package name. The Wear OS Data Layer only delivers messages between two apps with the same package name and the same signing key. Both modules are signed from the same settings in `android/sa-common.gradle`. CI fails the build if the two APKs carry different certificate digests, and `scripts/release-android.sh` checks the same thing, and that the certificate is not the debug certificate, before it stages a release.

## Where the key lives

The release key is kept by the maintainer, outside this repository and outside GitHub (it is not a CI secret). Keystore files are ignored by git and must never be committed. Losing the key breaks updates: no later release could install over an existing copy, and every user would have to uninstall once more. The maintainer keeps private backups.

## Releasing (maintainer)

1. Bump `version` in `package.json` (the versionCode is derived from it, see ARCHITECTURE.md) and merge.
2. Tag `v<version>` and push the tag. CI runs the tests, a debug-signed check build and the tag-equals-version check. CI publishes nothing.
3. On the maintainer's machine run `scripts/release-android.sh <signing-env-file>` (or set `SA_SIGNING_ENV`). The env file exports `SA_KEYSTORE_FILE`, `SA_KEYSTORE_PASSWORD`, `SA_KEY_ALIAS` and `SA_KEY_PASSWORD`. The script builds the signed release APKs, verifies both carry the same certificate and not the debug one, and writes `SleepingAid-<version>-phone.apk`, `SleepingAid-<version>-watch.apk` and `SHA256SUMS.txt` to `dist-android/release-<version>/`.
4. The script prints the `gh release create` (or `gh release upload`) command; run it yourself.

## Local builds

`scripts/build-android.sh` without the four variables signs the release APKs with the debug key and prints a warning; with all four set it uses that key; a partial set fails the build on purpose.
