// Geometry preparation: state layers, per-AC Census polygons, per-block SOI
// boundaries and grid density for the state-wide village view.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { geoCentroid } from 'd3';
import { topology } from 'topojson-server';
import { feature as topoFeature } from 'topojson-client';

const MAPSHAPER = resolve('node_modules/mapshaper/bin/mapshaper');
const SOI_LAMBERT_PROJ4 =
  '+proj=lcc +lat_0=24 +lon_0=80 +lat_1=12.472955 +lat_2=35.1728044444444 ' +
  '+x_0=4000000 +y_0=4000000 +datum=WGS84 +units=m +no_defs';

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Census shapefiles wind rings clockwise, which D3 interprets as the whole
// globe. Normalise: exterior rings clockwise (D3's small-area orientation),
// holes counter-clockwise. Needed for both area math and map filling.
const planarRingArea = (ring) => {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
};

const orientRing = (ring, positive) =>
  (planarRingArea(ring) > 0) === positive ? ring : [...ring].reverse();

export function rewindGeometry(geometry) {
  if (!geometry) return geometry;
  if (geometry.type === 'Polygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((ring, i) => orientRing(ring, i !== 0)),
    };
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((poly) =>
        poly.map((ring, i) => orientRing(ring, i !== 0)),
      ),
    };
  }
  return geometry;
}

