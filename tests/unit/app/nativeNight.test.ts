// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeNightSession } from '../../../src/app/nativeNight';
import type { NightStatus } from '../../../src/app/night';
import type { StoredAlarm } from '../../../src/app/storage';
import type { NativeAlarm } from '../../../src/native/nativeAlarm';
import type { NightEpoch, NightStatus as NativeStatus } from '../../../src/native/plugin';

const START = Date.UTC(2026, 10, 13, 23, 0, 0);
const WS = START + 7 * 3_600_000;
const WE = WS + 30 * 60_000;
const ACTIVE = { windowStart: WS, windowEnd: WE, startedAt: START, useMotion: true, fired: null };

function installDom(): void {
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('window', new EventTarget());
}

function epochs(n: number): NightEpoch[] {
  return Array.from({ length: n }, (_, i) => ({ start: START + i * 30_000, stage: i % 2 ? 'light' : 'deep', confidence: 0.7 }));
}

function setup(statuses: Array<NativeStatus | null>, eps: NightEpoch[] = epochs(40), now = () => START) {
  let i = 0;
  const api = {
    status: vi.fn(async () => statuses[Math.min(i++, statuses.length - 1)] ?? null),
    epochs: vi.fn(async () => eps),
    resumeTracking: vi.fn(async () => undefined),
  } as unknown as NativeAlarm & { status: ReturnType<typeof vi.fn>; epochs: ReturnType<typeof vi.fn>; resumeTracking: ReturnType<typeof vi.fn> };
  const onStatus = vi.fn<(s: NightStatus) => void>();
  const onAlarm = vi.fn<(a: StoredAlarm) => void>();
  const s = new NativeNightSession({ active: ACTIVE, useWatch: false, api, onStatus, onAlarm, now });
  return { s, api, onStatus, onAlarm };
}

beforeEach(() => {
  vi.useFakeTimers();
  installDom();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('NativeNightSession', () => {
  it('shows the engine status and fires nothing by itself, not even at the window end', async () => {
    const { s, onStatus, onAlarm } = setup([{ state: 'tracking', stage: 'light', motionSource: 'phone', motionHz: 10, hrBpm: 57 }], epochs(5), () => START);
    await s.start();
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ stage: 'light', motionHz: 10, hrBpm: 57, motionState: 'ok', wakeLock: 'held' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(onAlarm).not.toHaveBeenCalled();
    s.shutdown();
  });

  it('reports the engine decision once, then stops polling, and stores the summary', async () => {
    const wake = { reason: 'smart' as const, at: WS + 5 * 60_000, stage: 'light' };
    const { s, api, onAlarm } = setup([{ state: 'tracking', stage: 'light' }, { state: 'woke', stage: 'light', wake }]);
    await s.start();
    await vi.advanceTimersByTimeAsync(1200);
    expect(onAlarm).toHaveBeenCalledTimes(1);
    expect(onAlarm).toHaveBeenCalledWith({ reason: 'smart', at: wake.at, stage: 'light' });
    expect(s.saved?.alarm?.reason).toBe('smart');
    const calls = api.status.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.status.mock.calls.length).toBe(calls);
  });

  it('treats "no native record" after the window end as the backup alarm having rung', async () => {
    const { s, onAlarm } = setup([{ state: 'none' }], epochs(3), () => WE + 1000);
    await s.start();
    expect(onAlarm).toHaveBeenCalledWith({ reason: 'fallback', at: WE, stage: 'unknown' });
  });

  it('does not invent a wake while the window is still ahead', async () => {
    const { s, onAlarm } = setup([{ state: 'none' }], epochs(3), () => WS);
    await s.start();
    expect(onAlarm).not.toHaveBeenCalled();
    s.shutdown();
  });

  it('asks the engine to resume when it is recorded but not running, at most every 20 s', async () => {
    let now = START;
    const { s, api } = setup([{ state: 'tracking', needsResume: true }], epochs(3), () => now);
    await s.start();
    expect(api.resumeTracking).toHaveBeenCalledTimes(1);
    expect(api.resumeTracking).toHaveBeenCalledWith({ windowStart: WS, windowEnd: WE, startedAt: START, useMotion: true, useWatch: false });
    now += 5000;
    await s.poll();
    expect(api.resumeTracking).toHaveBeenCalledTimes(1);
    now += 20_000;
    await s.poll();
    expect(api.resumeTracking).toHaveBeenCalledTimes(2);
    s.shutdown();
  });

  it('stop() summarises the epochs and ends polling', async () => {
    const { s } = setup([{ state: 'tracking' }]);
    await s.start();
    const saved = await s.stop();
    expect(saved?.alarm).toBeNull();
    expect(saved?.demo).toBe(false);
  });

  it('too little data is not stored', async () => {
    const { s } = setup([{ state: 'tracking' }], epochs(5));
    await s.start();
    expect(await s.stop()).toBeNull();
  });

  it('survives a failing plugin (status null) without firing', async () => {
    const { s, onAlarm, onStatus } = setup([null]);
    await s.start();
    expect(onAlarm).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
    s.shutdown();
  });
});
