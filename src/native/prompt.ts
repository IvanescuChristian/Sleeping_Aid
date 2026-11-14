// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { h } from '../app/dom';
import type { NativeAlarm } from './nativeAlarm';

/**
 * Blocking screen shown when the night cannot be armed because exact alarms are not allowed.
 * `onReady` runs once the permission is present (after "Check again" or when the app regains focus).
 */
export function exactAlarmPrompt(native: NativeAlarm, o: { onReady: () => void; onBack: () => void; reason?: string }): HTMLElement {
  const status = h('p', { id: 'exact-status', class: 'error', role: 'alert' }, o.reason ? `The alarm is NOT armed: ${o.reason}` : 'The alarm is NOT armed.');
  const open = h('button', { type: 'button', id: 'open-exact-settings', class: 'btn primary big' }, 'Open alarm settings');
  const again = h('button', { type: 'button', id: 'exact-check', class: 'btn' }, 'Check again');
  const back = h('button', { type: 'button', id: 'exact-back', class: 'btn' }, 'Back');

  const check = async () => {
    const p = await native.permissions();
    if (p?.exactAlarm) {
      document.removeEventListener('visibilitychange', onVisible);
      o.onReady();
    } else {
      status.textContent = 'Still not allowed. Turn on "Alarms & reminders" for Sleeping Aid, then come back.';
    }
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') void check();
  };
  open.addEventListener('click', () => {
    document.addEventListener('visibilitychange', onVisible);
    void native.openExactAlarmSettings();
  });
  again.addEventListener('click', () => void check());
  back.addEventListener('click', () => {
    document.removeEventListener('visibilitychange', onVisible);
    o.onBack();
  });

  return h(
    'main',
    { class: 'screen setup', id: 'exact-prompt' },
    h('h1', null, 'Allow exact alarms'),
    status,
    h('p', { class: 'lead' }, 'Android must allow Sleeping Aid to set exact alarms. Without this the wake-up alarm could be late or never ring, so the night cannot start.'),
    open,
    again,
    back,
  );
}
