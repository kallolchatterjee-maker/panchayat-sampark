// Copies browser builds of D3 + topojson-client into public/vendor so the
// page works without a bundler and without a CDN dependency.
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public/vendor');

const files = [
  ['node_modules/d3/dist/d3.min.js', 'd3.min.js'],
  ['node_modules/topojson-client/dist/topojson-client.min.js', 'topojson-client.min.js'],
];

await mkdir(out, { recursive: true });
for (const [from, to] of files) {
  const src = resolve(root, from);
  if (!existsSync(src)) {
    console.warn(`[vendor] missing ${from} — skipping`);
    continue;
  }
  await copyFile(src, resolve(out, to));
  console.log(`[vendor] ${to}`);
}
