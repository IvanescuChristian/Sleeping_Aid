// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { WATCH_SHIFT_MS } from './config';
import type { Pipeline } from './pipeline';
import type { SourceSelector } from './sourceSelector';
import type { HrSample } from './types';

/** One decoded watch batch with the unshifted watch clock (see src/native/watch.ts for the wire schema). */
export interface WatchBatchInput {
  epochs: ReadonlyArray<{ start: number; activity: number; samples: number }>;
  hr: readonly HrSample[];
}

/**
 * Feeds one watch batch that arrived at `now`, mirrored by WatchFeed.apply in Kotlin. Leftovers before
 * `notBefore` are ignored and every timestamp moves WATCH_SHIFT_MS later. The selector sees the epochs first;
 * wrist activity enters only while the watch is the motion source, otherwise it would be a second source for
 * minutes the phone already covers. Heart rate has no phone counterpart, so it is never gated by the motion source.
 * Activity goes in before the heart rate of the same batch (the aggregator closes an epoch at the next sample).
 * Returns whether the activity was admitted.
 */
export function applyWatchBatch(pipe: Pipeline, selector: SourceSelector, b: WatchBatchInput, now: number, notBefore: number): boolean {
  const epochs = b.epochs.filter((e) => e.start >= notBefore);
  const hr = b.hr.filter((p) => p.t >= notBefore);
  selector.onWatchEpochs(now, epochs.map((e) => e.start));
  const admit = selector.source(now) === 'watch';
  if (admit) for (const e of epochs) pipe.ingestActivity({ t: e.start + WATCH_SHIFT_MS, activity: e.activity, samples: e.samples });
  for (const p of hr) pipe.ingestHr({ t: p.t + WATCH_SHIFT_MS, bpm: p.bpm });
  return admit && epochs.length > 0;
}
