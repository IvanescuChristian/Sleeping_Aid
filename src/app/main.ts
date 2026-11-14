// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import './style.css';
import { mountApp } from './app';
import { isNativeAndroid } from '../native/plugin';

const root = document.getElementById('app');
if (root) mountApp(root);

// WHY: inside the Android app the files are already bundled in the APK. A service worker would only add a second
// cache that could keep serving an old version of the app after an update. The web app keeps its offline worker.
if (import.meta.env.PROD && 'serviceWorker' in navigator && !isNativeAndroid()) {
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}
