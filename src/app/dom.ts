// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).

type Kid = Node | string | null | undefined | false;
type Props = Record<string, string | boolean | ((e: Event) => void) | undefined> | null;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = String(v);
    else if (k === 'checked' || k === 'disabled') (el as unknown as Record<string, boolean>)[k] = Boolean(v);
    else if (k === 'value') (el as unknown as { value: string }).value = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

export const pad2 = (n: number) => String(n).padStart(2, '0');

export function fmtClock(ts: number, seconds = false): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${seconds ? ':' + pad2(d.getSeconds()) : ''}`;
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fmtHours(min: number): string {
  const m = Math.round(min);
  return `${Math.floor(m / 60)} h ${pad2(m % 60)} min`;
}
