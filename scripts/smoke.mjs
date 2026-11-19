// End-to-end smoke test: boots the real Express app on an ephemeral port and
// exercises every route the browser touches. Run with `npm run smoke`.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createApp } from '../server.mjs';
import { num } from '../lib/format.mjs';

const failures = [];
const checks = [];
const check = (label, condition, detail = '') => {
  checks.push({ label, ok: Boolean(condition), detail });
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

const { app, store } = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = '';

async function get(path, options = {}) {
  return fetch(base + path, {
    ...options,
    headers: { ...(cookie ? { cookie } : {}), ...options.headers },
  });
}

try {
  // ------------------------------------------------------------------ login
  const anonymous = await get('/', { redirect: 'manual' });
  check('anonymous home redirects to login', anonymous.status === 302 &&
    (anonymous.headers.get('location') || '').startsWith('/login'));
  const loginPage = await get('/login');
  const loginHtml = await loginPage.text();
  check('login page is served', loginPage.status === 200 &&
    loginHtml.includes('लॉग इन') && loginHtml.includes('admin123'));
  const anonymousApi = await get('/api/progress');
  check('anonymous API is rejected', anonymousApi.status === 401, String(anonymousApi.status));

  const badLogin = await get('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'wrong' }),
  });
  check('wrong password is rejected', badLogin.status === 303 &&
    !badLogin.headers.get('set-cookie') &&
    (badLogin.headers.get('location') || '').includes('error=1'));

  const login = await get('/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'admin123', next: '/' }),
  });
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  check('valid login sets a session cookie', login.status === 303 &&
    cookie.startsWith('ps_session=') &&
    (login.headers.get('location') || '') === '/');
  check('session cookie is HttpOnly + SameSite=Strict',
    (login.headers.get('set-cookie') || '').includes('HttpOnly') &&
    (login.headers.get('set-cookie') || '').includes('SameSite=Strict'));

  // ------------------------------------------------------------------- page
  const home = await get('/');
  const html = await home.text();
  check('GET / returns 200', home.status === 200, String(home.status));
  check('page is server-rendered HTML', (home.headers.get('content-type') || '').includes('text/html'));
  check('page carries the campaign title', html.includes('उत्तर प्रदेश') && html.includes('पंचायत अभियान'));
  check('page has scroll sections', (html.match(/class="step/g) || []).length >= 8);
  check('page includes village network section', html.includes('id="village-network"'));
  check('page embeds the boot payload', html.includes('id="boot"'));
  check('page never references a blob URL', !html.includes('blob:'));
  check('page links local D3 vendor build', html.includes('/vendor/d3.min.js'));
  check('page mentions the match report', html.includes('village-match-report.csv'));
  check('page renders real booth total', html.includes(num(store.meta.totals.booths)));
  check('page renders shakti kendra total', html.includes(num(store.meta.org.shaktiKendras)));
  check('page names the booth meta source', html.includes('UP_Booth_Meta.csv'));
  check('page renders real village total', html.includes(num(store.meta.totals.villages)));
  check('page identifies the Amethi summary as a sample', html.includes('अमेठी') && html.includes('सभी जिलों का सारांश नहीं'));
  check('page includes all Amethi blocks in the selector', store.panchayat.blocks.every((block) => html.includes(`>${block.name}</option>`)));
  check('Amethi summary row totals are loaded', store.panchayat.gpRecords === store.panchayat.blocks.reduce((sum, block) => sum + block.gpRecordsCount, 0));
  const amethiAcs = store.acs.filter((ac) => ac.district === 'Amethi');
  check('page renders all Amethi constituency chart rows', amethiAcs.length === 4 && amethiAcs.every((ac) => html.includes(`data-amethi-ac="${ac.no}"`)));
  check('constituency chart explains workbook GP attribution', html.includes('उन्हें विधानसभा क्षेत्रों में बाँटा नहीं गया है'));
  check('comparison card is wired to the district selector', html.includes('data-district-select') && html.includes('data-assembly-chart'));
  const districts = [...new Set(store.acs.map((ac) => ac.district))];
  check('district selector lists every assembly district', districts.length === 75 && districts.every((name) => html.includes(`value="${name}"`)));
  check('default map mode is the campaign choropleth', html.includes('data-m="campaign" id="hero"') && html.includes('data-layer="campaign" aria-pressed="true"'));

  const bootPayload = JSON.parse(html.match(/<script type="application\/json" id="boot">([\s\S]*?)<\/script>/)[1]);
  check('district rows carry the campaign success metric', bootPayload.districts?.length === 75 && bootPayload.districts.every((row) => Number.isFinite(row[7])));
  check('campaign success values stay between 0 and 1', bootPayload.districts.every((row) => row[7] >= 0 && row[7] <= 1));

  // The Lok Sabha filter must be projected from the supplied parliament GeoJSON,
  // not from a hand-written list or the campaign deck.
  const parliamentRaw = JSON.parse(
    readFileSync(new URL('../Data/UTTAR PRADESH_parliament.geojson', import.meta.url), 'utf8'),
  );
  const sourcePcs = (parliamentRaw.features || []).map((feature) => ({
    no: Number(feature.properties.PC_NO),
    name: String(feature.properties.PC_NAME || '').trim(),
  }));
  check('parliament GeoJSON has 80 unique seats', sourcePcs.length === 80 && new Set(sourcePcs.map((pc) => pc.no)).size === 80);
  check('Lok Sabha filter comes from the parliament GeoJSON', bootPayload.pcOptions?.length === sourcePcs.length && sourcePcs.every((pc) => bootPayload.pcOptions.some((row) => row[0] === pc.no && row[1] === pc.name)));
  check('AC rows carry PC_NO for the filter', bootPayload.acs.length === 403 && bootPayload.acs.every((row) => Number.isFinite(row[11]) && row[11] > 0));
  check('Lok Sabha filter controls are rendered', (html.match(/data-pc-filter/g) || []).length >= 2 && html.includes('UTTAR PRADESH_parliament.geojson') && html.includes('id="pc-filter-status"'));

  const mainSource = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  const mapSource = readFileSync(new URL('../public/js/map.js', import.meta.url), 'utf8');
  const networkSource = readFileSync(new URL('../public/js/network.js', import.meta.url), 'utf8');
  check('campaign progress drives the choropleth', mapSource.includes('campaignScale') && mapSource.includes('setProgress') && mainSource.includes('map.setProgress('));
  check('village network dataviz is still wired', mainSource.includes('createVillageNetwork') && networkSource.includes('network-cells') && networkSource.includes('network-edges') && networkSource.includes('renderInfluenceDetail'));
  check('village network controls and influence panel are rendered', ['network-district', 'network-block', 'network-status', 'network-svg', 'influence-panel'].every((id) => html.includes(`id="${id}"`)));
  check('gram network uses force links and repulsion', ['forceLink', 'forceManyBody', 'buildCellLinks', 'buildMemberLinks', 'alphaDecay'].every((token) => networkSource.includes(token)));
  check('gram network reheat control is rendered and wired', html.includes('id="network-reheat"') && networkSource.includes("getElementById('network-reheat')") && networkSource.includes('reheatLayout'));
  check('Lok Sabha filter is wired to the map and AC list', mapSource.includes('selectPc') && mapSource.includes('pc-match') && mainSource.includes('map.selectPc(') && mainSource.includes('setOnPcSelect'));
  check('no unresolved EJS markers', !html.includes('<%'));

  const cached = await get('/');
  check('second page load is served', cached.status === 200);
  check('cached page is byte-identical', (await cached.text()) === html);

  // ---------------------------------------------------------------- healthz
  const health = await get('/healthz');
  const healthJson = await health.json();
  check('healthz reports ok', health.status === 200 && healthJson.ok === true);
  check('healthz reports 403 AC', healthJson.acs === 403, String(healthJson.acs));
  check('healthz reports 177516 booths', healthJson.booths === 177516, String(healthJson.booths));

  // ------------------------------------------------------------- drilldown API
  const rural = await get('/api/ac/5');
  const ruralJson = await rural.json();
  check('rural AC API returns 200', rural.status === 200);
  check('rural AC is Deoband', ruralJson.ac?.name === 'Deoband', ruralJson.ac?.name);
  check('rural AC lists villages', ruralJson.villages?.length > 0, String(ruralJson.villages?.length));
  check('rural AC lists labels', ruralJson.labels?.length > 0);
  check('rural AC carries index weights', ruralJson.weights?.length === 5);
  check(
    'village booth counts add up to matched booths',
    ruralJson.villages.reduce((sum, v) => sum + v.booths, 0) === ruralJson.ac.matchedBooths,
  );
  const orgBooths = (ruralJson.boothOrg?.zilas ?? []).reduce(
    (sum, zila) =>
      sum + zila.mandals.reduce(
        (mandalSum, mandal) =>
          mandalSum + mandal.kendras.reduce((kendraSum, kendra) => kendraSum + kendra.booths.length, 0),
        0,
      ),
    0,
  );
  check('rural AC booth org covers every booth', orgBooths === ruralJson.ac.booths, `${orgBooths} vs ${ruralJson.ac.booths}`);
  check(
    'rural AC booths carry shakti kendra, mandal and zila',
    ruralJson.boothOrg.zilas.every((zila) =>
      zila.name && zila.mandals.every((mandal) =>
        mandal.name && mandal.kendras.every((kendra) =>
          kendra.name && kendra.booths.every((booth) => booth.no && booth.name),
        ),
      ),
    ),
  );

  const urban = await get('/api/ac/171');
  const urbanJson = await urban.json();
  check('urban AC API returns 200', urban.status === 200);
  check('urban AC is Lucknow West', urbanJson.ac?.name === 'Lucknow West', urbanJson.ac?.name);
  check('urban AC has zero villages', urbanJson.villages?.length === 0);

  const missing = await get('/api/ac/9999');
  check('unknown AC returns 404', missing.status === 404, String(missing.status));
  const badAc = await get('/api/ac/abc');
  check('non-numeric AC returns 404', badAc.status === 404, String(badAc.status));

  // ------------------------------------------------------------------- search
  const search = await get('/api/search?q=behat');
  const searchJson = await search.json();
  check('search returns results', searchJson.results?.length > 0, String(searchJson.results?.length));
  check('search results carry AC + booths', searchJson.results.every((r) => r.ac && Number.isFinite(r.booths)));
  const searchEmpty = await get('/api/search?q=');
  check('empty search returns empty list', (await searchEmpty.json()).results.length === 0);
  const searchHindi = await get('/api/search?q=%E0%A4%97%E0%A5%8C%E0%A4%82');
  check('non-Latin search does not crash', searchHindi.status === 200);
  const villageSearch = await get('/api/search?q=khojanagla');
  const villageJson = await villageSearch.json();
  check(
    'search also covers village polygons',
    villageJson.results.some((r) => r.villageName && r.villageId),
    JSON.stringify(villageJson.results.slice(0, 2)),
  );

  // ------------------------------------------------------- village network API
  const networkIndexResponse = await get('/api/village-network/index');
  const networkIndex = await networkIndexResponse.json();
  check('village network index returns 75 districts', networkIndexResponse.status === 200 && networkIndex.length === 75);
  const networkBlock = networkIndex.flatMap((district) => district.blocks)[0];
  const networkResponse = await get(`/api/village-network/${networkBlock.id}`);
  const network = await networkResponse.json();
  check('village network block returns villages', networkResponse.status === 200 && network.nodes.length === networkBlock.villages);
  const networkBoundariesResponse = await get(`/data/village-networks/${networkBlock.id}.topo.json`);
  check('SOI network boundary chunk is served', networkBoundariesResponse.status === 200);
  const networkBoundaries = await networkBoundariesResponse.json();
  check(
    'SOI network boundary chunk has matching village geometries',
    networkBoundaries.objects?.v?.geometries?.length > 0 &&
      networkBoundaries.objects.v.geometries.every((geometry) =>
        network.nodes.some((node) => node.id === String(geometry.properties?.vlcode)),
      ),
  );
  check('village network links stay within one GP', network.links.every((link) => {
    const source = network.nodes.find((node) => node.id === link.source);
    const target = network.nodes.find((node) => node.id === link.target);
    return source?.gpCode && source.gpCode === target?.gpCode;
  }));
  const missingNetwork = await get('/api/village-network/unknown');
  check('unknown village network block returns 404', missingNetwork.status === 404);

  // ------------------------------------------------------------------ assets
  const topo = await get('/data/assembly.topo.json');
  check('assembly TopoJSON is served', topo.status === 200);
  const topoJson = await topo.json();
  check('assembly TopoJSON has objects', Boolean(topoJson.objects?.[Object.keys(topoJson.objects)[0]]));
  check('assembly TopoJSON is immutable-cacheable', (topo.headers.get('cache-control') || '').includes('immutable'));

  const chunk = await get('/data/ac/5.topo.json');
  check('rural village chunk is served', chunk.status === 200);
  const chunkJson = await chunk.json();
  check('village chunk has geometries', chunkJson.objects?.v?.geometries?.length > 0);

  const grid = await get('/data/village-grid.json');
  const gridJson = await grid.json();
  check('village grid is served', grid.status === 200 && gridJson.cells?.length > 5000);

  for (const [path, needle] of [
    ['/css/app.css', '#map'],
    ['/js/main.js', 'createMap'],
    ['/js/map.js', 'createMap'],
    ['/js/network.js', 'createVillageNetwork'],
    ['/vendor/d3.min.js', 'd3'],
    ['/vendor/topojson-client.min.js', 'topojson'],
  ]) {
    const asset = await get(path);
    const body = await asset.text();
    check(`asset ${path} is served`, asset.status === 200 && body.includes(needle), String(asset.status));
  }

  const notFound = await get('/does-not-exist');
  check('unknown page returns 404', notFound.status === 404, String(notFound.status));

  // -------------------------------------------------------------- compression
  const gzipHeader = await new Promise((resolve, reject) => {
    const url = new URL('/data/assembly.topo.json', base);
    const request = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname, headers: { 'accept-encoding': 'gzip' } },
      (response) => {
        response.resume();
        resolve(response.headers['content-encoding']);
      },
    );
    request.on('error', reject);
  });
  check('static geometry is gzip-compressed', gzipHeader === 'gzip', String(gzipHeader));
} catch (error) {
  failures.push(`unexpected error — ${error.stack || error}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const width = Math.max(...checks.map((c) => c.label.length));
for (const entry of checks) {
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.label.padEnd(width)}  ${entry.ok ? '' : entry.detail}`);
}
console.log('');
if (failures.length) {
  console.error(`${failures.length} smoke check(s) failed.`);
  process.exit(1);
}
console.log(`All ${checks.length} smoke checks passed against the live server.`);
