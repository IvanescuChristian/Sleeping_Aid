// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { describe, expect, it, vi } from 'vitest';
import { createNativeAlarm } from '../../../src/native/nativeAlarm';
import { isNativeAndroid, type AlarmPermissions, type SleepAidNativePlugin } from '../../../src/native/plugin';

const ALL_OK: AlarmPermissions = { exactAlarm: true, notifications: true, fullScreenIntent: true };
const END = Date.UTC(2026, 10, 14, 7, 0, 0);
const NIGHT = { windowStart: END - 30 * 60_000, windowEnd: END, startedAt: END - 8 * 3_600_000, useMotion: true, useWatch: false };

function mockPlugin(over: Partial<SleepAidNativePlugin> = {}): { [K in keyof SleepAidNativePlugin]: ReturnType<typeof vi.fn> } & SleepAidNativePlugin {
  return {
    scheduleHardAlarm: vi.fn().mockResolvedValue({ result: 'scheduled' }),
    cancelHardAlarm: vi.fn().mockResolvedValue(undefined),
    triggerWakeNow: vi.fn().mockResolvedValue({ result: 'rang' }),
    getAlarmPermissions: vi.fn().mockResolvedValue(ALL_OK),
    openExactAlarmSettings: vi.fn().mockResolvedValue(undefined),
    openFullScreenIntentSettings: vi.fn().mockResolvedValue(undefined),
    requestNotificationPermission: vi.fn().mockResolvedValue(ALL_OK),
    startNightService: vi.fn().mockResolvedValue({ started: true, state: 'tracking' }),
    stopNightService: vi.fn().mockResolvedValue(undefined),
    clearNight: vi.fn().mockResolvedValue(undefined),
    getNightStatus: vi.fn().mockResolvedValue({ state: 'tracking' }),
    getNightEpochs: vi.fn().mockResolvedValue({ epochs: [] }),
    setNightScreen: vi.fn().mockResolvedValue(undefined),
    getAlarmState: vi.fn().mockResolvedValue({ state: 'pending' }),
    ...over,
  } as never;
}

describe('isNativeAndroid', () => {
  it('is false in the browser and in node', () => {
    expect(isNativeAndroid()).toBe(false);
  });
});

