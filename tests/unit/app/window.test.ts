// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { describe, expect, it } from 'vitest';
import { downsample } from '../../../src/app/storage';
import { computeWindow } from '../../../src/app/window';

const now = new Date(2026, 10, 13, 23, 0, 0).getTime();

describe('computeWindow', () => {
  it('resolves the next occurrence of the end time', () => {
    const w = computeWindow('06:30', '07:00', now);
    expect(w.ok).toBe(true);
    if (w.ok) {
      expect(new Date(w.end).getDate()).toBe(14);
      expect(w.end - w.start).toBe(30 * 60_000);
    }
  });

  it('shows the engine error text for a 10-minute window', () => {
    const w = computeWindow('06:30', '06:40', now);
    expect(w).toEqual({ ok: false, error: 'Wake window must be at least 20 minutes' });
  });

  it('rejects empty or identical times', () => {
    expect(computeWindow('', '07:00', now).ok).toBe(false);
    expect(computeWindow('07:00', '07:00', now).ok).toBe(false);
  });

  it('wraps a window across midnight', () => {
    const w = computeWindow('23:50', '00:30', now);
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.end - w.start).toBe(40 * 60_000);
  });
});

describe('computeWindow exact timestamps', () => {
  const at = (day: number, h: number, m: number) => new Date(2026, 10, day, h, m, 0, 0).getTime();

  it('06:30-07:00 at 23:00 is tomorrow morning', () => {
    expect(computeWindow('06:30', '07:00', now)).toEqual({ ok: true, start: at(14, 6, 30), end: at(14, 7, 0) });
  });

  it('23:50-00:20 at 23:00 starts today and ends tomorrow', () => {
    expect(computeWindow('23:50', '00:20', now)).toEqual({ ok: true, start: at(13, 23, 50), end: at(14, 0, 20) });
  });

  it('inside the window (06:40 in 06:30-07:00) returns the current window, not tomorrow', () => {
    expect(computeWindow('06:30', '07:00', at(14, 6, 40))).toEqual({ ok: true, start: at(14, 6, 30), end: at(14, 7, 0) });
  });
});

describe('downsample', () => {
  it('takes the majority stage per bin and ignores unknown', () => {
    expect(downsample(['light', 'light', 'deep', 'unknown', 'unknown', 'unknown'], 3)).toEqual(['light', 'unknown']);
  });
});
