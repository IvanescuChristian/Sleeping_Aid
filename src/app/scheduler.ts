// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import type { AlarmDecision } from '../engine/smartAlarm';

export interface SchedulerOptions {
  windowEnd: number;
  /** Runs the pipeline and smart alarm. May throw; the scheduler must still reach the fallback. */
  onTick: (now: number) => AlarmDecision | null;
  /** Called exactly once. */
  onFire: (d: AlarmDecision) => void;
  /** Called on every non-firing tick (UI refresh). Errors are swallowed. */
  onStatus?: (now: number) => void;
  now?: () => number;
  intervalMs?: number;
  /** Also arm a setTimeout at windowEnd. Off for virtual clocks. */
  armTimeout?: boolean;
}

/**
 * Drives the alarm from three independent triggers: a 1 s interval comparing the clock to the
 * window end (a late tick fires immediately), a timeout at the window end, and explicit tick()
 * calls (e.g. on visibilitychange). Whatever the pipeline does, a throw in onTick is counted
 * and the window-end fallback still fires.
 */
export class AlarmScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private decision: AlarmDecision | null = null;
  private readonly clock: () => number;
  tickErrors = 0;

  constructor(private readonly opts: SchedulerOptions) {
    this.clock = opts.now ?? Date.now;
  }

  get fired(): AlarmDecision | null {
    return this.decision;
  }

  start(): void {
    if (this.interval !== null || this.decision) return;
    this.interval = setInterval(() => this.tick(), this.opts.intervalMs ?? 1000);
    if (this.opts.armTimeout !== false) {
      const delay = Math.max(0, this.opts.windowEnd - this.clock()) + 1;
      this.timeout = setTimeout(() => this.tick(), delay);
    }
    this.tick();
  }

  stop(): void {
    if (this.interval !== null) clearInterval(this.interval);
    if (this.timeout !== null) clearTimeout(this.timeout);
    this.interval = null;
    this.timeout = null;
  }

  tick(): void {
    if (this.decision) return;
    const now = this.clock();
    let d: AlarmDecision | null = null;
    try {
      d = this.opts.onTick(now);
    } catch {
      this.tickErrors++;
    }
    if (!d && now >= this.opts.windowEnd) {
      d = { reason: 'fallback', at: now, stageAtTrigger: 'unknown' };
    }
    if (d) {
      this.decision = d;
      this.stop();
      try {
        this.opts.onFire(d);
      } catch {
        this.tickErrors++;
      }
      return;
    }
    try {
      this.opts.onStatus?.(now);
    } catch {
      this.tickErrors++;
    }
  }
}