describe('createNativeAlarm off Android (web/PWA)', () => {
  it('does nothing and never touches the plugin', async () => {
    const p = mockPlugin();
    const n = createNativeAlarm(p, () => false);
    expect(n.enabled).toBe(false);
    expect(await n.arm(NIGHT)).toEqual({ ok: true, warnings: [] });
    await n.disarm();
    expect(await n.rearmAt(END)).toBe(true);
    expect(await n.wakeNow()).toBe('no-pending');
    expect(await n.permissions()).toBeNull();
    for (const fn of Object.values(p)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('arm on native Android', () => {
  it('schedules the hard alarm at the window end and starts the night service', async () => {
    const p = mockPlugin();
    const n = createNativeAlarm(p, () => true);
    expect(await n.arm(NIGHT)).toEqual({ ok: true, warnings: [] });
    expect(p.scheduleHardAlarm).toHaveBeenCalledWith({ atEpochMs: END, label: 'Sleeping Aid' });
    expect(p.startNightService).toHaveBeenCalledWith(NIGHT);
  });

  it('blocks arming without exact-alarm permission: nothing is scheduled and the service is not started', async () => {
    const p = mockPlugin({ getAlarmPermissions: vi.fn().mockResolvedValue({ ...ALL_OK, exactAlarm: false }) });
    const r = await createNativeAlarm(p, () => true).arm(NIGHT);
    expect(r).toMatchObject({ ok: false, reason: 'exact-alarm-denied' });
    expect(p.scheduleHardAlarm).not.toHaveBeenCalled();
    expect(p.startNightService).not.toHaveBeenCalled();
  });

  it('blocks when the native side reports exact-alarm-denied at scheduling time', async () => {
    const p = mockPlugin({ scheduleHardAlarm: vi.fn().mockResolvedValue({ result: 'exact-alarm-denied' }) });
    const r = await createNativeAlarm(p, () => true).arm(NIGHT);
    expect(r).toMatchObject({ ok: false, reason: 'exact-alarm-denied' });
    expect(p.startNightService).not.toHaveBeenCalled();
  });

  it('blocks when the plugin throws while scheduling', async () => {
    const p = mockPlugin({ scheduleHardAlarm: vi.fn().mockRejectedValue(new Error('boom')) });
    const r = await createNativeAlarm(p, () => true).arm(NIGHT);
    expect(r).toEqual({ ok: false, reason: 'error', message: 'boom' });
  });

  it('asks for the notification permission and warns, without blocking, when it stays denied', async () => {
    const denied = { ...ALL_OK, notifications: false };
    const p = mockPlugin({
      getAlarmPermissions: vi.fn().mockResolvedValue(denied),
      requestNotificationPermission: vi.fn().mockResolvedValue(denied),
    });
    const r = await createNativeAlarm(p, () => true).arm(NIGHT);
    expect(p.requestNotificationPermission).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings.join(' ')).toMatch(/Notifications are blocked/);
    expect(p.scheduleHardAlarm).toHaveBeenCalled();
  });

  it('warns about a missing full-screen intent but still arms', async () => {
    const p = mockPlugin({ getAlarmPermissions: vi.fn().mockResolvedValue({ ...ALL_OK, fullScreenIntent: false }) });
    const r = await createNativeAlarm(p, () => true).arm(NIGHT);
    expect(r.ok && r.warnings.join(' ')).toMatch(/Full-screen/);
    expect(p.scheduleHardAlarm).toHaveBeenCalled();
  });

  it('keeps the night armed when only the night service fails', async () => {
    const p = mockPlugin({ startNightService: vi.fn().mockRejectedValue(new Error('not allowed')) });
    const r = await createNativeAlarm(p, () => true).arm(NIGHT);
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings.join(' ')).toMatch(/smart wake will not run/);
  });
});

describe('native night engine glue', () => {
  it('status, epochs and resumeTracking forward to the plugin and never throw', async () => {
    const p = mockPlugin({ getNightEpochs: vi.fn().mockResolvedValue({ epochs: [{ start: 1, stage: 'light', confidence: 0.7 }] }) });
    const n = createNativeAlarm(p, () => true);
    expect(await n.status()).toEqual({ state: 'tracking' });
    expect(await n.epochs()).toEqual([{ start: 1, stage: 'light', confidence: 0.7 }]);
    await n.resumeTracking(NIGHT);
    expect(p.startNightService).toHaveBeenCalledWith(NIGHT);
    const bad = mockPlugin({
      getNightStatus: vi.fn().mockRejectedValue(new Error('x')),
      getNightEpochs: vi.fn().mockRejectedValue(new Error('x')),
      startNightService: vi.fn().mockRejectedValue(new Error('x')),
      clearNight: vi.fn().mockRejectedValue(new Error('x')),
    });
    const m = createNativeAlarm(bad, () => true);
    expect(await m.status()).toBeNull();
    expect(await m.epochs()).toEqual([]);
    await expect(m.resumeTracking(NIGHT)).resolves.toBeUndefined();
    await expect(m.clearNight()).resolves.toBeUndefined();
  });

  it('is inert off Android', async () => {
    const p = mockPlugin();
    const n = createNativeAlarm(p, () => false);
    expect(await n.status()).toBeNull();
    expect(await n.epochs()).toEqual([]);
    await n.resumeTracking(NIGHT);
    await n.clearNight();
    for (const fn of Object.values(p)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('disarm, snooze and wake on native Android', () => {
  it('disarm cancels the alarm and forgets the native night, even if one call fails', async () => {
    const p = mockPlugin({ cancelHardAlarm: vi.fn().mockRejectedValue(new Error('x')) });
    await expect(createNativeAlarm(p, () => true).disarm()).resolves.toBeUndefined();
    expect(p.cancelHardAlarm).toHaveBeenCalledTimes(1);
    expect(p.clearNight).toHaveBeenCalledTimes(1);
    expect(p.setNightScreen).toHaveBeenCalledWith({ on: false });
  });

  it('nightScreen forwards to the plugin, swallows errors and is a no-op off Android', async () => {
    const p = mockPlugin({ setNightScreen: vi.fn().mockRejectedValue(new Error('x')) });
    await expect(createNativeAlarm(p, () => true).nightScreen(true)).resolves.toBeUndefined();
    expect(p.setNightScreen).toHaveBeenCalledWith({ on: true });
    const q = mockPlugin();
    await createNativeAlarm(q, () => false).nightScreen(true);
    expect(q.setNightScreen).not.toHaveBeenCalled();
  });

  it('alreadyEnded is true only for a native alarm that rang and was stopped', async () => {
    const check = async (state: string | Error, native = true) => {
      const p = mockPlugin({ getAlarmState: state instanceof Error ? vi.fn().mockRejectedValue(state) : vi.fn().mockResolvedValue({ state }) });
      return createNativeAlarm(p, () => native).alreadyEnded();
    };
    expect(await check('ended')).toBe(true);
    expect(await check('ringing')).toBe(false);
    expect(await check('pending')).toBe(false);
    expect(await check('none')).toBe(false);
    expect(await check(new Error('x'))).toBe(false);
    expect(await check('ended', false)).toBe(false);
  });

  it('rearmAt cancels first, then schedules; reports a denial', async () => {
    const order: string[] = [];
    const p = mockPlugin({
      cancelHardAlarm: vi.fn(async () => void order.push('cancel')),
      scheduleHardAlarm: vi.fn(async () => (order.push('schedule'), { result: 'exact-alarm-denied' as const })),
    });
    expect(await createNativeAlarm(p, () => true).rearmAt(END)).toBe(false);
    expect(order).toEqual(['cancel', 'schedule']);
  });

  it('wakeNow forwards the native outcome and degrades to no-pending on errors', async () => {
    const ok = createNativeAlarm(mockPlugin(), () => true);
    expect(await ok.wakeNow()).toBe('rang');
    const failing = createNativeAlarm(mockPlugin({ triggerWakeNow: vi.fn().mockRejectedValue(new Error('x')) }), () => true);
    expect(await failing.wakeNow()).toBe('no-pending');
  });
});

describe('onAlarmEnded', () => {
  function withListener() {
    let cb: ((e: { reason: 'stopped' | 'snoozed' | 'missed'; at: number }) => void) | null = null;
    const remove = vi.fn(() => Promise.resolve());
    const p = mockPlugin({
      addListener: vi.fn((_: string, f: typeof cb) => {
        cb = f;
        return Promise.resolve({ remove });
      }),
    } as never);
    return { p, remove, fire: (e: { reason: 'stopped' | 'snoozed' | 'missed'; at: number }) => cb?.(e) };
  }

  it('is a no-op off Android', () => {
    const { p } = withListener();
    const off = createNativeAlarm(p, () => false).onAlarmEnded(0, () => undefined);
    off();
    expect((p as unknown as { addListener: ReturnType<typeof vi.fn> }).addListener).not.toHaveBeenCalled();
  });

  it('passes the reason on, ignores events from before the alarm screen, and unsubscribes', async () => {
    const { p, remove, fire } = withListener();
    const seen: string[] = [];
    const off = createNativeAlarm(p, () => true).onAlarmEnded(1000, (r) => seen.push(r));
    await Promise.resolve();
    fire({ reason: 'stopped', at: 999 }); // leftover from an earlier alarm
    fire({ reason: 'snoozed', at: 1000 });
    fire({ reason: 'stopped', at: 5000 });
    expect(seen).toEqual(['snoozed', 'stopped']);
    off();
    fire({ reason: 'missed', at: 6000 });
    expect(seen).toHaveLength(2);
    await Promise.resolve();
    expect(remove).toHaveBeenCalled();
  });

  it('removes a listener that registered after the unsubscribe', async () => {
    const { p, remove } = withListener();
    const off = createNativeAlarm(p, () => true).onAlarmEnded(0, () => undefined);
    off();
    await Promise.resolve();
    await Promise.resolve();
    expect(remove).toHaveBeenCalled();
  });
});
