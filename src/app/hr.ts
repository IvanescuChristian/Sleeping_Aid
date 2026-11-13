// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).

/**
 * Parses a GATT Heart Rate Measurement (characteristic 0x2A37).
 * Byte 0 is a flags field; bit 0 selects a uint16 (1) or uint8 (0) heart-rate value,
 * little-endian. Returns null for truncated packets and for 0 bpm (no skin contact).
 */
export function parseHeartRate(dv: DataView): number | null {
  if (dv.byteLength < 2) return null;
  const flags = dv.getUint8(0);
  let bpm: number;
  if (flags & 0x01) {
    if (dv.byteLength < 3) return null;
    bpm = dv.getUint16(1, true);
  } else {
    bpm = dv.getUint8(1);
  }
  return bpm >= 20 && bpm <= 250 ? bpm : null;
}
