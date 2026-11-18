// Validates build/ before you trust the page. Run with `npm run check`.
// Exits non-zero on the first failing group so CI/deploy can gate on it.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { geoCentroid } from 'd3';
import { feature as topoFeature } from 'topojson-client';

const BUILD = resolve('build');
const MAP = join(BUILD, 'map');
const CHUNKS = join(MAP, 'ac');
const REPORT = resolve('reports', 'village-match-report.csv');

const failures = [];
const checks = [];
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail });
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

if (!existsSync(BUILD)) {
  console.error('build/ missing. Run "npm run data" first.');
  process.exit(1);
}

const meta = read(join(BUILD, 'meta.json'));
const acs = read(join(BUILD, 'acs.json'));
const districts = read(join(BUILD, 'districts.json'));
const pc = read(join(BUILD, 'pc.json'));
const panchayat = read(join(BUILD, 'panchayat.json'));
const labels = read(join(BUILD, 'labels.json'));
const villageIndex = read(join(BUILD, 'villages-index.json'));
const networkIndex = read(join(BUILD, 'village-network-index.json'));
const grid = read(join(MAP, 'village-grid.json'));

// --------------------------------------------------------------- core totals
check('403 assembly constituencies', acs.length === 403, `found ${acs.length}`);
check('meta.acs matches file', meta.totals.acs === acs.length);
check(
  'booth total matches AC sum',
  acs.reduce((sum, ac) => sum + ac.booths, 0) === meta.totals.booths,
  `${acs.reduce((sum, ac) => sum + ac.booths, 0)} vs ${meta.totals.booths}`,
);
check('booth total is 177,516', meta.totals.booths === 177516, String(meta.totals.booths));
check('80 parliament constituencies', pc.length === 80, String(pc.length));
check('75 districts', districts.length === 75, String(districts.length));
check(
  'village polygons loaded',
  meta.totals.villages > 100000,
  String(meta.totals.villages),
);
check(
  'village count + unusable = raw',
  meta.totals.villages + meta.totals.unusableVillages === meta.totals.rawVillages,
);
check(
  'AC village sum equals village total',
  acs.reduce((sum, ac) => sum + ac.villages, 0) === meta.totals.villages,
  `${acs.reduce((sum, ac) => sum + ac.villages, 0)} vs ${meta.totals.villages}`,
);
check(
  'district booth sum equals state total',
  districts.reduce((sum, d) => sum + d.booths, 0) === meta.totals.booths,
);
check('no district lost its meta join', districts.every((d) => d.acs.length > 0));
const amethiAcs = acs.filter((ac) => ac.district === 'Amethi');
check('Amethi has four assembly constituencies', amethiAcs.length === 4, String(amethiAcs.length));
check('Amethi assembly numbers are unique', new Set(amethiAcs.map((ac) => ac.no)).size === amethiAcs.length);

const org = read(join(BUILD, 'org.json'));
const orgBooths = org.zilas.reduce((sum, zila) => sum + zila.booths, 0);
check('org file lists every zila', org.zilas.length === meta.org?.zilas, `${org.zilas.length} vs ${meta.org?.zilas}`);
check('org booths match the booth list', orgBooths === meta.totals.booths, `${orgBooths} vs ${meta.totals.booths}`);
check('org mandal total is recorded', meta.org?.mandals > 0 && org.totals?.mandals === meta.org.mandals);
check('org shakti kendra total is recorded', meta.org?.shaktiKendras > 0 && org.totals?.shaktiKendras === meta.org.shaktiKendras);
check(
  'every AC carries a zila–mandal–shakti kendra summary',
  acs.every((ac) => ac.org?.zilas?.length && ac.org.mandals > 0 && ac.org.shaktiKendras >= 0),
);
const boothDir = join(BUILD, 'booths');
const boothFiles = existsSync(boothDir) ? readdirSync(boothDir).filter((file) => file.endsWith('.json')) : [];
check('one booth-org file per AC', boothFiles.length === acs.length, String(boothFiles.length));
function countOrgBooths(tree) {
  return (tree?.zilas ?? []).reduce(
    (sum, zila) =>
      sum + zila.mandals.reduce(
        (mandalSum, mandal) =>
          mandalSum + mandal.kendras.reduce((kendraSum, kendra) => kendraSum + kendra.booths.length, 0),
        0,
      ),
    0,
  );
}
const orgSample = read(join(boothDir, '5.json'));
const ac5 = acs.find((ac) => ac.no === 5);
check('AC 5 booth org matches its booth count', countOrgBooths(orgSample) === ac5.booths, String(countOrgBooths(orgSample)));
check(
  'AC 5 summary matches its booth file',
  ac5.org.mandals === orgSample.zilas.reduce((sum, zila) => sum + zila.mandals.length, 0) &&
    ac5.org.shaktiKendras === orgSample.zilas.reduce(
      (sum, zila) => sum + zila.mandals.reduce(
        (inner, mandal) => inner + mandal.kendras.filter((kendra) => !String(kendra.id).startsWith('unassigned:')).length,
        0,
      ),
      0,
    ),
);
check('unassigned booths stay inside their mandal', (meta.org.unassignedBooths ?? 0) >= 0);

