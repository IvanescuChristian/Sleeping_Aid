// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).

type Ctor = typeof AudioContext;

/** Generated alarm tone: no audio assets, rising volume, looping until stopped. */
export class AlarmSound {
  private ctx: AudioContext | null = null;
  private stopFns: Array<() => void> = [];
  private vibrateTimer: ReturnType<typeof setInterval> | null = null;
  ringing = false;

  /** Create/resume the context. Must be called from a user gesture (Start night, Test sound, any tap on the alarm). */
  async unlock(): Promise<boolean> {
    try {
      const ctx = this.ensure();
      if (!ctx) return false;
      if (ctx.state !== 'running') await ctx.resume();
      return ctx.state === 'running';
    } catch {
      return false;
    }
  }

  /** Creating a context needs no gesture (it just starts suspended), so a ringing alarm can always build its graph. */
  private ensure(): AudioContext | null {
    if (!this.ctx) {
      const C: Ctor | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
      if (!C) return null;
      this.ctx = new C();
    }
    return this.ctx;
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  async test(): Promise<boolean> {
    const ok = await this.unlock();
    const ctx = this.ctx;
    if (!ok || !ctx) return false;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = 880;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.25, t + 0.05);
    g.gain.linearRampToValueAtTime(0, t + 0.6);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.65);
    return true;
  }

  startAlarm(rampSeconds = 60): void {
    if (this.ringing) return;
    this.ringing = true;
    try {
      void this.ensure()?.resume().catch(() => undefined);
      this.buildTone(rampSeconds);
    } catch {
      /* sound is best effort; vibration and the visible alarm still run */
    }
    this.startVibration();
  }

  stopAlarm(): void {
    this.ringing = false;
    for (const f of this.stopFns) {
      try {
        f();
      } catch {
        /* node already stopped */
      }
    }
    this.stopFns = [];
    if (this.vibrateTimer !== null) clearInterval(this.vibrateTimer);
    this.vibrateTimer = null;
    try {
      navigator.vibrate?.(0);
    } catch {
      /* unsupported */
    }
  }

  private buildTone(rampSeconds: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.03, t);
    master.gain.linearRampToValueAtTime(0.9, t + rampSeconds);
    // A 2 Hz square LFO on a gain node pulses the tone without any timer, so the loop survives throttling.
    const pulse = ctx.createGain();
    pulse.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 2;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.5;
    lfo.connect(lfoDepth).connect(pulse.gain);
    const oscs = [880, 1320].map((f) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const lvl = ctx.createGain();
      lvl.gain.value = f === 880 ? 0.6 : 0.3;
      o.connect(lvl).connect(pulse);
      return o;
    });
    pulse.connect(master).connect(ctx.destination);
    for (const o of [lfo, ...oscs]) o.start(t);
    this.stopFns.push(() => {
      master.gain.cancelScheduledValues(ctx.currentTime);
      for (const o of [lfo, ...oscs]) o.stop();
      master.disconnect();
    });
  }

  private startVibration(): void {
    const buzz = () => {
      try {
        navigator.vibrate?.([600, 300, 600, 300, 600]);
      } catch {
        /* unsupported */
      }
    };
    buzz();
    this.vibrateTimer = setInterval(buzz, 3500);
  }
}
