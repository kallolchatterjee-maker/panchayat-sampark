// Loads generated build/ artefacts and selected Data/ sources once and exposes
// the queries the SSR routes and API need.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fold } from '../scripts/lib/match.mjs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

const DEMO_PROGRESS = {
  current: 1847520,
  target: 2630940,
  metrics: [
    { key: 'volunteers', label: 'सक्रिय स्वयंसेवक', value: 1847520 },
    { key: 'villages', label: 'कवर गाँव', value: 68420 },
    { key: 'booths', label: 'सक्रिय बूथ', value: 118430 },
  ],
  updatedAt: '2026-11-16',
  source: 'demo',
};

// The Lok Sabha filter reads PC_NO / PC_NAME straight from the supplied
// GeoJSON. It is a small projection of a large file, so it is done once at
// store load time and shared by SSR and the browser boot payload.
function loadParliamentFilter(root) {
  const path = join(root, 'Data', 'UTTAR PRADESH_parliament.geojson');
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const byNo = new Map();
  for (const feature of raw.features || []) {
    const no = Number(feature?.properties?.PC_NO);
    const name = String(feature?.properties?.PC_NAME || '').trim();
    if (!Number.isFinite(no) || !name || byNo.has(no)) continue;
    byNo.set(no, { no, name });
  }
  return [...byNo.values()].sort((a, b) => a.no - b.no);
}

function loadBoothGrades(root) {
  const path = join(root, 'Data', 'UP_Booth_Analysis_6_yr_on_2026.json');
  const grades = new Map();
  if (!existsSync(path)) return { byBooth: grades, byAc: new Map() };
  let rows = [];
  try {
    rows = read(path);
  } catch {
    return { byBooth: grades, byAc: new Map() };
  }
  const byAc = new Map();
  for (const row of rows) {
    const ac = Number(row['AC']);
    const booth = Number(row['Booth 2026']);
    const grade = String(row['Grade'] || '').trim().toUpperCase();
    if (!Number.isFinite(ac) || !Number.isFinite(booth) || !/^[ABCD]$/.test(grade)) continue;
    grades.set(`${ac}|${booth}`, grade);
    if (!byAc.has(ac)) byAc.set(ac, { A: 0, B: 0, C: 0, D: 0, total: 0 });
    const bucket = byAc.get(ac);
    bucket[grade] += 1;
    bucket.total += 1;
  }
  return { byBooth: grades, byAc };
}

