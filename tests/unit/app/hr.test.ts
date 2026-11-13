// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { describe, expect, it } from 'vitest';
import { parseHeartRate } from '../../../src/app/hr';

const dv = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

describe('parseHeartRate (0x2A37)', () => {
  it('reads a uint8 value when flag bit 0 is clear', () => {
    expect(parseHeartRate(dv(0x00, 72))).toBe(72);
  });

  it('treats an implausible uint16 value (300 bpm) as invalid', () => {
    expect(parseHeartRate(dv(0x01, 0x2c, 0x01))).toBeNull();
  });

  it('reads a uint16 value in range (little-endian)', () => {
    expect(parseHeartRate(dv(0x01, 0x90, 0x00))).toBe(144);
  });

  it('ignores other flag bits (contact, energy, RR present)', () => {
    expect(parseHeartRate(dv(0b0001_1110, 61, 0x10, 0x00))).toBe(61);
    expect(parseHeartRate(dv(0b0001_1111, 0x3d, 0x00, 0x10, 0x00))).toBe(61);
  });

  it('rejects truncated packets and no-contact zero readings', () => {
    expect(parseHeartRate(dv())).toBeNull();
    expect(parseHeartRate(dv(0x00))).toBeNull();
    expect(parseHeartRate(dv(0x01, 0x40))).toBeNull();
    expect(parseHeartRate(dv(0x00, 0))).toBeNull();
    expect(parseHeartRate(dv(0x01, 0x00, 0x00))).toBeNull();
  });
});
