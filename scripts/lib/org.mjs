// Organizational hierarchy from Data/UP_Booth_Meta.csv.
// Joined to the 2026 booth list on assembly number + booth number:
// zila → mandal → shakti kendra → booth.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseCsv, loadBooths } from './csv.mjs';

const META_FILE = 'UP_Booth_Meta.csv';
const LIST_FILE = 'Uttar Pradesh 2026 (AC_Booth & Village list).csv';

function num(value) {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

export function loadBoothMeta(csvPath) {
  const text = readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  const header = rows.shift().map((h) => h.trim());
  const col = Object.fromEntries(header.map((name, index) => [name, index]));
  const required = [
    'ac_number',
    'booth_number',
    'booth_id',
    'zila_id',
    'zila',
    'mandal_id',
    'mandal',
    'shakti_kendra_id',
    'shakti_kendra',
  ];
  for (const name of required) {
    if (col[name] == null) throw new Error(`${META_FILE} is missing column ${name}`);
  }

  const byKey = new Map();
  for (const row of rows) {
    if (!row.length || row.every((value) => !String(value ?? '').trim())) continue;
    const acNo = num(row[col.ac_number]);
    const boothNo = num(row[col.booth_number]);
    const boothId = num(row[col.booth_id]);
    if (acNo == null || boothNo == null || boothId == null) {
      throw new Error(`Bad booth meta key: ${row[col.ac_number]} / ${row[col.booth_number]}`);
    }
    const key = `${acNo}|${boothNo}`;
    if (byKey.has(key)) throw new Error(`Duplicate booth meta for AC ${acNo} booth ${boothNo}`);
    const zilaId = String(row[col.zila_id]).trim();
    const mandalId = String(row[col.mandal_id]).trim();
    const skId = String(row[col.shakti_kendra_id]).trim();
    const zila = String(row[col.zila]).trim();
    const mandal = String(row[col.mandal]).trim();
    const sk = String(row[col.shakti_kendra]).trim();
    if (!zilaId || !mandalId || !zila || !mandal) {
      throw new Error(`Incomplete org row for AC ${acNo} booth ${boothNo}`);
    }
    // 285 booths are filed under a mandal with shakti_kendra_id 0 and a blank name.
    // Keep them on that mandal instead of inventing one statewide kendra.
    const unassigned = !skId || skId === '0' || !sk;
    byKey.set(key, {
      zilaId,
      zila,
      mandalId,
      mandal,
      skId: unassigned ? `unassigned:${mandalId}` : skId,
      sk: unassigned ? 'Unassigned' : sk,
      unassigned,
      boothId,
    });
  }
  return byKey;
}

function boothCountOfZila(zila) {
  return zila.mandals.reduce(
    (sum, mandal) => sum + mandal.kendras.reduce((inner, kendra) => inner + kendra.booths.length, 0),
    0,
  );
}

export function assembleBoothOrg(booths, metaByKey) {
  const acMaps = new Map();
  const zilaStats = new Map();
  const mandalParent = new Map();
  const skParent = new Map();
  const namedSk = new Set();
  let linked = 0;
  let unassignedBooths = 0;

  for (const booth of booths) {
    const meta = metaByKey.get(`${booth.acNo}|${booth.boothNo}`);
    if (!meta) continue;
    linked++;

    booth.boothId = meta.boothId;
    booth.zilaId = meta.zilaId;
    booth.zila = meta.zila;
    booth.mandalId = meta.mandalId;
    booth.mandal = meta.mandal;
    booth.shaktiKendraId = meta.skId;
    booth.shaktiKendra = meta.sk;

    const previousMandal = mandalParent.get(meta.mandalId);
    if (previousMandal && previousMandal !== meta.zilaId) {
      throw new Error(`Mandal ${meta.mandalId} (${meta.mandal}) belongs to more than one zila`);
    }
    mandalParent.set(meta.mandalId, meta.zilaId);
    const previousSk = skParent.get(meta.skId);
    if (previousSk && previousSk !== meta.mandalId) {
      throw new Error(`Shakti Kendra ${meta.skId} (${meta.sk}) belongs to more than one mandal`);
    }
    skParent.set(meta.skId, meta.mandalId);
    if (meta.unassigned) unassignedBooths++;
    else namedSk.add(meta.skId);

    if (!acMaps.has(booth.acNo)) acMaps.set(booth.acNo, new Map());
    const zilas = acMaps.get(booth.acNo);
    if (!zilas.has(meta.zilaId)) {
      zilas.set(meta.zilaId, { id: meta.zilaId, name: meta.zila, mandals: new Map() });
    }
    const zila = zilas.get(meta.zilaId);
    if (!zila.mandals.has(meta.mandalId)) {
      zila.mandals.set(meta.mandalId, { id: meta.mandalId, name: meta.mandal, kendras: new Map() });
    }
    const mandal = zila.mandals.get(meta.mandalId);
    if (!mandal.kendras.has(meta.skId)) {
      mandal.kendras.set(meta.skId, { id: meta.skId, name: meta.sk, booths: [] });
    }
    mandal.kendras.get(meta.skId).booths.push({
      no: booth.boothNo,
      id: meta.boothId,
      name: booth.boothLabel,
    });

    if (!zilaStats.has(meta.zilaId)) {
      zilaStats.set(meta.zilaId, {
        id: meta.zilaId,
        name: meta.zila,
        booths: 0,
        mandals: new Set(),
        sks: new Set(),
        acs: new Set(),
      });
    }
    const stats = zilaStats.get(meta.zilaId);
    stats.booths++;
    stats.mandals.add(meta.mandalId);
    if (!meta.unassigned) stats.sks.add(meta.skId);
    stats.acs.add(booth.acNo);
  }

  const byName = (a, b) => a.name.localeCompare(b.name, 'en') || String(a.id).localeCompare(String(b.id));
  const byAc = new Map();
  for (const [acNo, zilaMap] of acMaps) {
    const zilas = [...zilaMap.values()]
      .map((zila) => ({
        id: zila.id,
        name: zila.name,
        mandals: [...zila.mandals.values()]
          .map((mandal) => ({
            id: mandal.id,
            name: mandal.name,
            kendras: [...mandal.kendras.values()]
              .map((kendra) => ({
                id: kendra.id,
                name: kendra.name,
                booths: kendra.booths.sort((a, b) => a.no - b.no),
              }))
              .sort(byName),
          }))
          .sort(byName),
      }))
      .sort(byName);

    let mandals = 0;
    let shaktiKendras = 0;
    let unassigned = 0;
    for (const zila of zilas) {
      mandals += zila.mandals.length;
      for (const mandal of zila.mandals) {
        for (const kendra of mandal.kendras) {
          if (String(kendra.id).startsWith('unassigned:')) unassigned += kendra.booths.length;
          else shaktiKendras++;
        }
      }
    }
    byAc.set(acNo, { zilas, mandals, shaktiKendras, unassignedBooths: unassigned });
  }

  const zilas = [...zilaStats.values()]
    .map((zila) => ({
      id: zila.id,
      name: zila.name,
      booths: zila.booths,
      mandals: zila.mandals.size,
      shaktiKendras: zila.sks.size,
      acs: [...zila.acs].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.booths - a.booths || a.name.localeCompare(b.name, 'en'));

  return {
    byAc,
    zilas,
    org: {
      source: META_FILE,
      zilas: zilas.length,
      mandals: mandalParent.size,
      shaktiKendras: namedSk.size,
      booths: linked,
      unassignedBooths,
    },
  };
}

export function orgSummary(tree) {
  if (!tree) return { zilas: [], mandals: 0, shaktiKendras: 0 };
  return {
    zilas: tree.zilas.map((zila) => ({
      id: zila.id,
      name: zila.name,
      booths: boothCountOfZila(zila),
    })),
    mandals: tree.mandals,
    shaktiKendras: tree.shaktiKendras,
    unassignedBooths: tree.unassignedBooths || 0,
  };
}

export function writeBoothOrg(buildDir, assembled) {
  const dir = join(buildDir, 'booths');
  mkdirSync(dir, { recursive: true });
  for (const [acNo, tree] of assembled.byAc) {
    writeFileSync(join(dir, `${acNo}.json`), JSON.stringify({ zilas: tree.zilas }));
  }
  writeFileSync(
    join(buildDir, 'org.json'),
    JSON.stringify({
      source: assembled.org.source,
      totals: assembled.org,
      zilas: assembled.zilas,
    }),
  );
}

export function attachOrgSummaries(acs, byAc) {
  for (const ac of acs) {
    ac.org = orgSummary(byAc.get(ac.no));
  }
}

// Updates an existing build/ without rebuilding geometry. `npm run data` calls
// the same writers, so a full rebuild keeps this hierarchy.
export function populateExistingBuild(root = process.cwd()) {
  const data = resolve(root, 'Data');
  const build = resolve(root, 'build');
  const { booths } = loadBooths(resolve(data, LIST_FILE));
  const meta = loadBoothMeta(resolve(data, META_FILE));
  const assembled = assembleBoothOrg(booths, meta);
  if (assembled.org.booths !== booths.length) {
    throw new Error(`Booth meta linked ${assembled.org.booths} of ${booths.length} booths`);
  }
  writeBoothOrg(build, assembled);

  const acs = JSON.parse(readFileSync(join(build, 'acs.json'), 'utf8'));
  attachOrgSummaries(acs, assembled.byAc);
  writeFileSync(join(build, 'acs.json'), JSON.stringify(acs));

  const metaJson = JSON.parse(readFileSync(join(build, 'meta.json'), 'utf8'));
  metaJson.org = assembled.org;
  metaJson.sources = metaJson.sources || {};
  metaJson.sources.boothMeta = {
    file: META_FILE,
    bytes: readFileSync(resolve(data, META_FILE)).length,
    booths: assembled.org.booths,
    zilas: assembled.org.zilas,
    mandals: assembled.org.mandals,
    shaktiKendras: assembled.org.shaktiKendras,
  };
  writeFileSync(join(build, 'meta.json'), JSON.stringify(metaJson, null, 2));
  return assembled.org;
}
