// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { Pipeline } from '../engine/pipeline';
import type { AlarmDecision } from '../engine/smartAlarm';
import { summarizeNight } from '../engine/summary';
import type { EpochResult, Stage } from '../engine/types';
import { DemoFeeder } from './demo';
import { AlarmScheduler } from './scheduler';
import { HeartRateMonitor, MotionSensor, WakeLockHolder, type MotionState, type WakeLockState } from './sensors';
import { downsample, saveActive, saveNight, type ActiveNight, type StoredAlarm, type StoredNight } from './storage';

const BIN_EPOCHS = 10;
/** Less than this much staged data (10 min) is not worth a history entry. */
const MIN_KNOWN_EPOCHS = 20;

/**
 * Summarises staged epochs and stores the night (summary numbers and a coarse hypnogram only). Shared by the web
 * session and the native night, whose epochs come from the Android engine. Null when there is too little data.
 */
export function saveNightSummary(
  results: readonly EpochResult[],
  o: { windowStart: number; windowEnd: number; alarm: StoredAlarm | null; demo: boolean },
): StoredNight | null {
  try {
    if (results.filter((r) => r.stage !== 'unknown').length < MIN_KNOWN_EPOCHS) return null;
    const summary = summarizeNight(results);
    summary.hypnogram = downsample(summary.hypnogram, BIN_EPOCHS);
    const night: StoredNight = {
      id: summary.startMs,
      summary,
      binEpochs: BIN_EPOCHS,
      windowStart: o.windowStart,
      windowEnd: o.windowEnd,
      alarm: o.alarm,
      demo: o.demo,
    };
    saveNight(night);
    return night;
  } catch {
    return null;
  }
}

export interface NightStatus {
  now: number;
  stage: Stage;
  motionState: MotionState;
  motionHz: number;
  hrBpm: number | null;
  hrConnected: boolean;
  wakeLock: WakeLockState;
  pipelineErrors: number;
  demo: boolean;
  /** Native night only: where motion comes from. Absent on the web. */
  motionSource?: 'phone' | 'watch' | 'watch-waiting' | 'none';
}

export interface NightOptions {
  active: ActiveNight;
  hr: HeartRateMonitor | null;
  demo?: boolean;
  onStatus: (s: NightStatus) => void;
  onAlarm: (a: StoredAlarm) => void;
}

/** Wires sensors, pipeline and the AlarmScheduler for one night. */
export class NightSession {
  readonly pipeline: Pipeline;
  readonly scheduler: AlarmScheduler;
  readonly motion = new MotionSensor();
  readonly wake = new WakeLockHolder();
  private readonly demo: DemoFeeder | null;
  private lastRender = 0;
  private alarmDecision: AlarmDecision | null = null;
  private readonly onVisible = () => this.scheduler.tick();

  constructor(private readonly o: NightOptions) {
    const a = o.active;
    this.demo = o.demo ? new DemoFeeder(a.startedAt) : null;
    const windowStart = this.demo?.windowStart ?? a.windowStart;
    const windowEnd = this.demo?.windowEnd ?? a.windowEnd;
    this.pipeline = new Pipeline({ windowStart, windowEnd, clock: () => this.now() });
    this.scheduler = new AlarmScheduler({
      windowEnd,
      now: () => this.now(),
      intervalMs: this.demo ? 10 : 1000,
      armTimeout: !this.demo,
      onTick: (now) => {
        // Pipeline work is fenced separately from the scheduler: its failure must never delay the fallback.
        this.demo?.advance(this.pipeline);
        return this.pipeline.tick(this.demo ? this.demo.now : now);
      },
      onStatus: (now) => this.render(now),
      onFire: (d) => this.fire(d),
    });
  }

  get windowStart(): number {
    return this.pipeline.alarm.windowStart;
  }
  get windowEnd(): number {
    return this.pipeline.alarm.windowEnd;
  }

  now(): number {
    return this.demo ? this.demo.now : Date.now();
  }

