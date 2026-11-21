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

// WCAG relative luminance / contrast ratio, used to guard the theme palette.
function contrastRatio(a, b) {
  const luminance = (hex) => {
    const [r, g, bl] = hex.match(/\w\w/g).map((v) => parseInt(v, 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

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
    loginHtml.includes('लॉग इन') && loginHtml.includes('id="login-form"'));
  check('login page hides the demo credentials', !loginHtml.includes('admin123'));
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
  check('dashboard omits source citations',
    !html.includes('class="src"') && !html.includes('स्रोत:') &&
    !html.includes('.csv') && !html.includes('.geojson'));
  check('dashboard omits explanatory note blocks', !html.includes('class="note"') && !html.includes('tier-viz-note'));
  check('page renders real booth total', html.includes(num(store.meta.totals.booths)));
  check('page renders shakti kendra total', html.includes(num(store.meta.org.shaktiKendras)));
  check('page renders real village total', html.includes(num(store.meta.totals.villages)));
  check('Amethi panchayat sample is removed',
    !html.includes('panchayat-sample') && !html.includes('data-panchayat-explorer') &&
    !html.includes('data-panchayat-block'));
  check('Amethi summary row totals are loaded', store.panchayat.gpRecords === store.panchayat.blocks.reduce((sum, block) => sum + block.gpRecordsCount, 0));
  const amethiAcs = store.acs.filter((ac) => ac.district === 'Amethi');
  check('page renders all Amethi constituency chart rows', amethiAcs.length === 4 && amethiAcs.every((ac) => html.includes(`data-amethi-ac="${ac.no}"`)));
  check('comparison card is wired to the district selector', html.includes('data-district-select') && html.includes('data-assembly-chart'));
  const districts = [...new Set(store.acs.map((ac) => ac.district))];
  check('district selector lists every assembly district', districts.length === 75 && districts.every((name) => html.includes(`value="${name}"`)));
  check('hero drives the zone appointment map',
    html.includes('data-m="campaign" id="hero"') &&
    html.includes('<svg id="svg" data-m="campaign"') &&
    html.includes('data-layer="campaign" aria-pressed="true"') &&
    html.includes('id="gz"'));
  check('hero BAN strip is removed', !html.includes('ban-strip') && !html.includes('class="ban"'));
  check('hero carries the campaign introduction',
    html.includes('class="hero-intro"') && html.includes('2026 पंचायत अभियान') &&
    html.includes('छह क्षेत्रों में काम करता है'));

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
  check('Lok Sabha filter controls are rendered', (html.match(/data-pc-filter/g) || []).length >= 2 && html.includes('id="pc-filter-status"'));

  const mainSource = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  const mapSource = readFileSync(new URL('../public/js/map.js', import.meta.url), 'utf8');
  const networkSource = readFileSync(new URL('../public/js/network.js', import.meta.url), 'utf8');
  const cssText = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  const demoProgressTokens = ['id="hero-gauge"', 'id="map-bans"', 'id="ban-current"', '(डेमो)', 'अभियान प्रगति', 'गहराई = प्रगति', 'गहराई: अभियान प्रगति'];
  check('demo progress gauges and numbers are hidden', demoProgressTokens.every((token) => !html.includes(token) && !mapSource.includes(token) && !mainSource.includes(token)));
  check('zone appointment map replaces the demo progress layer',
    mapSource.includes('up-kshetra.json') && mapSource.includes('drawZones') &&
    mapSource.includes('zone-label-value') && mapSource.includes('zoneDescription') &&
    !mapSource.includes('campaignScale') && !mapSource.includes('campaignOpacity') &&
    !mapSource.includes('setProgress') && !mainSource.includes('map.setProgress('));
  check('village network dataviz is still wired', mainSource.includes('createVillageNetwork') && networkSource.includes('network-cells') && networkSource.includes('network-edges') && networkSource.includes('renderInfluenceDetail'));
  check('village network controls and influence panel are rendered', ['network-district', 'network-block', 'network-status', 'network-svg', 'influence-panel'].every((id) => html.includes(`id="${id}"`)));
  check('gram network uses force links and repulsion', ['forceLink', 'forceManyBody', 'buildCellLinks', 'buildMemberLinks', 'alphaDecay'].every((token) => networkSource.includes(token)));
  check('gram network reheat control is rendered and wired', html.includes('id="network-reheat"') && networkSource.includes("getElementById('network-reheat')") && networkSource.includes('reheatLayout'));
  check('Lok Sabha filter is wired to the map and AC list', mapSource.includes('selectPc') && mapSource.includes('pc-match') && mainSource.includes('map.selectPc(') && mainSource.includes('setOnPcSelect'));

  const teamData = JSON.parse(readFileSync(new URL('../public/team-appointments.json', import.meta.url), 'utf8'));

  // Selecting a Lok Sabha seat replaces the zone labels with its own appointment
  // callout plus the AC numbers that touch the seat boundary.
  const pcData = JSON.parse(readFileSync(new URL('../public/pc-appointments.json', import.meta.url), 'utf8'));
  const pcRows = Object.values(pcData.pcs);
  check('Lok Sabha appointment callout is rendered in the map',
    html.includes('id="pc-appointment-view"') &&
    ['pc-app-title', 'pc-app-share', 'pc-app-count', 'pc-app-coverage', 'pc-app-neighbours']
      .every((id) => html.includes(`id="${id}"`)) &&
    cssText.includes('#pc-appointment-view') &&
    cssText.includes("[data-theme='light'] .pc-appointment-card"));
  check('Lok Sabha callout shows both appointment percentages',
    mapSource.includes('function pcDescription()') &&
    mapSource.includes('function renderPcAppointments()') &&
    mapSource.includes('ensurePcAppointments().then(renderPcAppointments)') &&
    mapSource.includes("pcViewEl.style.display = visible ? 'block' : 'none'") &&
    mapSource.includes('टीम कवरेज:') &&
    mapSource.includes('पड़ोसी विधानसभा:'));
  check('every Lok Sabha seat carries appointment and neighbour data',
    pcRows.length === 80 &&
    pcRows.every((row) => row.acCount > 0 && row.acAppointed >= 0 &&
      row.appointed >= row.acAppointed && row.share >= 0 && row.share < 100 &&
      row.coverage >= 0 && row.coverage <= 100 && row.neighbours.length > 0 &&
      row.neighbours.every((no, i, all) => Number.isFinite(no) && (i === 0 || all[i - 1] < no))));
  check('Lok Sabha totals reconcile with the tracker',
    pcData.total === teamData.totals.appointed &&
    pcRows.reduce((sum, row) => sum + row.appointed, 0) ===
      teamData.rows.filter((row) => row.level === 'Vidhan Sabha' && /appoint/i.test(row.status || '')).length &&
    pcRows.reduce((sum, row) => sum + row.acCount, 0) === 403 &&
    pcRows.reduce((sum, row) => sum + row.acAppointed, 0) === teamData.totals.acs);

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
    ['/js/theme.js', 'theme-toggle'],
    ['/js/team-appointments.js', 'team-tree'],
    ['/team-appointments.json', '"zoneOrder"'],
    ['/up-kshetra.json', '"total"'],
    ['/pc-appointments.json', '"pcs"'],
    ['/vendor/d3.min.js', 'd3'],
    ['/vendor/topojson-client.min.js', 'topojson'],
  ]) {
    const asset = await get(path);
    const body = await asset.text();
    check(`asset ${path} is served`, asset.status === 200 && body.includes(needle), String(asset.status));
  }

  // ------------------------------------------------------------------ theming
  const tileRule = cssText.match(/\.tile\s*\{([^}]*)\}/)?.[1] ?? '';
  check('stat tiles are chevron shaped', html.includes('class="tile"') &&
    tileRule.includes('clip-path: polygon(') && tileRule.includes('100% 50%'));
  const tilesRule = cssText.match(/\.tiles\s*\{([^}]*)\}/)?.[1] ?? '';
  check('all four stat tiles stay on one row',
    tilesRule.includes('grid-template-columns: repeat(4, minmax(0, 1fr))') &&
    /\.tile b\s*\{[^}]*white-space: nowrap/.test(cssText) &&
    (cssText.match(/grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/g) || []).length >= 2);
  check('hero intro and zone label styles are defined',
    cssText.includes('.hero-intro') && cssText.includes('.zone-label-name') &&
    cssText.includes('--zone-halo') &&
    !cssText.includes('.ban-strip') && !/\.ban\s*\{/.test(cssText));

  // Team appointment showcase (Data/Tracker.xlsx sheet 3, materialised as JSON).
  const teamScript = readFileSync(new URL('../public/js/team-appointments.js', import.meta.url), 'utf8');
  check('team section follows the three-tier card',
    html.indexOf('data-m="panchayat"') < html.indexOf('id="team"') &&
    html.indexOf('id="team"') < html.indexOf('data-m="ac"'));
  check('team section hides the map and takes full width',
    html.includes('data-map-hidden') && mainSource.includes("classList.toggle('map-hidden'") &&
    cssText.includes('body.map-hidden #map'));
  check('team KPIs come from the tracker sheet',
    html.includes(num(teamData.totals.acs)) && html.includes(num(teamData.totals.zilas)) &&
    html.includes('विधानसभा टीम'));
  check('team JSON has every appointment row', teamData.rows.length === teamData.totals.names && teamData.totals.names > 0);
  check('team JSON covers all six zones and every Vidhan Sabha team',
    teamData.zoneOrder.length === 6 && teamData.totals.acs <= teamData.totals.acsTarget && teamData.totals.acsTarget === 403);
  check('team JSON carries forward hierarchy and cleans mobile numbers',
    teamData.rows.filter((row) => row.level === 'Vidhan Sabha' && row.zone && row.zila && row.ac).length > 900 &&
    teamData.rows.every((row) => !/[Ee]/.test(row.mobile)));
  check('team tree is wired for search and expand/collapse',
    ['team-search', 'team-expand', 'team-collapse', 'team-tree'].every((id) => html.includes(`id="${id}"`)) &&
    ['team-node', 'team-hit', "fetch('/team-appointments.json')"].every((token) => teamScript.includes(token)));
  check('each team member shows verification and duty information',
    ['team-person-meta', 'सत्यापित', 'असत्यापित', 'सत्यापन: —', 'दायित्व: हाँ', 'दायित्व: नहीं', 'दायित्व: जानकारी नहीं दी', 'दायित्व: —'].every((token) => teamScript.includes(token)) &&
    !teamScript.includes('SARAL') &&
    ['team-person-meta', 'team-badge-verified', 'team-badge-unverified', 'team-badge-duty-yes', 'team-badge-duty-no'].every((token) => cssText.includes(token)) &&
    html.includes('team-appointments.js?v='));
  check('team JSON maps the shifted workbook columns correctly',
    teamData.totals.verified === teamData.rows.filter((row) => row.verification === 'Verified').length &&
    teamData.totals.notVerified === teamData.rows.filter((row) => row.verification === 'Not Verified').length &&
    ['हाँ', 'नहीं', 'जानकारी नहीं दी', ''].every((value) => teamData.rows.some((row) => row.dutyInfo === value)) &&
    !teamData.rows.some((row) => /^(Verified|Not Verified)$/.test(row.designation)) &&
    !teamData.rows.some((row) => /^(हाँ|नहीं|जानकारी नहीं दी)$/.test(row.mobile)));

  // Six-zone hero map (Data/up_kshetra.geojson → committed public asset).
  const zoneData = JSON.parse(readFileSync(new URL('../public/up-kshetra.json', import.meta.url), 'utf8'));
  check('zone asset has exactly six campaign zones',
    zoneData.features.length === 6 && zoneData.total === teamData.totals.appointed &&
    ['पश्चिम', 'ब्रज', 'अवध', 'कानपुर', 'गोरखपुर', 'काशी'].every((name) =>
      zoneData.features.some((f) => f.properties.name === name)));
  // The one appointment not attributed to a zone is the Pradesh-level post.
  check('zone appointment shares add up to the full team',
    teamData.rows.filter((row) => row.level === 'Pradesh').length === 1 &&
    zoneData.features.reduce((sum, f) => sum + f.properties.appointed, 0) ===
      teamData.totals.appointed - 1 &&
    zoneData.features.every((f) => f.properties.share > 0 && f.properties.share < 100 && f.geometry));
  check('zone geometry and labels are wired into svg#svg',
    html.includes('id="gz"') && mapSource.includes("select('#gz')") &&
    cssText.includes('.zone-label') && cssText.includes('.zone {'));
  check('hero zone map hides every finer boundary layer',
    mapSource.includes('const outlineHidden = zoneView || districtPick') &&
    mapSource.includes("layers.assembly.style('display', outlineHidden ? 'none' : null)") &&
    mapSource.includes("layers.parliament.style('display', outlineHidden ? 'none' : null)") &&
    mapSource.includes("layers.districts.style('display', zoneView ? 'none' : null)"));
  check('zone view is the initial paint, not a scroll side effect',
    html.includes('<svg id="svg" data-m="campaign"') &&
    cssText.includes("#svg[data-m='campaign'] #gd,") &&
    cssText.includes("#svg[data-m='campaign'] #gp,") &&
    cssText.includes("#svg[data-m='campaign'] #ga,"));
  check('zone geometry is fetched before the larger boundary files',
    mapSource.includes("cache.zones = await fetchAsset('up-kshetra.json')") &&
    mapSource.indexOf('await loadZones()') < mapSource.indexOf('ensureBaseLayers().catch') &&
    !mapSource.includes('const [districtTopo, pcTopo, acTopo, zones]'));
  check('map redraws when its box settles without needing a scroll',
    mapSource.includes('new ResizeObserver(scheduleMapResize).observe(mapEl)') &&
    mainSource.includes('applyScrollState(true)') &&
    !mainSource.includes('requestAnimationFrame(applyScrollState)'));
  const zoneNameFont = Number(cssText.match(/\.zone-label-name\s*\{[^}]*font-size:\s*clamp\((\d+)px/)?.[1] ?? 0);
  const zoneValueFont = Number(cssText.match(/\.zone-label-value\s*\{[^}]*font-size:\s*clamp\((\d+)px/)?.[1] ?? 0);
  check('zone metrics are legible for older readers',
    zoneNameFont >= 18 && zoneValueFont >= 15 &&
    cssText.includes('stroke-width: 5px') &&
    cssText.includes('font-variant-numeric: tabular-nums'));
  check('campaign legend never calls quantiles on a quantize scale',
    mapSource.includes('d3.scaleQuantize()') &&
    !/const scale = zoneOpacityScale\(\);[^}]*scale\.quantiles\(\)/.test(mapSource) &&
    mapSource.includes('d3.range(ZONE_TINTS.length + 1)'));

  check('light mode toggle is rendered',
    html.includes('id="theme-toggle"') && html.includes('class="theme-toggle-icon"') &&
    (html.match(/data-theme-toggle/g) || []).length === 2);
  check('light theme tokens and overrides are defined',
    cssText.includes("[data-theme='light']") && cssText.includes('--page-bg') && cssText.includes('--accent-ui'));
  check('theme is applied before CSS paints',
    html.includes("dataset.theme = saved === 'light' ? 'light' : 'dark'") && html.includes('/js/theme.js'));
  check('story cards follow the active theme',
    cssText.includes('--story-bg: var(--ink-2)') &&
    cssText.includes('--story-bg: #ffffff') &&
    cssText.includes('background: var(--story-bg);') &&
    !cssText.includes('.dark {\n  background: var(--ink-2);'));
  check('form controls follow the active theme',
    cssText.includes('--control-bg: #000') &&
    cssText.includes('--control-bg: #ffffff') &&
    cssText.includes('background: var(--control-bg);'));
  check('light mode removes text and node shadows',
    cssText.includes('text-shadow: none;') &&
    cssText.includes("[data-theme='light'] .network-team circle.pradhan,") &&
    cssText.includes('filter: none;'));
  check('network regions are themeable',
    cssText.includes('.network-region.selected') &&
    cssText.includes("[data-theme='light'] .network-region.selected"));

  // WCAG AA: normal text >= 4.5:1; focus rings and UI borders >= 3:1.
  const aaText = [
    ['body text on cream', '#121212', '#f5f2ec'],
    ['muted text on cream', '#6b655c', '#f5f2ec'],
    ['orange ink on cream', '#b03a00', '#f5f2ec'],
    ['body text on light card', '#1a1a1a', '#ffffff'],
    ['muted text on light card', '#5b544b', '#ffffff'],
    ['accent text on light card', '#a83a00', '#ffffff'],
    ['muted text on light page', '#5b544b', '#efe9df'],
    ['story muted on light card', '#5b544b', '#ffffff'],
    ['story accent on light card', '#a83a00', '#ffffff'],
    ['story note on light card', '#8a3c0d', '#ffffff'],
    ['team verified badge', '#ffffff', '#146c43'],
    ['team unverified badge', '#ffffff', '#8a3c0d'],
    ['team duty badge', '#ffffff', '#1d4f91'],
    ['team duty negative badge', '#ffffff', '#8a3c0d'],
    ['story muted on dark card', '#a9a29a', '#1a1a1a'],
    ['story accent on dark card', '#ff6200', '#1a1a1a'],
    ['ui text on dark chip', '#e8e2d8', '#121212'],
    ['ui text on light chip', '#1a1a1a', '#ffffff'],
  ];
  const aaUi = [
    ['dark focus ring', '#ffd21f', '#121212'],
    ['light focus ring', '#a83a00', '#ffffff'],
    ['light ui border', '#8a8175', '#ffffff'],
  ];
  check('WCAG AA text contrast', aaText.every(([, a, b]) => contrastRatio(a, b) >= 4.5),
    aaText.filter(([, a, b]) => contrastRatio(a, b) < 4.5).map(([name]) => name).join(', '));
  check('WCAG AA focus and UI contrast', aaUi.every(([, a, b]) => contrastRatio(a, b) >= 3),
    aaUi.filter(([, a, b]) => contrastRatio(a, b) < 3).map(([name]) => name).join(', '));

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
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.label.padEnd(width)}  ${entry.ok ? '' : entry.detail || 'data mismatch'}`);
}
console.log('');
if (failures.length) {
  console.error(`${failures.length} smoke check(s) failed.`);
  process.exit(1);
}
console.log(`All ${checks.length} smoke checks passed against the live server.`);
