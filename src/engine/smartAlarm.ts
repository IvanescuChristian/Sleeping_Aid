// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import {
  DEEP_COOLDOWN_EPOCHS,
  EPOCH_MS,
  FRESH_EPOCHS,
  LIGHT_RUN_EPOCHS,
  MAX_WINDOW_MS,
  MIN_WINDOW_MS,
  SMART_MIN_CONFIDENCE,
} from './config';
import type { Clock, EpochResult, Stage } from './types';

export type AlarmWindowErrorCode = 'non_finite' | 'end_not_after_start' | 'too_short' | 'too_long';

export class AlarmWindowError extends Error {
  constructor(
    readonly code: AlarmWindowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AlarmWindowError';
  }
}

export interface AlarmDecision {
  reason: 'smart' | 'fallback';
  at: number;
  stageAtTrigger: Stage;
}

export interface AlarmState {
  windowStart: number;
  windowEnd: number;
  fired: AlarmDecision | null;
  lastStage: Stage;
  lastEpochStart: number | null;
  epochsIngested: number;
  /** Ingest or evaluation failures; surfaced so the UI can warn without the alarm ever depending on them. */
  errorCount: number;
  lastError: string | null;
}

export function validateWindow(windowStart: number, windowEnd: number): void {
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
    throw new AlarmWindowError('non_finite', 'Wake window bounds must be finite timestamps');
  }
  if (windowEnd <= windowStart) {
    throw new AlarmWindowError('end_not_after_start', 'Wake window end must be after its start');
  }
  const len = windowEnd - windowStart;
  if (len < MIN_WINDOW_MS) {
    throw new AlarmWindowError('too_short', 'Wake window must be at least ' + MIN_WINDOW_MS / 60_000 + ' minutes');
  }
  if (len > MAX_WINDOW_MS) {
    throw new AlarmWindowError('too_long', 'Wake window must be at most ' + MAX_WINDOW_MS / 60_000 + ' minutes');
  }
}

const STAGES: ReadonlySet<string> = new Set(['wake', 'light', 'deep', 'rem', 'unknown']);

export class SmartAlarm {
  readonly windowStart: number;
  readonly windowEnd: number;
  private readonly clock: Clock;
  private readonly recent: EpochResult[] = [];
  private decision: AlarmDecision | null = null;
  private lastStage: Stage = 'unknown';
  private lastEpochStart: number | null = null;
  private ingested = 0;
  private errors = 0;
  private lastError: string | null = null;

  constructor(opts: { windowStart: number; windowEnd: number; clock?: Clock }) {
    validateWindow(opts.windowStart, opts.windowEnd);
    this.windowStart = opts.windowStart;
    this.windowEnd = opts.windowEnd;
    this.clock = opts.clock ?? Date.now;
  }

  /** Never throws: a bad epoch is counted and dropped so it cannot affect the fallback. */
  ingest(r: EpochResult): boolean {
    try {
      if (this.decision) return false;
      if (!r || !Number.isFinite(r.start) || !STAGES.has(r.stage) || !Number.isFinite(r.confidence)) {
        throw new TypeError('malformed epoch result');
      }
      this.recent.push({ start: r.start, stage: r.stage, confidence: r.confidence });
      const keep = Math.max(DEEP_COOLDOWN_EPOCHS, LIGHT_RUN_EPOCHS);
      if (this.recent.length > keep) this.recent.shift();
      this.lastStage = r.stage;
      this.lastEpochStart = r.start;
      this.ingested++;
      return true;
    } catch (err) {
      this.recordError(err);
      return false;
    }
  }

  /**
   * Returns a decision at most once. The fallback branch reads only the window
   * bounds and the clock, so no stager or ingest state can block it, and a
   * jumped clock (throttled timers) still fires on the first tick after the end.
   */
  tick(nowMs?: number): AlarmDecision | null {
    if (this.decision) return null;
    const now = nowMs ?? this.clock();
    if (!Number.isFinite(now)) return null;

    if (now >= this.windowEnd) {
      return this.fire({ reason: 'fallback', at: now, stageAtTrigger: this.lastStage });
    }
    if (now >= this.windowStart) {
      try {
        if (this.smartConditionsMet(now)) {
          return this.fire({ reason: 'smart', at: now, stageAtTrigger: this.lastStage });
        }
      } catch (err) {
        this.recordError(err);
      }
    }
    return null;
  }

  getState(): AlarmState {
    return {
      windowStart: this.windowStart,
      windowEnd: this.windowEnd,
      fired: this.decision,
      lastStage: this.lastStage,
      lastEpochStart: this.lastEpochStart,
      epochsIngested: this.ingested,
      errorCount: this.errors,
      lastError: this.lastError,
    };
  }

  private fire(d: AlarmDecision): AlarmDecision {
    this.decision = d;
    return d;
  }

  private smartConditionsMet(now: number): boolean {
    const last = this.recent[this.recent.length - 1];
    if (!last) return false;
    if (now - (last.start + EPOCH_MS) >= FRESH_EPOCHS * EPOCH_MS) return false;

    const run = this.recent.slice(-LIGHT_RUN_EPOCHS);
    if (run.length < LIGHT_RUN_EPOCHS) return false;
    // Wake counts as good: someone already awake gains nothing from waiting.
    if (!run.every((r) => r.stage === 'light' || r.stage === 'wake')) return false;
    if (this.recent.slice(-DEEP_COOLDOWN_EPOCHS).some((r) => r.stage === 'deep')) return false;
    const meanConf = run.reduce((s, r) => s + r.confidence, 0) / run.length;
    return meanConf >= SMART_MIN_CONFIDENCE;
  }

  private recordError(err: unknown): void {
    this.errors++;
    this.lastError = err instanceof Error ? err.message : 'unknown error';
  }
}
