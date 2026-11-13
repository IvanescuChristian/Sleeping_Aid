// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlarmScheduler } from '../../../src/app/scheduler';
import type { AlarmDecision } from '../../../src/engine/smartAlarm';

const T0 = Date.UTC(2026, 10, 13, 23, 0, 0);
const END = T0 + 8 * 3_600_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

function make(onTick: (n: number) => AlarmDecision | null = () => null, onFire = vi.fn()) {
  const s = new AlarmScheduler({ windowEnd: END, onTick, onFire });
  s.start();
  return { s, onFire };
}

describe('AlarmScheduler', () => {
  it('fires the fallback at the window end, exactly once', () => {
    const { onFire } = make();
    vi.advanceTimersByTime(8 * 3_600_000 - 2000);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire.mock.calls[0]?.[0].reason).toBe('fallback');
    vi.advanceTimersByTime(3_600_000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('fires immediately on a late tick after the clock jumped past the end', () => {
    const { onFire } = make();
    vi.setSystemTime(END + 45 * 60_000); // timers were frozen, the wall clock moved on
    vi.advanceTimersByTime(1000); // the very next interval tick
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire.mock.calls[0]?.[0].at).toBeGreaterThanOrEqual(END);
  });

  it('fires on an explicit tick() (e.g. visibilitychange) without waiting for a timer', () => {
    const { s, onFire } = make();
    vi.setSystemTime(END + 1);
    s.tick();
    s.tick();
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('keeps going and still fires the fallback when the pipeline throws', () => {
    const onTick = vi.fn(() => {
      throw new Error('boom');
    });
    const { s, onFire } = make(onTick);
    vi.advanceTimersByTime(60_000);
    expect(onTick.mock.calls.length).toBeGreaterThan(30);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8 * 3_600_000);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire.mock.calls[0]?.[0].reason).toBe('fallback');
    expect(s.tickErrors).toBeGreaterThan(0);
  });

  it('passes through a smart decision before the end and then stops ticking', () => {
    let calls = 0;
    const onTick = (now: number): AlarmDecision | null => (++calls === 5 ? { reason: 'smart', at: now, stageAtTrigger: 'light' } : null);
    const { onFire } = make(onTick);
    vi.advanceTimersByTime(30_000);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire.mock.calls[0]?.[0].reason).toBe('smart');
    expect(calls).toBe(5);
    vi.advanceTimersByTime(9 * 3_600_000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('does not refire when onFire itself throws, and UI errors do not stop ticks', () => {
    const status = vi.fn(() => {
      throw new Error('ui');
    });
    const onFire = vi.fn(() => {
      throw new Error('ring');
    });
    const s = new AlarmScheduler({ windowEnd: END, onTick: () => null, onFire, onStatus: status });
    s.start();
    vi.advanceTimersByTime(10_000);
    expect(status.mock.calls.length).toBeGreaterThan(5);
    vi.advanceTimersByTime(9 * 3_600_000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('fires at once when started after the window end (resumed night)', () => {
    vi.setSystemTime(END + 10 * 60_000);
    const { onFire } = make();
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
