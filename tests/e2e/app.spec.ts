// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { expect, test, type Page } from '@playwright/test';

const EVENING = new Date('2026-11-13T23:00:00Z');
const HOUR = 3_600_000;

async function open(page: Page): Promise<void> {
  await page.clock.install({ time: EVENING });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sleeping Aid' })).toBeVisible();
}

async function startPlainNight(page: Page): Promise<void> {
  await page.locator('#win-start').fill('06:30');
  await page.locator('#win-end').fill('07:00');
  await page.locator('#use-motion').uncheck();
  await page.locator('#start-night').click();
  await expect(page.locator('#stage')).toBeVisible();
}

const fires = (page: Page) => page.evaluate(() => document.documentElement.dataset.alarmFires ?? '0');

test('setup rejects a 10-minute window with the engine error text', async ({ page }) => {
  await open(page);
  await page.locator('#win-start').fill('06:30');
  await page.locator('#win-end').fill('06:40');
  await expect(page.locator('#win-error')).toHaveText('Wake window must be at least 20 minutes');
  await page.locator('#start-night').click();
  await expect(page.locator('#stage')).toHaveCount(0);
  await page.locator('#win-end').fill('07:00');
  await expect(page.locator('#win-error')).toHaveText('');
  await expect(page.locator('#reliability-note')).toContainText("set your phone's regular alarm");
});

test('a night without sensors rings the fallback alarm once after the window end', async ({ page }) => {
  await open(page);
  await startPlainNight(page);
  await expect(page.locator('#hr-status')).toHaveText('no HR');
  await page.clock.fastForward(8 * HOUR + 60_000); // jumps past 07:00; the late tick must still fire
  await expect(page.locator('#alarm-reason')).toContainText('Fallback');
  await page.clock.runFor(10_000);
  await expect(page.locator('#alarm-reason')).toHaveCount(1);
  expect(await fires(page)).toBe('1');
});

test('reloading mid-night resumes the night and fires after the end', async ({ page }) => {
  await open(page);
  await startPlainNight(page);
  await page.clock.runFor(60_000);
  await page.reload();
  await expect(page.locator('#stage')).toBeVisible();
  await expect(page.locator('.banner.info')).toContainText('resumed');
  await page.clock.fastForward(8 * HOUR + 60_000);
  await expect(page.locator('#alarm-reason')).toContainText('Fallback');
  expect(await fires(page)).toBe('1');
});

test('reloading after the window end fires immediately', async ({ page }) => {
  await open(page);
  await startPlainNight(page);
  await page.evaluate(() => {
    const k = 'sleepingaid.active.v1';
    const a = JSON.parse(localStorage.getItem(k) ?? '{}');
    a.windowEnd = Date.now() - 5000;
    a.windowStart = a.windowEnd - 30 * 60_000;
    localStorage.setItem(k, JSON.stringify(a));
  });
  await page.reload();
  await expect(page.locator('#alarm-reason')).toContainText('Fallback');
  expect(await fires(page)).toBe('1');
});

test('demo night reaches an alarm, draws the hypnogram and is stored in history', async ({ page }) => {
  await open(page);
  await page.locator('#demo-night').click();
  await expect(page.locator('#stage')).toBeVisible();
  await page.clock.runFor(15_000);
  await expect(page.locator('#alarm-reason')).toContainText(/Smart wake|Fallback/);
  await page.locator('#dismiss').click();
  await expect(page.locator('#score')).toBeVisible();
  expect(await page.locator('svg.hypnogram rect').count()).toBeGreaterThan(20);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sleepingaid.history.v1') ?? '[]'));
  expect(stored).toHaveLength(1);
  expect(stored[0].demo).toBe(true);
  expect(stored[0].summary.hypnogram.length).toBeLessThan(150);
  // Only summaries and a downsampled hypnogram: no raw sensor arrays anywhere in storage.
  const dump = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  expect(dump).not.toMatch(/"ax"|"bpm"/);
  await expect(page.locator('#history-list li')).toHaveCount(1);
});

test('delete all data clears the history', async ({ page }) => {
  await open(page);
  await page.locator('#demo-night').click();
  await page.clock.runFor(15_000);
  await page.locator('#dismiss').click();
  await expect(page.locator('#history-list li')).toHaveCount(1);
  await page.locator('#delete-all').click();
  await page.locator('#delete-confirm').click();
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#history-list li')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('sleepingaid.history.v1'))).toBeNull();
});

test('the Bluetooth button is disabled with an explanation when Web Bluetooth is absent', async ({ page }) => {
  await page.addInitScript(() => {
    delete (Navigator.prototype as unknown as Record<string, unknown>).bluetooth;
  });
  await open(page);
  await expect(page.locator('#connect-hr')).toBeDisabled();
  await expect(page.locator('#hr-note')).toContainText('Web Bluetooth');
});

test('the Bluetooth button is enabled when Web Bluetooth exists', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'bluetooth', { value: { requestDevice: () => Promise.reject(new Error('cancelled')) }, configurable: true });
  });
  await open(page);
  await expect(page.locator('#connect-hr')).toBeEnabled();
  await page.locator('#connect-hr').click();
  await expect(page.locator('#hr-note')).toContainText('cancelled');
});

test('manifest is linked and the service worker caches the shell for offline use', async ({ page, context }) => {
  await page.goto('/');
  const ready = await page.evaluate(async () => !!(await navigator.serviceWorker.ready).active);
  expect(ready).toBe(true);
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  const res = await page.request.get(new URL(href ?? '', page.url()).toString());
  const manifest = await res.json();
  expect(manifest.name).toBe('Sleeping Aid');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
  await page.reload(); // now controlled by the worker
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sleeping Aid' })).toBeVisible();
  await context.setOffline(false);
});

test('the screen wake lock stays held while the alarm rings and is released on Dismiss', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __wl: { requests: number; released: number } };
    w.__wl = { requests: 0, released: 0 };
    Object.defineProperty(Navigator.prototype, 'wakeLock', {
      configurable: true,
      value: {
        request: () => {
          w.__wl.requests++;
          const s = new EventTarget() as EventTarget & { release(): Promise<void> };
          s.release = () => {
            w.__wl.released++;
            return Promise.resolve();
          };
          return Promise.resolve(s);
        },
      },
    });
  });
  await open(page);
  await startPlainNight(page);
  const wl = () => page.evaluate(() => (window as unknown as { __wl: { requests: number; released: number } }).__wl);
  expect((await wl()).requests).toBeGreaterThan(0);
  await page.clock.fastForward(8 * HOUR + 60_000);
  await expect(page.locator('#alarm-reason')).toContainText('Fallback');
  await page.clock.runFor(5_000);
  expect((await wl()).released).toBe(0);
  await page.locator('#dismiss').click();
  expect((await wl()).released).toBeGreaterThan(0);
});
