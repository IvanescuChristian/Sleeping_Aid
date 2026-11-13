// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import type { Stage } from '../engine/types';

const NS = 'http://www.w3.org/2000/svg';
/** Top to bottom, the conventional hypnogram order. */
const LEVELS: Stage[] = ['wake', 'rem', 'light', 'deep'];
const LABELS: Record<Stage, string> = { wake: 'Awake', rem: 'REM', light: 'Light', deep: 'Deep', unknown: 'No data' };

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** SVG hypnogram; one block per stored bin. Static, so it costs nothing after drawing. */
export function drawHypnogram(hyp: readonly Stage[], binMin: number): SVGElement {
  const W = 600;
  const H = 130;
  const left = 46;
  const rowH = 26;
  const plotW = W - left - 6;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'hypnogram', role: 'img', preserveAspectRatio: 'none' });
  const totalMin = hyp.length * binMin;
  root.setAttribute('aria-label', `Hypnogram of ${Math.round(totalMin)} minutes: stages over time, top row awake, bottom row deep sleep.`);
  LEVELS.forEach((s, i) => {
    const y = 6 + i * rowH;
    root.append(svg('line', { x1: left, x2: W - 6, y1: y + rowH / 2, y2: y + rowH / 2, class: 'hyp-grid' }));
    const t = svg('text', { x: 4, y: y + rowH / 2 + 4, class: 'hyp-label' });
    t.textContent = LABELS[s];
    root.append(t);
  });
  const bw = hyp.length ? plotW / hyp.length : plotW;
  hyp.forEach((s, i) => {
    const row = LEVELS.indexOf(s);
    if (row < 0) return;
    root.append(svg('rect', { x: left + i * bw, y: 6 + row * rowH + 4, width: Math.max(1, bw + 0.5), height: rowH - 8, class: `hyp-${s}`, rx: 1 }));
  });
  return root;
}
