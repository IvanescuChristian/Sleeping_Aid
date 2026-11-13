// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { describe, expect, it } from 'vitest';

// Set before any Date is constructed; Node re-reads TZ on assignment. Kept in its own file so other suites keep the host zone.
process.env.TZ = 'Europe/Helsinki';

import { computeWindow } from '../../../src/app/window';

describe('computeWindow across the 2026-10-25 autumn DST change (Europe/Helsinki)', () => {
  it('keeps the typed wall-clock times although the night is an hour longer', () => {
    // 04:00 EEST (+3) becomes 03:00 EET (+2) that night.
    const now = new Date(2026, 9, 24, 23, 0, 0).getTime();
    const w = computeWindow('02:30', '04:30', now);
    // Wall 02:30 is still EEST (23:30Z); wall 04:30 is EET (02:30Z): exactly the 3 h maximum.
    expect(w).toEqual({ ok: true, start: Date.UTC(2026, 9, 24, 23, 30), end: Date.UTC(2026, 9, 25, 2, 30) });
  });

  it('validates on the real duration, not the wall-clock difference', () => {
    const now = new Date(2026, 9, 24, 23, 0, 0).getTime();
    // 2 h of wall clock but 3 h of real time is fine; 02:00-04:30 is 3.5 h real time and must be rejected.
    expect(computeWindow('02:00', '04:30', now)).toEqual({ ok: false, error: 'Wake window must be at most 180 minutes' });
  });
});