// ------------------------------------------------------- panchayat summaries
check('Amethi summary has all blocks', panchayat.blocks.length > 0 && panchayat.district === 'अमेठी');
check(
  'block ward records match district summary',
  panchayat.blocks.reduce((sum, block) => sum + block.kshetraWardCount, 0) === panchayat.kshetraWardRecords,
);
check(
  'block GP rows match district summary',
  panchayat.blocks.reduce((sum, block) => sum + block.gpRecordsCount, 0) === panchayat.gpRecords,
);
check(
  'unique GP names match block lists',
  new Set(panchayat.blocks.flatMap((block) => block.gps)).size === panchayat.uniqueGps,
);

// ------------------------------------------------------------ per-AC sanity
const badArea = acs.filter(
  (ac) => !Number.isFinite(ac.areaKm2) || ac.areaKm2 <= 0 || ac.areaKm2 > 3000,
);
check('all AC areas plausible (0–3000 km²)', badArea.length === 0, badArea.map((a) => `${a.name}:${a.areaKm2}`).join(', '));

const badBooths = acs.filter((ac) => !Number.isFinite(ac.booths) || ac.booths < 50 || ac.booths > 2000);
check('all booth counts plausible (50–2000)', badBooths.length === 0, badBooths.map((a) => `${a.name}:${a.booths}`).join(', '));

const badIndex = acs.filter((ac) => !Number.isFinite(ac.index) || ac.index < 0 || ac.index > 100);
check('saturation index within 0–100', badIndex.length === 0, badIndex.map((a) => `${a.name}:${a.index}`).join(', '));

const ranks = new Set(acs.map((ac) => ac.rank));
check('ranks are unique 1..403', ranks.size === 403 && Math.max(...ranks) === 403);

const badCoverage = acs.filter((ac) => !(ac.coverage >= 0 && ac.coverage <= 1));
check('coverage fractions within 0–1', badCoverage.length === 0);

const weights = meta.indexWeights.reduce((sum, w) => sum + w.weight, 0);
check('index weights sum to 100', weights === 100, String(weights));

const componentKeys = ['boothsPerVillage', 'boothsPerKm2', 'coverage', 'gpsPerKm2', 'boothsPerGp'];
const missingComponents = acs.filter(
  (ac) => !ac.components || componentKeys.some((key) => !(key in ac.components)),
);
check('every AC has all index components', missingComponents.length === 0);

const urban = acs.filter((ac) => ac.villages === 0);
check(
  'urban AC list matches zero-village ACs',
  urban.length === meta.urbanAcs.length &&
    urban.every((ac) => meta.urbanAcs.some((u) => u.no === ac.no)),
);

// -------------------------------------------------------------- match report
const matchedBooths = labels.filter((l) => l.i).reduce((sum, l) => sum + l.b, 0);
check('label index covers every AC/label pair', labels.length === meta.totals.labelAcPairs);
check('matched booth total is consistent', matchedBooths === meta.match.matchedBooths);
check(
  'match percentages are computed from the same numbers',
  meta.match.boothCoveragePct === Number(((meta.match.matchedBooths / meta.match.totalBooths) * 100).toFixed(1)),
);
check(
  'label statuses partition the index',
  meta.match.auto + meta.match.review + meta.match.unmatched === labels.length,
);

const reportLines = readFileSync(REPORT, 'utf8').trim().split('\n');
check(
  'review CSV has one row per AC/label pair',
  reportLines.length === labels.length + 1,
  `${reportLines.length - 1} vs ${labels.length}`,
);
check('review CSV header is stable', reportLines[0].startsWith('ac_no,ac_name,csv_village_label'));