  async start(): Promise<void> {
    const o = this.o;
    // Armed first: the alarm must not depend on any sensor setup succeeding.
    this.scheduler.start();
    if (this.demo) return;
    // A resumed night past its end fires inside start(); tracking sensors would only be left running.
    const live = this.alarmDecision === null;
    const guard = (step: () => void) => {
      try {
        step();
      } catch {
        /* a failing sensor degrades tracking only; the scheduler is already running */
      }
    };
    guard(() => {
      this.wake.onChange = () => this.render(this.now(), true);
      this.wake.start();
    });
    guard(() => {
      if (live && o.active.useMotion) this.motion.start((s) => this.pipeline.ingestMotion(s));
    });
    guard(() => {
      if (live && o.hr) o.hr.onSample = (bpm, t) => this.pipeline.ingestHr({ t, bpm });
    });
    guard(() => {
      if (!live) return;
      document.addEventListener('visibilitychange', this.onVisible);
      window.addEventListener('pageshow', this.onVisible);
    });
  }

  /** Stops timers and tracking sensors. The wake lock is separate: the screen must stay on while the alarm rings. */
  private stopTracking(): void {
    this.scheduler.stop();
    this.motion.stop();
    if (this.o.hr) {
      this.o.hr.onSample = null;
    }
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('pageshow', this.onVisible);
  }

  /** Releases everything including the wake lock; safe to call repeatedly. */
  shutdown(): void {
    this.stopTracking();
    this.wake.stop();
  }

  /** Called when the user dismisses (or cancels a snooze after) the alarm: frees the screen and the BLE link. */
  release(): void {
    this.shutdown();
    this.o.hr?.disconnect();
  }

  /** Ends the night without an alarm (user pressed Stop). Returns the saved night, if there was enough data. */
  stop(): StoredNight | null {
    this.release();
    return this.persistSummary(null);
  }

  /** Stored night for the decision that fired, available after the alarm. */
  saved: StoredNight | null = null;

  private fire(d: AlarmDecision): void {
    this.alarmDecision = d;
    const alarm: StoredAlarm = { reason: d.reason, at: d.at, stage: d.stageAtTrigger };
    // The alarm UI comes first; bookkeeping failures cannot delay it.
    try {
      document.documentElement.dataset.alarmFires = String(Number(document.documentElement.dataset.alarmFires ?? '0') + 1);
    } catch {
      /* ignore */
    }
    try {
      this.o.onAlarm(alarm);
    } finally {
      try {
        this.stopTracking();
        if (!this.demo) saveActive({ ...this.o.active, fired: alarm });
        this.saved = this.persistSummary(alarm);
      } catch {
        /* storage problems must not matter now */
      }
    }
  }

  private persistSummary(alarm: StoredAlarm | null): StoredNight | null {
    return saveNightSummary(this.pipeline.results, { windowStart: this.windowStart, windowEnd: this.windowEnd, alarm, demo: this.demo !== null });
  }

  /** At most once per second in real use; the demo runs faster so it stays watchable. */
  private render(now: number, force = false): void {
    const wall = Date.now();
    const gap = this.demo ? 150 : 1000;
    if (!force && wall - this.lastRender < gap) return;
    this.lastRender = wall;
    this.motion.refresh(now);
    const hr = this.o.hr;
    this.o.onStatus({
      now,
      stage: this.pipeline.alarm.getState().lastStage,
      motionState: this.demo ? 'ok' : this.motion.state,
      motionHz: this.demo ? 2 : this.motion.hz,
      hrBpm: this.demo ? this.demoHr() : (hr?.current(now) ?? null),
      hrConnected: this.demo ? true : hr?.state === 'connected',
      wakeLock: this.demo ? 'held' : this.wake.state,
      pipelineErrors: this.pipeline.pipelineErrors,
      demo: this.demo !== null,
    });
  }

  private demoHr(): number | null {
    const d = this.demo;
    if (!d) return null;
    const i = Math.min(d.night.hr.length - 1, Math.max(0, Math.floor((d.now - d.night.startMs) / 1000)));
    return d.night.hr[i]?.bpm ?? null;
  }

  get decision(): AlarmDecision | null {
    return this.alarmDecision;
  }
}
