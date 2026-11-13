// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0
// Copyright (c) 2026 Christian Ivanescu. See LICENSE for terms (source-available; not open source).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Fills the service worker's precache list with the files of the finished build. */
function precache(): Plugin {
  let outDir = 'dist';
  return {
    name: 'sleeping-aid-precache',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const files = walk(outDir)
        .map((f) => relative(outDir, f).split('\\').join('/'))
        .filter((f) => f !== 'sw.js');
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const list = ['./', ...files.map((f) => './' + f)];
      const swPath = join(outDir, 'sw.js');
      const sw = readFileSync(swPath, 'utf8')
        .replace('__PRECACHE__', JSON.stringify(list))
        .replace('__BUILD_ID__', hash.digest('hex').slice(0, 12));
      writeFileSync(swPath, sw);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [precache()],
  build: { outDir: 'dist', target: 'es2022' },
  preview: { port: 4173, strictPort: true },
});
