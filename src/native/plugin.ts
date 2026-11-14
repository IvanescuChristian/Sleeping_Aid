// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** Status of the Android permissions the alarm depends on. */
export interface AlarmPermissions {
  /** AlarmManager.canScheduleExactAlarms(). Without it the hard alarm cannot be armed. */
  exactAlarm: boolean;
  /** POST_NOTIFICATIONS granted and notifications enabled. */
  notifications: boolean;
  /** NotificationManager.canUseFullScreenIntent(): the alarm screen over the lock screen. */
  fullScreenIntent: boolean;
}

export type ScheduleOutcome = 'scheduled' | 'already-fired' | 'exact-alarm-denied';
export type TriggerOutcome = 'rang' | 'already-fired' | 'no-pending';

/** A watch that is connected and has the Sleeping Aid watch app (advertises the watch capability). */
export interface WatchNode {
  id: string;
  name: string;
  nearby: boolean;
}

export interface WatchStatus {
  /** False when the Wear OS Data Layer could not be queried at all (no Play services, no watch support). */
  available: boolean;
  connected: boolean;
  nodes: WatchNode[];
  /** Phone clock of the last batch received from the watch; 0 when none yet. */
  lastEpochAt: number;
  lastSeq: number;
  session: string;
}

/** Native alarm state: 'ended' means it rang and was stopped; a snoozed alarm is 'pending' again. */
export type NativeAlarmState = 'none' | 'pending' | 'ringing' | 'ended';

/** Why the native alarm ended without JavaScript asking for it. */
export type AlarmEndReason = 'stopped' | 'snoozed' | 'missed';

export type NativeNightState = 'none' | 'tracking' | 'woke' | 'ended';

/** Parameters of a night, persisted natively so the engine can resume after the process was killed. */
export interface NightParams {
  windowStart: number;
  windowEnd: number;
  /** Identifies the night: the same value means "resume", a new one starts a fresh night. */
  startedAt: number;
  useMotion: boolean;
  useWatch: boolean;
}

/** Live status of the native smart-wake engine (android NightStore + NightTracker). */
export interface NightStatus {
  state: NativeNightState;
  startedAt?: number;
  windowStart?: number;
  windowEnd?: number;
  stage?: string;
  epochs?: number;
  lastEpochAt?: number;
  /**
   * Where motion comes from now. 'watch-waiting': the watch is the source but has not delivered yet.
   * 'phone': no watch wanted. 'phone-fallback': the watch was wanted but is silent or not yet trusted again.
   */
  motionSource?: 'phone' | 'phone-fallback' | 'watch' | 'watch-waiting' | 'none';
  motionHz?: number;
  hrBpm?: number;
  errors?: number;
  /** Tracking is recorded but no service runs it (killed, or not restarted after a reboot). */
  needsResume?: boolean;
  /** Present once the engine (smart) or the backup alarm (fallback) woke the user. */
  wake?: { reason: 'smart' | 'fallback'; at: number; stage: string };
}

export interface NightEpoch {
  start: number;
  stage: string;
  confidence: number;
  /** Device that supplied the epoch's motion; absent for a gap. */
  source?: 'watch' | 'phone';
}

/** Typed surface of the native `SleepAidNative` Capacitor plugin (android/app/src/main/java). */
export interface SleepAidNativePlugin {
  scheduleHardAlarm(o: { atEpochMs: number; label: string }): Promise<{ result: ScheduleOutcome }>;
  cancelHardAlarm(): Promise<void>;
  triggerWakeNow(): Promise<{ result: TriggerOutcome }>;
  getAlarmPermissions(): Promise<AlarmPermissions>;
  openExactAlarmSettings(): Promise<void>;
  openFullScreenIntentSettings(): Promise<void>;
  requestNotificationPermission(): Promise<AlarmPermissions>;
  /** Night screen mode: keep the screen on at minimum brightness (on) or restore normal behaviour (off). */
  setNightScreen(o: { on: boolean }): Promise<void>;
  getAlarmState(): Promise<{ state: NativeAlarmState }>;
  /** Starts or resumes the native night engine. `started: false` means that night already woke or ended. */
  startNightService(o: NightParams): Promise<{ started: boolean; state: NativeNightState }>;
  stopNightService(): Promise<void>;
  /** Forgets the native night (outcome and epochs); called once the summary is saved, and on "delete all". */
  clearNight(): Promise<void>;
  getNightStatus(): Promise<NightStatus>;
  getNightEpochs(): Promise<{ epochs: NightEpoch[] }>;
  /** Asks the watch app to start recording. `reset: true` (a new night) also drops buffered batches of earlier nights. */
  startWatch(o: { reset: boolean }): Promise<{ sent: number }>;
  stopWatch(): Promise<{ sent: number }>;
  getWatchStatus(): Promise<WatchStatus>;
  /** Legacy: always empty now that the native engine consumes watch batches. */
  drainWatchEpochs(): Promise<{ batches: string[] }>;
  /** Live batch from the watch. No longer emitted: the native engine consumes watch batches itself. */
  addListener(eventName: 'watchEpochs', cb: (e: { json: string }) => void): Promise<PluginListenerHandle>;
  /** The alarm was stopped, snoozed or silenced on the native alarm screen or its notification. `at` is the phone clock. */
  addListener(eventName: 'alarmEnded', cb: (e: { reason: AlarmEndReason; at: number }) => void): Promise<PluginListenerHandle>;
}

export const SleepAidNative = registerPlugin<SleepAidNativePlugin>('SleepAidNative');

/** True only inside the Capacitor Android app; false in the browser, the PWA and the unit tests. */
export function isNativeAndroid(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}
