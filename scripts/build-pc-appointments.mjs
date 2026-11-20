// Materialise the Lok Sabha appointment callouts shown on the map.
// The source tracker is not available on GitHub Pages, and computing polygon
// adjacency in the browser would delay every filter change, so both the
// appointment roll-up and the neighbouring AC numbers are derived here once.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topology } from 'topojson-server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSEMBLY = join(ROOT, 'Data', 'UTTAR PRADESH_ASSEMBLY.geojson');
const TEAM = join(ROOT, 'public', 'team-appointments.json');
const TARGET = join(ROOT, 'public', 'pc-appointments.json');

const [assembly, team] = await Promise.all([
  readFile(ASSEMBLY, 'utf8').then((text) => JSON.parse(text)),
  readFile(TEAM, 'utf8').then((text) => JSON.parse(text)),
]);

if (assembly.type !== 'FeatureCollection' || assembly.features.length !== 403) {
  throw new Error('Expected all 403 assembly constituencies in the source GeoJSON');
}

// Every Appointed row at Vidhan Sabha level belongs to an AC number such as
// "39 - धनौरा"; the leading number is the reliable join key across the tracker
// and the assembly geometry.
const appointedByAc = new Map();
for (const row of team.rows) {
  if (row.level !== 'Vidhan Sabha' || !/appoint/i.test(row.status || '')) continue;
  const no = Number(String(row.ac || '').match(/^\s*(\d+)/)?.[1]);
  if (!Number.isFinite(no)) continue;
  appointedByAc.set(no, (appointedByAc.get(no) || 0) + 1);
}

// Shared arcs are exact shared borders in the generated topology. A seat
// borders another seat when one of those arcs appears in both geometries.
const topo = topology({ ac: { type: 'FeatureCollection', features: assembly.features } });
const geometries = topo.objects.ac.geometries;
const arcOwners = new Map();
const collectArcs = (node, out = []) => {
  if (typeof node === 'number') out.push(Math.abs(node));
  else if (Array.isArray(node)) for (const value of node) collectArcs(value, out);
  return out;
};
geometries.forEach((geometry, index) => {
  for (const arc of collectArcs(geometry.arcs)) {
    if (!arcOwners.has(arc)) arcOwners.set(arc, []);
    arcOwners.get(arc).push(index);
  }
});
const neighboursByIndex = geometries.map(() => new Set());
for (const owners of arcOwners.values()) {
  for (let a = 0; a < owners.length; a += 1) {
    for (let b = a + 1; b < owners.length; b += 1) {
      neighboursByIndex[owners[a]].add(owners[b]);
      neighboursByIndex[owners[b]].add(owners[a]);
    }
  }
}

const rollup = new Map();
for (const feature of assembly.features) {
  const props = feature.properties || {};
  const pcNo = Number(props.PC_NO);
  if (!Number.isFinite(pcNo)) continue;
  const acNo = Number(props.AC_NO);
  const row = rollup.get(pcNo) || {
    no: pcNo,
    name: String(props.PC_NAME || '').trim(),
    acCount: 0,
    acAppointed: 0,
    appointed: 0,
    inside: [],
  };
  row.acCount += 1;
  row.inside.push(acNo);
  const appointed = appointedByAc.get(acNo) || 0;
  if (appointed) {
    row.acAppointed += 1;
    row.appointed += appointed;
  }
  rollup.set(pcNo, row);
}

const total = Number(team.totals?.appointed) || team.rows.length;
const pcs = {};
for (const [pcNo, row] of rollup) {
  const outside = new Set();
  for (const index of row.inside) {
    const geometryIndex = geometries.findIndex(
      (geometry) => Number(geometry.properties?.AC_NO) === index,
    );
    if (geometryIndex < 0) continue;
    for (const neighbour of neighboursByIndex[geometryIndex]) {
      if (Number(geometries[neighbour].properties?.PC_NO) !== pcNo) {
        outside.add(Number(geometries[neighbour].properties?.AC_NO));
      }
    }
  }
  pcs[pcNo] = {
    no: pcNo,
    name: row.name,
    appointed: row.appointed,
    share: Math.round((row.appointed / total) * 1000) / 10,
    acCount: row.acCount,
    acAppointed: row.acAppointed,
    coverage: Math.round((row.acAppointed / row.acCount) * 1000) / 10,
    neighbours: [...outside].filter(Number.isFinite).sort((a, b) => a - b),
  };
}

await writeFile(TARGET, `${JSON.stringify({ total, pcs })}\n`);
console.log(
  `Lok Sabha appointments → public/pc-appointments.json ` +
    `(${Object.keys(pcs).length} seats, ${total} appointments)`,
);
