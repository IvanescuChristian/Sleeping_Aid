// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { suggestBedtimes } from '../engine/suggest';
import { nativeAlarm, screenPreference } from '../native/nativeAlarm';
import { exactAlarmPrompt } from '../native/prompt';
import { watchLink, watchPreference } from '../native/watch';
import { AlarmSound } from './audio';
import { fmtClock, fmtDate, fmtHours, h } from './dom';
import { drawHypnogram } from './hypnogram';
import { NativeNightSession } from './nativeNight';
import { NightSession, type NightStatus } from './night';
import { AlarmScheduler } from './scheduler';
import { HeartRateMonitor, MotionSensor } from './sensors';
import {
  clearActive,
  deleteAll,
  loadActive,
  loadHistory,
  loadSettings,
  saveActive,
  saveSettings,
  type ActiveNight,
  type StoredAlarm,
  type StoredNight,
} from './storage';
import { computeWindow } from './window';

const SNOOZE_MS = 9 * 60_000;
/** A night or ringing alarm older than this is stale (phone was off); resuming it would only be noise. */
const STALE_MS = 3 * 60 * 60_000;
const NOTE =
  "Keep the phone charging and this app open on screen. As a fail-safe, also set your phone's regular alarm for the window end.";

const NATIVE_NOTE =
  'Smart wake runs on the phone itself: the screen can be off and the app closed. The exact backup alarm at the window end always rings, even if tracking stops.';

const NATIVE_HINT =
  'Put the phone on the mattress or the nightstand, ideally charging. Heart rate and motion come from the Wear OS watch when it is connected, otherwise from the phone sensor.';

/** Share of the night's epochs per motion source, as a short sentence for the summary. */
function sourceShareText(c: { watch: number; phone: number; none: number }): string {
  const total = c.watch + c.phone + c.none;
  if (total === 0) return '';
  const pct = (n: number) => `${Math.round((100 * n) / total)}%`;
  return `Motion came from the watch for ${pct(c.watch)} of the night, from the phone fallback for ${pct(c.phone)}, and was missing for ${pct(c.none)}.`;
}

const STAGE_TEXT: Record<string, string> = { wake: 'Awake', light: 'Light sleep', deep: 'Deep sleep', rem: 'REM', unknown: 'Waiting for data' };