export function writeJson(path, data, { pretty = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
}

function runMapshaper(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [MAPSHAPER, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`mapshaper exited ${code}\n${stdout}\n${stderr}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

export async function simplifyTopo({ input, output, percent, fields, quantization = 100000 }) {
  const args = [
    input,
    '-simplify',
    `${percent}%`,
    'keep-shapes',
    '-clean',
    '-filter-fields',
    fields.join(','),
    '-o',
    'format=topojson',
    `quantization=${quantization}`,
    output,
  ];
  const { stdout } = await runMapshaper(args);
  const bytes = readFileSync(output).length;
  return { output, bytes, log: stdout.trim().split('\n').slice(-3).join(' | ') };
}

function remapArcTree(value, sourceArcs, arcs, indexes) {
  if (typeof value === 'number') {
    const sourceIndex = value < 0 ? ~value : value;
    let index = indexes.get(sourceIndex);
    if (index === undefined) {
      index = arcs.length;
      indexes.set(sourceIndex, index);
      arcs.push(sourceArcs[sourceIndex]);
    }
    return value < 0 ? ~index : index;
  }
  return value.map((child) => remapArcTree(child, sourceArcs, arcs, indexes));
}

function remapGeometry(geometry, sourceArcs, arcs, indexes) {
  const result = { type: geometry.type };
  if (geometry.id !== undefined) result.id = geometry.id;
  if (geometry.properties) result.properties = geometry.properties;
  if (geometry.bbox) result.bbox = geometry.bbox;
  if (geometry.type === 'GeometryCollection') {
    result.geometries = geometry.geometries.map((child) =>
      remapGeometry(child, sourceArcs, arcs, indexes),
    );
  } else if (geometry.arcs) {
    result.arcs = remapArcTree(geometry.arcs, sourceArcs, arcs, indexes);
  } else if (geometry.coordinates) {
    result.coordinates = geometry.coordinates;
  }
  return result;
}

function matchingVillageChunk(topology, geometry, candidates) {
  const chunkIds = new Set(candidates.map((candidate) => candidate.chunkId));
  if (chunkIds.size === 1) return candidates[0].chunkId;
  const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const villageName = normalize(geometry.properties?.village);
  const named = candidates.filter((candidate) => normalize(candidate.name) === villageName);
  const choices = named.length ? named : candidates;
  if (new Set(choices.map((candidate) => candidate.chunkId)).size === 1) return choices[0].chunkId;

  const [lon, lat] = geoCentroid(topoFeature(topology, geometry));
  const distance = (candidate) => {
    const [candidateLon, candidateLat] = candidate.location ?? [];
    if (!Number.isFinite(candidateLon) || !Number.isFinite(candidateLat)) return Infinity;
    return Math.hypot(
      (lon - candidateLon) * Math.cos((lat * Math.PI) / 180),
      lat - candidateLat,
    );
  };
  return choices.reduce((best, candidate) =>
    distance(candidate) < distance(best) ? candidate : best,
  ).chunkId;
}

export async function buildVillageBoundaryChunks({
  input,
  temporaryOutput,
  outputDir,
  villageToChunk,
  percent = 12,
  quantization = 1000000,
}) {
  mkdirSync(outputDir, { recursive: true });
  try {
    await runMapshaper([
      input,
      '-simplify',
      `${percent}%`,
      'keep-shapes',
      '-proj',
      'wgs84',
      `init=${SOI_LAMBERT_PROJ4}`,
      '-filter-fields',
      'vlcode,village,block,district',
      '-o',
      'format=topojson',
      `quantization=${quantization}`,
      temporaryOutput,
    ]);

    const source = readJson(temporaryOutput);
    const sourceObject = Object.values(source.objects ?? {}).find(
      (object) => object.type === 'GeometryCollection',
    );
    if (!sourceObject || !Array.isArray(source.arcs) || !source.transform) {
      throw new Error('SOI village boundaries did not produce a quantized TopoJSON layer');
    }

    const geometriesByChunk = new Map();
    let matchedFeatures = 0;
    for (const geometry of sourceObject.geometries) {
      const villageId = String(geometry.properties?.vlcode ?? '').trim();
      const candidates = villageToChunk.get(villageId);
      if (!candidates?.length) continue;
      const chunkId = matchingVillageChunk(source, geometry, candidates);
      if (!geometriesByChunk.has(chunkId)) geometriesByChunk.set(chunkId, []);
      geometriesByChunk.get(chunkId).push(geometry);
      matchedFeatures++;
    }

    let bytes = 0;
    let chunks = 0;
    const chunkIds = new Set(
      [...villageToChunk.values()].flatMap((candidates) =>
        candidates.map((candidate) => candidate.chunkId),
      ),
    );
    for (const chunkId of chunkIds) {
      const geometries = geometriesByChunk.get(chunkId) ?? [];
      const arcs = [];
      const indexes = new Map();
      const outputGeometries = geometries.map((geometry) =>
        remapGeometry(geometry, source.arcs, arcs, indexes),
      );
      const topology = {
        type: 'Topology',
        transform: source.transform,
        arcs,
        objects: {
          v: { type: 'GeometryCollection', geometries: outputGeometries },
        },
      };
      const json = JSON.stringify(topology);
      const output = resolve(outputDir, `${chunkId}.topo.json`);
      writeFileSync(output, json);
      bytes += Buffer.byteLength(json);
      chunks++;
    }

    return {
      sourceFeatures: sourceObject.geometries.length,
      matchedFeatures,
      chunks,
      bytes,
      simplifiedTo: `${percent}%`,
      quantization,
    };
  } finally {
    rmSync(temporaryOutput, { force: true });
  }
}

// Point layers are tiny — just trim properties, no simplification needed.
export function pointsToGeoJson(features, pick) {
  return {
    type: 'FeatureCollection',
    features: features
      .filter((f) => f.geometry && f.geometry.type === 'Point')
      .map((f) => ({
        type: 'Feature',
        properties: pick(f.properties),
        geometry: { type: 'Point', coordinates: f.geometry.coordinates.map((n) => Number(n.toFixed(5))) },
      })),
  };
}

/**
 * Splits village polygons by AC and emits one quantized TopoJSON per AC.
 * Props are deliberately terse: n=name, g=gp_code, gn=gp_name, b=block,
 * i=village id, c=linked booths.
 */
export function buildVillageChunks(features, boothCounts) {
  const byAc = new Map();
  for (const feature of features) {
    const ac = Number(feature.properties?.ac_no);
    if (!ac || !feature.geometry) continue;
    if (!byAc.has(ac)) byAc.set(ac, []);
    byAc.get(ac).push(feature);
  }

  const chunks = new Map();

  for (const [acNo, group] of byAc) {
    const counts = boothCounts.get(acNo) ?? new Map();
    const outFeatures = [];
    for (const f of group) {
      const p = f.properties;
      const id = String(p.vil_lgd || p.objectid || p.id || '');
      if (!id) continue;
      const name = (p.vilname11 || '').trim() || null;
      const gp = p.gp_code || null;
      const bloc = (p.block_name || '').trim() || null;

      outFeatures.push({
        type: 'Feature',
        id,
        properties: { i: id, n: name, g: gp, gn: p.gp_name || null, b: bloc, c: counts.get(id) ?? 0 },
        geometry: rewindGeometry(f.geometry),
      });
    }

    const fc = { type: 'FeatureCollection', features: outFeatures };
    const topo = topology({ v: fc }, 100000);
    chunks.set(acNo, { json: JSON.stringify(topo), features: outFeatures.length });
  }

  return chunks;
}

// 0.03° grid: village + linked-booth density for the state-wide village view.
export function buildVillageGrid(villages, cell = 0.05) {
  const cells = new Map();
  for (const v of villages) {
    if (!v.centroid) continue;
    const x = Math.floor(v.centroid[0] / cell) * cell;
    const y = Math.floor(v.centroid[1] / cell) * cell;
    const key = `${x.toFixed(2)}|${y.toFixed(2)}`;
    let entry = cells.get(key);
    if (!entry) {
      entry = { lon: x + cell / 2, lat: y + cell / 2, villages: 0, booths: 0, linked: 0 };
      cells.set(key, entry);
    }
    entry.villages++;
    entry.booths += v.boothCount;
    if (v.boothCount > 0) entry.linked++;
  }
  return {
    cell,
    cells: [...cells.values()]
      .sort((a, b) => a.booths - b.booths)
      .map((c) => [
        Number(c.lon.toFixed(4)),
        Number(c.lat.toFixed(4)),
        c.villages,
        c.booths,
        c.linked,
      ]),
  };
}

export function topoFeatureCount(path) {
  const topo = readJson(path);
  const key = Object.keys(topo.objects)[0];
  return topo.objects[key].geometries.length;
}
