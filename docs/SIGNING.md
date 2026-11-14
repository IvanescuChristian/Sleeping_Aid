# Signing the Android apps

Status: MVP. The phone and watch APKs are signed with the Android **debug key**, which the build tools generate automatically. There is no release keystore, no update path and no signing secrets in GitHub.

## What this means for you

- Release assets are named `SleepingAid-<version>-phone-mvp-debugsigned.apk` and `SleepingAid-<version>-watch-mvp-debugsigned.apk`, with a combined `SHA256SUMS.txt`.
- A debug key is not protected: anyone could build a lookalike app signed the same way. Check the SHA-256 value against the release page and only download from this project's Releases.
- A future version may not install over this one. Uninstall the old version first; that deletes the app's data.
- Install the phone and watch APKs from the same release.

## Why phone and watch still match

The phone and watch apps share a package name. The Wear OS Data Layer only delivers messages between two apps with the same package name and the same signing key. CI builds both APKs in one job, so both get the same auto-generated debug key, and the workflow fails the build if the two release APKs carry different certificate digests.

## Releasing

1. Bump `version` in `package.json` (the versionCode is derived from it, see ARCHITECTURE.md).
2. Tag `v<version>` and push the tag. The tag must equal `v` plus the `package.json` version.
3. The workflow tests, builds both APKs, checks they share one certificate, and publishes the two APKs and `SHA256SUMS.txt` to a GitHub Release. The release notes say it is an MVP debug-signed build.

## If you later want stable signing

`android/sa-common.gradle` still honours four environment variables for local builds: `SA_KEYSTORE_FILE`, `SA_KEYSTORE_PASSWORD`, `SA_KEY_ALIAS` and `SA_KEY_PASSWORD`. Set all four and the release APKs are signed with that keystore; set none and they use the debug key; a partial set fails the build on purpose. Create a keystore with `keytool -genkeypair` outside the repository (keystore files are ignored by git, never commit one) and keep a private backup: losing the key means installs can never be updated. The CI workflow does not use these variables.
