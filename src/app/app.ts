// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { suggestBedtimes } from '../engine/suggest';
import { AlarmSound } from './audio';
import { fmtClock, fmtDate, fmtHours, h } from './dom';
import { drawHypnogram } from './hypnogram';
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

const STAGE_TEXT: Record<string, string> = { wake: 'Awake', light: 'Light sleep', deep: 'Deep sleep', rem: 'REM', unknown: 'Waiting for data' };

export function mountApp(root: HTMLElement): void {
  const sound = new AlarmSound();
  const hr = new HeartRateMonitor();
  let session: NightSession | null = null;
  let snooze: AlarmScheduler | null = null;

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
    const hrBtn = h('button', { type: 'button', id: 'connect-hr', class: 'btn' }, 'Connect heart-rate sensor');
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
          h('label', { class: 'check' }, motion, ' Use motion (phone lying on the mattress)'),
          hrBtn,
          hrNote,
        ),
        h('section', null, h('h2', null, 'Alarm sound'), testBtn, soundNote),
        h('section', null, h('h2', null, 'Bedtime suggestions'), sugg),
        h('p', { class: 'callout', id: 'reliability-note' }, NOTE),
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
    const motionOk = active.useMotion && !o.demo && !o.resumed ? await MotionSensor.requestPermission() : true;
    let notice = '';
    if (!motionOk) {
      active = { ...active, useMotion: false };
      notice = 'Motion permission was denied, so only the wake window (and heart rate, if connected) is used.';
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

  function showNight(s: NightSession, notice: string, demo: boolean, resumed: boolean): void {
    const clock = h('div', { class: 'clock', 'aria-hidden': 'true' }, fmtClock(s.now()));
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
        st.motionState === 'ok' ? `Motion: ${st.motionHz} Hz` : st.motionState === 'off' ? 'Motion: off' : st.motionState === 'none' ? 'Motion: no data from this device' : 'Motion: starting...',
      );
      set(hrLine, st.hrBpm !== null ? `Heart rate: ${st.hrBpm} bpm` : 'no HR');
      const lost = st.wakeLock === 'lost' || st.wakeLock === 'unavailable';
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
        const saved = s.stop();
        paint = null;
        clearActive();
        if (saved) showSummary(saved.id);
        else showSetup();
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
        resumed && h('p', { class: 'banner info' }, 'Night resumed after a reload. Sensor history before the reload is lost; the alarm window is kept. Reconnect heart rate is not possible without a tap.'),
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
  function showAlarm(a: StoredAlarm): void {
    paint = null;
    sound.startAlarm();
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

    const finish = () => {
      sound.stopAlarm();
      snooze?.stop();
      snooze = null;
    };
    dismiss.addEventListener('click', () => {
      finish();
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
    showAlarm(active.fired);
  } else if (active && !active.fired && now < active.windowEnd + STALE_MS) {
    void beginNight(active, { demo: false, resumed: true });
  } else {
    if (active) clearActive();
    showSetup();
  }
}
