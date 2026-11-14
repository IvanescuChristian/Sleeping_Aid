// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import {
  isNativeAndroid,
  SleepAidNative,
  type AlarmEndReason,
  type AlarmPermissions,
  type NightEpoch,
  type NightParams,
  type NightStatus,
  type SleepAidNativePlugin,
  type TriggerOutcome,
} from './plugin';

export type ArmResult =
  | { ok: true; warnings: string[] }
  | { ok: false; reason: 'exact-alarm-denied' | 'error'; message: string };

const LABEL = 'Sleeping Aid';

const SCREEN_KEY = 'sleepaid.keepScreenOn';

/**
 * Optional "keep the screen on, dimmed" for the night. Off by default: the native engine decides with the screen
 * off. It stays as a setting for people who want the clock visible on the nightstand.
 */
export const screenPreference = {
  get(): boolean {
    try {
      return localStorage.getItem(SCREEN_KEY) === '1';
    } catch {
      return false;
    }
  },
  set(on: boolean): void {
    try {
      localStorage.setItem(SCREEN_KEY, on ? '1' : '0');
    } catch {
      /* not persisted */
    }
  },
};

/**
 * Glue between the night flow and the native alarm. Everything is a no-op off Android, so the web
 * app behaves exactly as before. The plugin and the platform check are injectable for tests.
 */
export function createNativeAlarm(plugin: SleepAidNativePlugin, isNative: () => boolean) {
  return {
    get enabled(): boolean {
      return isNative();
    },

    /**
     * Arms the native hard alarm for the window end and starts the native night engine, which then decides the
     * smart wake on its own (screen off, app closed). The night parameters are persisted natively.
     * Fails (ok: false) when exact alarms are not allowed: the caller must block the night and prompt the user.
     * Notification and full-screen-intent problems and a failing night service only produce warnings.
     */
    async arm(night: NightParams): Promise<ArmResult> {
      if (!isNative()) return { ok: true, warnings: [] };
      const warnings: string[] = [];
      let perms: AlarmPermissions;
      try {
        perms = await plugin.getAlarmPermissions();
      } catch (e) {
        return { ok: false, reason: 'error', message: errText(e) };
      }
      if (!perms.exactAlarm) {
        return { ok: false, reason: 'exact-alarm-denied', message: 'Exact alarms are not allowed for this app.' };
      }
      if (!perms.notifications) {
        try {
          perms = await plugin.requestNotificationPermission();
        } catch {
          /* reported below */
        }
        if (!perms.notifications) {
          warnings.push('Notifications are blocked: the alarm still rings, but its on-screen controls may not show. Allow notifications in the app settings.');
        }
      }
      if (!perms.fullScreenIntent) {
        warnings.push('Full-screen alarms are not allowed: the alarm will ring but may not open over the lock screen.');
      }
      try {
        const r = await plugin.scheduleHardAlarm({ atEpochMs: night.windowEnd, label: LABEL });
        if (r.result === 'exact-alarm-denied') {
          return { ok: false, reason: 'exact-alarm-denied', message: 'Exact alarms are not allowed for this app.' };
        }
      } catch (e) {
        return { ok: false, reason: 'error', message: errText(e) };
      }
      try {
        await plugin.startNightService(night);
      } catch {
        warnings.push('The night service could not start. The backup alarm is armed, but smart wake will not run.');
      }
      return { ok: true, warnings };
    },

    /**
     * Cancels the hard alarm (and a ringing one), stops the night engine, forgets its epochs and ends night screen
     * mode. The summary must already be saved. Never throws.
     */
    async disarm(): Promise<void> {
      if (!isNative()) return;
      await Promise.allSettled([plugin.cancelHardAlarm(), plugin.clearNight(), plugin.setNightScreen({ on: false })]);
    },

    /** Live status of the native engine; null off Android or when the plugin fails. */
    async status(): Promise<NightStatus | null> {
      if (!isNative()) return null;
      try {
        return await plugin.getNightStatus();
      } catch {
        return null;
      }
    },

    /** Epochs of the native night so far. Empty off Android or on failure. */
    async epochs(): Promise<NightEpoch[]> {
      if (!isNative()) return [];
      try {
        return (await plugin.getNightEpochs()).epochs;
      } catch {
        return [];
      }
    },

    /** Starts the engine again for a night that is still tracked natively but has no running service. */
    async resumeTracking(night: NightParams): Promise<void> {
      if (!isNative()) return;
      await plugin.startNightService(night).catch(() => undefined);
    },

    /** Forgets the native night (outcome and epochs), for "delete all data". Never throws. */
    async clearNight(): Promise<void> {
      if (!isNative()) return;
      await plugin.clearNight().catch(() => undefined);
    },

    /** Reschedules the hard alarm, for the snooze. Returns false when it could not be armed. */
    async rearmAt(atEpochMs: number): Promise<boolean> {
      if (!isNative()) return true;
      try {
        await plugin.cancelHardAlarm();
        return (await plugin.scheduleHardAlarm({ atEpochMs, label: LABEL })).result !== 'exact-alarm-denied';
      } catch {
        return false;
      }
    },

    /** The JS smart-wake (or fallback) fired: ring natively now. Resolves 'no-pending' when nothing native can ring. */
    async wakeNow(): Promise<TriggerOutcome> {
      if (!isNative()) return 'no-pending';
      try {
        return (await plugin.triggerWakeNow()).result;
      } catch {
        return 'no-pending';
      }
    },

    /** Dimmed keep-screen-on for the night (native replacement for the Screen Wake Lock API). Never throws. */
    async nightScreen(on: boolean): Promise<void> {
      if (!isNative()) return;
      await plugin.setNightScreen({ on }).catch(() => undefined);
    },

    /** True when the native alarm rang and was already stopped, so a JS alarm screen would be stale. */
    async alreadyEnded(): Promise<boolean> {
      if (!isNative()) return false;
      try {
        return (await plugin.getAlarmState()).state === 'ended';
      } catch {
        return false;
      }
    },

    async permissions(): Promise<AlarmPermissions | null> {
      if (!isNative()) return null;
      try {
        return await plugin.getAlarmPermissions();
      } catch {
        return null;
      }
    },

    async openExactAlarmSettings(): Promise<void> {
      await plugin.openExactAlarmSettings().catch(() => undefined);
    },

    /**
     * Calls `cb` when the alarm is stopped, snoozed or silenced on the native alarm screen or its notification,
     * so the JavaScript alarm screen can close. Events older than `notBefore` (phone clock) are leftovers from an
     * earlier alarm (the plugin keeps events until a listener exists) and are ignored. Returns the unsubscribe
     * function; a no-op off Android.
     */
    onAlarmEnded(notBefore: number, cb: (reason: AlarmEndReason) => void): () => void {
      if (!isNative()) return () => undefined;
      let off = false;
      let handle: { remove(): Promise<void> } | null = null;
      plugin
        .addListener('alarmEnded', (e) => {
          if (!off && e.at >= notBefore) cb(e.reason);
        })
        .then((h) => {
          if (off) void h.remove();
          else handle = h;
        })
        .catch(() => undefined);
      return () => {
        off = true;
        void handle?.remove().catch(() => undefined);
        handle = null;
      };
    },
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : 'native alarm error';
}

export type NativeAlarm = ReturnType<typeof createNativeAlarm>;

export const nativeAlarm: NativeAlarm = createNativeAlarm(SleepAidNative, isNativeAndroid);
