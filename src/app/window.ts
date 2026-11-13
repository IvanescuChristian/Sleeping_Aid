// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { AlarmWindowError, validateWindow } from '../engine/smartAlarm';

export type WindowResult = { ok: true; start: number; end: number } | { ok: false; error: string };

function parseHm(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

/**
 * Turns two clock times into the next concrete wake window. The end is the next occurrence of
 * the end time after `now`; the start is the latest occurrence of the start time at or before it
 * (so 23:50-00:10 wraps midnight). Both are built from wall-clock fields, not by subtracting a length,
 * so a DST change inside the night keeps the times the user typed.
 * If `now` is already inside the window, that window is returned rather than tomorrow's.
 * Validation is delegated to the engine so the UI shows exactly the engine's wording.
 */
export function computeWindow(startHm: string, endHm: string, now: number): WindowResult {
  const s = parseHm(startHm);
  const e = parseHm(endHm);
  if (s === null || e === null) return { ok: false, error: 'Enter both a start and an end time.' };
  const d = new Date(now);
  d.setHours(Math.floor(e / 60), e % 60, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  const end = d.getTime();
  const st = new Date(end);
  st.setHours(Math.floor(s / 60), s % 60, 0, 0);
  if (st.getTime() > end) st.setDate(st.getDate() - 1);
  const start = st.getTime();
  try {
    validateWindow(start, end);
  } catch (err) {
    if (err instanceof AlarmWindowError) return { ok: false, error: err.message };
    throw err;
  }
  return { ok: true, start, end };
}
