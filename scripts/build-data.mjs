// Builds every derived artefact the server and the map need.
// Raw data stays in Data/; this script never mutates it.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { geoArea, geoCentroid } from 'd3';

import { loadBooths } from './lib/csv.mjs';
import { loadBoothMeta, assembleBoothOrg, writeBoothOrg, attachOrgSummaries } from './lib/org.mjs';
import { matchVillages, fold } from './lib/match.mjs';
import {
  readJson,
  writeJson,
  simplifyTopo,
  pointsToGeoJson,
  buildVillageChunks,
  buildVillageGrid,
  buildVillageBoundaryChunks,
  topoFeatureCount,
  rewindGeometry,
} from './lib/geo.mjs';

const RAW = resolve('Data');
const BUILD = resolve('build');
const MAP = resolve(BUILD, 'map');
const CHUNKS = resolve(MAP, 'ac');
const VILLAGE_DATA = resolve(BUILD, 'villages');
const NETWORK_DATA = resolve(BUILD, 'village-networks');
const NETWORK_BOUNDARIES = resolve(MAP, 'village-networks');
const REPORTS = resolve('reports');
const PANCHAYAT_SUMMARIES = resolve(RAW, 'amethi-panchayat.json');

const t0 = Date.now();
const log = (msg) => console.log(`[data ${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const EARTH_KM2 = 6371.0088 ** 2;
// Census rings are wound clockwise, which D3 treats as the whole globe.
// rewindGeometry() normalises them before area/centroid math.
function areaKm2(feature) {
  return geoArea({ type: 'Feature', geometry: rewindGeometry(feature.geometry) }) * EARTH_KM2;
}

const titleCase = (value) =>
  value
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Of|And|The)\b/g, (m) => m.toLowerCase());

// ---------------------------------------------------------------- source files
const files = {
  booths: resolve(RAW, 'Uttar Pradesh 2026 (AC_Booth & Village list).csv'),
  boothMeta: resolve(RAW, 'UP_Booth_Meta.csv'),
  assembly: resolve(RAW, 'UTTAR PRADESH_ASSEMBLY.geojson'),
  parliament: resolve(RAW, 'UTTAR PRADESH_parliament.geojson'),
  districts: resolve(RAW, 'UTTAR PRADESH_DISTRICTS.geojson'),
  subdistricts: resolve(RAW, 'UTTAR PRADESH_SUBDISTRICTS.geojson'),
  villages: resolve(RAW, 'UTTAR PRADESH_VILLAGES.geojson'),
  districtHq: resolve(RAW, 'UTTAR PRADESH District Hq.geojson'),
  subdistrictHq: resolve(RAW, 'UTTAR PRADESH Sub District Hq.geojson'),
  soiVillageBoundaries: resolve('vb_soi_up.GeoJSON'),
};
for (const [key, path] of Object.entries(files)) {
  if (!existsSync(path)) throw new Error(`Missing source file (${key}): ${path}`);
}
if (!existsSync(PANCHAYAT_SUMMARIES)) {
  throw new Error(`Missing Amethi Panchayat summaries: ${PANCHAYAT_SUMMARIES}`);
}

rmSync(BUILD, { recursive: true, force: true });
mkdirSync(CHUNKS, { recursive: true });
mkdirSync(VILLAGE_DATA, { recursive: true });
mkdirSync(NETWORK_DATA, { recursive: true });
mkdirSync(NETWORK_BOUNDARIES, { recursive: true });
mkdirSync(REPORTS, { recursive: true });

// ------------------------------------------------------------------ 1. booths
log('parsing booth list');
const { booths } = loadBooths(files.booths);
const boothsByAc = new Map();
const labelCountsByAc = new Map(); // ac -> Map(label -> booth count)
const acNamesFromCsv = new Map();

for (const booth of booths) {
  boothsByAc.set(booth.acNo, (boothsByAc.get(booth.acNo) ?? 0) + 1);
  if (!labelCountsByAc.has(booth.acNo)) labelCountsByAc.set(booth.acNo, new Map());
  const counts = labelCountsByAc.get(booth.acNo);
  counts.set(booth.villageLabel, (counts.get(booth.villageLabel) ?? 0) + 1);
  acNamesFromCsv.set(booth.acNo, booth.acName);
}
const totalBooths = booths.length;
log(`${totalBooths.toLocaleString('en-IN')} booths, ${labelCountsByAc.size} ACs`);

log('joining zila, mandal and shakti kendra from UP_Booth_Meta.csv');
const boothMetaByKey = loadBoothMeta(files.boothMeta);
const boothOrg = assembleBoothOrg(booths, boothMetaByKey);
if (boothOrg.org.booths !== totalBooths) {
  throw new Error(`Booth meta linked ${boothOrg.org.booths} of ${totalBooths} booths`);
}
log(
  `${boothOrg.org.zilas.toLocaleString('en-IN')} zila · ` +
    `${boothOrg.org.mandals.toLocaleString('en-IN')} mandal · ` +
    `${boothOrg.org.shaktiKendras.toLocaleString('en-IN')} shakti kendra`,
);

// --------------------------------------------------------- 2. state-wide layers
log('reading assembly for AC metadata + areas');
const assemblyRaw = readJson(files.assembly);
const assemblyByAc = new Map();
for (const f of assemblyRaw.features) {
  const p = f.properties;
  assemblyByAc.set(Number(p.AC_NO), {
    no: Number(p.AC_NO),
    name: (p.AC_NAME || '').trim(),
    displayName: (p.AC_NAME || '').trim(),
    districtCode: String(p.dtcode11 ?? '').trim(),
    districtUpper: (p.DIST_NAME || '').trim(),
    pcNo: Number(p.PC_NO) || null,
    pcName: (p.PC_NAME || '').trim() || null,
    areaKm2: areaKm2(f),
  });
}
log(`${assemblyByAc.size} assembly constituencies`);

log('reading district metadata + areas');
const districtsRaw = readJson(files.districts);

// The district layer and the village layer spell some names differently
// (Faizabad/Ayodhya, Bara Banki/Barabanki, Kushinagar/Kushi Nagar, …).
// Normalise to letters-only keys and map legacy names to their modern form.
const DISTRICT_ALIAS = new Map([['faizabad', 'ayodhya']]);
const MODERN_DISTRICT = new Map([['ayodhya', 'Ayodhya']]);
const districtKey = (name) => {
  const key = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return DISTRICT_ALIAS.get(key) ?? key;
};

const districtByCode = new Map();
const districtByKey = new Map();
for (const f of districtsRaw.features) {
  const p = f.properties;
  const code = String(p.dtcode11 ?? '').trim();
  const layerName = (p.dtname || '').trim();
  const key = districtKey(layerName);
  const district = {
    code,
    name: MODERN_DISTRICT.get(key) ?? layerName,
    layerName,
    areaKm2: areaKm2(f),
    acs: [],
    booths: 0,
    villages: 0,
    gps: 0,
    blocks: 0,
  };
  districtByCode.set(code, district);
  districtByKey.set(key, district);
}

log('reading parliament metadata + areas');
const parliamentRaw = readJson(files.parliament);
const parliamentByNo = new Map();
for (const f of parliamentRaw.features) {
  const p = f.properties;
  parliamentByNo.set(Number(p.PC_NO), {
    no: Number(p.PC_NO),
    name: (p.PC_NAME || '').trim(),
    areaKm2: areaKm2(f),
    acs: 0,
    booths: 0,
    villages: 0,
  });
}

// A few ACs carry legacy district codes or names (e.g. Kheragarh → Agra,
// Sambhal ACs → Moradabad/Budaun), so resolve by code, then by name.
const districtByUpper = new Map(
  [...districtByCode.values()].map((d) => [d.layerName.toUpperCase(), d]),
);
const resolveDistrict = (ac) =>
  districtByCode.get(ac.districtCode) ??
  districtByKey.get(districtKey(ac.districtUpper)) ??
  districtByUpper.get((ac.districtUpper || '').toUpperCase()) ??
  null;

// --------------------------------------------------------------- 3. villages
log('reading village polygons (this is the big one)');
const villagesRaw = readJson(files.villages);
const rawVillageCount = villagesRaw.features.length;
const villageMeta = [];
const villagesByAc = new Map();
const villageMetaByAc = new Map();
const districtVillageStats = new Map();
const acDistrictVotes = new Map();

let emptyGeometry = 0;
let blankNames = 0;
for (const f of villagesRaw.features) {
  const p = f.properties ?? {};
  const acNo = Number(p.ac_no);
  if (!acNo || !f.geometry) {
    emptyGeometry++;
    continue;
  }
  const id = String(p.vil_lgd || p.objectid || p.id || '');
  if (!id) {
    emptyGeometry++;
    continue;
  }
  const name = (p.vilname11 || '').trim() || null;
  if (!name) blankNames++;

  const geometry = rewindGeometry(f.geometry);
  f.geometry = geometry;

  let centroid = null;
  try {
    centroid = geoCentroid({ type: 'Feature', geometry });
    if (!Number.isFinite(centroid[0]) || !Number.isFinite(centroid[1])) centroid = null;
  } catch {
    centroid = null;
  }

  const meta = {
    id,
    acNo,
    name,
    gpCode: p.gp_code || null,
    gpName: (p.gp_name || '').trim() || null,
    block: (p.block_name || '').trim() || null,
    blockKey: p.block_lgd || p.block_name || null,
    district: (p.dtname || '').trim() || null,
    centroid,
  };
  villageMeta.push(meta);

  if (!villagesByAc.has(acNo)) villagesByAc.set(acNo, []);
  villagesByAc.get(acNo).push({ id, name, gp: meta.gpCode });
  if (!villageMetaByAc.has(acNo)) villageMetaByAc.set(acNo, new Map());
  villageMetaByAc.get(acNo).set(id, meta);

  const dkey = meta.district ? districtKey(meta.district) : null;
  if (dkey) {
    if (!districtVillageStats.has(dkey)) {
      districtVillageStats.set(dkey, { villages: 0, gps: new Set(), blocks: new Set() });
    }
    const ds = districtVillageStats.get(dkey);
    ds.villages++;
    if (meta.gpCode) ds.gps.add(meta.gpCode);
    if (meta.blockKey) ds.blocks.add(meta.blockKey);

    // Modern district name per AC, by majority of its village polygons.
    if (!acDistrictVotes.has(acNo)) acDistrictVotes.set(acNo, new Map());
    const votes = acDistrictVotes.get(acNo);
    votes.set(dkey, (votes.get(dkey) ?? 0) + 1);
  }
}
log(
  `${villageMeta.length.toLocaleString('en-IN')} villages, ${blankNames} blank names, ${emptyGeometry} unusable geometries`,
);

// AC → district as the village layer sees it (fixes legacy assembly codes such
// as Sambhal ACs labelled Moradabad/Budaun, and Kheragarh labelled code 106).
const acDistrictName = new Map();
for (const [acNo, votes] of acDistrictVotes) {
  const [key] = [...votes].sort((a, b) => b[1] - a[1])[0];
  const district = districtByKey.get(key);
  if (district) acDistrictName.set(acNo, district.name);
}
const districtForAc = (ac) =>
  districtByKey.get(districtKey(acDistrictName.get(ac.no) ?? '')) ?? resolveDistrict(ac);

// ------------------------------------------------- 4. village <-> booth matching
log('matching booth-list village labels to village polygons');
const labelsByAc = new Map();
for (const [acNo, counts] of labelCountsByAc) labelsByAc.set(acNo, [...counts.keys()]);
const { results: matchesByAc } = matchVillages(labelsByAc, villagesByAc);

const boothCountsByAc = new Map(); // ac -> Map(villageId -> booths)
const matchedBoothsByAc = new Map();
const matchedLabelsByAc = new Map();
const reportRows = [];

for (const [acNo, counts] of labelCountsByAc) {
  const matches = matchesByAc.get(acNo) ?? new Map();
  const perVillage = new Map();
  let matchedBooths = 0;
  let matchedLabels = 0;

  for (const [label, boothCount] of counts) {
    const match = matches.get(label);
    if (match?.id) {
      perVillage.set(match.id, (perVillage.get(match.id) ?? 0) + boothCount);
      matchedBooths += boothCount;
      matchedLabels++;
    }
    reportRows.push({
      acNo,
      acName: assemblyByAc.get(acNo)?.name ?? acNamesFromCsv.get(acNo) ?? '',
      label,
      booths: boothCount,
      status: match?.status ?? 'unmatched',
      score: Number((match?.score ?? 0).toFixed(3)),
      ambiguous: match?.ambiguous ? 'yes' : '',
      villageId: match?.id ?? '',
      villageName: match?.name ?? '',
      secondName: match?.second?.name ?? '',
      secondScore: match?.second?.score != null ? Number(match.second.score.toFixed(3)) : '',
    });
  }

  boothCountsByAc.set(acNo, perVillage);
  matchedBoothsByAc.set(acNo, matchedBooths);
  matchedLabelsByAc.set(acNo, matchedLabels);
}
const matchedBoothTotal = [...matchedBoothsByAc.values()].reduce((a, b) => a + b, 0);
log(
  `linked ${matchedBoothTotal.toLocaleString('en-IN')}/${totalBooths.toLocaleString('en-IN')} booths (${((matchedBoothTotal / totalBooths) * 100).toFixed(1)}%)`,
);

// ------------------------------------------------------ 5. per-AC village topos
log('building per-AC TopoJSON chunks');
const chunks = buildVillageChunks(villagesRaw.features, boothCountsByAc);
for (const [acNo, chunk] of chunks) {
  writeFileSync(resolve(CHUNKS, `${acNo}.topo.json`), chunk.json);
}
villagesRaw.features.length = 0;
const chunkBytes = [...chunks.values()].reduce((a, c) => a + c.json.length, 0);
log(`${chunks.size} chunks, ${(chunkBytes / 1048576).toFixed(1)} MB total`);

// village booth counts + district/ac aggregates

const acVillageStats = new Map();
for (const v of villageMeta) {
  if (!acVillageStats.has(v.acNo)) {
    acVillageStats.set(v.acNo, { villages: 0, gps: new Set(), blocks: new Set(), withBooths: 0 });
  }
  const s = acVillageStats.get(v.acNo);
  s.villages++;
  if (v.gpCode) s.gps.add(v.gpCode);
  if (v.blockKey) s.blocks.add(v.blockKey);
  v.boothCount = boothCountsByAc.get(v.acNo)?.get(v.id) ?? 0;
  if (v.boothCount > 0) s.withBooths++;
}

const grid = buildVillageGrid(villageMeta);
writeJson(resolve(MAP, 'village-grid.json'), grid);
log(`village grid: ${grid.cells.length} cells`);

// ------------------------------------------------------------------ 6. labels
log('writing label index for search + drill-down panels');
const labelEntries = [];
for (const [acNo, counts] of labelCountsByAc) {
  const matches = matchesByAc.get(acNo) ?? new Map();
  for (const [label, boothCount] of counts) {
    const match = matches.get(label);
    labelEntries.push({
      l: label,
      ac: acNo,
      b: boothCount,
      i: match?.id ?? null,
      n: match?.name ?? null,
      s: match?.score ?? 0,
      st: match?.status ?? 'unmatched',
      amb: match?.ambiguous ?? false,
    });
  }
}
labelEntries.sort((a, b) => a.l.localeCompare(b.l, 'en'));
writeJson(resolve(BUILD, 'labels.json'), labelEntries);
log(`${labelEntries.length.toLocaleString('en-IN')} AC/label pairs`);

// Every named village, independent of whether a booth label matched it, so
// search works for the full settlement list, not just linked ones.
const villageIndex = villageMeta
  .filter((v) => v.name)
  .map((v) => [v.name, v.acNo, v.id, v.boothCount]);
writeJson(resolve(BUILD, 'villages-index.json'), villageIndex);
log(`${villageIndex.length.toLocaleString('en-IN')} searchable village names`);

// Compact block-sized network chunks keep the graph responsive while links
// remain grounded in shared Gram Panchayat membership.
const networkGroups = new Map();
for (const village of villageMeta) {
  const district =
    districtByKey.get(districtKey(village.district))?.name || village.district || 'अज्ञात ज़िला';
  const blockKey = String(village.blockKey ?? village.block ?? '').trim() || 'unknown';
  const key = JSON.stringify([district, blockKey]);
  if (!networkGroups.has(key)) {
    networkGroups.set(key, {
      district,
      blockKey,
      blockName: village.block || 'ब्लॉक का नाम उपलब्ध नहीं',
      villages: [],
    });
  }
  networkGroups.get(key).villages.push(village);
}

const networkIndex = new Map();
const villageToNetwork = new Map();
let networkId = 0;
const orderedNetworks = [...networkGroups.values()].sort(
  (a, b) => a.district.localeCompare(b.district, 'en') || a.blockKey.localeCompare(b.blockKey, 'en'),
);
for (const group of orderedNetworks) {
  const id = String(++networkId);
  const nodes = group.villages.map((village) => ({
    id: village.id,
    name: village.name || 'अनाम गाँव',
    gpCode: village.gpCode ? String(village.gpCode) : null,
    gpName: village.gpName,
    booths: village.boothCount ?? 0,
    ac: village.acNo,
    location: village.centroid,
  }));
  for (const node of nodes) {
    if (!villageToNetwork.has(node.id)) villageToNetwork.set(node.id, []);
    villageToNetwork.get(node.id).push({
      chunkId: id,
      name: node.name,
      location: node.location,
    });
  }
  const gpGroups = new Map();
  for (const node of nodes) {
    if (!node.gpCode) continue;
    if (!gpGroups.has(node.gpCode)) gpGroups.set(node.gpCode, []);
    gpGroups.get(node.gpCode).push(node);
  }
  const links = [];
  for (const members of gpGroups.values()) {
    members.sort(
      (a, b) =>
        (a.location?.[0] ?? 0) - (b.location?.[0] ?? 0) ||
        (a.location?.[1] ?? 0) - (b.location?.[1] ?? 0) ||
        a.id.localeCompare(b.id, 'en'),
    );
    for (let i = 1; i < members.length; i++) {
      links.push({
        source: members[i - 1].id,
        target: members[i].id,
        gpCode: members[i].gpCode,
      });
    }
  }
  writeJson(resolve(NETWORK_DATA, `${id}.json`), {
    district: group.district,
    block: group.blockName,
    nodes,
    links,
  });

  if (!networkIndex.has(group.district)) networkIndex.set(group.district, []);
  networkIndex.get(group.district).push({
    id,
    name: group.blockName,
    villages: nodes.length,
    gps: gpGroups.size,
  });
}

const villageNetworkIndex = [...networkIndex.entries()]
  .map(([name, blocks]) => ({
    name,
    villages: blocks.reduce((sum, block) => sum + block.villages, 0),
    blocks: blocks.sort((a, b) => b.villages - a.villages || a.name.localeCompare(b.name, 'en')),
  }))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));
writeJson(resolve(BUILD, 'village-network-index.json'), villageNetworkIndex);
log(`${networkId.toLocaleString('en-IN')} block-sized village network chunks`);

log('reprojecting and splitting SOI village boundaries by network block');
const networkBoundaryStats = await buildVillageBoundaryChunks({
  input: files.soiVillageBoundaries,
  temporaryOutput: resolve(BUILD, '.soi-villages.topo.json'),
  outputDir: NETWORK_BOUNDARIES,
  villageToChunk: villageToNetwork,
});
log(
  `SOI boundaries: ${networkBoundaryStats.matchedFeatures.toLocaleString('en-IN')}/` +
    `${networkBoundaryStats.sourceFeatures.toLocaleString('en-IN')} features matched, ` +
    `${networkBoundaryStats.chunks} chunks, ${(networkBoundaryStats.bytes / 1048576).toFixed(1)} MB`,
);

// per-AC label files for the drill-down API
for (const [acNo, counts] of labelCountsByAc) {
  const matches = matchesByAc.get(acNo) ?? new Map();
  const metaById = villageMetaByAc.get(acNo) ?? new Map();
  const labels = [];
  const unlinked = [];
  const byVillage = new Map();
  for (const [label, boothCount] of counts) {
    const m = matches.get(label);
    const entry = {
      l: label,
      b: boothCount,
      i: m?.id ?? null,
      n: m?.name ?? null,
      s: m?.score ?? 0,
      st: m?.status ?? 'unmatched',
      amb: m?.ambiguous ?? false,
    };
    labels.push(entry);
    if (!entry.i) {
      unlinked.push({ l: label, b: boothCount });
      continue;
    }
    if (!byVillage.has(entry.i)) {
      const vm = metaById.get(entry.i);
      byVillage.set(entry.i, {
        id: entry.i,
        name: entry.n,
        gp: vm?.gpCode ?? null,
        gpName: vm?.gpName ?? null,
        block: vm?.block ?? null,
        booths: 0,
      });
    }
    byVillage.get(entry.i).booths += boothCount;
  }
  labels.sort((a, b) => b.b - a.b);
  const villages = [...byVillage.values()].sort((a, b) => b.booths - a.booths);
  writeJson(resolve(VILLAGE_DATA, `${acNo}.json`), { labels, unlinked, villages });
}

// match report
log('writing village-match-report.csv');
const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const reportHeader = [
  'ac_no',
  'ac_name',
  'csv_village_label',
  'booths',
  'status',
  'score',
  'ambiguous',
  'matched_village_id',
  'matched_village_name',
  'runner_up',
  'runner_up_score',
];
const report = [reportHeader.join(',')];
for (const r of reportRows) {
  report.push(
    [
      r.acNo,
      r.acName,
      r.label,
      r.booths,
      r.status,
      r.score,
      r.ambiguous,
      r.villageId,
      r.villageName,
      r.secondName,
      r.secondScore,
    ]
      .map(esc)
      .join(','),
  );
}
writeFileSync(resolve(REPORTS, 'village-match-report.csv'), report.join('\n'));

// district + parliament aggregates
for (const ac of assemblyByAc.values()) {
  const district = districtForAc(ac);
  if (district) {
    district.acs.push(ac.no);
    district.booths += boothsByAc.get(ac.no) ?? 0;
    const stats = acVillageStats.get(ac.no);
    district.villages += stats?.villages ?? 0;
    district.gps += stats?.gps.size ?? 0;
  }
  const pc = parliamentByNo.get(ac.pcNo);
  if (pc) {
    pc.acs++;
    pc.booths += boothsByAc.get(ac.no) ?? 0;
    const stats = acVillageStats.get(ac.no);
    pc.villages += stats?.villages ?? 0;
  }
}
for (const district of districtByCode.values()) {
  const ds = districtVillageStats.get(districtKey(district.name));
  if (ds) {
    district.gps = ds.gps.size;
    district.blocks = ds.blocks.size;
  }
  district.areaKm2 = Number(district.areaKm2.toFixed(2));
  district.boothsPerKm2 = Number((district.booths / district.areaKm2).toFixed(2));
  district.code = undefined;
}

// ------------------------------------------------------------------- 7. metrics
log('computing AC metrics + Booth Saturation Index');
const INDEX_WEIGHTS = [
  { key: 'boothsPerVillage', weight: 25, label: 'बूथ प्रति गाँव' },
  { key: 'boothsPerKm2', weight: 30, label: 'बूथ प्रति वर्ग किमी' },
  { key: 'coverage', weight: 20, label: 'गाँव-बूथ लिंक कवरेज' },
  { key: 'gpsPerKm2', weight: 15, label: 'ग्राम पंचायत घनत्व' },
  { key: 'boothsPerGp', weight: 10, label: 'बूथ प्रति ग्राम पंचायत' },
];

const acs = [...assemblyByAc.values()].map((ac) => {
  const stats = acVillageStats.get(ac.no);
  const booths = boothsByAc.get(ac.no) ?? 0;
  const district =
    acDistrictName.get(ac.no) ??
    resolveDistrict(ac)?.name ??
    titleCase(ac.districtUpper || '');
  const villages = stats?.villages ?? 0;
  const gps = stats?.gps.size ?? 0;
  const blocks = stats?.blocks.size ?? 0;
  const matchedBooths = matchedBoothsByAc.get(ac.no) ?? 0;
  const areaKm2 = Number(ac.areaKm2.toFixed(2));
  return {
    no: ac.no,
    name: ac.name,
    district,
    pcNo: ac.pcNo,
    pcName: ac.pcName,
    areaKm2,
    booths,
    villages,
    gps,
    blocks,
    matchedLabels: matchedLabelsByAc.get(ac.no) ?? 0,
    matchedBooths,
    coverage: booths ? matchedBooths / booths : 0,
    boothsPerVillage: villages ? booths / villages : null,
    boothsPerKm2: areaKm2 ? booths / areaKm2 : null,
    gpsPerKm2: areaKm2 ? gps / areaKm2 : null,
    boothsPerGp: gps ? booths / gps : null,
    urban: villages === 0,
    hasChunk: chunks.has(ac.no),
  };
});

const percentileRanks = (key) => {
  const values = acs
    .map((a) => a[key])
    .filter((v) => v != null && Number.isFinite(v))
    .sort((a, b) => a - b);
  const n = values.length;
  const map = new Map();
  if (!n) return (v) => (v == null ? null : 0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[j + 1] === values[i]) j++;
    const rank = ((i + j) / 2 / (n - 1)) * 100;
    map.set(values[i], rank);
    i = j + 1;
  }
  return (v) => (v == null || !Number.isFinite(v) ? null : map.get(v) ?? 0);
};

const pct = {};
for (const { key } of INDEX_WEIGHTS) pct[key] = percentileRanks(key);

for (const ac of acs) {
  let weighted = 0;
  let weightSum = 0;
  ac.components = {};
  for (const { key, weight } of INDEX_WEIGHTS) {
    const value = ac[key];
    const rank = pct[key](value);
    ac.components[key] = {
      value: value == null ? null : Number(value.toFixed(key === 'coverage' ? 3 : 2)),
      pct: rank == null ? null : Number(rank.toFixed(1)),
    };
    if (rank != null) {
      weighted += rank * weight;
      weightSum += weight;
    }
  }
  ac.index = weightSum ? Number((weighted / weightSum).toFixed(1)) : 0;
  delete ac.areaKm2Raw;
}

acs.sort((a, b) => b.index - a.index);
acs.forEach((ac, i) => (ac.rank = i + 1));

// rounding for transport
for (const ac of acs) {
  for (const key of ['boothsPerVillage', 'boothsPerKm2', 'gpsPerKm2', 'boothsPerGp']) {
    if (ac[key] != null) ac[key] = Number(ac[key].toFixed(2));
  }
  ac.coverage = Number(ac.coverage.toFixed(3));
}
attachOrgSummaries(acs, boothOrg.byAc);

// total GP count across ACs is not unique statewide; count from village meta
const gpSet = new Set();
const blockSet = new Set();
const districtSet = new Set();
for (const v of villageMeta) {
  if (v.gpCode) gpSet.add(v.gpCode);
  if (v.blockKey) blockSet.add(v.blockKey);
  if (v.district) districtSet.add(v.district);
}
const villagesWithBooths = villageMeta.filter((v) => v.boothCount > 0).length;

// ------------------------------------------------------- 8. simplify state layers
log('simplifying boundary layers with mapshaper');
const layerSpecs = [
  {
    key: 'districts',
    input: files.districts,
    percent: 3,
    fields: ['dtname', 'Dist_LGD'],
    file: 'districts.topo.json',
  },
  {
    key: 'parliament',
    input: files.parliament,
    percent: 3,
    fields: ['PC_NO', 'PC_NAME'],
    file: 'parliament.topo.json',
  },
  {
    key: 'assembly',
    input: files.assembly,
    percent: 4,
    fields: ['AC_NO', 'AC_NAME', 'DIST_NAME', 'PC_NO', 'PC_NAME'],
    file: 'assembly.topo.json',
  },
  {
    key: 'subdistricts',
    input: files.subdistricts,
    percent: 2,
    fields: ['sdtname', 'dtname', 'Subdt_LGD'],
    file: 'subdistricts.topo.json',
  },
];

const layers = {};
for (const spec of layerSpecs) {
  const output = resolve(MAP, spec.file);
  const result = await simplifyTopo({
    input: spec.input,
    output,
    percent: spec.percent,
    fields: spec.fields,
  });
  const features = topoFeatureCount(output);
  layers[spec.key] = {
    file: `/data/${spec.file}`,
    bytes: result.bytes,
    features,
    simplifiedTo: `${spec.percent}%`,
  };
  log(`${spec.key}: ${features} features, ${(result.bytes / 1024).toFixed(0)} KB`);
}
layers.villages = {
  dir: '/data/ac',
  chunks: chunks.size,
  bytes: chunkBytes,
  features: villageMeta.length,
};
layers.networkBoundaries = {
  dir: '/data/village-networks',
  chunks: networkBoundaryStats.chunks,
  bytes: networkBoundaryStats.bytes,
  features: networkBoundaryStats.matchedFeatures,
  sourceFeatures: networkBoundaryStats.sourceFeatures,
  simplifiedTo: networkBoundaryStats.simplifiedTo,
  quantization: networkBoundaryStats.quantization,
};

// HQ points
const hqDistricts = pointsToGeoJson(readJson(files.districtHq).features, (p) => ({
  name: (p.DIST_HQNM || p.DIST_HQ || p.DTNAME || '').trim(),
  district: (p.DTNAME || '').trim(),
}));
const hqSubdistricts = pointsToGeoJson(readJson(files.subdistrictHq).features, (p) => ({
  name: (p.NAME11 || p.LOC_NAME || '').trim(),
  district: (p.dtname || '').trim(),
}));
writeJson(resolve(MAP, 'hq-districts.json'), hqDistricts);
writeJson(resolve(MAP, 'hq-subdistricts.json'), hqSubdistricts);
layers.hq = {
  districts: hqDistricts.features.length,
  subdistricts: hqSubdistricts.features.length,
};

// ------------------------------------------------------------------- 9. outputs
const matchStats = {
  labelAcPairs: labelEntries.length,
  auto: labelEntries.filter((l) => l.st === 'auto').length,
  review: labelEntries.filter((l) => l.st === 'review').length,
  unmatched: labelEntries.filter((l) => l.st === 'unmatched').length,
  ambiguous: labelEntries.filter((l) => l.amb).length,
  matchedBooths: matchedBoothTotal,
  totalBooths,
  boothCoveragePct: Number(((matchedBoothTotal / totalBooths) * 100).toFixed(1)),
  labelCoveragePct: Number(
    (((labelEntries.length - labelEntries.filter((l) => l.st === 'unmatched').length) /
      labelEntries.length) *
      100).toFixed(1),
  ),
  villagesWithBooths,
};

const urbanAcs = acs.filter((a) => a.urban).map((a) => ({ no: a.no, name: a.name }));

const meta = {
  builtAt: new Date().toISOString(),
  version: 1,
  sources: {
    booths: {
      file: 'Uttar Pradesh 2026 (AC_Booth & Village list).csv',
      bytes: readFileSync(files.booths).length,
      booths: totalBooths,
      columns: 7,
    },
    boothMeta: {
      file: 'UP_Booth_Meta.csv',
      bytes: readFileSync(files.boothMeta).length,
      booths: boothOrg.org.booths,
      zilas: boothOrg.org.zilas,
      mandals: boothOrg.org.mandals,
      shaktiKendras: boothOrg.org.shaktiKendras,
    },
    villages: {
      file: 'UTTAR PRADESH_VILLAGES.geojson',
      bytes: readFileSync(files.villages).length,
      features: rawVillageCount,
      usable: villageMeta.length,
      withoutAcNumber: emptyGeometry,
      blankNames,
    },
    assembly: { file: 'UTTAR PRADESH_ASSEMBLY.geojson', features: assemblyByAc.size },
    parliament: { file: 'UTTAR PRADESH_parliament.geojson', features: parliamentByNo.size },
    districts: { file: 'UTTAR PRADESH_DISTRICTS.geojson', features: districtByCode.size },
    subdistricts: { file: 'UTTAR PRADESH_SUBDISTRICTS.geojson', features: layers.subdistricts.features },
    soiVillageBoundaries: {
      file: 'vb_soi_up.GeoJSON',
      crs: 'EPSG:7755',
      features: networkBoundaryStats.sourceFeatures,
      matchedFeatures: networkBoundaryStats.matchedFeatures,
    },
  },
  totals: {
    acs: acs.length,
    pc: parliamentByNo.size,
    districts: districtByCode.size,
    subdistricts: layers.subdistricts.features,
    villages: villageMeta.length,
    rawVillages: rawVillageCount,
    unusableVillages: emptyGeometry,
    gps: gpSet.size,
    blocks: blockSet.size,
    villageDistricts: districtSet.size,
    booths: totalBooths,
    villageLabels: new Set(labelEntries.map((l) => l.l)).size,
    labelAcPairs: labelEntries.length,
  },
  match: matchStats,
  org: boothOrg.org,
  indexWeights: INDEX_WEIGHTS,
  layers,
  urbanAcs,
  blankVillageNames: blankNames,
  villagesWithoutGp: villageMeta.filter((v) => !v.gpCode).length,
};

writeBoothOrg(BUILD, boothOrg);
writeJson(resolve(BUILD, 'meta.json'), meta, { pretty: true });
writeJson(resolve(BUILD, 'panchayat.json'), readJson(PANCHAYAT_SUMMARIES));
writeJson(resolve(BUILD, 'acs.json'), acs);
writeJson(
  resolve(BUILD, 'districts.json'),
  [...districtByCode.values()].filter((d) => d.name).sort((a, b) => b.booths - a.booths),
);
writeJson(
  resolve(BUILD, 'pc.json'),
  [...parliamentByNo.values()].sort((a, b) => b.booths - a.booths),
);

log('done');
console.log(
  JSON.stringify(
    {
      totals: meta.totals,
      match: meta.match,
      buildMB: Number(
        Object.values(layers)
          .reduce((a, l) => a + (l.bytes ?? 0), 0) / 1048576,
      ).toFixed(1),
    },
    null,
    2,
  ),
);
