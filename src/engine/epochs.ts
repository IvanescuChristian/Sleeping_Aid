// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { EPOCH_MS, GRAVITY_TAU_MS, MAX_GAP_EPOCHS, MIN_HR_SAMPLES_FOR_SD, REORDER_GRACE_MS } from './config';
import type { Epoch, HrSample, MotionSample } from './types';

interface Acc {
  devSum: number;
  motionN: number;
  hrN: number;
  hrMean: number;
  hrM2: number;
}

/**
 * Buckets samples into fixed epochs. Motion and HR may arrive in any interleaving;
 * an epoch only closes once time has passed its end plus a small grace, so a
 * slightly late packet from the other sensor is not lost.
 */
export class EpochAggregator {
  private readonly open = new Map<number, Acc>();
  private nextEmit: number | null = null;
  private maxT = -Infinity;
  private gravity: number | null = null;
  private lastMotionT = -Infinity;
  /** Samples dropped for non-finite fields (a malformed packet must never poison the stream). */
  rejected = 0;
  /** Samples dropped because their epoch had already been emitted. */
  late = 0;

  constructor(private readonly epochMs: number = EPOCH_MS) {}

  ingestMotion(s: MotionSample): Epoch[] {
    if (!isFiniteNum(s?.t) || !isFiniteNum(s.ax) || !isFiniteNum(s.ay) || !isFiniteNum(s.az)) {
      this.rejected++;
      return [];
    }
    const start = this.bucket(s.t);
    if (this.isClosed(start)) {
      this.late++;
      return [];
    }
    // Magnitude, not axes: the phone can lie in any orientation on the mattress.
    const mag = Math.hypot(s.ax, s.ay, s.az);
    let dev = 0;
    if (this.gravity === null) {
      this.gravity = mag;
    } else {
      dev = Math.abs(mag - this.gravity);
      const dt = Math.max(0, s.t - this.lastMotionT);
      this.gravity += (1 - Math.exp(-dt / GRAVITY_TAU_MS)) * (mag - this.gravity);
    }
    this.lastMotionT = Math.max(this.lastMotionT, s.t);
    const acc = this.acc(start);
    acc.devSum += dev;
    acc.motionN++;
    return this.touch(s.t);
  }

  ingestHr(s: HrSample): Epoch[] {
    if (!isFiniteNum(s?.t) || !isFiniteNum(s.bpm) || s.bpm <= 0) {
      this.rejected++;
      return [];
    }
    const start = this.bucket(s.t);
    if (this.isClosed(start)) {
      this.late++;
      return [];
    }
    const acc = this.acc(start);
    acc.hrN++;
    const d = s.bpm - acc.hrMean;
    acc.hrMean += d / acc.hrN;
    acc.hrM2 += d * (s.bpm - acc.hrMean);
    return this.touch(s.t);
  }

  /** Advances time without a sample, so sensor gaps still close (and are reported) on schedule. */
  advance(nowMs: number): Epoch[] {
    if (!isFiniteNum(nowMs)) return [];
    return this.touch(nowMs);
  }

  private touch(t: number): Epoch[] {
    if (t > this.maxT) this.maxT = t;
    return this.drain(this.maxT);
  }

  private bucket(t: number): number {
    return Math.floor(t / this.epochMs) * this.epochMs;
  }

  private isClosed(start: number): boolean {
    return this.nextEmit !== null && start < this.nextEmit;
  }

  private acc(start: number): Acc {
    if (this.nextEmit === null) this.nextEmit = start;
    let a = this.open.get(start);
    if (!a) {
      a = { devSum: 0, motionN: 0, hrN: 0, hrMean: 0, hrM2: 0 };
      this.open.set(start, a);
    }
    return a;
  }

  private drain(upTo: number): Epoch[] {
    const out: Epoch[] = [];
    if (this.nextEmit === null) return out;
    const lastClosable = this.bucket(upTo - REORDER_GRACE_MS) - this.epochMs;
    if ((lastClosable - this.nextEmit) / this.epochMs > MAX_GAP_EPOCHS) {
      this.nextEmit = lastClosable - MAX_GAP_EPOCHS * this.epochMs;
      this.open.clear();
    }
    while (this.nextEmit <= lastClosable) {
      out.push(this.emit(this.nextEmit));
      this.open.delete(this.nextEmit);
      this.nextEmit += this.epochMs;
    }
    return out;
  }

  private emit(start: number): Epoch {
    const a = this.open.get(start);
    if (!a) return { start, activity: NaN, hrMean: null, hrSd: null, motionSamples: 0, hrSamples: 0 };
    return {
      start,
      activity: a.motionN > 0 ? a.devSum / a.motionN : NaN,
      hrMean: a.hrN > 0 ? a.hrMean : null,
      hrSd: a.hrN >= MIN_HR_SAMPLES_FOR_SD ? Math.sqrt(a.hrM2 / a.hrN) : null,
      motionSamples: a.motionN,
      hrSamples: a.hrN,
    };
  }
}

function isFiniteNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}
