// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { EPOCH_MS, REORDER_GRACE_MS, WATCH_FRESH_MS, WATCH_GRACE_MS, WATCH_RECOVER_EPOCHS, WATCH_RECOVER_MS, WATCH_SHIFT_MS } from './config';
import type { EpochSource } from './types';

/**
 * A watch epoch is fresh while the aggregator can still accept it: it arrives before its shifted epoch has closed.
 * Anything older (a reconnect flushing buffered backlog) would be dropped as late anyway, so it must not count as
 * proof that the watch stream is live.
 */
export const WATCH_EPOCH_MAX_AGE_MS = WATCH_SHIFT_MS + REORDER_GRACE_MS;

/**
 * Decides which device feeds motion, watch first. Pure: time only enters through `now`, so the same call
 * sequence gives the same answers in the Kotlin mirror (SourceSelector.kt) and in both parity suites.
 *
 * The watch is the source while it is live. It stops being live after WATCH_FRESH_MS without a fresh epoch (at
 * the start of a night: after WATCH_GRACE_MS without one). It becomes the source again only after
 * WATCH_RECOVER_EPOCHS consecutive fresh epochs over at least WATCH_RECOVER_MS (hysteresis against flapping).
 * The selector only gates inputs; the aggregator additionally refuses to mix sources inside one epoch.
 */
export class SourceSelector {
  private current: EpochSource;
  private lastFreshAt = 0;
  private lastCountedStart = -Infinity;
  private recoverCount = 0;
  private recoverFirstAt = 0;
  private recoverLastAt = 0;
  /** Number of source changes so far; bounded by the hysteresis, asserted in tests. */
  switches = 0;

  constructor(private readonly o: { startedAt: number; watchEnabled: boolean }) {
    this.current = o.watchEnabled ? 'watch' : 'phone';
  }

  /** True once a fresh watch epoch has been seen (before that the watch is "waiting", not "stale"). */
  get watchSeen(): boolean {
    return this.lastFreshAt > 0;
  }

  /** Report the epoch starts (watch clock, unshifted) of a batch that arrived at `now`. */
  onWatchEpochs(now: number, starts: readonly number[]): void {
    if (!this.o.watchEnabled) return;
    // Staleness first: after a long silence the first new epoch must start a recovery, not refresh the watch.
    this.source(now);
    for (const start of [...starts].sort((a, b) => a - b)) {
      if (start <= this.lastCountedStart) continue;
      this.lastCountedStart = start;
      if (now - (start + EPOCH_MS) > WATCH_EPOCH_MAX_AGE_MS) continue;
      this.lastFreshAt = now;
      if (this.current === 'watch') continue;
      if (this.recoverCount > 0 && now - this.recoverLastAt >= WATCH_FRESH_MS) this.recoverCount = 0;
      if (this.recoverCount === 0) this.recoverFirstAt = now;
      this.recoverCount++;
      this.recoverLastAt = now;
      if (this.recoverCount >= WATCH_RECOVER_EPOCHS && now - this.recoverFirstAt >= WATCH_RECOVER_MS) {
        this.current = 'watch';
        this.switches++;
        this.recoverCount = 0;
      }
    }
  }

  /** The source that may feed motion at `now`. Call on every tick so staleness is noticed without any input. */
  source(now: number): EpochSource {
    if (!this.o.watchEnabled) return 'phone';
    if (this.current === 'watch') {
      const stale = this.lastFreshAt > 0 ? now - this.lastFreshAt >= WATCH_FRESH_MS : now - this.o.startedAt >= WATCH_GRACE_MS;
      if (stale) {
        this.current = 'phone';
        this.switches++;
        this.recoverCount = 0;
      }
    }
    return this.current;
  }
}
