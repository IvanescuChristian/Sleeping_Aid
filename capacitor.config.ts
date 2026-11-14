// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.github.ivanescuchristian.sleepingaid',
  appName: 'Sleeping Aid',
  // Vite build output; `npm run build` must run before `npx cap sync android`.
  webDir: 'dist',
  android: {
    // Sideloaded APK only: no web-content debugging in release builds.
    webContentsDebuggingEnabled: false,
  },
};

export default config;
