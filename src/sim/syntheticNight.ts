// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { EPOCH_MS } from '../engine/config';
import type { HrSample, MotionSample, Stage } from '../engine/types';

/** Small, fast, seedable PRNG so every simulated night is exactly reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export interface Dropout {
  fromMs: number;
  toMs: number;
  /** Which sensor goes silent; defaults to both. */
  sensor?: 'motion' | 'hr' | 'both';
}

export interface SyntheticNightOptions {
  seed: number;
  bedtime: number;
  durationMin: number;
  hr?: boolean;
  motion?: boolean;
  /** 10 Hz matches a phone; tests use a lower rate to stay fast. */
  motionHz?: number;
  dropouts?: Dropout[];
  cycleMin?: number;
}

export interface SyntheticNight {
  /** Bedtime snapped up to the epoch grid so truth index i covers [startMs + i*EPOCH_MS, +EPOCH_MS). */
  startMs: number;
  truth: Stage[];
  motion: MotionSample[];
  hr: HrSample[];
}

export function truthStageAt(night: SyntheticNight, t: number): Stage {
  const i = Math.floor((t - night.startMs) / EPOCH_MS);
  return night.truth[i] ?? 'unknown';
}

const EPM = 60_000 / EPOCH_MS; // epochs per minute

/**
 * Ground-truth hypnogram: latency awake, then cycles with a jittered length. Early cycles are deep-heavy,
 * late cycles REM-heavy, and brief awakenings cluster at cycle ends, as in typical adult sleep.
 */
export function generateHypnogram(rng: () => number, epochCount: number, cycleMin: number): Stage[] {
  const out: Stage[] = [];
  const push = (s: Stage, n: number) => {
    for (let i = 0; i < n && out.length < epochCount; i++) out.push(s);
  };
  push('wake', Math.round((5 + 15 * rng()) * EPM));
  for (let k = 0; out.length < epochCount; k++) {
    const c = cycleMin * (0.88 + 0.24 * rng()) * EPM;
    const deep = Math.max(0, 0.3 - 0.07 * k) * c * (0.8 + 0.4 * rng());
    const rem = Math.min(0.35, 0.1 + 0.06 * k) * c * (0.8 + 0.4 * rng());
    const light1 = 0.15 * c;
    const light2 = Math.max(0.1 * c, c - light1 - deep - rem);
    push('light', Math.round(light1));
    push('deep', Math.round(deep));
    push('light', Math.round(light2));
    if (rng() < 0.05) push('wake', 1 + Math.floor(rng() * 3));
    push('rem', Math.round(rem));
    if (rng() < 0.4) push('wake', 1 + Math.floor(rng() * 3));
  }
  return out;
}

interface Burst {
  from: number;
  to: number;
  sd: number;
}

/** Movement bursts inside one epoch (seconds from epoch start). Stage-dependent rate and size. */
function bursts(rng: () => number, stage: Stage): Burst[] {
  const b: Burst[] = [];
  const add = (len: number, sd: number) => {
    const from = rng() * (30 - len);
    b.push({ from, to: from + len, sd });
  };
  switch (stage) {
    case 'wake':
      if (rng() < 0.9) add(8 + 17 * rng(), 0.3 + 0.9 * rng());
      break;
    case 'light':
      if (rng() < 0.15) add(2 + 6 * rng(), 0.05 + 0.2 * rng());
      break;
    case 'rem':
      if (rng() < 0.08) add(1 + 2 * rng(), 0.05);
      break;
    case 'deep':
      if (rng() < 0.01) add(1 + rng(), 0.04);
      break;
    default:
      break;
  }
  return b;
}

const HR_OFFSET: Record<Stage, number> = { deep: -6, light: 0, rem: 4, wake: 14, unknown: 0 };
// REM is the most variable and deep the steadiest, the contrast the stager relies on.
const HR_NOISE: Record<Stage, number> = { deep: 0.7, light: 1.4, rem: 3.0, wake: 3.5, unknown: 1.4 };

function inDropout(t: number, d: Dropout[], sensor: 'motion' | 'hr'): boolean {
  return d.some((x) => t >= x.fromMs && t < x.toMs && (x.sensor ?? 'both') !== (sensor === 'motion' ? 'hr' : 'motion'));
}

export function generateNight(o: SyntheticNightOptions): SyntheticNight {
  const startMs = Math.ceil(o.bedtime / EPOCH_MS) * EPOCH_MS;
  const epochCount = Math.round((o.durationMin * 60_000) / EPOCH_MS);
  const truth = generateHypnogram(mulberry32(o.seed), epochCount, o.cycleMin ?? 90);
  const dropouts = o.dropouts ?? [];
  const motion: MotionSample[] = [];
  const hr: HrSample[] = [];

  if (o.motion !== false) {
    // Separate streams per signal: toggling HR must not change the motion of the same seed.
    const rng = mulberry32((o.seed ^ 0x9e3779b9) >>> 0);
    const hz = o.motionHz ?? 10;
    const perEpoch = Math.round(hz * (EPOCH_MS / 1000));
    // Arbitrary phone orientation, constant on the mattress; the engine must not care.
    const gv = [gauss(rng), gauss(rng), gauss(rng)];
    const gn = Math.hypot(gv[0] as number, gv[1] as number, gv[2] as number) || 1;
    // Mattress and phone-case dependent noise floor, varied per night.
    const noiseMul = 0.7 + 0.8 * rng();
    const g = gv.map((x) => (9.81 * x) / gn) as [number, number, number];
    for (let e = 0; e < epochCount; e++) {
      const stage = truth[e] as Stage;
      const bs = bursts(rng, stage);
      for (let i = 0; i < perEpoch; i++) {
        const t = startMs + e * EPOCH_MS + (i * EPOCH_MS) / perEpoch;
        const sec = (i * 30) / perEpoch;
        const burst = bs.find((x) => sec >= x.from && sec < x.to);
        const sd = 0.003 * noiseMul + (burst ? burst.sd : 0);
        if (inDropout(t, dropouts, 'motion')) continue;
        motion.push({ t, ax: g[0] + sd * gauss(rng), ay: g[1] + sd * gauss(rng), az: g[2] + sd * gauss(rng) });
      }
    }
  }

  if (o.hr !== false) {
    const rng = mulberry32((o.seed ^ 0x85ebca6b) >>> 0);
    const base = 54 + 12 * rng();
    // Per-night noise scale and a slow drift (circadian-like) so thresholds cannot be fit to one fixed profile.
    const noiseMul = 0.8 + 0.6 * rng();
    const driftAmp = 4 * rng();
    const driftPhase = 2 * Math.PI * rng();
    let level = base + HR_OFFSET.wake;
    const secs = epochCount * (EPOCH_MS / 1000);
    for (let s = 0; s < secs; s++) {
      const stage = truth[Math.floor((s * 1000) / EPOCH_MS)] as Stage;
      // First-order lag: HR follows stage changes over about a minute rather than jumping.
      const drift = driftAmp * Math.sin(driftPhase + (2 * Math.PI * s) / 21_600);
      level += (base + drift + HR_OFFSET[stage] - level) / 45;
      const t = startMs + s * 1000;
      if (inDropout(t, dropouts, 'hr')) continue;
      const bpm = Math.round(Math.max(35, Math.min(180, level + noiseMul * HR_NOISE[stage] * gauss(rng))));
      hr.push({ t, bpm });
    }
  }

  return { startMs, truth, motion, hr };
}
