// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { EpochAggregator } from './epochs';
import { SmartAlarm, type AlarmDecision } from './smartAlarm';
import { Stager } from './stager';
import type { ActivitySample, Clock, Epoch, EpochResult, HrSample, MotionSample } from './types';

export interface EpochStager {
  process(e: Epoch): EpochResult;
}

/**
 * Wires aggregator, stager and alarm. Every sensor-side step is fenced by
 * try/catch and tick() always reaches the alarm, so a defect upstream degrades
 * to "fallback only" instead of a silent alarm.
 */
export class Pipeline {
  readonly aggregator: EpochAggregator;
  readonly alarm: SmartAlarm;
  readonly results: EpochResult[] = [];
  private readonly stager: EpochStager;
  pipelineErrors = 0;

  constructor(opts: { windowStart: number; windowEnd: number; clock?: Clock; stager?: EpochStager }) {
    this.aggregator = new EpochAggregator();
    this.stager = opts.stager ?? new Stager();
    this.alarm = new SmartAlarm({ windowStart: opts.windowStart, windowEnd: opts.windowEnd, clock: opts.clock });
  }

  ingestMotion(s: MotionSample): void {
    try {
      this.process(this.aggregator.ingestMotion(s));
    } catch {
      this.pipelineErrors++;
    }
  }

  ingestActivity(s: ActivitySample): void {
    try {
      this.process(this.aggregator.ingestActivity(s));
    } catch {
      this.pipelineErrors++;
    }
  }

  ingestHr(s: HrSample): void {
    try {
      this.process(this.aggregator.ingestHr(s));
    } catch {
      this.pipelineErrors++;
    }
  }

  tick(nowMs?: number): AlarmDecision | null {
    if (nowMs !== undefined) {
      try {
        this.process(this.aggregator.advance(nowMs));
      } catch {
        this.pipelineErrors++;
      }
    }
    return this.alarm.tick(nowMs);
  }

  private process(epochs: Epoch[]): void {
    for (const e of epochs) {
      try {
        const r = this.stager.process(e);
        this.results.push(r);
        this.alarm.ingest(r);
      } catch {
        this.pipelineErrors++;
      }
    }
  }
}
