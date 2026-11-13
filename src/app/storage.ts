// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import type { NightSummary } from '../engine/summary';
import type { Stage } from '../engine/types';

const KEY_HISTORY = 'sleepingaid.history.v1';
const KEY_ACTIVE = 'sleepingaid.active.v1';
const KEY_SETTINGS = 'sleepingaid.settings.v1';
const MAX_NIGHTS = 60;

export interface StoredAlarm {
  reason: 'smart' | 'fallback' | 'snooze';
  at: number;
  stage: Stage;
}

/** Only summary numbers and a downsampled hypnogram are kept; raw sensor streams never reach storage. */
export interface StoredNight {
  id: number;
  summary: NightSummary;
  /** Epochs (30 s) merged into one hypnogram entry. */
  binEpochs: number;
  windowStart: number;
  windowEnd: number;
  alarm: StoredAlarm | null;
  demo: boolean;
}

export interface ActiveNight {
  windowStart: number;
  windowEnd: number;
  startedAt: number;
  useMotion: boolean;
  /** Set once the alarm has fired and until the user dismisses it. */
  fired: StoredAlarm | null;
}

export interface Settings {
  start: string;
  end: string;
  useMotion: boolean;
}

export const DEFAULT_SETTINGS: Settings = { start: '06:30', end: '07:00', useMotion: true };

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

export function loadHistory(): StoredNight[] {
  const raw = read(KEY_HISTORY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (n): n is StoredNight =>
      isObj(n) && typeof n.id === 'number' && isObj(n.summary) && Array.isArray((n.summary as { hypnogram?: unknown }).hypnogram),
  );
}

export function saveNight(n: StoredNight): boolean {
  const rest = loadHistory().filter((x) => x.id !== n.id);
  const next = [n, ...rest].sort((a, b) => b.id - a.id).slice(0, MAX_NIGHTS);
  return write(KEY_HISTORY, next);
}

export function loadActive(): ActiveNight | null {
  const a = read(KEY_ACTIVE);
  if (!isObj(a) || typeof a.windowStart !== 'number' || typeof a.windowEnd !== 'number' || typeof a.startedAt !== 'number') return null;
  return {
    windowStart: a.windowStart,
    windowEnd: a.windowEnd,
    startedAt: a.startedAt,
    useMotion: a.useMotion !== false,
    fired: isObj(a.fired) ? (a.fired as unknown as StoredAlarm) : null,
  };
}

export function saveActive(a: ActiveNight): boolean {
  return write(KEY_ACTIVE, a);
}

export function clearActive(): void {
  try {
    localStorage.removeItem(KEY_ACTIVE);
  } catch {
    /* storage unavailable: nothing to clear */
  }
}

export function loadSettings(): Settings {
  const s = read(KEY_SETTINGS);
  if (!isObj(s)) return { ...DEFAULT_SETTINGS };
  return {
    start: typeof s.start === 'string' ? s.start : DEFAULT_SETTINGS.start,
    end: typeof s.end === 'string' ? s.end : DEFAULT_SETTINGS.end,
    useMotion: s.useMotion !== false,
  };
}

export function saveSettings(s: Settings): void {
  write(KEY_SETTINGS, s);
}

export function deleteAll(): void {
  for (const k of [KEY_HISTORY, KEY_ACTIVE, KEY_SETTINGS]) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
}

/** Majority stage per bin (unknown only when a bin has no data), so a 8 h night stores about 100 entries. */
export function downsample(h: readonly Stage[], bin: number): Stage[] {
  const out: Stage[] = [];
  for (let i = 0; i < h.length; i += bin) {
    const counts = new Map<Stage, number>();
    for (const s of h.slice(i, i + bin)) if (s !== 'unknown') counts.set(s, (counts.get(s) ?? 0) + 1);
    let best: Stage = 'unknown';
    let n = 0;
    for (const [s, c] of counts) {
      if (c > n) {
        best = s;
        n = c;
      }
    }
    out.push(best);
  }
  return out;
}
