// Materialise the six campaign zones as a small committed browser asset.
// Data/up_kshetra.geojson is deliberately ignored by Git and GitHub Pages never
// reads Data/, so the geometry is copied (and lightly trimmed) into public/.
// Appointment counts come from the already-committed team-appointments.json.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'Data', 'up_kshetra.geojson');
const TEAM = join(ROOT, 'public', 'team-appointments.json');
const TARGET = join(ROOT, 'public', 'up-kshetra.json');

const ZONE_NAMES = {
  Paschim: 'पश्चिम',
  Braj: 'ब्रज',
  Awadh: 'अवध',
  Kanpur: 'कानपुर',
  Gorakhpur: 'गोरखपुर',
  Kashi: 'काशी',
};

const roundCoord = (value) => Math.round(value * 10000) / 10000;
const trim = (node) =>
  Array.isArray(node)
    ? node.map(trim)
    : typeof node === 'number'
      ? roundCoord(node)
      : node;

const [raw, team] = await Promise.all([
  readFile(SOURCE, 'utf8').then((text) => JSON.parse(text)),
  readFile(TEAM, 'utf8').then((text) => JSON.parse(text)),
]);

if (raw.type !== 'FeatureCollection' || raw.features.length !== 6) {
  throw new Error('up_kshetra.geojson must contain exactly six zone features');
}

const total = Number(team.totals?.appointed) || team.rows.length;
const appointedByZone = new Map();
for (const row of team.rows) {
  if (!row.zone || row.status !== 'Appointed') continue;
  appointedByZone.set(row.zone, (appointedByZone.get(row.zone) || 0) + 1);
}

const features = raw.features.map((feature) => {
  const en = String(feature.properties?.kshetra || '');
  const name = ZONE_NAMES[en] || en;
  const appointed = appointedByZone.get(name) || 0;
  return {
    type: 'Feature',
    properties: {
      id: en.toLowerCase(),
      en,
      name,
      appointed,
      share: Math.round((appointed / total) * 1000) / 10,
    },
    geometry: trim(feature.geometry),
  };
});

await writeFile(TARGET, `${JSON.stringify({ total, features })}\n`);
console.log(`Zones → public/up-kshetra.json (${features.length} zones, ${total} appointments)`);
