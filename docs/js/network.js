const ORANGE_SHADES = ['#5c2f15', '#8a3d10', '#c24d0a', '#ff6200', '#ff8b3d', '#ffb067', '#ffd0a8'];
const INFLUENCE_COLORS = {
  '<100': '#ffb067',
  '100-300': '#ff6200',
  '300+': '#8a3d10',
};

const boot = JSON.parse(document.getElementById('boot').textContent);
const moduleVersion = `${encodeURIComponent(boot.v)}&ui=22`;
let districtFeatures = null;

const districtKey = (name) => {
  const key = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return key === 'faizabad' ? 'ayodhya' : key;
};

async function loadDistrictFeatures() {
  if (districtFeatures) return districtFeatures;
  const response = await fetch(`/data/districts.topo.json?v=${moduleVersion}`);
  if (!response.ok) throw new Error(`District boundaries: ${response.status}`);
  const topology = await response.json();
  const object = topology.objects[Object.keys(topology.objects)[0]];
  districtFeatures = window.topojson.feature(topology, object).features;
  return districtFeatures;
}

function hashString(value) {
  let h = 2166136261;
  const str = String(value ?? '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createVillageNetwork({ onVillageClick }) {
  const d3 = window.d3;
  const view = document.getElementById('network-view');
  const svg = d3.select('#network-svg');
  const districtSelect = document.getElementById('network-district');
  const blockSelect = document.getElementById('network-block');
  const status = document.getElementById('network-status');
  const title = document.getElementById('network-title');
  const subtitle = document.getElementById('network-subtitle');
  const tip = document.getElementById('network-tip');
  const influencePanel = document.getElementById('influence-panel');
  const influenceTitle = document.getElementById('influence-title');
  const influenceSubtitle = document.getElementById('influence-subtitle');
  const influenceClose = document.getElementById('influence-close');
  const influenceSvg = d3.select('#influence-svg');

  const cache = new Map();
  const boundaryCache = new Map();
  let districts = null;
  let currentData = null;
  let requestId = 0;
  let controller = null;
  let simulation = null;
  let cellSimulation = null;
  let detailSimulation = null;
  let reheatLayout = () => {};
  let reheatCount = 0;
  let selectedMemberId = null;
  let lastTrigger = null;
  let syncSelection = () => {};
  let zoomBehavior = null;

  function ensureZoom() {
    if (zoomBehavior) return zoomBehavior;
    zoomBehavior = d3
      .zoom()
      .scaleExtent([0.65, 12])
      .filter((event) => event.type !== 'dblclick')
      .on('zoom', (event) => {
        svg.select('.network-zoom').attr('transform', event.transform);
      });
    svg.call(zoomBehavior);
    svg.on('dblclick.zoom', null);

    const zoomBy = (factor) => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) svg.call(zoomBehavior.scaleBy, factor);
      else svg.transition().duration(220).call(zoomBehavior.scaleBy, factor);
    };
    document.getElementById('network-zoom-in')?.addEventListener('click', () => zoomBy(1.5));
    document.getElementById('network-zoom-out')?.addEventListener('click', () => zoomBy(1 / 1.5));
    document.getElementById('network-zoom-reset')?.addEventListener('click', () => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) svg.call(zoomBehavior.transform, d3.zoomIdentity);
      else svg.transition().duration(220).call(zoomBehavior.transform, d3.zoomIdentity);
    });
    document.getElementById('network-reheat')?.addEventListener('click', () => reheatLayout());
    return zoomBehavior;
  }

  function showTip(event, text) {
    tip.textContent = text;
    tip.style.display = 'block';
    const [x, y] = d3.pointer(event, view);
    tip.style.left = `${Math.min(x + 14, view.clientWidth - (tip.offsetWidth || 180) - 8)}px`;
    tip.style.top = `${Math.min(y + 14, view.clientHeight - (tip.offsetHeight || 40) - 8)}px`;
  }

  function clearTip() {
    tip.style.display = 'none';
  }

  function closeInfluence({ restoreFocus = false } = {}) {
    selectedMemberId = null;
    if (detailSimulation) detailSimulation.stop();
    detailSimulation = null;
    influenceSvg.selectAll('*').remove();
    influenceSvg.attr('aria-label', 'प्रभाव का ग्रे बबल चार्ट');
    influencePanel.classList.remove('open');
    svg
      .selectAll('.network-team circle')
      .classed('selected', false)
      .classed('dim', false)
      .attr('aria-expanded', 'false');
    svg.selectAll('.network-cell').classed('dim', false);
    syncSelection();
    const trigger = lastTrigger;
    lastTrigger = null;
    if (restoreFocus && trigger && document.contains(trigger)) {
      trigger.focus({ preventScroll: true });
    }
  }

  influenceClose?.addEventListener('click', () => closeInfluence({ restoreFocus: true }));

  influencePanel?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeInfluence({ restoreFocus: true });
    }
  });

  function setBlockOptions(district) {
    blockSelect.replaceChildren();
    for (const block of district.blocks) {
      const option = document.createElement('option');
      option.value = block.id;
      option.textContent = `${block.name} · ${block.villages.toLocaleString('en-IN')} गाँव · ${block.gps.toLocaleString('en-IN')} GP`;
      blockSelect.append(option);
    }
    blockSelect.disabled = district.blocks.length === 0;
    if (district.blocks.length) {
      blockSelect.value = district.blocks[0].id;
      void loadBlock(blockSelect.value);
    } else {
      status.textContent = 'इस ज़िले में ब्लॉक नेटवर्क उपलब्ध नहीं है।';
    }
  }

  async function loadIndex() {
    if (districts) return;
    status.textContent = 'ज़िले और ब्लॉक लोड हो रहे हैं…';
    const response = await fetch(`/api/village-network/index?v=${moduleVersion}`);
    if (!response.ok) throw new Error(`Village network index: ${response.status}`);
    districts = await response.json();
    districtSelect.replaceChildren();
    for (const district of districts) {
      const option = document.createElement('option');
      option.value = district.name;
      option.textContent = `${district.name} · ${district.villages.toLocaleString('en-IN')} गाँव`;
      districtSelect.append(option);
    }
    if (!districts.length) throw new Error('Village network index is empty');
    const largest = districts.reduce((best, item) => (item.villages > best.villages ? item : best));
    districtSelect.value = largest.name;
    setBlockOptions(largest);
  }

  function renderInfluenceDetail(member) {
    if (!influencePanel || !influenceSvg.node()) return;
    if (detailSimulation) detailSimulation.stop();
    influenceSvg.selectAll('*').remove();

    const width = Math.max(220, influencePanel.clientWidth - 20);
    const height = 170;
    influenceSvg.attr('viewBox', `0 0 ${width} ${height}`);

    const total = Math.max(1, Number(member.influence || 0));
    // 6 grey bubbles showing level-of-influence breakdown (deterministic)
    const levels = 6;
    let remaining = total;
    const parts = [];
    for (let i = 0; i < levels; i++) {
      const s = hashString(`${member.id}:lvl:${i}`);
      const base = i === levels - 1 ? remaining : Math.max(1, Math.round((total / levels) * (0.55 + (s % 90) / 100)));
      const value = Math.min(remaining, base);
      parts.push({ id: `${member.id}-l${i}`, value, level: i + 1 });
      remaining -= value;
    }
    if (remaining > 0) parts[parts.length - 1].value += remaining;

    const r = d3.scaleSqrt().domain([0, d3.max(parts, (p) => p.value) || 1]).range([10, 34]);
    const nodes = parts.map((p) => {
      const angle = (hashString(`${p.id}:start`) / 4294967295) * Math.PI * 2;
      const reach = 6 + (hashString(`${p.id}:reach`) / 4294967295) * 18;
      return {
        ...p,
        r: r(p.value),
        x: width / 2 + Math.cos(angle) * reach,
        y: height / 2 + Math.sin(angle) * reach,
      };
    });
    const color = d3.scaleLinear().domain([0, levels - 1]).range(['#d9d9d9', '#6b6b6b']);

    influenceTitle.textContent = `${member.villageName} · ${member.name}`;
    influenceSubtitle.textContent =
      `${member.role || 'टीम सदस्य'} · प्रभाव ${total.toLocaleString('en-IN')} (${member.bucket}) · स्तर-विवरण`;
    influenceSvg.attr(
      'aria-label',
      `प्रभाव ${total.toLocaleString('en-IN')} का स्तर-विवरण। ` +
        parts.map((part) => `स्तर ${part.level}: ${part.value.toLocaleString('en-IN')}`).join('; '),
    );
    influencePanel.classList.add('open');
    influencePanel.focus({ preventScroll: true });

    const g = influenceSvg.append('g');
    const circles = g
      .selectAll('circle')
      .data(nodes)
      .join('circle')
      .attr('r', (d) => d.r)
      .attr('fill', (d) => color(d.level - 1))
      .attr('fill-opacity', 0.95)
      .attr('stroke', '#2a2a2a')
      .attr('stroke-width', 1.2);

    const labels = g
      .selectAll('text')
      .data(nodes)
      .join('text')
      .attr('text-anchor', 'middle')
      .attr('dy', '0.35em')
      .attr('fill', '#111')
      .attr('font-size', 10)
      .attr('font-weight', 700)
      .text((d) => d.value.toLocaleString('en-IN'));

    const clampNodes = () => {
      for (const d of nodes) {
        d.x = Math.max(d.r, Math.min(width - d.r, d.x));
        d.y = Math.max(d.r, Math.min(height - d.r, d.y));
      }
    };
    const paintNodes = () => {
      circles.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
      labels.attr('x', (d) => d.x).attr('y', (d) => d.y);
    };

    detailSimulation = d3
      .forceSimulation(nodes)
      .force('charge', d3.forceManyBody().strength(-18).distanceMax(120))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide().radius((d) => d.r + 3))
      .force('x', d3.forceX(width / 2).strength(0.08))
      .force('y', d3.forceY(height / 2).strength(0.08))
      .alphaDecay(0.02)
      .on('tick', () => {
        clampNodes();
        paintNodes();
      });
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      detailSimulation.stop();
      for (let i = 0; i < 120; i++) detailSimulation.tick();
      clampNodes();
      paintNodes();
    }
  }

  function draw(data, villageBoundaries) {
    currentData = data;
    syncSelection = () => {};
    closeInfluence();
    if (simulation) simulation.stop();
    if (cellSimulation) cellSimulation.stop();
    const width = Math.max(320, view.clientWidth);
    const height = Math.max(320, view.clientHeight);
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    svg.selectAll('*').remove();
    const stage = svg.append('g').attr('class', 'network-zoom');
    const zoom = ensureZoom();
    zoom.extent([
      [0, 0],
      [width, height],
    ]);
    zoom.translateExtent([
      [-width, -height],
      [width * 2, height * 2],
    ]);

    const villages = (data.nodes || [])
      .filter((node) => Array.isArray(node.location) && node.location.length === 2 && node.location.every(Number.isFinite))
      .map((node) => ({ ...node }));
    if (!villages.length) throw new Error(`Village network ${data.district}/${data.block} has no coordinates`);

    const nodeFeatures = villages.map((node) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: node.location },
    }));
    const mapCollection = {
      type: 'FeatureCollection',
      features: [...(villageBoundaries || []), ...nodeFeatures],
    };
    const projection = d3
      .geoMercator()
      .fitExtent(
        [
          [28, Math.max(150, height * 0.16)],
          [width - 28, height - 90],
        ],
        mapCollection,
      );
    const path = d3.geoPath(projection);
    const boundaries = districtFeatures || [];
    const selectedKey = districtKey(data.district);

    stage
      .append('g')
      .attr('class', 'network-regions')
      .selectAll('path')
      .data(boundaries)
      .join('path')
      .attr('class', 'network-region')
      .attr('d', path)
      .attr('fill', (feature) => (districtKey(feature.properties.dtname) === selectedKey ? '#1a1410' : 'none'))
      .attr('stroke', (feature) => (districtKey(feature.properties.dtname) === selectedKey ? '#8a3d10' : '#3a2a20'))
      .attr('stroke-width', (feature) => (districtKey(feature.properties.dtname) === selectedKey ? 0.9 : 0.55));

    stage
      .append('g')
      .attr('class', 'network-village-boundaries')
      .selectAll('path')
      .data(villageBoundaries || [])
      .join('path')
      .attr('d', path)
      .append('title')
      .text((feature) => feature.properties.village || feature.properties.vlcode);

    // Team members are the small circles. Gram panchayats are the larger
    // map-anchored cells they sit in — the same cell/dot split as a
    // community network, read for this block's villages.
    const rScale = d3.scaleSqrt().domain([0, 750]).range([3.2, 8.2]);
    const members = [];
    const villageById = new Map();
    for (const village of villages) {
      const point = projection(village.location);
      if (!point) continue;
      const team = Array.isArray(village.team) && village.team.length ? village.team : [];
      const roster = team.length
        ? team
        : [{
            id: `${village.id}-m1`,
            name: 'सदस्य 1',
            role: 'टीम सदस्य',
            isPradhan: false,
            bucket: '<100',
            influence: 50,
          }];
      const nodes = roster.map((member) => {
        const bucket = member.bucket && INFLUENCE_COLORS[member.bucket] ? member.bucket : '<100';
        return {
          ...member,
          bucket,
          influence: Number(member.influence || 0),
          villageId: village.id,
          villageName: village.name,
          villageAc: village.ac,
          gpCode: village.gpCode,
          gpName: village.gpName || village.name,
          px: point[0],
          py: point[1],
          r: rScale(Number(member.influence || 0)),
        };
      });
      villageById.set(village.id, { ...village, px: point[0], py: point[1], members: nodes });
      members.push(...nodes);
    }

    const groups = new Map();
    for (const village of villageById.values()) {
      const id = village.gpCode ? `gp:${village.gpCode}` : `v:${village.id}`;
      if (!groups.has(id)) {
        groups.set(id, {
          id,
          label: village.gpName || village.name,
          villages: [],
          members: [],
        });
      }
      const group = groups.get(id);
      group.villages.push(village);
      group.members.push(...village.members);
    }

    const cells = [];
    for (const group of groups.values()) {
      let sx = 0;
      let sy = 0;
      let sw = 0;
      const acWeight = new Map();
      for (const village of group.villages) {
        const weight = Math.max(1, village.members.reduce((sum, member) => sum + member.influence, 0));
        sx += village.px * weight;
        sy += village.py * weight;
        sw += weight;
        acWeight.set(village.ac, (acWeight.get(village.ac) || 0) + weight);
      }
      const area = group.members.reduce((sum, member) => sum + member.r * member.r, 0);
      const ac = [...acWeight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      cells.push({
        id: group.id,
        label: group.label,
        ac,
        ax: sw ? sx / sw : width / 2,
        ay: sw ? sy / sw : height / 2,
        r: Math.sqrt(area * 1.45) + 8,
        villageCount: group.villages.length,
        memberCount: group.members.length,
        influence: group.members.reduce((sum, member) => sum + member.influence, 0),
        members: group.members,
      });
    }

    const areaBudget = width * height * 0.22;
    const areaSum = cells.reduce((sum, cell) => sum + Math.PI * cell.r * cell.r, 0);
    const fit = Math.min(1, Math.sqrt(areaBudget / Math.max(areaSum, 1)));
    for (const cell of cells) cell.r = Math.max(14, Math.min(72, cell.r * fit));

    // Force layout begins from a deterministic scatter around each geographic
    // anchor, so panchayats visibly settle into clusters instead of snapping.
    const cellLinks = buildCellLinks(cells);
    const clampCells = () => {
      for (const cell of cells) {
        cell.x = Math.max(cell.r + 8, Math.min(width - cell.r - 8, cell.x));
        cell.y = Math.max(cell.r + 8, Math.min(height - cell.r - 8, cell.y));
      }
    };
    const syncMemberAnchors = () => {
      for (const cell of cells) {
        for (const member of cell.members) {
          member.cx = cell.x;
          member.cy = cell.y;
        }
      }
    };
    for (const cell of cells) {
      const angle = (hashString(`${cell.id}:cell`) / 4294967295) * Math.PI * 2;
      const reach = 12 + (hashString(`${cell.id}:dist`) / 4294967295) * 34;
      cell.x = cell.ax + Math.cos(angle) * reach;
      cell.y = cell.ay + Math.sin(angle) * reach;
    }
    clampCells();

    for (const cell of cells) {
      for (const member of cell.members) {
        const spin = (hashString(member.id) / 4294967295) * Math.PI * 2;
        const reach = (hashString(`${member.id}:r`) / 4294967295) * Math.max(2, cell.r * 0.55);
        member.cellId = cell.id;
        member.cx = cell.x;
        member.cy = cell.y;
        member.x = cell.x + Math.cos(spin) * reach;
        member.y = cell.y + Math.sin(spin) * reach;
      }
    }

    const acIds = [...new Set(cells.map((cell) => cell.ac).filter((ac) => ac != null))].sort((a, b) => a - b);
    const acColor = (ac) => ORANGE_SHADES[(Math.max(0, acIds.indexOf(ac)) + 2) % ORANGE_SHADES.length];

    // Stable force links: neighbouring panchayats in one assembly, and team
    // members around their village and gram pradhan. Built from anchors so the
    // graph keeps the same relationships as it breathes.
    function buildCellLinks(list) {
      const links = [];
      const seen = new Set();
      const byAc = d3.group(list.filter((cell) => cell.ac != null), (cell) => cell.ac);
      for (const group of byAc.values()) {
        if (group.length < 2) continue;
        for (const cell of group) {
          const nearest = group
            .filter((other) => other.id !== cell.id)
            .map((other) => ({ other, dist: (other.ax - cell.ax) ** 2 + (other.ay - cell.ay) ** 2 }))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, 2);
          for (const { other } of nearest) {
            const key = cell.id < other.id ? `${cell.id}|${other.id}` : `${other.id}|${cell.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            links.push({ source: cell, target: other });
          }
        }
      }
      return links;
    }

    function buildMemberLinks() {
      const links = [];
      const byVillage = d3.group(members, (member) => member.villageId);
      for (const group of byVillage.values()) {
        for (let i = 1; i < group.length; i++) {
          links.push({ source: group[0], target: group[i], type: 'village' });
        }
      }
      const byCell = d3.group(members, (member) => member.cellId);
      for (const group of byCell.values()) {
        const pradhan = group.find((member) => member.isPradhan);
        if (!pradhan) continue;
        for (const member of group) {
          if (member.id !== pradhan.id) {
            links.push({ source: member, target: pradhan, type: 'panchayat' });
          }
        }
      }
      return links;
    }

    function edgePath(link) {
      const a = link.source;
      const b = link.target;
      if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(b.x)) return null;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const bend = link.type === 'village' ? 0.2 : link.type === 'panchayat' ? -0.16 : -0.12;
      return `M${a.x},${a.y}Q${mx - dy * bend},${my + dx * bend} ${b.x},${b.y}`;
    }

    function assemblyLinks() {
      const byAc = d3.group(cells.filter((cell) => cell.ac != null), (cell) => cell.ac);
      const links = [];
      const seen = new Set();
      for (const list of byAc.values()) {
        if (list.length < 2) continue;
        const neighbors = list.length > 16 ? 1 : 2;
        for (const cell of list) {
          const nearest = list
            .filter((other) => other.id !== cell.id)
            .map((other) => ({ other, dist: (other.x - cell.x) ** 2 + (other.y - cell.y) ** 2 }))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, neighbors);
          for (const { other } of nearest) {
            const [left, right] = cell.id < other.id ? [cell, other] : [other, cell];
            const key = `ac|${left.id}|${right.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            links.push({
              key,
              type: 'assembly',
              source: left,
              target: right,
              w: left.influence + right.influence,
            });
          }
        }
      }
      return links;
    }

    function egoLinks(member) {
      const links = [];
      for (const other of members) {
        if (other.id === member.id) continue;
        if (other.villageId === member.villageId) {
          links.push({ key: `v|${member.id}|${other.id}`, type: 'village', source: member, target: other, w: other.influence });
        } else if (other.cellId === member.cellId && other.isPradhan) {
          links.push({ key: `p|${member.id}|${other.id}`, type: 'panchayat', source: member, target: other, w: other.influence });
        }
      }
      return links;
    }

    const edgeLayer = stage.append('g').attr('class', 'network-edges');
    let edgeSelection = null;

    function paintEdges() {
      const selected = members.find((member) => member.id === selectedMemberId) || null;
      edgeSelection = selected;
      const data = selected ? egoLinks(selected) : assemblyLinks();
      const maxW = d3.max(data, (link) => link.w) || 1;
      const widthScale = d3.scaleSqrt().domain([0, maxW]).range([1.15, selected ? 2.6 : 3.8]);
      edgeLayer
        .selectAll('path')
        .data(data, (link) => link.key)
        .join('path')
        .attr('class', (link) => link.type)
        .attr('stroke-width', (link) => widthScale(link.w))
        .attr('d', edgePath);
    }

    const cellLayer = stage.append('g').attr('class', 'network-cells');
    const cellCircles = cellLayer
      .selectAll('circle')
      .data(cells, (cell) => cell.id)
      .join('circle')
      .attr('class', 'network-cell')
      .attr('cx', (cell) => cell.x)
      .attr('cy', (cell) => cell.y)
      .attr('r', (cell) => cell.r)
      .attr('fill', (cell) => (cell.ac == null ? '#8a5a34' : acColor(cell.ac)))
      .attr('stroke', (cell) => (cell.ac == null ? '#8a5a34' : acColor(cell.ac)))
      .append('title')
      .text(
        (cell) =>
          `${cell.label}: ${cell.villageCount.toLocaleString('en-IN')} गाँव, ` +
          `${cell.memberCount.toLocaleString('en-IN')} सदस्य, ` +
          `प्रभाव ${cell.influence.toLocaleString('en-IN')}` +
          (cell.ac == null ? '' : `, विधानसभा ${cell.ac}`),
      );
    // append('title') changes the selection to the titles. Re-select circles.
    const cellMarks = cellLayer.selectAll('circle.network-cell');
    cellMarks
      .on('pointermove', (event, cell) => {
        showTip(
          event,
          `${cell.label} · ${cell.villageCount.toLocaleString('en-IN')} गाँव · ` +
            `${cell.memberCount.toLocaleString('en-IN')} सदस्य · प्रभाव ${cell.influence.toLocaleString('en-IN')}`,
        );
      })
      .on('pointerleave', clearTip);

    function shorten(value, max) {
      const text = String(value || '');
      return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    }

    function placeLabels(list) {
      const placed = [];
      const keep = [];
      for (const cell of [...list].sort((a, b) => b.r - a.r || b.influence - a.influence)) {
        if (cell.r < 20) continue;
        const text = shorten(cell.label, 22);
        const boxWidth = text.length * 6.4;
        const box = {
          x0: cell.x - boxWidth / 2,
          x1: cell.x + boxWidth / 2,
          y0: cell.y - cell.r - 16,
          y1: cell.y - cell.r - 2,
        };
        const hit = placed.some((item) => box.x0 < item.x1 && box.x1 > item.x0 && box.y0 < item.y1 && box.y1 > item.y0);
        if (hit) continue;
        placed.push(box);
        // Keep the live cell object so the label follows it during the force
        // animation instead of freezing at its starting position.
        cell.text = text;
        keep.push(cell);
        if (keep.length >= 12) break;
      }
      return keep;
    }

    const cellLabels = stage
      .append('g')
      .attr('class', 'network-cell-labels')
      .selectAll('text')
      .data(placeLabels(cells))
      .join('text')
      .attr('class', 'network-cell-label')
      .attr('x', (cell) => cell.x)
      .attr('y', (cell) => cell.y - cell.r - 6)
      .text((cell) => cell.text);

    const memberTip = (member) => {
      const inf = Number(member.influence || 0).toLocaleString('en-IN');
      return `${member.gpName} · ${member.villageName} · ${member.name} · प्रभाव ${inf} (${member.bucket})`;
    };

    const teamLayer = stage.append('g').attr('class', 'network-team');
    const circles = teamLayer
      .selectAll('circle')
      .data(members, (member) => member.id)
      .join('circle')
      .attr('class', (member) => (member.isPradhan ? 'dot pradhan' : 'dot'))
      .attr('cx', (member) => member.x)
      .attr('cy', (member) => member.y)
      .attr('r', (member) => member.r)
      .attr('fill', (member) => INFLUENCE_COLORS[member.bucket] || ORANGE_SHADES[3])
      .attr('fill-opacity', 0.95)
      .attr('role', 'button')
      .attr('tabindex', 0)
      .attr('aria-haspopup', 'dialog')
      .attr('aria-expanded', 'false')
      .attr(
        'aria-label',
        (member) =>
          `${member.gpName}, ${member.villageName}, ${member.name}, ${member.role || 'टीम सदस्य'}, ` +
          `प्रभाव ${Number(member.influence || 0).toLocaleString('en-IN')} (${member.bucket})`,
      );

    function applySelection() {
      const selected = members.find((member) => member.id === selectedMemberId) || null;
      const partners = new Set();
      if (selected) {
        partners.add(selected.id);
        for (const other of members) {
          if (other.villageId === selected.villageId || (other.cellId === selected.cellId && other.isPradhan)) {
            partners.add(other.id);
          }
        }
      }
      circles
        .classed('selected', (member) => Boolean(selected && member.id === selected.id))
        .classed('dim', (member) => Boolean(selected && !partners.has(member.id)))
        .attr('aria-expanded', (member) => String(Boolean(selected && member.id === selected.id)));
      cellMarks.classed('dim', (cell) => Boolean(selected && cell.id !== selected.cellId));
      paintEdges();
    }

    const selectMember = (member) => {
      selectedMemberId = member.id;
      lastTrigger = circles.filter((item) => item.id === member.id).node() ?? null;
      applySelection();
      renderInfluenceDetail(member);
    };

    circles
      .on('pointermove', (event, member) => showTip(event, memberTip(member)))
      .on('pointerleave', clearTip)
      .on('focus', (event, member) => showTip(event, memberTip(member)))
      .on('blur', clearTip)
      .on('click', (event, member) => {
        event.stopPropagation();
        selectMember(member);
      })
      .on('keydown', (event, member) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectMember(member);
          return;
        }
        if (event.key === 'Escape' && selectedMemberId) {
          closeInfluence({ restoreFocus: true });
        }
      });

    svg.on('click', (event) => {
      if (event.target === svg.node()) closeInfluence();
    });

    const clampMembers = () => {
      for (const member of members) {
        member.x = Math.max(member.r, Math.min(width - member.r, member.x));
        member.y = Math.max(member.r, Math.min(height - member.r, member.y));
      }
    };
    const paintCells = () => {
      cellMarks.attr('cx', (cell) => cell.x).attr('cy', (cell) => cell.y);
      cellLabels.attr('x', (cell) => cell.x).attr('y', (cell) => cell.y - cell.r - 6);
      if (!edgeSelection) paintEdges();
    };
    const paintMembers = () => {
      circles.attr('cx', (member) => member.x).attr('cy', (member) => member.y);
      if (edgeSelection) edgeLayer.selectAll('path').attr('d', edgePath);
    };

    // Panchayats repel each other but stay loosely tied to their geographic
    // anchor; neighbours in one assembly are gently pulled into a cluster.
    cellSimulation = d3
      .forceSimulation(cells)
      .force('link', d3.forceLink(cellLinks).id((cell) => cell.id)
        .distance((link) => Math.max(link.source.r + link.target.r + 18, 46))
        .strength(0.06))
      .force('charge', d3.forceManyBody().strength((cell) => -Math.max(24, cell.r * 2.4)).distanceMax(260))
      .force('x', d3.forceX((cell) => cell.ax).strength(0.2))
      .force('y', d3.forceY((cell) => cell.ay).strength(0.2))
      .force('collide', d3.forceCollide((cell) => cell.r + 6).iterations(3))
      .alphaDecay(0.018)
      .on('tick', () => {
        clampCells();
        syncMemberAnchors();
        paintCells();
      });

    // Team members repel, collide and follow their village / pradhan links,
    // while the moving panchayat centre remains their home anchor.
    const memberLinks = buildMemberLinks();
    simulation = d3
      .forceSimulation(members)
      .force('link', d3.forceLink(memberLinks).id((member) => member.id)
        .distance((link) => (link.type === 'panchayat' ? 16 : 12))
        .strength((link) => (link.type === 'panchayat' ? 0.1 : 0.16)))
      .force('charge', d3.forceManyBody().strength((member) => -Math.max(6, member.r * 2.2)).distanceMax(58))
      .force('x', d3.forceX((member) => member.cx).strength(0.06))
      .force('y', d3.forceY((member) => member.cy).strength(0.06))
      .force('collide', d3.forceCollide((member) => member.r + 1.15).iterations(2))
      .alphaDecay(0.015)
      .on('tick', () => {
        clampMembers();
        paintMembers();
      });

    const settle = () => {
      for (const sim of [cellSimulation, simulation]) {
        if (!sim) continue;
        sim.stop();
        for (let i = 0; i < 180; i++) sim.tick();
        sim.alpha(0);
      }
      clampCells();
      syncMemberAnchors();
      paintCells();
      clampMembers();
      paintMembers();
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) settle();

    reheatLayout = () => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      reheatCount += 1;
      // A deterministic nudge makes the reheat visible even after settling.
      for (const cell of cells) {
        const angle = (hashString(`${cell.id}:rh:${reheatCount}`) / 4294967295) * Math.PI * 2;
        const reach = 8 + (hashString(`${cell.id}:rj:${reheatCount}`) / 4294967295) * 22;
        cell.x += Math.cos(angle) * reach;
        cell.y += Math.sin(angle) * reach;
      }
      syncMemberAnchors();
      for (const member of members) {
        const angle = (hashString(`${member.id}:rh:${reheatCount}`) / 4294967295) * Math.PI * 2;
        const reach = 4 + (hashString(`${member.id}:rj:${reheatCount}`) / 4294967295) * 12;
        member.x += Math.cos(angle) * reach;
        member.y += Math.sin(angle) * reach;
      }
      clampCells();
      clampMembers();
      paintCells();
      paintMembers();
      if (reduce) {
        settle();
        return;
      }
      if (cellSimulation) cellSimulation.alpha(0.7).restart();
      if (simulation) simulation.alpha(0.9).restart();
    };

    syncSelection = applySelection;
    applySelection();
    svg.call(zoom.transform, d3.zoomIdentity);

    const bucketCounts = members.reduce((acc, member) => {
      acc[member.bucket] = (acc[member.bucket] || 0) + 1;
      return acc;
    }, {});
    title.textContent = `${data.district} · ${data.block}`;
    subtitle.textContent =
      `${villages.length.toLocaleString('en-IN')} गाँव · ${cells.length.toLocaleString('en-IN')} ग्राम पंचायत · ` +
      `${members.length.toLocaleString('en-IN')} टीम सदस्य`;
    status.textContent =
      `बड़ा वृत्त ग्राम पंचायत; छोटा वृत्त टीम सदस्य, आकार = प्रभाव। ` +
      `वृत्त धक्का-खींच कर अपने समूह में बैठते हैं — ✧ दबाकर दोबारा हिलाएँ। ` +
      `300+: ${(bucketCounts['300+'] || 0).toLocaleString('en-IN')}, ` +
      `100–300: ${(bucketCounts['100-300'] || 0).toLocaleString('en-IN')}, ` +
      `<100: ${(bucketCounts['<100'] || 0).toLocaleString('en-IN')}. ` +
      `सदस्य चुनें: गाँव की टीम और ग्राम प्रधान जुड़ेंगे, प्रभाव-स्तर ग्रे चार्ट में खुलेगा।`;
  }

  async function loadNetwork(id, signal) {
    if (cache.has(id)) return cache.get(id);
    const response = await fetch(`/api/village-network/${encodeURIComponent(id)}?v=${moduleVersion}`, { signal });
    if (!response.ok) throw new Error(`Village network block ${id}: ${response.status}`);
    const data = await response.json();
    cache.set(id, data);
    return data;
  }

  async function loadVillageBoundaries(id, signal) {
    if (boundaryCache.has(id)) return boundaryCache.get(id);
    const response = await fetch(`/data/village-networks/${encodeURIComponent(id)}.topo.json?v=${moduleVersion}`, { signal });
    if (!response.ok) throw new Error(`SOI village boundaries ${id}: ${response.status}`);
    const topology = await response.json();
    const object = topology.objects?.v;
    if (!object) throw new Error(`SOI village boundaries ${id} contain no village object`);
    const features = window.topojson.feature(topology, object).features;
    boundaryCache.set(id, features);
    return features;
  }

  async function loadBlock(id) {
    const selected = String(id);
    const thisRequest = ++requestId;
    controller?.abort();
    controller = new AbortController();
    closeInfluence();
    status.textContent = 'गाँव नेटवर्क लोड हो रहा है…';
    try {
      const [data, boundaries] = await Promise.all([
        loadNetwork(selected, controller.signal),
        loadVillageBoundaries(selected, controller.signal),
        loadDistrictFeatures(),
      ]);
      if (thisRequest === requestId) draw(data, boundaries);
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error(error);
        if (thisRequest === requestId) status.textContent = 'नेटवर्क लोड नहीं हो सका। सर्वर लॉग देखें।';
      }
    }
  }

  districtSelect.addEventListener('change', () => {
    const district = districts.find((item) => item.name === districtSelect.value);
    if (district) setBlockOptions(district);
  });
  blockSelect.addEventListener('change', () => {
    if (blockSelect.value) void loadBlock(blockSelect.value);
  });
  window.addEventListener('resize', () => {
    if (currentData && view.style.display !== 'none') {
      draw(currentData, boundaryCache.get(blockSelect.value) ?? []);
    }
  });

  return {
    async show() {
      try {
        const alreadyLoaded = Boolean(districts);
        await loadIndex();
        if (alreadyLoaded && currentData) {
          draw(currentData, boundaryCache.get(blockSelect.value) ?? []);
        }
        // Returning to the view brings a settled layout gently back to life.
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!reduce) {
          if (cellSimulation) cellSimulation.alpha(0.35).restart();
          if (simulation) simulation.alpha(0.35).restart();
        }
      } catch (error) {
        console.error(error);
        status.textContent = 'नेटवर्क इंडेक्स लोड नहीं हो सका। सर्वर लॉग देखें।';
      }
    },
    hide() {
      clearTip();
      closeInfluence();
      cellSimulation?.stop();
      simulation?.stop();
    },
  };
}
