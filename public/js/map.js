// D3 map: state layers, real choropleths, per-AC village drill-down.
// Geometry is loaded lazily; only the assembly/district/parliament layers are
// fetched up front. Villages arrive one AC at a time (~15–60 KB gzipped).
const ORANGE = ['#3a2417', '#5c2f15', '#8a3d10', '#c24d0a', '#ff6200'];
// Drill-down villages: transparent for the lowest join count, deep orange for the highest.
const VILLAGE_ORANGE = [
  'rgba(194, 65, 12, 0.05)',
  'rgba(234, 88, 12, 0.28)',
  'rgba(234, 88, 12, 0.52)',
  'rgba(249, 115, 22, 0.78)',
  '#c2410c',
];
const INDEX_COLORS = ['#e03a2f', '#f5c518', '#8fcf6a', '#1a8f5a'];

export function createMap({ boot }) {
  const d3 = window.d3;
  const topojson = window.topojson;

  const svg = d3.select('#svg');
  const g = d3.select('#g');
  const layers = {
    zones: d3.select('#gz'),
    districts: d3.select('#gd'),
    parliament: d3.select('#gp'),
    assembly: d3.select('#ga'),
    subdistricts: d3.select('#gs'),
    grid: d3.select('#gg'),
    tiers: d3.select('#gt'),
    villages: d3.select('#gv'),
    hq: d3.select('#gh'),
  };
  const tip = document.getElementById('tip');
  const mapEl = document.getElementById('map');
  const legendEl = document.getElementById('legend');
  const statEl = document.getElementById('mapstat');
  const descEl = document.getElementById('map-svg-desc');
  const defaultDesc = descEl?.textContent || '';

  const AC = boot.acs;
  const acMeta = new Map(AC.map((a) => [a[0], a]));
  const sortedBooths = AC.map((a) => a[3]).sort((a, b) => a - b);
  const medianBooths = sortedBooths.length
    ? sortedBooths[Math.floor(sortedBooths.length / 2)]
    : 0;

  // District polygons and village polygons spell some names differently.
  const districtKeyOf = (name) => {
    const key = String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z]/g, '');
    return key === 'faizabad' ? 'ayodhya' : key;
  };
  const districtAgg = new Map();
  for (const district of boot.districts || []) {
    districtAgg.set(districtKeyOf(district[0]), district);
    if (district[4]) districtAgg.set(districtKeyOf(district[4]), district);
  }
  const districtAggOf = (feature) =>
    districtAgg.get(districtKeyOf(feature.properties.dtname));
  const pcAgg = new Map((boot.pc || []).map((p) => [p[0], p]));

  // Three-tier definition comes from the view model, so the card chart and this
  // map cannot drift apart. metricIndex points into a boot.districts row.
  const TIERS = boot.tiers || [];
  const tierById = new Map(TIERS.map((tier) => [tier.id, tier]));
  const defaultTier = tierById.has('gram') ? 'gram' : TIERS[0]?.id;
  const tierScales = new Map(
    TIERS.map((tier) => {
      const values = (boot.districts || [])
        .map((district) => district[tier.metricIndex])
        .filter((value) => value > 0);
      return [
        tier.id,
        d3.scaleQuantile(values.length ? values : [0, 1], ORANGE),
      ];
    }),
  );

  const state = {
    mode: 'campaign',
    tier: defaultTier,
    district: null,
    pc: null,
    selected: null,
    hq: false,
    ready: false,
    width: 0,
    height: 0,
    projection: null,
    path: null,
    zoom: null,
  };

  const cache = {
    zones: null,
    chunks: new Map(),
    grid: null,
    subdistricts: null,
    hqDistricts: null,
    hqSubdistricts: null,
    features: {},
  };

  const acBoothScale = d3.scaleQuantile(
    AC.map((a) => a[3]),
    ORANGE,
  );
  const densityScale = d3.scaleQuantile(
    AC.map((a) => a[7]).filter((v) => v > 0),
    ORANGE,
  );
  const indexScale = d3.scaleThreshold([40, 60, 80], INDEX_COLORS);
  const districtScale = d3.scaleQuantile(
    (boot.districts || []).map((d) => d[1]),
    ORANGE,
  );
  // Six zones: a deeper tint means a larger share of all appointments.
  const ZONE_TINTS = [
    'rgba(255, 98, 0, 0.22)',
    'rgba(255, 98, 0, 0.34)',
    'rgba(255, 98, 0, 0.46)',
    'rgba(255, 98, 0, 0.58)',
    'rgba(255, 98, 0, 0.7)',
  ];
  const zoneOpacityScale = () => {
    const max = d3.max(cache.zones?.features || [], (f) => f.properties.share) || 1;
    return d3.scaleQuantize().domain([0, max]).range([0.22, 0.34, 0.46, 0.58, 0.7]);
  };
  const pcScale = d3.scaleQuantile(
    (boot.pc || []).map((p) => p[2]),
    ORANGE,
  );

  let onAcClick = () => {};
  let onVillageClick = () => {};
  let onDistrictSelect = () => {};
  let onPcSelect = () => {};

  // ------------------------------------------------------------------ tooltip
  function showTip(event, text) {
    tip.textContent = text;
    tip.style.display = 'block';
    const pad = 14;
    const x = Math.min(event.clientX + pad, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min(event.clientY + pad, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  function hideTip() {
    tip.style.display = 'none';
  }

  function districtTipText(feature) {
    const agg = districtAggOf(feature);
    const name = agg?.[0] ?? feature.properties.dtname ?? 'ज़िला';
    if (state.mode !== 'panchayat') {
      return `${name} · ${fmt(agg?.[1] ?? 0)} बूथ · ${fmt(agg?.[2] ?? 0)} गाँव`;
    }
    const tier = tierById.get(state.tier);
    const value = tier ? agg?.[tier.metricIndex] ?? 0 : 0;
    const blocks = agg?.[6]
      ? `${fmt(agg[6])} ब्लॉक`
      : 'ब्लॉक-गणना नहीं';
    return (
      `${name} · ${fmt(value)} ${tier?.districtMetric ?? ''} · ${tier?.metricLabel ?? ''}\n` +
      `${fmt(agg?.[2] ?? 0)} गाँव · ${blocks} · ${fmt(agg?.[5] ?? 0)} GP\n` +
      `क्लिक: ज़िला चुनें`
    );
  }

  const fmt = (value) => new Intl.NumberFormat('en-IN').format(Math.round(value));
  const escHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  const prefersReducedMotion = () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // -------------------------------------------------------------------- layers
  const fetchJson = (name) => d3.json(`/data/${name}?v=${boot.v}`);
  // public/ asset mirrored into docs/; the Pages fetch shim rewrites the
  // root-relative URL to the project's base path.
  const fetchAsset = (name) => d3.json(`/${name}?v=${boot.v}`);

  async function loadZones() {
    // The hero only needs the six zone polygons. Load them on their own so the
    // opening view is never held back by the much larger boundary files.
    cache.zones = await fetchAsset('up-kshetra.json');
  }

  let baseLayersPromise = null;
  function ensureBaseLayers() {
    if (!baseLayersPromise) {
      baseLayersPromise = (async () => {
        const [districtTopo, pcTopo, acTopo] = await Promise.all([
          fetchJson('districts.topo.json'),
          fetchJson('parliament.topo.json'),
          fetchJson('assembly.topo.json'),
        ]);
        const first = (topo) =>
          topojson.feature(topo, topo.objects[Object.keys(topo.objects)[0]]);
        cache.features.districts = first(districtTopo);
        cache.features.parliament = first(pcTopo);
        cache.features.assembly = first(acTopo);
        // Redraw with the finer geometry now available; campaign mode keeps it
        // hidden, so the hero view does not change.
        resize();
      })();
    }
    return baseLayersPromise;
  }

  async function ensureSubdistricts() {
    if (cache.features.subdistricts) return;
    const topo = await fetchJson('subdistricts.topo.json');
    cache.features.subdistricts = topojson.feature(
      topo,
      topo.objects[Object.keys(topo.objects)[0]],
    );
    drawSubdistricts();
  }

  async function ensureGrid() {
    if (cache.grid) return;
    cache.grid = await fetchJson('village-grid.json');
    drawGrid();
  }

  async function ensureHq() {
    if (cache.hqDistricts) return;
    const [district, sub] = await Promise.all([
      fetchJson('hq-districts.json'),
      fetchJson('hq-subdistricts.json'),
    ]);
    cache.hqDistricts = district;
    cache.hqSubdistricts = sub;
    drawHq();
  }

  // -------------------------------------------------------------------- render
  function drawBase() {
    // The hero paints straight from the zone asset before these arrive.
    if (!cache.features.districts || !cache.features.parliament || !cache.features.assembly) return;
    const { path } = state;

    layers.districts
      .selectAll('path')
      .data(cache.features.districts.features)
      .join('path')
      .attr('class', 'dt')
      .attr('d', path)
      .on('mousemove', (event, d) => showTip(event, districtTipText(d)))
      .on('mouseleave', hideTip)
      .on('click', (event, d) => {
        if (state.mode !== 'panchayat') return;
        event.stopPropagation();
        selectDistrict(districtAggOf(d)?.[0] ?? d.properties.dtname);
      })
      .on('keydown', (event, d) => {
        if (
          (state.mode !== 'panchayat') ||
          (event.key !== 'Enter' && event.key !== ' ')
        )
          return;
        event.preventDefault();
        selectDistrict(districtAggOf(d)?.[0] ?? d.properties.dtname);
      });

    layers.parliament
      .selectAll('path')
      .data(cache.features.parliament.features)
      .join('path')
      .attr('class', 'pc')
      .attr('d', path)
      .on('mousemove', (event, d) => {
        const agg = pcAgg.get(Number(d.properties.PC_NO));
        showTip(
          event,
          `${d.properties.PC_NAME || 'लोकसभा'} · ${fmt(agg?.[2] ?? 0)} बूथ`,
        );
      })
      .on('mouseleave', hideTip)
      .on('click', (event, d) => {
        if (state.mode !== 'pc') return;
        event.stopPropagation();
        selectPc(Number(d.properties.PC_NO), { toggle: true });
      })
      .on('keydown', (event, d) => {
        if (state.mode !== 'pc' || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        selectPc(Number(d.properties.PC_NO), { toggle: true });
      });

    layers.assembly
      .selectAll('path')
      .data(cache.features.assembly.features)
      .join('path')
      .attr('class', 'ac')
      .attr('d', path)
      .on('mousemove', (event, d) => {
        const ac = acMeta.get(Number(d.properties.AC_NO));
        showTip(
          event,
          `${ac?.[1] ?? d.properties.AC_NAME} · ${ac?.[2] ?? d.properties.DIST_NAME} · ` +
            `${fmt(ac?.[3] ?? 0)} बूथ · ${fmt(ac?.[4] ?? 0)} गाँव\nक्लिक: गाँव नक्शा खोलेगा`,
        );
      })
      .on('mouseleave', hideTip)
      .on('click', (event, d) => {
        // In the Lok Sabha view the outlines belong to the PC filter; in the
        // two district views they are hidden. Everywhere else, clicking an AC
        // opens its village map (drill-down).
        if (state.mode === 'pc' || state.mode === 'campaign' || state.mode === 'panchayat') return;
        event.stopPropagation();
        const no = Number(d.properties.AC_NO);
        onAcClick(no);
      })
      .on('mouseover', function () {
        d3.select(this).classed('hover', true);
      })
      .on('mouseout', function () {
        d3.select(this).classed('hover', false);
      });

    layers.assembly
      .selectAll('path')
      .classed('on', (d) => Number(d.properties.AC_NO) === state.selected);
  }

  function drawSubdistricts() {
    if (!cache.features.subdistricts) return;
    layers.subdistricts
      .selectAll('path')
      .data(cache.features.subdistricts.features)
      .join('path')
      .attr('class', 'sd')
      .attr('d', state.path)
      .on('mousemove', (event, d) =>
        showTip(
          event,
          `${d.properties.sdtname || 'तहसील'} · ${d.properties.dtname || ''}`,
        ),
      )
      .on('mouseleave', hideTip);
  }

  function drawGrid() {
    const { projection } = state;
    if (!cache.grid || !projection) return;
    const cell = cache.grid.cell;
    const max = d3.max(cache.grid.cells, (c) => c[3]) || 1;
    const opacity = d3.scaleSqrt().domain([0, max]).range([0.1, 0.95]);

    const x = (lon, lat) => projection([lon, lat])?.[0] ?? 0;
    const y = (lon, lat) => projection([lon, lat])?.[1] ?? 0;

    layers.grid
      .selectAll('rect')
      .data(cache.grid.cells)
      .join('rect')
      .attr('class', 'grid-cell')
      .attr('x', (d) => x(d[0] - cell / 2, d[1]))
      .attr('y', (d) => y(d[0], d[1] + cell / 2))
      .attr('width', (d) => Math.abs(x(d[0] + cell / 2, d[1]) - x(d[0] - cell / 2, d[1])) + 0.6)
      .attr('height', (d) => Math.abs(y(d[0], d[1] - cell / 2) - y(d[0], d[1] + cell / 2)) + 0.6)
      .style('fill', (d) => (d[3] > 0 ? '#ff6200' : '#5a4635'))
      .style('fill-opacity', (d) => (d[3] > 0 ? opacity(d[3]) : 0.22));
  }

  function drawHq() {
    if (!cache.hqDistricts || !state.projection) return;
    const features = [...cache.hqDistricts.features, ...cache.hqSubdistricts.features];
    layers.hq
      .selectAll('path')
      .data(features)
      .join('path')
      .attr('class', 'hq')
      .attr('d', state.path)
      .on('mousemove', (event, d) =>
        showTip(event, `${d.properties.name || 'मुख्यालय'} · ${d.properties.district || ''}`),
      )
      .on('mouseleave', hideTip);
  }

  // ------------------------------------------------------------------- zones
  function zoneTipText(feature) {
    const p = feature.properties;
    return (
      `${p.name} · ${fmt(p.appointed)} नियुक्तियाँ\n` +
      `कुल ${fmt(cache.zones?.total || 0)} का ${p.share}% हिस्सा`
    );
  }

  function zoneDescription() {
    if (!cache.zones) return defaultDesc;
    const parts = cache.zones.features.map(
      (f) => `${f.properties.name} ${fmt(f.properties.appointed)} नियुक्तियाँ, ${f.properties.share}%`,
    );
    return `कुल ${fmt(cache.zones.total)} नियुक्तियों (प्रदेश स्तर सहित) की क्षेत्रवार हिस्सेदारी: ${parts.join('; ')}।`;
  }

  function drawZones() {
    if (!cache.zones || !state.path) return;
    const opacity = zoneOpacityScale();
    const zones = cache.zones.features;

    const paths = layers.zones
      .selectAll('path.zone')
      .data(zones, (f) => f.properties.id)
      .join('path')
      .attr('class', 'zone')
      .attr('d', state.path)
      .style('fill', '#ff6200')
      .style('fill-opacity', (f) => opacity(f.properties.share))
      .on('mousemove', (event, f) => showTip(event, zoneTipText(f)))
      .on('mouseleave', hideTip)
      .on('mouseover', function () { d3.select(this).classed('hover', true); })
      .on('mouseout', function () { d3.select(this).classed('hover', false); });

    paths
      .selectAll('title')
      .data((f) => [f])
      .join('title')
      .text((f) => zoneTipText(f).replace('\n', ' · '));

    const labels = layers.zones
      .selectAll('g.zone-label')
      .data(zones, (f) => f.properties.id)
      .join('g')
      .attr('class', 'zone-label')
      .attr('transform', (f) => {
        const [x, y] = state.path.centroid(f);
        return `translate(${x},${y})`;
      });
    labels.selectAll('text').remove();
    labels
      .append('text')
      .attr('class', 'zone-label-name')
      .attr('dy', '-0.15em')
      .text((f) => f.properties.name);
    labels
      .append('text')
      .attr('class', 'zone-label-value')
      .attr('dy', '1.25em')
      .text((f) => `${fmt(f.properties.appointed)} · ${f.properties.share}%`);
  }

  // One bubble per district, sized by the selected tier's metric. The same
  // metric drives the choropleth fill, so the two encodings reinforce each other.
  function drawTierMarkers() {
    if (!cache.features.districts || !state.path || !tierById.has(state.tier)) return;
    const tier = tierById.get(state.tier);
    const rows = cache.features.districts.features
      .map((feature) => ({ feature, agg: districtAggOf(feature) }))
      .filter((row) => row.agg)
      .map((row) => ({ ...row, key: districtKeyOf(row.feature.properties.dtname) }));
    const max = d3.max(rows, (row) => row.agg[tier.metricIndex]) || 1;
    const radius = d3.scaleSqrt().domain([0, max]).range([1.5, 7]);

    layers.tiers
      .selectAll('circle')
      .data(rows, (row) => row.key)
      .join('circle')
      .attr('class', 'tier-dot')
      .attr('cx', (row) => state.path.centroid(row.feature)[0])
      .attr('cy', (row) => state.path.centroid(row.feature)[1])
      .attr('r', (row) => radius(row.agg[tier.metricIndex] || 0))
      .classed('on', (row) => state.district === districtKeyOf(row.agg[0]))
      .on('mousemove', (event, row) => showTip(event, districtTipText(row.feature)))
      .on('mouseleave', hideTip)
      .on('click', (event, row) => {
        event.stopPropagation();
        selectDistrict(row.agg[0]);
      });
  }

  function drawVillages(no) {
    const chunk = cache.chunks.get(no);
    if (!chunk) return;
    const { path } = state;

    layers.villages.selectAll('*').remove();
    if (!chunk.features.length) return;

    const max = d3.max(chunk.features, (f) => f.properties.c || 0) || 1;
    const scale = d3.scaleQuantize([1, max], VILLAGE_ORANGE);

    layers.villages
      .selectAll('path')
      .data(chunk.features)
      .join('path')
      .attr('class', 'v')
      .attr('d', path)
      .style('fill', (d) => (d.properties.c > 0 ? scale(d.properties.c) : 'rgba(120, 113, 108, 0.16)'))
      .on('mousemove', (event, d) => {
        const p = d.properties;
        showTip(
          event,
          `${p.n || 'गाँव'} · ${p.c || 0} बूथ` +
            `${p.gn ? ` · GP: ${p.gn}` : ''}${p.b ? ` · ${p.b}` : ''}`,
        );
      })
      .on('mouseleave', hideTip)
      .on('click', (event, d) => onVillageClick(d.properties.i));

    if (chunk.gp) {
      layers.villages
        .append('path')
        .datum(chunk.gp)
        .attr('class', 'gpmesh')
        .attr('d', path);
    }
  }

  // ------------------------------------------------------------------- scales
  function districtColor(feature) {
    if (state.mode === 'panchayat') {
      const agg = districtAggOf(feature);
      const tier = tierById.get(state.tier);
      if (!agg || !tier) return '#2a2a2a';
      const value = agg[tier.metricIndex] || 0;
      return value > 0 ? tierScales.get(tier.id)(value) : '#2a2a2a';
    }
    const agg = districtAggOf(feature);
    return agg ? districtScale(agg[1]) : '#2a2a2a';
  }

  function pcColor(feature) {
    const agg = pcAgg.get(Number(feature.properties.PC_NO));
    return agg ? pcScale(agg[2]) : '#2a2a2a';
  }

  function acColor(feature) {
    const ac = acMeta.get(Number(feature.properties.AC_NO));
    if (!ac) return '#2a2a2a';
    if (state.mode === 'ac') return acBoothScale(ac[3]);
    if (state.mode === 'density') return ac[7] > 0 ? densityScale(ac[7]) : '#2c2c2c';
    if (state.mode === 'index') return indexScale(ac[8]);
    return null;
  }

  function applyFills() {
    const reduced = prefersReducedMotion();
    const duration = reduced ? 0 : 450;
    if (reduced) {
      layers.districts
        .selectAll('path')
        .style('fill', (d) =>
          state.mode === 'dt' || state.mode === 'panchayat' ? districtColor(d) : null,
        );
      layers.parliament
        .selectAll('path')
        .style('fill', (d) => (state.mode === 'pc' ? pcColor(d) : null));
      layers.assembly
        .selectAll('path')
        .style('fill', (d) => (state.mode === 'panchayat' ? 'none' : acColor(d)));
      return;
    }
    layers.districts
      .selectAll('path')
      .transition()
      .duration(duration)
      .style('fill', (d) =>
        state.mode === 'dt' || state.mode === 'panchayat' ? districtColor(d) : null,
      );

    layers.parliament
      .selectAll('path')
      .transition()
      .duration(duration)
      .style('fill', (d) => (state.mode === 'pc' ? pcColor(d) : null));

    layers.assembly
      .selectAll('path')
      .transition()
      .duration(duration)
      .style('fill', (d) => (state.mode === 'panchayat' ? 'none' : acColor(d)));
  }

  // ------------------------------------------------------------------- legend
  function quantileItems(scale, format) {
    const domain = scale.domain();
    const q = scale.quantiles();
    const bounds = [domain[0], ...q, domain[domain.length - 1]];
    const colors = scale.range();
    return colors.map((color, i) => {
      if (i === 0) return [color, `< ${format(bounds[1])}`];
      if (i === colors.length - 1) return [color, `≥ ${format(bounds[i])}`];
      return [color, `${format(bounds[i])}–${format(bounds[i + 1])}`];
    });
  }

  function renderLegend(mode) {
    let title = '';
    let items = [];
    if (mode === 'campaign') {
      title = 'नियुक्ति हिस्सेदारी · क्षेत्रवार';
      const scale = zoneOpacityScale();
      const bounds = [0, ...scale.quantiles(), scale.domain()[1]];
      items = ZONE_TINTS.map((color, i) => [
        color,
        `${Math.round(bounds[i])}–${Math.round(bounds[i + 1])}%`,
      ]);
    } else if (mode === 'dt') {
      title = 'बूथ प्रति ज़िला';
      items = quantileItems(districtScale, (v) => fmt(v));
    } else if (mode === 'panchayat') {
      const tier = tierById.get(state.tier);
      title = `${tier?.label ?? 'पंचायत'} · ${tier?.metricLabel ?? ''}`;
      items = quantileItems(tierScales.get(state.tier), (v) => fmt(v));
      items.push(['#ffb067', 'बिंदु = ज़िला']);
    } else if (mode === 'pc') {
      title = 'बूथ प्रति लोकसभा';
      items = quantileItems(pcScale, (v) => fmt(v));
      if (state.pc) {
        items.push(['#ffb067', `चुना: ${escHtml(pcAgg.get(state.pc)?.[1] ?? state.pc)}`]);
      }
    } else if (mode === 'ac') {
      title = 'बूथ प्रति विधानसभा';
      items = quantileItems(acBoothScale, (v) => fmt(v));
    } else if (mode === 'density') {
      title = 'बूथ / वर्ग किमी';
      items = quantileItems(densityScale, (v) => v.toFixed(1));
    } else if (mode === 'index') {
      title = 'बूथ सैचुरेशन';
      items = [
        ['#e03a2f', '< 40'],
        ['#f5c518', '40–60'],
        ['#8fcf6a', '60–80'],
        ['#1a8f5a', '80+'],
      ];
    } else if (mode === 'villages') {
      title = 'गाँव · बूथ घनत्व';
      items = [
        ['#5a4635', 'बिना बूथ'],
        ['#8a3d10', 'कम'],
        ['#ff6200', 'अधिक'],
      ];
    } else if (mode === 'drill') {
      title = 'गाँव · जुड़े बूथ';
      items = [
        ['rgba(120, 113, 108, 0.5)', '0'],
        ['rgba(194, 65, 12, 0.12)', 'कम'],
        ['rgba(234, 88, 12, 0.4)', ''],
        ['rgba(249, 115, 22, 0.75)', ''],
        ['#c2410c', 'अधिक'],
      ];
    } else if (mode === 'sd') {
      title = 'तहसील सीमाएँ';
      items = [['#6b5647', '310 तहसील']];
    } else if (mode === 'network') {
      title = 'ग्राम पंचायत नेटवर्क';
    }

    legendEl.innerHTML =
      `<div class="ttl">${title}</div><div class="items">` +
      items
        .map(
          ([color, label]) =>
            `<span><s style="background:${color}"></s>${label}</span>`,
        )
        .join('') +
      '</div>';
  }

  function renderStat(mode) {
    const totals = boot.meta.totals;
    if (mode === 'campaign' && cache.zones) {
      const zones = [...cache.zones.features].sort(
        (a, b) => b.properties.share - a.properties.share,
      );
      const lead = zones[0];
      statEl.innerHTML =
        `<b>${fmt(cache.zones.total)}</b> नियुक्तियाँ · <b>${zones.length}</b> क्षेत्र · ` +
        `सबसे बड़ा हिस्सा ${escHtml(lead.properties.name)} ${lead.properties.share}%`;
    } else if (mode === 'dt') {
      statEl.innerHTML = `<b>${fmt(totals.districts)}</b> ज़िले · <b>${fmt(totals.booths)}</b> बूथ · ज़िले पर बूथ संख्या`;
    } else if (mode === 'panchayat') {
      const tier = tierById.get(state.tier);
      const agg = state.district ? districtAgg.get(state.district) : null;
      statEl.innerHTML = agg
        ? `<b>${escHtml(agg[0])}</b> · ${fmt(agg[tier.metricIndex] || 0)} ${tier.districtMetric} · ${tier.label}`
        : `<b>${fmt(totals.districts)}</b> ज़िले · स्तर: ${tier.label} · ${tier.metricLabel} · ज़िला चुनने पर क्लिक करें`;
    } else if (mode === 'pc') {
      const row = state.pc ? pcAgg.get(state.pc) : null;
      statEl.innerHTML = row
        ? `<b>${escHtml(row[1])}</b> · ${fmt(row[4])} विधानसभा · ${fmt(row[2])} बूथ · ${fmt(row[3])} गाँव · सूची फ़िल्टर`
        : `<b>${fmt(totals.pc)}</b> लोकसभा · <b>${fmt(totals.acs)}</b> विधानसभा`;
    } else if (mode === 'ac') {
      statEl.innerHTML = `<b>${fmt(totals.acs)}</b> विधानसभा · मीडियन <b>${fmt(medianBooths)}</b> बूथ · ड्रिल-डाउन अनुभाग में क्लिक करें`;
    } else if (mode === 'density') {
      statEl.innerHTML = `बूथ प्रति वर्ग किमी · विधानसभा क्षेत्रफल से`;
    } else if (mode === 'index') {
      statEl.innerHTML = `बूथ सैचुरेशन इंडेक्स · असली घटकों से बना`;
    } else if (mode === 'villages') {
      statEl.innerHTML = `<b>${fmt(totals.villages)}</b> गाँव · 0.05° ग्रिड · रंग = जुड़े बूथ`;
    } else if (mode === 'sd') {
      statEl.innerHTML = `<b>${fmt(totals.subdistricts)}</b> तहसील · ${fmt(totals.blocks)} ब्लॉक`;
    } else if (mode === 'drill') {
      const ac = state.selected ? acMeta.get(state.selected) : null;
      statEl.innerHTML = ac
        ? `<b>${ac[1]}</b> · ${ac[2]} · ${fmt(ac[3])} बूथ · ${fmt(ac[4])} गाँव`
        : `विधानसभा चुनें · गाँव बहुभुज + GP सीमा`;
    } else if (mode === 'network') {
      statEl.innerHTML = `गाँव · लिंक = साझा ग्राम पंचायत`;
    }
  }

  function updateLayerButtons(mode) {
    document.querySelectorAll('.layers button').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.layer === mode));
    });
  }

  // --------------------------------------------------------------------- zoom
  function initZoom() {
    state.zoom = d3
      .zoom()
      .scaleExtent([1, 22])
      .filter((event) => event.type !== 'wheel')
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });
    svg.call(state.zoom);
    svg.on('dblclick.zoom', null);
  }

  function transformFor(feature) {
    const b = state.path.bounds(feature);
    const dx = b[1][0] - b[0][0];
    const dy = b[1][1] - b[0][1];
    const k = Math.min(12, 0.62 / Math.max(dx / state.width, dy / state.height));
    return d3.zoomIdentity
      .translate(
        state.width / 2 - (k * (b[0][0] + b[1][0])) / 2,
        state.height / 2 - (k * (b[0][1] + b[1][1])) / 2,
      )
      .scale(k);
  }

  function flyTo(feature, duration = 900) {
    if (!state.zoom) return;
    const transform = feature ? transformFor(feature) : d3.zoomIdentity;
    if (prefersReducedMotion() || !duration) {
      svg.call(state.zoom.transform, transform);
      return;
    }
    svg.transition().duration(duration).call(state.zoom.transform, transform);
  }

  // ------------------------------------------------------------------- layout
  function resize() {
    const rect = mapEl.getBoundingClientRect();
    state.width = Math.max(320, rect.width);
    state.height = Math.max(320, rect.height);
    if (!cache.zones && !cache.features.assembly) return;
    // Fit to the six zones alone on the opening view; adding the 403 assembly
    // polygons here would delay the first paint without changing the framing.
    const extent = cache.zones
      ? { type: 'FeatureCollection', features: cache.zones.features }
      : cache.features.assembly;
    state.projection = d3
      .geoMercator()
      .fitExtent(
        [
          [state.width * 0.03, state.height * 0.05],
          [state.width * 0.97, state.height * 0.95],
        ],
        extent,
      );
    state.path = d3.geoPath(state.projection).pointRadius(2.6);

    drawZones();
    drawBase();
    renderPcSelection();
    drawSubdistricts();
    drawGrid();
    drawHq();
    drawTierMarkers();
    if (state.mode === 'drill' && state.selected) drawVillages(state.selected);
    applyFills();
    renderLegend(state.mode);
    renderStat(state.mode);
  }

  // -------------------------------------------------------------------- modes
  async function setMode(mode) {
    // Every mode except the zone hero and the full-width panels needs the
    // boundary geometry. Await it here so a fast scroll during boot still lands
    // on a fully drawn map.
    if (mode !== 'campaign' && mode !== 'network' && mode !== 'team') {
      await ensureBaseLayers();
    }
    state.mode = mode;
    svg.attr('data-m', mode);
    if (descEl) descEl.textContent = mode === 'campaign' ? zoneDescription() : defaultDesc;
    updateLayerButtons(mode);
    const networkView = document.getElementById('network-view');
    networkView.style.display = mode === 'network' ? 'block' : 'none';
    networkView.setAttribute('aria-hidden', String(mode !== 'network'));
    const panchayatView = document.getElementById('panchayat-view');
    if (panchayatView) {
      panchayatView.style.display = mode === 'panchayat' ? 'block' : 'none';
      panchayatView.setAttribute('aria-hidden', String(mode !== 'panchayat'));
    }
    legendEl.style.display = mode === 'network' ? 'none' : '';
    statEl.style.display = mode === 'network' ? 'none' : '';
    document.querySelector('.mapfoot').style.display = mode === 'network' ? 'none' : '';

    // The hero view is the six-zone map from up_kshetra.geojson; every finer
    // boundary (district, parliament, assembly) must step aside or its 403
    // dark polygons cover the zone fills. The panchayat view does the same for
    // the district choropleth.
    const zoneView = mode === 'campaign';
    const districtPick = mode === 'panchayat';
    const outlineHidden = zoneView || districtPick;
    layers.zones.style('display', zoneView ? null : 'none');
    layers.districts.style('display', zoneView ? 'none' : null);
    layers.subdistricts.style('display', mode === 'sd' ? null : 'none');
    layers.grid.style('display', mode === 'villages' ? null : 'none');
    layers.villages.style('display', mode === 'drill' ? null : 'none');
    layers.tiers.style('display', districtPick ? null : 'none');
    layers.parliament.style('display', outlineHidden ? 'none' : null);
    layers.assembly.style('display', outlineHidden ? 'none' : null);
    layers.hq.style('display', state.hq ? null : 'none');
    layers.districts
      .selectAll('path')
      .attr('tabindex', districtPick ? 0 : null)
      .attr('role', districtPick ? 'button' : null);
    layers.parliament
      .selectAll('path')
      .attr('tabindex', mode === 'pc' ? 0 : null)
      .attr('role', mode === 'pc' ? 'button' : null);
    renderPcSelection();

    if (mode === 'sd') await ensureSubdistricts();
    if (mode === 'villages') await ensureGrid();

    if (mode === 'campaign') drawZones();
    applyFills();
    drawTierMarkers();
    renderLegend(mode);
    renderStat(mode);
    renderPanchayatReadout();

    if (mode === 'drill') {
      if (state.selected) {
        const feature = cache.features.assembly.features.find(
          (f) => Number(f.properties.AC_NO) === state.selected,
        );
        if (feature) flyTo(feature);
        await loadAndDraw(state.selected);
      } else {
        layers.villages.selectAll('*').remove();
        flyTo(null);
      }
    } else {
      layers.villages.selectAll('*').remove();
      if (districtPick && state.district) {
        const feature = cache.features.districts.features.find(
          (f) => districtKeyOf(f.properties.dtname) === state.district,
        );
        if (feature) flyTo(feature);
      } else {
        flyTo(null);
      }
    }
  }

  async function loadAndDraw(no) {
    if (!cache.chunks.has(no)) {
      const ac = acMeta.get(no);
      // Urban seats carry no village polygons at all — don't request a 404.
      if (!ac || ac[4] === 0) {
        cache.chunks.set(no, { features: [], gp: null });
      } else {
        statEl.innerHTML = 'गाँव लोड हो रहे हैं…';
        try {
          const topo = await fetchJson(`ac/${no}.topo.json`);
          const features = topojson.feature(topo, topo.objects.v).features;
          const gp = topojson.mesh(
            topo,
            topo.objects.v,
            (a, b) => (a.properties.g || '') !== (b.properties.g || ''),
          );
          cache.chunks.set(no, { features, gp });
        } catch (error) {
          console.error(`village chunk ${no}`, error);
          cache.chunks.set(no, { features: [], gp: null });
        }
      }
    }
    if (state.selected === no) drawVillages(no);
    renderStat(state.mode);
  }

  // --------------------------------------------------------- three-tier layer
  function renderPanchayatReadout() {
    const host = document.getElementById('panchayat-readout');
    if (!host) return;
    const tier = tierById.get(state.tier);
    const agg = state.district ? districtAgg.get(state.district) : null;
    if (!agg) {
      const rows = boot.districts || [];
      const gps = rows.reduce((sum, row) => sum + (row[5] || 0), 0);
      const blocks = rows.reduce((sum, row) => sum + (row[6] || 0), 0);
      host.innerHTML =
        `<b>${fmt(rows.length)} ज़िले</b> · ${fmt(blocks)} ब्लॉक (डेटा में) · ${fmt(gps)} GP (डेटा में)` +
        '<br><small>किसी ज़िले पर क्लिक करें या पट्टी चुनें।</small>';
      return;
    }
    const value = agg[tier.metricIndex] || 0;
    const blocks = agg[6]
      ? `${fmt(agg[6])} ब्लॉक`
      : 'ब्लॉक-गणना नहीं';
    host.innerHTML =
      `<b>${escHtml(agg[0])}</b> · <span class="pr-value">${fmt(value)} ${tier.districtMetric}</span>` +
      `<br><small>${fmt(agg[2] || 0)} गाँव · ${blocks} · ${fmt(agg[5] || 0)} GP</small>`;
  }

  // Keep the parliament outlines and the ACs they contain in sync with the
  // shared Lok Sabha filter (the selectors live outside the map).
  function renderPcSelection() {
    layers.parliament
      .selectAll('path')
      .classed('on', (d) => Boolean(state.pc) && Number(d.properties.PC_NO) === state.pc)
      .classed('dim', (d) => Boolean(state.pc) && Number(d.properties.PC_NO) !== state.pc);
    layers.assembly
      .selectAll('path')
      .classed('pc-match', (d) => {
        if (!state.pc) return false;
        const ac = acMeta.get(Number(d.properties.AC_NO));
        return Number(ac?.[11]) === state.pc;
      });
  }

  function selectPc(no, { toggle = false, fly = true } = {}) {
    const numeric = Number(no);
    const valid = Number.isFinite(numeric) && pcAgg.has(numeric);
    state.pc = valid && (!toggle || numeric !== state.pc) ? numeric : null;
    renderPcSelection();
    if (state.mode === 'pc') {
      renderLegend(state.mode);
      renderStat(state.mode);
    }
    onPcSelect(state.pc ? String(state.pc) : '');

    if (!fly) return;
    const feature = state.pc
      ? cache.features.parliament.features.find(
          (f) => Number(f.properties.PC_NO) === state.pc,
        )
      : null;
    flyTo(feature ?? null, 700);
  }

  function selectDistrict(name, { toggle = true, fly = true } = {}) {
    const key = districtKeyOf(name);
    const agg = districtAgg.get(key);
    // Clicking the active district on the map clears it; an explicit choice
    // from a selector sets it without toggling off.
    state.district = agg && (!toggle || key !== state.district) ? key : null;

    layers.districts
      .selectAll('path')
      .classed('on', (d) => Boolean(state.district) && districtKeyOf(d.properties.dtname) === state.district);
    drawTierMarkers();
    renderStat(state.mode);
    renderPanchayatReadout();
    onDistrictSelect(state.district ? districtAgg.get(state.district) : null);

    if (!state.district) {
      if (fly) flyTo(null, 700);
      return;
    }
    const feature = cache.features.districts.features.find(
      (f) => districtKeyOf(f.properties.dtname) === state.district,
    );
    if (feature && fly) flyTo(feature, 700);
  }

  function setTier(id) {
    if (!tierById.has(id)) return;
    state.tier = id;
    document.querySelectorAll('[data-tier-viz] .tier-row').forEach((row) => {
      row.setAttribute('aria-pressed', String(row.dataset.tier === id));
    });
    if (state.mode !== 'panchayat') {
      setMode('panchayat');
      return;
    }
    applyFills();
    drawTierMarkers();
    renderLegend(state.mode);
    renderStat(state.mode);
    renderPanchayatReadout();
  }

  async function focusAc(no) {
    const acNo = Number(no);
    if (!Number.isFinite(acNo) || !cache.features.assembly) return;
    state.selected = acNo;
    // Opening an AC is also a Lok Sabha choice: keep the shared filter in sync.
    const pcNo = Number(acMeta.get(acNo)?.[11]);
    if (Number.isFinite(pcNo) && pcNo > 0 && pcNo !== state.pc) {
      state.pc = pcNo;
      renderPcSelection();
      onPcSelect(String(pcNo));
    }
    layers.assembly
      .selectAll('path')
      .classed('on', (d) => Number(d.properties.AC_NO) === acNo);
    const feature = cache.features.assembly.features.find(
      (f) => Number(f.properties.AC_NO) === acNo,
    );
    if (feature) flyTo(feature);
    await loadAndDraw(acNo);
    renderStat(state.mode);
  }

  function highlightVillage(id) {
    const key = String(id);
    layers.villages
      .selectAll('path.v')
      .classed('hot', (d) => String(d.properties.i) === key);
  }

  // ---------------------------------------------------------------------- wire
  function wireControls() {
    document.querySelectorAll('.layers button').forEach((button) => {
      button.addEventListener('click', () => {
        setMode(button.dataset.layer);
      });
    });

    const zoomBy = (factor) => {
      if (prefersReducedMotion()) svg.call(state.zoom.scaleBy, factor);
      else svg.transition().duration(250).call(state.zoom.scaleBy, factor);
    };

    document.getElementById('zoom-in').addEventListener('click', () => {
      zoomBy(1.5);
    });
    document.getElementById('zoom-out').addEventListener('click', () => {
      zoomBy(1 / 1.5);
    });
    document.getElementById('zoom-reset').addEventListener('click', () => {
      if (state.mode === 'drill' && state.selected) {
        const feature = cache.features.assembly.features.find(
          (f) => Number(f.properties.AC_NO) === state.selected,
        );
        if (feature) flyTo(feature);
      } else if (state.mode === 'panchayat' && state.district) {
        const feature = cache.features.districts.features.find(
          (f) => districtKeyOf(f.properties.dtname) === state.district,
        );
        if (feature) flyTo(feature);
      } else if (state.mode === 'pc' && state.pc) {
        const feature = cache.features.parliament.features.find(
          (f) => Number(f.properties.PC_NO) === state.pc,
        );
        if (feature) flyTo(feature);
      } else {
        flyTo(null);
      }
    });
    const hqButton = document.getElementById('hq-toggle');
    hqButton.addEventListener('click', async () => {
      state.hq = !state.hq;
      hqButton.setAttribute('aria-pressed', String(state.hq));
      layers.hq.style('display', state.hq ? null : 'none');
      if (state.hq) await ensureHq();
    });

    let resizeTimer;
    const scheduleMapResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const rect = mapEl.getBoundingClientRect();
        if (Math.abs(rect.width - state.width) < 4 && Math.abs(rect.height - state.height) < 4) return;
        resize();
        flyTo(null, 0);
      }, 140);
    };
    window.addEventListener('resize', scheduleMapResize);
    // Fonts and fixed positioning can settle after the first paint; redraw as
    // soon as the map box really changes instead of waiting for a scroll.
    if ('ResizeObserver' in window) new ResizeObserver(scheduleMapResize).observe(mapEl);
  }

  const ready = (async () => {
    await loadZones();
    state.ready = true;
    resize();
    initZoom();
    wireControls();
    await setMode('campaign');
    // Boundary layers are optional for the hero; fetch them after it is live.
    ensureBaseLayers().catch((error) => console.error('Base layers failed', error));
  })();

  return {
    ready,
    setMode,
    setTier,
    selectDistrict,
    selectPc,
    focusAc,
    highlightVillage,
    setOnAcClick(fn) {
      onAcClick = fn;
    },
    setOnVillageClick(fn) {
      onVillageClick = fn;
    },
    setOnDistrictSelect(fn) {
      onDistrictSelect = fn;
    },
    setOnPcSelect(fn) {
      onPcSelect = fn;
    },
    get mode() {
      return state.mode;
    },
    get tier() {
      return state.tier;
    },
  };
}
