// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, defineConfig, devices } from '@playwright/test';

/**
 * Use the Chromium Playwright expects; if that build is not installed, fall back to the newest
 * Chromium already in the local browser cache (override with PW_CHROMIUM_PATH). Nothing is downloaded.
 */
function chromiumPath(): string | undefined {
  if (process.env.PW_CHROMIUM_PATH) return process.env.PW_CHROMIUM_PATH;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    /* fall through to the cache scan */
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const found = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map((d) => join(cache, d, 'chrome-linux64', 'chrome'))
    .find((p) => existsSync(p));
  return found;
}

const executablePath = chromiumPath();

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    timezoneId: 'UTC',
    locale: 'en-GB',
    serviceWorkers: 'allow',
    ...devices['Pixel 7'],
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
