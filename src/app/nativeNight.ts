// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import type { EpochResult, Stage } from '../engine/types';
import type { NativeAlarm } from '../native/nativeAlarm';
import type { NightParams, NightStatus as NativeStatus } from '../native/plugin';
import { saveNightSummary, type NightStatus } from './night';
import { saveActive, type ActiveNight, type StoredAlarm, type StoredNight } from './storage';

const POLL_MS = 1000;
/** A night that should be tracked natively but is not: ask the engine to start again at most this often. */
const RESUME_RETRY_MS = 20_000;
const STAGES: ReadonlySet<string> = new Set(['wake', 'light', 'deep', 'rem', 'unknown']);

export interface NativeNightOptions {
  active: ActiveNight;
  useWatch: boolean;
  api: NativeAlarm;
  onStatus: (s: NightStatus) => void;
  onAlarm: (a: StoredAlarm) => void;
  now?: () => number;
}

/**
 * The night on native Android as the screen sees it. The Kotlin engine is authoritative: it stages the night and
 * decides the wake (screen off, app closed), and the backup alarm is an AlarmManager alarm. This class therefore
 * holds NO pipeline and fires NO alarm; it only shows the engine's live status while the page is visible, notices
 * the wake decision, and turns the persisted epochs into the stored summary.
 */
export class NativeNightSession {
  readonly windowStart: number;
  readonly windowEnd: number;
  /** Stored night for the wake that ended it, available after onAlarm. */
  saved: StoredNight | null = null;
  decision: StoredAlarm | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private closed = false;
  private lastResumeAt = 0;
  private readonly clock: () => number;
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') void this.poll();
  };

  constructor(private readonly o: NativeNightOptions) {
    this.windowStart = o.active.windowStart;
    this.windowEnd = o.active.windowEnd;
    this.clock = o.now ?? Date.now;
  }

  now(): number {
    return this.clock();
  }

  get params(): NightParams {
    const a = this.o.active;
    return { windowStart: a.windowStart, windowEnd: a.windowEnd, startedAt: a.startedAt, useMotion: a.useMotion, useWatch: this.o.useWatch };
  }

  /** Polls only while the page is visible: hidden pages are throttled anyway, and the engine does not need us. */
  async start(): Promise<void> {
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('pageshow', this.onVisible);
    this.timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void this.poll();
    }, POLL_MS);
    await this.poll();
  }

  private stopPolling(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('pageshow', this.onVisible);
  }

  async poll(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const st = await this.o.api.status();
      if (this.closed || !st) return;
      const now = this.now();
      if (st.state === 'woke' && st.wake) {
        await this.wake({ reason: st.wake.reason, at: st.wake.at, stage: toStage(st.wake.stage) });
      } else if (st.state === 'none' && now >= this.windowEnd) {
        // The engine has no record, yet the window is over: the backup alarm has rung (or is ringing) natively.
        await this.wake({ reason: 'fallback', at: this.windowEnd, stage: 'unknown' });
      } else {
        if (st.needsResume && now - this.lastResumeAt >= RESUME_RETRY_MS) {
          this.lastResumeAt = now;
          await this.o.api.resumeTracking(this.params);
        }
        this.o.onStatus(toStatus(st, now));
      }
    } finally {
      this.busy = false;
    }
  }

  private async wake(alarm: StoredAlarm): Promise<void> {
    this.closed = true;
    this.stopPolling();
    this.decision = alarm;
    // The alarm screen first; the summary is bookkeeping and cannot delay it.
    this.o.onAlarm(alarm);
    try {
      this.saved = saveNightSummary(await this.results(), { windowStart: this.windowStart, windowEnd: this.windowEnd, alarm, demo: false });
      saveActive({ ...this.o.active, fired: alarm });
    } catch {
      /* storage problems must not matter now */
    }
  }

  private async results(): Promise<EpochResult[]> {
    return (await this.o.api.epochs()).filter((e) => STAGES.has(e.stage)).map((e) => ({ start: e.start, stage: e.stage as Stage, confidence: e.confidence }));
  }

  /** Stops polling. The engine is stopped by nativeAlarm.disarm(). */
  shutdown(): void {
    this.closed = true;
    this.stopPolling();
  }

  release(): void {
    this.shutdown();
  }

  /** The user pressed Stop: stores what the engine staged so far (if enough). Call before disarming. */
  async stop(): Promise<StoredNight | null> {
    this.shutdown();
    try {
      return saveNightSummary(await this.results(), { windowStart: this.windowStart, windowEnd: this.windowEnd, alarm: null, demo: false });
    } catch {
      return null;
    }
  }
}

function toStage(s: string): Stage {
  return STAGES.has(s) ? (s as Stage) : 'unknown';
}

function toStatus(st: NativeStatus, now: number): NightStatus {
  const hz = st.motionHz ?? 0;
  return {
    now,
    stage: toStage(st.stage ?? 'unknown'),
    motionState: st.motionSource === 'none' ? 'off' : hz > 0 ? 'ok' : 'waiting',
    motionHz: hz,
    hrBpm: st.hrBpm ?? null,
    hrConnected: st.hrBpm !== undefined,
    // The screen may be off on native; there is no wake lock to lose.
    wakeLock: 'held',
    pipelineErrors: st.errors ?? 0,
    demo: false,
    motionSource: st.motionSource,
  };
}