// Village search index (all named polygons, linked or not).
check(
  'village search index covers named villages',
  villageIndex.length > 90000,
  String(villageIndex.length),
);
check(
  'village search rows are [name, ac, id, booths]',
  villageIndex.every(
    (row) =>
      Array.isArray(row) &&
      typeof row[0] === 'string' &&
      Number.isFinite(row[1]) &&
      typeof row[2] === 'string' &&
      Number.isFinite(row[3]),
  ),
);
const networkBlocks = networkIndex.flatMap((district) => district.blocks);
check('village network covers all districts', networkIndex.length === 75, String(networkIndex.length));
check('village network blocks are unique', new Set(networkBlocks.map((block) => block.id)).size === networkBlocks.length);
check('village network covers every usable village', networkBlocks.reduce((sum, block) => sum + block.villages, 0) === meta.totals.villages);
const networkSample = read(join(BUILD, 'village-networks', `${networkBlocks[0]?.id}.json`));
const networkNodesById = new Map(networkSample.nodes.map((node) => [node.id, node]));
check('village network chunks have villages', networkSample.nodes.length > 0);
check(
  'village network nodes have geographic coordinates',
  networkSample.nodes.every(
    (node) =>
      Array.isArray(node.location) &&
      node.location.length === 2 &&
      node.location.every(Number.isFinite),
  ),
);
check(
  'village network links share GP codes',
  networkSample.links.every(
    (link) =>
      networkNodesById.get(link.source)?.gpCode &&
      networkNodesById.get(link.source)?.gpCode === networkNodesById.get(link.target)?.gpCode,
  ),
);
const networkBoundaryDir = join(MAP, 'village-networks');
const networkBoundaryFiles = readdirSync(networkBoundaryDir).filter((file) => file.endsWith('.topo.json'));
check(
  'SOI village boundary chunks match network blocks',
  networkBoundaryFiles.length === networkBlocks.length,
  `${networkBoundaryFiles.length} vs ${networkBlocks.length}`,
);
const networkBoundary = read(join(networkBoundaryDir, `${networkBlocks[0]?.id}.topo.json`));
const boundaryObject = networkBoundary.objects?.v;
const boundaryGeometries = boundaryObject?.geometries ?? [];
check('SOI village boundary chunk has geometries', boundaryGeometries.length > 0);
check(
  'SOI boundary codes match network villages',
  boundaryGeometries.every((geometry) => networkNodesById.has(String(geometry.properties?.vlcode))),
);
const boundaryFeatures = topoFeature(networkBoundary, boundaryObject).features;
const boundaryCenter = boundaryFeatures.length ? geoCentroid(boundaryFeatures[0]) : [];
check(
  'SOI boundaries are reprojected to Uttar Pradesh coordinates',
  boundaryCenter[0] >= 76 &&
    boundaryCenter[0] <= 86 &&
    boundaryCenter[1] >= 23 &&
    boundaryCenter[1] <= 31,
  boundaryCenter.join(','),
);
const candidatesByVillageId = new Map();
for (const block of networkBlocks) {
  const chunk = read(join(BUILD, 'village-networks', `${block.id}.json`));
  for (const node of chunk.nodes) {
    if (!candidatesByVillageId.has(node.id)) candidatesByVillageId.set(node.id, []);
    candidatesByVillageId.get(node.id).push({
      chunkId: block.id,
      name: node.name,
      location: node.location,
    });
  }
}
const ambiguousVillageIds = new Set(
  [...candidatesByVillageId]
    .filter(([, candidates]) => new Set(candidates.map((candidate) => candidate.chunkId)).size > 1)
    .map(([id]) => id),
);
const normalizeVillageName = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const misassignedBoundaries = [];
for (const file of networkBoundaryFiles) {
  const chunkId = file.slice(0, -'.topo.json'.length);
  const topology = read(join(networkBoundaryDir, file));
  for (const geometry of topology.objects.v.geometries) {
    const villageId = String(geometry.properties?.vlcode ?? '');
    if (!ambiguousVillageIds.has(villageId)) continue;
    const candidates = candidatesByVillageId.get(villageId);
    const villageName = normalizeVillageName(geometry.properties?.village);
    const named = candidates.filter((candidate) => normalizeVillageName(candidate.name) === villageName);
    const choices = named.length ? named : candidates;
    const [lon, lat] = geoCentroid(topoFeature(topology, geometry));
    const distance = (candidate) => {
      const [candidateLon, candidateLat] = candidate.location ?? [];
      if (!Number.isFinite(candidateLon) || !Number.isFinite(candidateLat)) return Infinity;
      return Math.hypot(
        (lon - candidateLon) * Math.cos((lat * Math.PI) / 180),
        lat - candidateLat,
      );
    };
    const distanceByChunk = new Map();
    for (const candidate of choices) {
      const current = distanceByChunk.get(candidate.chunkId) ?? Infinity;
      distanceByChunk.set(candidate.chunkId, Math.min(current, distance(candidate)));
    }
    const assignedDistance = distanceByChunk.get(chunkId);
    if (
      assignedDistance === undefined ||
      assignedDistance > Math.min(...distanceByChunk.values()) + 1e-6
    ) {
      misassignedBoundaries.push(villageId);
    }
  }
}
check(
  'duplicate village codes use the nearest network node',
  misassignedBoundaries.length === 0,
  `${misassignedBoundaries.length} mismatches`,
);

