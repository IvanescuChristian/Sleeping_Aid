// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NightSession } from '../../../src/app/night';
import { WakeLockHolder } from '../../../src/app/sensors';

const T0 = Date.UTC(2026, 10, 13, 23, 0, 0);
const END = T0 + 30 * 60_000;

class FakeSentinel extends EventTarget {
  released = 0;
  release(): Promise<void> {
    this.released++;
    return Promise.resolve();
  }
}

function installDom(wakeLock: unknown): void {
  const target = new EventTarget();
  vi.stubGlobal('document', Object.assign(target, { visibilityState: 'visible', documentElement: { dataset: {} } }));
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', { wakeLock });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WakeLockHolder', () => {
  it('does not use the Screen Wake Lock API on native Android', () => {
    const request = vi.fn();
    installDom({ request });
    const holder = new WakeLockHolder(() => true);
    holder.start();
    expect(request).not.toHaveBeenCalled();
    expect(holder.state).toBe('pending');
    holder.stop();
  });


  it('releases a sentinel that resolves after stop() and never reports held', async () => {
    const sentinel = new FakeSentinel();
    let resolve!: (s: FakeSentinel) => void;
    installDom({ request: () => new Promise<FakeSentinel>((r) => (resolve = r)) });
    const holder = new WakeLockHolder();
    holder.start();
    holder.stop();
    resolve(sentinel);
    await Promise.resolve();
    await Promise.resolve();
    expect(sentinel.released).toBe(1);
    expect(holder.state).not.toBe('held');
  });
});

function makeSession(onAlarm = vi.fn(), hr: { disconnect: () => void; onSample: unknown } | null = null) {
  const s = new NightSession({
    active: { windowStart: T0, windowEnd: END, startedAt: T0, useMotion: true, fired: null },
    // The session only touches onSample, disconnect and the read-only status fields of the monitor.
    hr: hr as never,
    onStatus: () => undefined,
    onAlarm,
  });
  return { s, onAlarm };
}

describe('NightSession', () => {
  it('keeps the wake lock while the alarm rings and releases it on release()', async () => {
    const sentinel = new FakeSentinel();
    installDom({ request: () => Promise.resolve(sentinel) });
    const hr = { disconnect: vi.fn(), onSample: null as unknown };
    const { s, onAlarm } = makeSession(vi.fn(), hr);
    vi.spyOn(s.motion, 'start').mockImplementation(() => undefined);
    await s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.wake.state).toBe('held');

    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(onAlarm).toHaveBeenCalledTimes(1);
    expect(sentinel.released).toBe(0);
    expect(hr.disconnect).not.toHaveBeenCalled();

    s.release();
    expect(sentinel.released).toBe(1);
    expect(hr.disconnect).toHaveBeenCalledTimes(1);
  });

  it('still fires the fallback when motion and wake-lock setup throw', async () => {
    installDom({
      request: () => {
        throw new Error('wake lock exploded');
      },
    });
    const { s, onAlarm } = makeSession();
    vi.spyOn(s.motion, 'start').mockImplementation(() => {
      throw new Error('motion exploded');
    });
    vi.spyOn(s.wake, 'start').mockImplementation(() => {
      throw new Error('wake exploded');
    });
    await s.start();
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(onAlarm).toHaveBeenCalledTimes(1);
    expect(onAlarm.mock.calls[0]?.[0].reason).toBe('fallback');
  });

  it('arms the scheduler before touching any sensor', async () => {
    installDom({ request: () => Promise.resolve(new FakeSentinel()) });
    const { s } = makeSession();
    const order: string[] = [];
    vi.spyOn(s.scheduler, 'start').mockImplementation(() => void order.push('scheduler'));
    vi.spyOn(s.wake, 'start').mockImplementation(() => void order.push('wake'));
    vi.spyOn(s.motion, 'start').mockImplementation(() => void order.push('motion'));
    await s.start();
    expect(order).toEqual(['scheduler', 'wake', 'motion']);
  });

  it('stop() disconnects the heart-rate device and releases the wake lock', async () => {
    const sentinel = new FakeSentinel();
    installDom({ request: () => Promise.resolve(sentinel) });
    const hr = { disconnect: vi.fn(), onSample: null as unknown };
    const { s } = makeSession(vi.fn(), hr);
    vi.spyOn(s.motion, 'start').mockImplementation(() => undefined);
    await s.start();
    await vi.advanceTimersByTimeAsync(0);
    s.stop();
    expect(hr.disconnect).toHaveBeenCalledTimes(1);
    expect(sentinel.released).toBe(1);
  });
});