function hashString(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const INFLUENCE_BUCKETS = ['<100', '100-300', '300+'];

function demoTeamForNode(node) {
  const seed = hashString(String(node.id ?? node.name ?? 'x'));
  const count = 5 + (seed % 3); // 5-7
  const team = [];
  for (let i = 0; i < count; i++) {
    const s = hashString(`${node.id}:${i}:${seed}`);
    const bucket = INFLUENCE_BUCKETS[s % INFLUENCE_BUCKETS.length];
    const influence =
      bucket === '<100' ? 20 + (s % 80) : bucket === '100-300' ? 100 + (s % 201) : 300 + (s % 451);
    const isPradhan = i === 0;
    team.push({
      id: `${node.id}-m${i + 1}`,
      name: isPradhan ? 'प्रधान' : `सदस्य ${i + 1}`,
      role: isPradhan ? 'ग्राम प्रधान' : 'टीम सदस्य',
      isPradhan,
      influence,
      bucket,
    });
  }
  return team;
}

export function loadStore(root = process.cwd()) {
  const build = resolve(buildDir(root));
  const required = [
    'meta.json',
    'acs.json',
    'districts.json',
    'pc.json',
    'panchayat.json',
    'labels.json',
    'villages-index.json',
    'village-network-index.json',
  ];
  const missing = required.filter((file) => !existsSync(join(build, file)));
  if (missing.length) {
    throw new Error(
      `build/ is incomplete (missing ${missing.join(', ')}). Run "npm run data" first.`,
    );
  }

  const meta = read(join(build, 'meta.json'));
  const acs = read(join(build, 'acs.json'));
  const districts = read(join(build, 'districts.json'));
  const pc = read(join(build, 'pc.json'));
  const parliamentFilter = loadParliamentFilter(root);
  const panchayat = read(join(build, 'panchayat.json'));
  const labels = read(join(build, 'labels.json'));
  const villageIndex = read(join(build, 'villages-index.json'));
  const villageNetworkIndex = read(join(build, 'village-network-index.json'));

  const acsByNo = new Map(acs.map((ac) => [ac.no, ac]));
  const labelsByAc = new Map();
  for (const entry of labels) {
    if (!labelsByAc.has(entry.ac)) labelsByAc.set(entry.ac, []);
    labelsByAc.get(entry.ac).push(entry);
  }

  // Search covers two sources: booth-list village labels (with booth counts)
  // and every named village polygon. Linked villages appear only once.
  const searchable = [];
  const linkedVillages = new Set();
  for (const entry of labels) {
    if (entry.i) linkedVillages.add(`${entry.ac}|${entry.i}`);
    searchable.push({
      entry,
      label: fold(entry.l),
      village: entry.n ? fold(entry.n) : '',
    });
  }
  for (const [name, acNo, id, booths] of villageIndex) {
    if (!name || linkedVillages.has(`${acNo}|${id}`)) continue;
    searchable.push({
      entry: {
        l: name,
        ac: acNo,
        b: booths,
        i: id,
        n: name,
        s: 0,
        st: 'village',
        amb: false,
      },
      label: '',
      village: fold(name),
    });
  }

  const detailCache = new Map();
  const networkChunks = new Map();
  const networkBlocks = new Map(
    villageNetworkIndex.flatMap((district) => district.blocks.map((block) => [block.id, block])),
  );
  const boothGrades = loadBoothGrades(root);
  function villageDetail(no) {
    const acNo = Number(no);
    if (!Number.isFinite(acNo)) return null;
    const ac = acsByNo.get(acNo);
    if (!ac) return null;
    if (detailCache.has(acNo)) return detailCache.get(acNo);

    const path = join(build, 'villages', `${acNo}.json`);
    let detail = { labels: [], unlinked: [], villages: [] };
    if (existsSync(path)) detail = read(path);
    const boothOrgPath = join(build, 'booths', `${acNo}.json`);
    const boothOrg = existsSync(boothOrgPath) ? read(boothOrgPath) : null;

    const result = {
      ac,
      ...detail,
      boothOrg,
      totals: {
        labels: detail.labels.length,
        linkedLabels: detail.labels.filter((l) => l.i).length,
        unlinked: detail.unlinked.length,
        linkedVillages: detail.villages.length,
      },
      weights: meta.indexWeights,
    };
    detailCache.set(acNo, result);
    return result;
  }

  function villageNetwork(id) {
    const key = String(id);
    if (!networkBlocks.has(key)) return null;
    if (!networkChunks.has(key)) {
      const base = read(join(build, 'village-networks', `${key}.json`));
      const nodes = (base.nodes || []).map((node) => ({
        ...node,
        team: demoTeamForNode(node),
      }));
      networkChunks.set(key, { ...base, nodes });
    }
    return networkChunks.get(key);
  }

  function progress() {
    return {
      ...DEMO_PROGRESS,
      metrics: DEMO_PROGRESS.metrics.map((metric) => {
        if (metric.key === 'villages') return { ...metric, value: meta.totals.villages ?? metric.value };
        if (metric.key === 'booths') return { ...metric, value: meta.totals.booths ?? metric.value };
        return metric;
      }),
    };
  }

  const version = new Date(meta.builtAt).getTime().toString(36);

  function search(query, limit = 20) {
    const q = fold(query);
    if (!q) return [];
    const ranked = [];
    for (const item of searchable) {
      let rank = 9;
      if (item.label === q || item.village === q) rank = 0;
      else if (item.label.startsWith(q) || item.village.startsWith(q)) rank = 1;
      else if (item.label.includes(q) || item.village.includes(q)) rank = 2;
      if (rank === 9) continue;
      ranked.push({ rank, entry: item.entry });
    }
    ranked.sort(
      (a, b) =>
        a.rank - b.rank ||
        b.entry.b - a.entry.b ||
        a.entry.l.localeCompare(b.entry.l, 'en'),
    );
    return ranked.slice(0, limit).map(({ entry }) => ({
      label: entry.l,
      ac: entry.ac,
      acName: acsByNo.get(entry.ac)?.name ?? '',
      district: acsByNo.get(entry.ac)?.district ?? '',
      booths: entry.b,
      villageId: entry.i,
      villageName: entry.n,
      status: entry.st,
    }));
  }

  return {
    root,
    build,
    meta,
    acs,
    acsByNo,
    districts,
    pc,
    parliamentFilter,
    panchayat,
    labelsByAc,
    villageDetail,
    villageNetworkIndex,
    villageNetwork,
    boothGrades,
    progress,
    search,
    version,
    // Pre-folded rows for the static GitHub Pages search shim (same ranking
    // rules as search() above, without shipping the whole server to Pages).
    searchIndex: searchable.map(({ entry, label, village }) => ({
      ...entry,
      lf: label,
      vf: village,
    })),
  };
}

function buildDir(root) {
  return join(root, 'build');
}