export function mountApp(root: HTMLElement): void {
  const sound = new AlarmSound();
  const hr = new HeartRateMonitor();
  let session: NightSession | NativeNightSession | null = null;
  let snooze: AlarmScheduler | null = null;
  /** Whether a start message went to the watch for this night (so a stop is due). The native engine consumes its data. */
  let watchUsed = false;

  /** Tells the watch to stop recording. Safe to call repeatedly. */
  const endWatch = () => {
    if (watchUsed) {
      watchUsed = false;
      void watchLink.stop();
    }
  };

  const show = (...nodes: Node[]) => {
    root.replaceChildren(...nodes);
    window.scrollTo(0, 0);
  };

  // ---------- Setup ----------
  function showSetup(): void {
    const settings = loadSettings();
    const startIn = h('input', { type: 'time', id: 'win-start', value: settings.start, required: true });
    const endIn = h('input', { type: 'time', id: 'win-end', value: settings.end, required: true });
    const err = h('p', { id: 'win-error', class: 'error', role: 'alert' });
    const motion = h('input', { type: 'checkbox', id: 'use-motion', checked: settings.useMotion });
    const sugg = h('ul', { id: 'suggestions', class: 'plain' });
    const hrNote = h('p', { id: 'hr-note', class: 'hint' });
    const watchBox = h('input', { type: 'checkbox', id: 'use-watch', checked: watchPreference.get() });
    const watchNote = h('p', { id: 'watch-note', class: 'hint' }, 'Looking for a watch...');
    watchBox.addEventListener('change', () => watchPreference.set(watchBox.checked));
    if (watchLink.enabled) {
      void watchLink.status().then((st) => {
        watchNote.textContent = !st.available
          ? 'Watch support is not available on this phone.'
          : st.connected
            ? `Watch connected: ${st.nodes.map((n) => n.name).join(', ')}. Wear it tonight: it supplies heart rate and wrist motion. Only if it goes silent for 2.5 minutes does the phone sensor take over, and the watch is used again once it has been back for a minute.`
            : 'No watch with the Sleeping Aid watch app found. Install the watch app and open it once (see docs/WATCH_SETUP.md). Until then the phone on the mattress is used.';
      });
    }
    const hrBtn = h('button', { type: 'button', id: 'connect-hr', class: 'btn' }, 'Connect heart-rate sensor');
    const screenBox = h('input', { type: 'checkbox', id: 'keep-screen', checked: screenPreference.get() });
    screenBox.addEventListener('change', () => screenPreference.set(screenBox.checked));
    const soundNote = h('p', { id: 'sound-note', class: 'hint', role: 'status' });

    const current = () => computeWindow(startIn.value, endIn.value, Date.now());

    const refresh = () => {
      const w = current();
      err.textContent = w.ok ? '' : w.error;
      saveSettings({ start: startIn.value, end: endIn.value, useMotion: motion.checked });
      const past = loadHistory().filter((n) => !n.demo);
      const wake = w.ok ? w.end : Date.now() + 8 * 3_600_000;
      const items = suggestBedtimes(wake, past.map((n) => n.summary)).map((b) =>
        h('li', null, `Bed by ${fmtClock(b.bedtime)} for ${b.cycles} sleep cycles (${fmtHours(b.sleepMin)})`),
      );
      const basis = past.length ? `from your last ${past.length} night${past.length > 1 ? 's' : ''}` : 'using a typical 90 min cycle';
      sugg.replaceChildren(...items, h('li', { class: 'hint' }, `Estimated ${basis}.`));
    };
    startIn.addEventListener('input', refresh);
    endIn.addEventListener('input', refresh);
    motion.addEventListener('change', refresh);

    const renderHr = () => {
      if (!HeartRateMonitor.supported()) {
        hrBtn.disabled = true;
        hrNote.textContent = 'Heart-rate sensors need Web Bluetooth, which this browser does not provide. Use Chrome on Android.';
      } else if (hr.state === 'connected' || hr.state === 'reconnecting') {
        hrBtn.textContent = 'Disconnect heart-rate sensor';
        hrNote.textContent = `${hr.state === 'connected' ? 'Connected' : 'Reconnecting'}: ${hr.deviceName ?? 'sensor'}.`;
      } else if (hr.state === 'connecting') {
        hrBtn.textContent = 'Connecting...';
        hrNote.textContent = '';
      } else {
        hrBtn.textContent = 'Connect heart-rate sensor';
        hrNote.textContent = hr.error
          ? `Could not connect: ${hr.error}`
          : 'Works with watches or straps that broadcast standard Bluetooth heart rate. Optional; motion alone still works.';
      }
    };
    hr.onChange = renderHr;
    hrBtn.addEventListener('click', () => {
      if (hr.state === 'connected' || hr.state === 'reconnecting') hr.disconnect();
      else void hr.connect().catch(() => undefined);
    });
    renderHr();

    const testBtn = h('button', { type: 'button', id: 'test-sound', class: 'btn' }, 'Test alarm sound');
    testBtn.addEventListener('click', () => {
      void sound.test().then((ok) => (soundNote.textContent = ok ? 'You should hear a short beep.' : 'Audio is blocked or unavailable in this browser.'));
    });

    const start = h('button', { type: 'button', id: 'start-night', class: 'btn primary big' }, 'Start night');
    start.addEventListener('click', () => {
      refresh();
      const w = current();
      if (!w.ok) {
        startIn.focus();
        return;
      }
      void beginNight(
        { windowStart: w.start, windowEnd: w.end, startedAt: Date.now(), useMotion: motion.checked, fired: null },
        { demo: false },
      );
    });
    const demo = h('button', { type: 'button', id: 'demo-night', class: 'btn' }, 'Try a demo night');
    demo.addEventListener('click', () => {
      const now = Date.now();
      void beginNight({ windowStart: now, windowEnd: now + 60 * 60_000, startedAt: now, useMotion: false, fired: null }, { demo: true });
    });
    const hist = h('button', { type: 'button', id: 'open-history', class: 'btn' }, 'Last night and history');
    hist.addEventListener('click', () => showSummary());

    refresh();
    show(
      h(
        'main',
        { class: 'screen setup' },
        h('h1', null, 'Sleeping Aid'),
        h('p', { class: 'lead' }, 'Wakes you in light sleep, inside a window you choose.'),
        h(
          'section',
          null,
          h('h2', null, 'Wake window'),
          h('div', { class: 'row' }, h('label', null, 'From', startIn), h('label', null, 'To', endIn)),
          err,
        ),
        h(
          'section',
          null,
          h('h2', null, 'Sensors'),
          // On Android the watch is the primary sensor and the phone sensor its fallback, so the watch comes first.
          watchLink.enabled && h('label', { class: 'check' }, watchBox, ' Use Wear OS watch (heart rate and wrist motion)'),
          watchLink.enabled && watchNote,
          h('label', { class: 'check' }, motion, watchLink.enabled ? ' Phone on the mattress (fallback when the watch is not available)' : ' Use motion (phone lying on the mattress)'),
          // Web Bluetooth does not run reliably with the screen off, so the native engine takes heart rate from the watch only.
          !nativeAlarm.enabled && hrBtn,
          !nativeAlarm.enabled && hrNote,
          nativeAlarm.enabled && h('label', { class: 'check' }, screenBox, ' Keep the screen on, dimmed (optional)'),
        ),
        h('section', null, h('h2', null, 'Alarm sound'), testBtn, soundNote),
        h('section', null, h('h2', null, 'Bedtime suggestions'), sugg),
        h('p', { class: 'callout', id: 'reliability-note' }, nativeAlarm.enabled ? NATIVE_NOTE : NOTE),
        nativeAlarm.enabled && h('p', { class: 'hint', id: 'native-screen-hint' }, NATIVE_HINT),
        start,
        h('div', { class: 'row' }, demo, hist),
      ),
    );
  }

  // ---------- Night ----------
  async function beginNight(active: ActiveNight, o: { demo: boolean; resumed?: boolean }): Promise<void> {
    // Both calls start inside the tap, which is what the autoplay and permission rules look for.
    // The audio unlock is not awaited: without a gesture (a resumed night) resume() stays pending until the next tap.
    void sound.unlock();
    const native = !o.demo && nativeAlarm.enabled;
    // Native Android reads the accelerometer itself, so the WebView's permission API says nothing about it.
    const motionOk = active.useMotion && !o.demo && !o.resumed && !native ? await MotionSensor.requestPermission() : true;
    let notice = '';
    if (!motionOk) {
      active = { ...active, useMotion: false };
      notice = 'Motion permission was denied, so only the wake window (and heart rate, if connected) is used.';
    }
    // Wear OS watch: used when one with the watch app is connected. It then supplies heart rate and motion; the
    // native engine falls back to the phone sensor when the watch goes silent.
    const watchOn = native && watchLink.enabled && watchPreference.get() && (await watchLink.status()).connected;

    if (native) {
      // A resumed night first asks the engine what happened while the app was closed: if it already woke the
      // user, tracking must not be started again, whatever the hard alarm reports.
      const before = o.resumed ? await nativeAlarm.status() : null;
      const done = before !== null && before.startedAt === active.startedAt && before.state === 'woke';
      if (!done) {
        const armed = await nativeAlarm.arm({ windowStart: active.windowStart, windowEnd: active.windowEnd, startedAt: active.startedAt, useMotion: active.useMotion, useWatch: watchOn });
        if (!armed.ok) {
          show(
            exactAlarmPrompt(nativeAlarm, {
              reason: armed.reason === 'error' ? armed.message : undefined,
              onReady: () => void beginNight(active, o),
              onBack: () => {
                clearActive();
                showSetup();
              },
            }),
          );
          return;
        }
        if (armed.warnings.length) notice = [notice, ...armed.warnings].filter(Boolean).join(' ');
        // Optional, after arming, so a blocked night never leaves the screen pinned on.
        if (screenPreference.get()) void nativeAlarm.nightScreen(true);
      }
      if (watchOn) {
        watchUsed = true;
        if (!done) void watchLink.start(!o.resumed);
      }
      saveActive(active);
      session?.shutdown();
      const ns = new NativeNightSession({
        active,
        useWatch: watchOn,
        api: nativeAlarm,
        onStatus: (st) => paint?.(st),
        onAlarm: (a) => showAlarm(a, { resumed: o.resumed === true }),
      });
      session = ns;
      showNight(ns, notice, false, o.resumed === true);
      await ns.start();
      return;
    }

    if (!o.demo) saveActive(active);
    session?.shutdown();
    session = new NightSession({
      active,
      hr: hr.state === 'connected' || hr.state === 'reconnecting' ? hr : null,
      demo: o.demo,
      onStatus: (s) => paint?.(s),
      onAlarm: (a) => showAlarm(a),
    });
    showNight(session, notice, o.demo, o.resumed === true);
    await session.start();
  }

  let paint: ((s: NightStatus) => void) | null = null;

  /** What the night screen needs of a night: the web session and the native one both fit. */
  interface NightHandle {
    windowStart: number;
    windowEnd: number;
    /** Ends the night without an alarm and returns the stored night, if there was enough data. */
    stop(): StoredNight | null | Promise<StoredNight | null>;
  }

  function showNight(s: NightHandle & { now?(): number }, notice: string, demo: boolean, resumed: boolean): void {
    const native = nativeAlarm.enabled && !demo;
    const clock = h('div', { class: 'clock', 'aria-hidden': 'true' }, fmtClock(s.now ? s.now() : Date.now()));
    const stage = h('p', { id: 'stage', class: 'big-stage', role: 'status' }, 'Waiting for data');
    const motionLine = h('p', { id: 'motion-status' }, 'Motion: -');
    const hrLine = h('p', { id: 'hr-status' }, 'no HR');
    const wl = h('p', { id: 'wl-warning', class: 'banner', role: 'alert', hidden: true });
    const snd = h('p', { id: 'sound-warning', class: 'banner', role: 'alert', hidden: true }, 'Alarm sound is not armed. Tap the screen once.');
    const stopBox = h('div', { class: 'stop-box' });
    const windowText = h('p', { class: 'dim' }, `Wake window ${fmtClock(s.windowStart)} to ${fmtClock(s.windowEnd)}`);

    const set = (el: HTMLElement, text: string) => {
      if (el.textContent !== text) el.textContent = text;
    };
    paint = (st) => {
      set(clock, fmtClock(st.now));
      set(stage, STAGE_TEXT[st.stage] ?? st.stage);
      set(
        motionLine,
        st.motionSource === 'watch'
          ? 'Source: Watch'
          : st.motionSource === 'watch-waiting'
            ? 'Source: waiting for the watch'
            : st.motionSource === 'phone-fallback'
              ? `Source: Phone fallback (watch not delivering)${st.motionState === 'ok' ? '' : ', phone sensor starting...'}`
              : st.motionState === 'ok'
              ? `Motion: ${st.motionHz} Hz`
              : st.motionState === 'off'
                ? 'Motion: off'
                : st.motionState === 'none'
                  ? 'Motion: no data from this device'
                  : 'Motion: starting...',
      );
      set(hrLine, st.hrBpm !== null ? `Heart rate: ${Math.round(st.hrBpm)} bpm` : 'no HR');
      // Native Android keeps the screen on itself; the Screen Wake Lock API is not used there.
      const lost = !nativeAlarm.enabled && (st.wakeLock === 'lost' || st.wakeLock === 'unavailable');
      wl.hidden = !lost;
      set(wl, st.wakeLock === 'lost' ? 'Screen lock was released. Keep the screen on or the alarm may be late.' : 'Cannot keep the screen awake here. Disable auto-lock manually.');
      snd.hidden = sound.running || st.demo;
    };
    const unlock = () => void sound.unlock();
    document.addEventListener('pointerdown', unlock, { once: true });

    const stopBtn = h('button', { type: 'button', id: 'stop-night', class: 'btn' }, 'Stop night');
    stopBtn.addEventListener('click', () => {
      const yes = h('button', { type: 'button', id: 'stop-confirm', class: 'btn danger' }, 'Yes, stop: no alarm will ring');
      const no = h('button', { type: 'button', class: 'btn' }, 'Keep sleeping');
      no.addEventListener('click', () => stopBox.replaceChildren(stopBtn));
      yes.addEventListener('click', () => {
        paint = null;
        // The engine's epochs are read before disarm() forgets them.
        void Promise.resolve(s.stop()).then(async (saved) => {
          endWatch();
          await nativeAlarm.disarm();
          clearActive();
          if (saved) showSummary(saved.id);
          else showSetup();
        });
      });
      stopBox.replaceChildren(h('p', { class: 'dim' }, 'Stop tracking and cancel the alarm?'), yes, no);
    });
    stopBox.append(stopBtn);

    show(
      h(
        'main',
        { class: 'screen night' },
        wl,
        snd,
        demo && h('p', { class: 'banner info' }, 'Demo night: a synthetic night replayed at high speed.'),
        resumed &&
          h(
            'p',
            { class: 'banner info' },
            native
              ? 'Night resumed. Tracking runs in the background and kept its history.'
              : 'Night resumed after a reload. Sensor history before the reload is lost; the alarm window is kept. Reconnect heart rate is not possible without a tap.',
          ),
        notice && h('p', { class: 'banner' }, notice),
        clock,
        windowText,
        stage,
        motionLine,
        hrLine,
        stopBox,
      ),
    );
  }

  // ---------- Alarm ----------
  function showAlarm(a: StoredAlarm, o: { resumed?: boolean } = {}): void {
    paint = null;
    // The alarm screen must be bright again (only matters when the optional keep-screen-on was used).
    void nativeAlarm.nightScreen(false);
    // The night is over: the watch has nothing left to record.
    endWatch();
    let closed = false;
    if (!nativeAlarm.enabled) {
      sound.startAlarm();
    } else if (!o.resumed) {
      // The native alarm rings (also if the WebView had been suspended). The web tone is only a backup
      // for the case where native has nothing pending to ring; a resumed, already fired alarm stays silent.
      void nativeAlarm.wakeNow().then(async (r) => {
        if (r === 'no-pending' && !closed) sound.startAlarm();
        // Stopped on the native screen before this ran: the alarm event was missed, so close instead of showing a silent screen.
        else if (r === 'already-fired' && !closed && (await nativeAlarm.alreadyEnded()) && !closed) dismiss.click();
      });
    } else if (nativeAlarm.enabled) {
      // Resumed after a reload: same stale case, the native Stop may have happened while the app was closed.
      void nativeAlarm.alreadyEnded().then((ended) => {
        if (ended && !closed) dismiss.click();
      });
    }
    const reasonText =
      a.reason === 'smart'
        ? a.stage === 'wake'
          ? 'Smart wake: you were already awake inside your window.'
          : 'Smart wake: you were in light sleep.'
        : a.reason === 'snooze'
          ? 'Snooze ended.'
          : 'Fallback alarm: your wake window ended before a light-sleep moment was found.';
    const dismiss = h('button', { type: 'button', id: 'dismiss', class: 'btn primary big' }, 'Dismiss');
    const snz = h('button', { type: 'button', id: 'snooze', class: 'btn big' }, 'Snooze 9 min');
    const wake = h('p', { id: 'sound-warning', class: 'banner', hidden: true }, 'Tap anywhere to start the sound.');
    const screen = h(
      'main',
      { class: 'screen alarm', id: 'alarm-screen' },
      h('h1', null, 'Wake up'),
      h('div', { class: 'clock' }, fmtClock(Date.now())),
      h('p', { id: 'alarm-reason', class: 'reason' }, reasonText),
      wake,
      dismiss,
      snz,
    );
    // The tone graph exists already; a tap only has to resume a context the browser kept suspended.
    screen.addEventListener('pointerdown', () => void sound.unlock().then((ok) => (wake.hidden = ok)));
    setTimeout(() => {
      wake.hidden = sound.running;
    }, 300);

    // Stop, Snooze or the 15-minute silence on the native alarm screen or notification: mirror it here.
    const offAlarmEnded = nativeAlarm.onAlarmEnded(Date.now() - 2000, (reason) => {
      if (closed) return;
      if (reason === 'snoozed') snz.click();
      else dismiss.click();
    });
    const finish = () => {
      closed = true;
      offAlarmEnded();
      sound.stopAlarm();
      snooze?.stop();
      snooze = null;
    };
    dismiss.addEventListener('click', () => {
      finish();
      void nativeAlarm.disarm();
      session?.release();
      const saved = session?.saved ?? loadHistory().find((n) => n.alarm?.at === a.at) ?? null;
      clearActive();
      session = null;
      if (saved) showSummary(saved.id);
      else showSetup();
    });
    snz.addEventListener('click', () => {
      finish();
      const end = Date.now() + SNOOZE_MS;
      void nativeAlarm.rearmAt(end);
      snooze = new AlarmScheduler({
        windowEnd: end,
        onTick: () => null,
        onFire: (d) => showAlarm({ reason: 'snooze', at: d.at, stage: 'unknown' }),
      });
      snooze.start();
      show(
        h(
          'main',
          { class: 'screen alarm' },
          h('h1', null, 'Snoozing'),
          h('p', { id: 'snooze-note' }, `Alarm rings again at ${fmtClock(end)}. Keep this screen open.`),
          (() => {
            const cancel = h('button', { type: 'button', id: 'snooze-cancel', class: 'btn' }, 'Cancel snooze');
            cancel.addEventListener('click', () => {
              snooze?.stop();
              snooze = null;
              void nativeAlarm.disarm();
              session?.release();
              session = null;
              clearActive();
              showSetup();
            });
            return cancel;
          })(),
        ),
      );
    });
    show(screen);
  }

  // ---------- Summary / history ----------
  function showSummary(id?: number): void {
    const nights = loadHistory();
    const night: StoredNight | undefined = nights.find((n) => n.id === id) ?? nights[0];
    const back = h('button', { type: 'button', id: 'back', class: 'btn' }, 'Back');
    back.addEventListener('click', showSetup);
    const parts: Array<Node | false> = [h('h1', null, 'Night summary')];

    if (!night) {
      parts.push(h('p', { id: 'empty' }, 'No nights recorded yet.'));
    } else {
      const sm = night.summary;
      const m = sm.minutesPerStage;
      parts.push(
        h('p', { class: 'dim', id: 'summary-date' }, `${fmtDate(night.id)}${night.demo ? ' (demo night)' : ''}`),
        h('div', { class: 'score', id: 'score', 'aria-label': `Sleep score ${sm.quality} out of 100` }, h('span', { class: 'num' }, String(sm.quality)), h('span', null, 'sleep score')),
        h(
          'dl',
          { class: 'stats', id: 'stats' },
          ...[
            ['Total sleep', fmtHours(sm.totalSleepMin)],
            ['Efficiency', `${Math.round(sm.efficiency)}%`],
            ['Fell asleep after', sm.sleepOnsetLatencyMin === null ? 'n/a' : `${Math.round(sm.sleepOnsetLatencyMin)} min`],
            ['Awakenings', String(sm.awakenings)],
            ['Light', `${Math.round(m.light)} min`],
            ['Deep', `${Math.round(m.deep)} min`],
            ['REM', `${Math.round(m.rem)} min`],
            ['Awake', `${Math.round(m.wake)} min`],
            ['Alarm', night.alarm ? `${night.alarm.reason} at ${fmtClock(night.alarm.at)}` : 'stopped manually'],
          ].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
        ),
        !!sm.sourceEpochs && h('p', { class: 'hint', id: 'source-share' }, sourceShareText(sm.sourceEpochs as { watch: number; phone: number; none: number })),
        h('div', { class: 'hyp-wrap', id: 'hypnogram-wrap' }, drawHypnogram(sm.hypnogram, (night.binEpochs * 30) / 60)),
        h('p', { class: 'hint' }, 'Stages are estimated from motion and heart rate. They are not a medical measurement.'),
      );
    }

    const list = h('ul', { id: 'history-list', class: 'plain' });
    for (const n of nights) {
      const b = h('button', { type: 'button', class: 'btn row-btn', 'data-id': String(n.id) }, `${fmtDate(n.id)}${n.demo ? ' (demo)' : ''}: score ${n.summary.quality}, ${fmtHours(n.summary.totalSleepMin)}`);
      b.addEventListener('click', () => showSummary(n.id));
      list.append(h('li', null, b));
    }
    const del = h('button', { type: 'button', id: 'delete-all', class: 'btn danger' }, 'Delete all data');
    const delBox = h('div', null, del);
    del.addEventListener('click', () => {
      const yes = h('button', { type: 'button', id: 'delete-confirm', class: 'btn danger' }, 'Yes, delete everything');
      const no = h('button', { type: 'button', class: 'btn' }, 'Cancel');
      no.addEventListener('click', () => delBox.replaceChildren(del));
      yes.addEventListener('click', () => {
        deleteAll();
        void nativeAlarm.clearNight();
        showSummary();
      });
      delBox.replaceChildren(h('p', { class: 'dim' }, 'Removes every stored night and your settings from this device.'), yes, no);
    });

    show(
      h(
        'main',
        { class: 'screen summary' },
        ...parts,
        h('h2', null, 'History'),
        nights.length ? list : h('p', { class: 'hint' }, 'Nothing stored.'),
        h('p', { class: 'hint' }, 'Data stays on this device. Only summaries and a coarse hypnogram are kept, never raw sensor data.'),
        delBox,
        back,
      ),
    );
  }

  // ---------- Boot: resume an interrupted night ----------
  const active = loadActive();
  const now = Date.now();
  if (active && active.fired && now - active.fired.at < STALE_MS) {
    showAlarm(active.fired, { resumed: true });
  } else if (active && !active.fired && now < active.windowEnd + STALE_MS) {
    void beginNight(active, { demo: false, resumed: true });
  } else {
    if (active) clearActive();
    showSetup();
  }
}