// -------------------------------------------------------------------- chunks
const chunkFiles = readdirSync(CHUNKS).filter((file) => file.endsWith('.topo.json'));
check('per-AC chunks exist', chunkFiles.length > 390, String(chunkFiles.length));

let missingChunks = [];
let emptyChunks = [];
let largest = { file: '', bytes: 0 };
for (const ac of acs) {
  const file = join(CHUNKS, `${ac.no}.topo.json`);
  if (ac.villages > 0 && !existsSync(file)) missingChunks.push(ac.no);
  if (!existsSync(file)) continue;
  const bytes = statSync(file).size;
  if (bytes > largest.bytes) largest = { file: `${ac.no}`, bytes };
  if (bytes < 200) emptyChunks.push(ac.no);
}
check('every rural AC has a chunk', missingChunks.length === 0, missingChunks.join(','));
check('no chunk is suspiciously empty', emptyChunks.length === 0, emptyChunks.join(','));
check('largest chunk under 400 KB', largest.bytes < 400 * 1024, `${largest.file}: ${kb(largest.bytes)}`);

const sample = read(join(CHUNKS, '5.topo.json'));
check('chunk is valid TopoJSON', Boolean(sample.objects?.v?.geometries?.length));
const sampleFeature = sample.objects.v.geometries[0];
check(
  'chunk geometries carry name + booths',
  sampleFeature?.properties &&
    'n' in sampleFeature.properties &&
    'c' in sampleFeature.properties,
);

// ------------------------------------------------------------- state layers
const layerFiles = ['assembly.topo.json', 'parliament.topo.json', 'districts.topo.json', 'subdistricts.topo.json'];
for (const file of layerFiles) {
  const path = join(MAP, file);
  check(`layer ${file} exists`, existsSync(path));
  if (existsSync(path)) {
    const bytes = statSync(path).size;
    check(`layer ${file} under 400 KB`, bytes < 400 * 1024, kb(bytes));
    const topo = read(path);
    check(`layer ${file} has geometries`, Boolean(topo.objects?.[Object.keys(topo.objects)[0]]?.geometries?.length));
  }
}
check('HQ point layers exist', existsSync(join(MAP, 'hq-districts.json')) && existsSync(join(MAP, 'hq-subdistricts.json')));

// ---------------------------------------------------------------- village grid
const cells = grid.cells ?? [];
check('village grid has cells', cells.length > 5000, String(cells.length));
const outOfBounds = cells.filter(
  (cell) => cell[0] < 76 || cell[0] > 86 || cell[1] < 23 || cell[1] > 31,
);
check('grid cells stay inside Uttar Pradesh', outOfBounds.length === 0, String(outOfBounds.length));
check('grid records booth sums', cells.some((cell) => cell[3] > 0));
check('grid cell size is documented', grid.cell > 0);

// --------------------------------------------------------------------- print
const width = Math.max(...checks.map((c) => c.label.length));
for (const entry of checks) {
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.label.padEnd(width)}  ${entry.ok ? '' : entry.detail}`);
}
console.log('');
if (failures.length) {
  console.error(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log(
  `All ${checks.length} checks passed · ${acs.length} AC · ${meta.totals.booths.toLocaleString('en-IN')} booths · ` +
    `${meta.totals.villages.toLocaleString('en-IN')} villages · build ${meta.builtAt}`,
);
