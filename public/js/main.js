// Client entry: wires the D3 map to the scrollytelling cards, the
// drill-down panel, village search and the density scatter.
const boot = JSON.parse(document.getElementById('boot').textContent);
const [{ createMap }, { createVillageNetwork }] = await Promise.all([
  import(`./map.js?v=${encodeURIComponent(boot.v)}&ui=29`),
  import(`./network.js?v=${encodeURIComponent(boot.v)}&ui=24`),
]);
const nf = new Intl.NumberFormat('en-IN');
const n = (value) => nf.format(Math.round(Number(value) || 0));
const d = (value, digits = 1) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—');
const pctText = (value) => `${(Number(value) * 100).toFixed(1)}%`;
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Keep the grouped layer chips honest: the open chevron shows which child
// layer is active, and choosing one closes the menu again.
const layerGroups = [...document.querySelectorAll('.layer-group')];

function syncLayerGroups(mode) {
  layerGroups.forEach((group) => {
    const activeButton = group.querySelector(`button[data-layer="${mode}"]`);
    const current = group.querySelector('.layer-group-current');
    group.classList.toggle('has-active', Boolean(activeButton));
    if (current) current.textContent = activeButton ? activeButton.textContent.trim() : '';
    if (activeButton) group.open = false;
  });
}

const mapInstance = createMap({ boot });
const baseSetMode = mapInstance.setMode.bind(mapInstance);
mapInstance.setMode = (mode, ...args) => {
  syncLayerGroups(mode);
  return baseSetMode(mode, ...args);
};
const map = mapInstance;
syncLayerGroups(map.mode || 'campaign');

layerGroups.forEach((group) => {
  group.addEventListener('toggle', () => {
    if (!group.open) return;
    layerGroups.forEach((other) => {
      if (other !== group) other.open = false;
    });
  });
});

// --------------------------------------------------------- three-tier binding
// The map's #panchayat-readout is the only district readout; the card just
// owns the tier buttons, so there is no duplicated information on screen.
const tierById = new Map(boot.tiers.map((tier) => [tier.id, tier]));

function setActiveTier(id) {
  if (!tierById.has(id)) return;
  document.querySelectorAll('[data-tier-viz] .tier-row').forEach((row) => {
    row.setAttribute('aria-pressed', String(row.dataset.tier === id));
  });
}

// ---------------------------------------- district assembly comparison chart
// The previous card picks a district (or the map does); this list then shows
// every assembly constituency of that district, not a hard-coded Amethi set.
const DEFAULT_DISTRICT = 'Amethi';
const acsByDistrict = new Map();
for (const ac of boot.acs) {
  const key = String(ac[2] || '').toLowerCase();
  if (!acsByDistrict.has(key)) acsByDistrict.set(key, []);
  acsByDistrict.get(key).push(ac);
}
const districtSelect = document.querySelector('[data-district-select]');
const assemblyChart = document.querySelector('[data-assembly-chart]');
const assemblyLabel = document.querySelector('[data-assembly-label]');
const assemblyName = document.querySelector('[data-assembly-name]');
const assemblyCount = document.querySelector('[data-assembly-count]');

function renderAssemblyDistrict(name, { syncSelect = true } = {}) {
  const district = name || DEFAULT_DISTRICT;
  const rows = [...(acsByDistrict.get(district.toLowerCase()) || [])].sort(
    (a, b) => a[0] - b[0],
  );
  if (!rows.length || !assemblyChart) return;
  const maxVillages = Math.max(...rows.map((ac) => ac[4])) || 1;

  assemblyChart.innerHTML = rows
    .map((ac) => {
      const width = ((ac[4] / maxVillages) * 100).toFixed(1);
      return `
      <button
        class="amethi-ac-row"
        type="button"
        data-amethi-ac="${ac[0]}"
        aria-label="${esc(ac[1])}, विधानसभा ${ac[0]}, ${n(ac[4])} गाँव, ${n(ac[3])} बूथ, ${n(ac[5])} ग्राम पंचायत, ${n(ac[10])} ब्लॉक। मानचित्र और गाँव विवरण खोलें।"
      >
        <span class="amethi-ac-top"><b>${esc(ac[1])}</b><small>विधानसभा ${ac[0]}</small></span>
        <span class="amethi-ac-track" aria-hidden="true"><i style="width: ${width}%"></i></span>
        <span class="amethi-ac-meta">
          <b>${n(ac[4])} गाँव</b> · ${n(ac[3])} बूथ · ${n(ac[5])} ग्राम पंचायत · ${n(ac[10])} ब्लॉक
        </span>
        <span class="amethi-ac-action">मानचित्र और गाँव विवरण खोलें →</span>
      </button>`;
    })
    .join('');
  assemblyChart.setAttribute('aria-label', `${district} विधानसभा क्षेत्रों की तुलना`);
  if (assemblyLabel) assemblyLabel.textContent = district.toUpperCase();
  if (assemblyName) assemblyName.textContent = district;
  if (assemblyCount) assemblyCount.textContent = n(rows.length);
  if (syncSelect && districtSelect) districtSelect.value = district;
}

districtSelect?.addEventListener('change', async () => {
  await map.ready;
  map.selectDistrict(districtSelect.value, { toggle: false });
});

document.addEventListener('click', async (event) => {
  const row = event.target.closest('[data-tier-viz] .tier-row');
  if (!row) return;
  await map.ready;
  setActiveTier(row.dataset.tier);
  map.setTier(row.dataset.tier);
});

map.setOnDistrictSelect((district) => {
  renderAssemblyDistrict(district?.[0] ?? DEFAULT_DISTRICT);
});

const steps = [...document.querySelectorAll('.step')];
const panel = document.getElementById('panel');
const select = document.getElementById('sel');
const searchInput = document.getElementById('q');
const results = document.getElementById('results');
const searchStatus = document.getElementById('search-status');
const drillStatus = document.getElementById('drill-status');
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = motionQuery.matches;
motionQuery.addEventListener?.('change', (event) => {
  reducedMotion = event.matches;
});
let villageNetwork = null;

// -------------------------------------------------------- Lok Sabha filter
// The option list is built from Data/UTTAR PRADESH_parliament.geojson by the
// view model; boot.acs[11] carries each AC's PC_NO for the narrow list.
const pcFilterSelects = [...document.querySelectorAll('[data-pc-filter]')];
const pcFilterStatus = document.getElementById('pc-filter-status');
const pcRows = new Map();
for (const row of boot.pcOptions || boot.pc || []) {
  const no = Number(row[0]);
  if (!Number.isFinite(no) || pcRows.has(no)) continue;
  pcRows.set(no, {
    no,
    name: row[1],
    acCount: Number(row[2]) || 0,
    booths: Number(row[3]) || 0,
  });
}
const acsByPc = new Map();
for (const ac of boot.acs) {
  const pcNo = Number(ac[11]);
  if (!pcNo) continue;
  if (!acsByPc.has(pcNo)) acsByPc.set(pcNo, []);
  acsByPc.get(pcNo).push(ac);
}
const allAcOptions = [...boot.acs].sort((a, b) =>
  String(a[1] || '').localeCompare(String(b[1] || ''), 'en'),
);
let currentAc = null;

const acOptionHtml = (ac) =>
  `<option value="${ac[0]}">${esc(ac[1])} · ${esc(ac[2])} · ${n(ac[3])} बूथ</option>`;

function renderFilteredAcOptions(pcNo, keepAc) {
  const rows = pcNo
    ? [...(acsByPc.get(pcNo) || [])].sort((a, b) =>
        String(a[1] || '').localeCompare(String(b[1] || ''), 'en'),
      )
    : allAcOptions;
  const keep = keepAc == null || keepAc === '' ? null : Number(keepAc);
  const kept = keep != null && rows.some((ac) => ac[0] === keep);
  select.innerHTML =
    '<option value="">— विधानसभा चुनें —</option>' + rows.map(acOptionHtml).join('');
  if (kept) select.value = String(keep);
  return kept;
}

function applyPcFilter(value, { fromMap = false, fly = true, setMode = false } = {}) {
  const numeric = value === '' || value == null ? NaN : Number(value);
  const pcNo = Number.isFinite(numeric) && pcRows.has(numeric) ? numeric : null;
  const row = pcNo ? pcRows.get(pcNo) : null;
  pcFilterSelects.forEach((el) => {
    el.value = pcNo ? String(pcNo) : '';
  });
  if (pcFilterStatus) {
    pcFilterStatus.textContent = row
      ? `PC ${row.no} · ${row.name}: ${n(row.acCount)} विधानसभाएँ, ${n(row.booths)} बूथ। सूची इसी लोकसभा तक सीमित है।`
      : `सभी लोकसभा · ${n(pcRows.size)} सीटें दिखाई जा रही हैं।`;
  }

  const keepAc = select.value;
  const kept = renderFilteredAcOptions(pcNo, keepAc);
  if (keepAc && !kept) {
    currentAc = null;
    panel.setAttribute('aria-busy', 'false');
    panel.innerHTML = '<p class="loading">लोकसभा फ़िल्टर बदल गया। विधानसभा चुनें।</p>';
    drillStatus.textContent = 'लोकसभा फ़िल्टर बदल गया। विधानसभा चुनें।';
  }

  if (!fromMap) {
    map.ready.then(async () => {
      if (setMode && map.mode !== 'pc') await map.setMode('pc');
      map.selectPc(pcNo, { fly, toggle: false });
    });
  }
}

pcFilterSelects.forEach((el) => {
  el.addEventListener('change', () => applyPcFilter(el.value, { setMode: true, fly: true }));
});
map.setOnPcSelect((pcNo) => applyPcFilter(pcNo, { fromMap: true }));

// ----------------------------------------- Amethi assembly comparison chart
const amethiChart = document.querySelector('[data-amethi-constituencies]');
amethiChart?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-amethi-ac]');
  if (!button || !amethiChart.contains(button)) return;

  showAc(button.dataset.amethiAc, { focusPanel: true });
});

// ---------------------------------------------------------------- scroll → mode
let currentStep = null;
let scrollQueued = false;

function pickStep() {
  const mid = window.innerHeight / 2;
  let found = null;
  for (const step of steps) {
    const rect = step.getBoundingClientRect();
    if (rect.top <= mid && rect.bottom > mid) found = step;
  }
  return found;
}

function applyScrollState(force = false) {
  scrollQueued = false;
  const step = pickStep();
  if (!step || (!force && step === currentStep)) return;
  currentStep = step;
  for (const candidate of steps) candidate.classList.toggle('on', candidate === step);
  const mode = step.dataset.m || 'dt';
  if (force || map.mode !== mode) map.setMode(mode);
  if (mode === 'network') villageNetwork?.show();
  else villageNetwork?.hide();
  // The team section takes the full width and replaces the sticky map.
  document.body.classList.toggle('map-hidden', step.hasAttribute('data-map-hidden'));
  const layerButton = document.querySelector(`.layers button[data-layer="${mode}"]`);
  if (layerButton) layerButton.setAttribute('aria-pressed', 'true');
}

function onScroll() {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => applyScrollState());
}

// ------------------------------------------------------------------- drilldown
const detailCache = new Map();
let villageRows = new Map();

async function getDetail(no) {
  if (!detailCache.has(no)) {
    const response = await fetch(`/api/ac/${no}`);
    if (!response.ok) throw new Error(`AC ${no}: ${response.status}`);
    detailCache.set(no, await response.json());
  }
  return detailCache.get(no);
}

function componentRow(component, weight, label) {
  const pct = component?.pct;
  return `
    <div class="comp">
      <div class="head">
        <span>${esc(label)} <small class="sm">${weight}% भार</small></span>
        <b>${component?.value == null ? '—' : d(component.value, 2)}${pct == null ? '' : ` · ${d(pct, 0)}`}</b>
      </div>
      <div class="bar"><i style="width:${pct == null ? 0 : Math.max(0, Math.min(100, pct))}%"></i></div>
    </div>`;
}

function orgBoothCount(zila) {
  return zila.mandals.reduce(
    (sum, mandal) => sum + mandal.kendras.reduce((inner, kendra) => inner + kendra.booths.length, 0),
    0,
  );
}

function renderOrg(org) {
  if (!org?.zilas?.length) return '';
  const tree = org.zilas.map((zila) => {
    const mandals = zila.mandals.map((mandal) => {
      const mandalBooths = mandal.kendras.reduce((sum, kendra) => sum + kendra.booths.length, 0);
      const kendras = mandal.kendras.map((kendra) => {
        const booths = kendra.booths.map((booth) =>
          `<div><span>${n(booth.no)} · ${esc(booth.name)}</span></div>`,
        ).join('');
        const kendraName = kendra.name === 'Unassigned' ? 'अनिर्दिष्ट' : kendra.name;
        return `
          <details class="org-kendra">
            <summary>शक्ति केंद्र · ${esc(kendraName)} <b>${n(kendra.booths.length)}</b></summary>
            <div class="vlist" tabindex="0" role="group" aria-label="${esc(kendraName)} के बूथ">${booths}</div>
          </details>`;
      }).join('');
      return `
        <details class="org-mandal">
          <summary>मंडल · ${esc(mandal.name)} <b>${n(mandalBooths)}</b></summary>
          ${kendras}
        </details>`;
    }).join('');
    return `
      <details class="org-zila" open>
        <summary>संगठन ज़िला · ${esc(zila.name)} <b>${n(orgBoothCount(zila))}</b></summary>
        ${mandals}
      </details>`;
  }).join('');
  return `
    <div class="org-tree">
      <h3>बूथ संगठन <small class="sm">ज़िला → मंडल → शक्ति केंद्र</small></h3>
      ${tree}
    </div>`;
}

function renderPanel(detail, gradeInfo = null) {
  const ac = detail.ac;
  const totals = detail.totals;
  const weights = detail.weights || [];
  const coverage = ac.booths ? ac.matchedBooths / ac.booths : 0;
  const org = detail.boothOrg;
  const orgMandals = ac.org?.mandals ?? org?.zilas?.reduce((sum, zila) => sum + zila.mandals.length, 0) ?? 0;
  const orgKendras = ac.org?.shaktiKendras ?? 0;
  const orgZilas = (ac.org?.zilas?.length ? ac.org.zilas : org?.zilas || []).map((zila) => zila.name).join(', ') || '—';

  const grades = gradeInfo?.grades || { A: 0, B: 0, C: 0, D: 0, total: 0 };
  const gTotal = Math.max(0, Number(grades.total || 0));
  const seg = (key) => (gTotal ? (grades[key] / gTotal) * 100 : 0);
  const gradeHtml = gTotal
    ? `
    <div class="grade-summary">
      <h3>बूथ ग्रेडिंग</h3>
      <div class="grade-bar" role="img" aria-label="बूथ ग्रेड वितरण A से D">
        <i class="gA" style="width:${seg('A')}%" title="A: ${n(grades.A)}"></i>
        <i class="gB" style="width:${seg('B')}%" title="B: ${n(grades.B)}"></i>
        <i class="gC" style="width:${seg('C')}%" title="C: ${n(grades.C)}"></i>
        <i class="gD" style="width:${seg('D')}%" title="D: ${n(grades.D)}"></i>
      </div>
      <div class="grade-legend">
        <span><s class="gA"></s> A (तीव्र): ${n(grades.A)}</span>
        <span><s class="gB"></s> B: ${n(grades.B)}</span>
        <span><s class="gC"></s> C: ${n(grades.C)}</span>
        <span><s class="gD"></s> D (हल्का): ${n(grades.D)}</span>
        <span>कुल: ${n(gTotal)}</span>
      </div>
    </div>`
    : '';

  const villageList = detail.villages.slice(0, 40).map((village) => `
    <div data-v="${esc(village.id)}">
      <span>${esc(village.name || 'अनाम गाँव')}
        <small class="gp">${esc(village.gpName || (village.gp ? `GP ${village.gp}` : 'GP कोड नहीं'))}${village.block ? ` · ${esc(village.block)}` : ''}</small>
      </span>
      <b>${n(village.booths)}</b>
    </div>`).join('');

  const unlinked = detail.unlinked.slice(0, 12).map((label) => `
    <div><span>${esc(label.l)}<small class="gp">नाम नहीं मिला</small></span><b>${n(label.b)}</b></div>`).join('');

  panel.innerHTML = `
    <div class="hd">
      <h3 id="panel-title" tabindex="-1">${esc(ac.name)}</h3>
      <span>${d(ac.index, 1)} सूचकांक · रैंक ${ac.rank}</span>
    </div>
    <div class="drillstat">
      <div>ज़िला <b>${esc(ac.district)}</b></div>
      <div>संगठन ज़िला <b>${esc(orgZilas)}</b></div>
      <div>मंडल <b>${org ? n(orgMandals) : '—'}</b></div>
      <div>शक्ति केंद्र <b>${org ? n(orgKendras) : '—'}</b></div>
      <div>बूथ <b>${n(ac.booths)}</b></div>
      <div>गाँव <b>${n(ac.villages)}</b></div>
      <div>ग्राम पंचायत <b>${n(ac.gps)}</b></div>
      <div>क्षेत्रफल <b>${n(ac.areaKm2)} वर्ग किमी</b></div>
      <div>बूथ/वर्ग किमी <b>${ac.boothsPerKm2 == null ? '—' : d(ac.boothsPerKm2, 2)}</b></div>
      <div>नाम-लिंक कवरेज <b>${pctText(coverage)}</b></div>
      <div>जुड़े बूथ <b>${n(ac.matchedBooths)}</b></div>
    </div>

    ${ac.villages === 0 ? '<div class="alert">इस निर्वाचन क्षेत्र में गाँव बहुभुज नहीं हैं — पूरी तरह शहरी सीट।</div>' : ''}
    ${gradeHtml}
    ${renderOrg(org)}

    <h3>सूचकांक की बनावट</h3>
    ${weights.map((w) => componentRow(ac.components?.[w.key], w.weight, w.label)).join('')}

    <h3>गाँव <small class="sm">${n(totals.linkedVillages)} जुड़े · ${n(totals.unlinked)} लेबल बिना जुड़े</small></h3>
    <div class="vlist" tabindex="0" role="group" aria-label="${esc(ac.name)} के जुड़े गाँव">${villageList || '<div class="loading">कोई जुड़ा गाँव नहीं मिला।</div>'}</div>

    ${unlinked ? `<h3>बिना जुड़े बूथ-लेबल</h3><div class="vlist" tabindex="0" role="group" aria-label="बिना जुड़े बूथ-लेबल">${unlinked}</div>` : ''}
  `;

  villageRows = new Map(
    [...panel.querySelectorAll('[data-v]')].map((row) => [String(row.dataset.v), row]),
  );
}

async function getBoothGrades(acNo) {
  try {
    const res = await fetch(`/api/booth-grades/${acNo}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function showAc(no, { fly = true, focusPanel = false, scrollToVillages = true } = {}) {
  const acNo = Number(no);
  if (!Number.isFinite(acNo)) return;
  // Make sure the AC is present in the narrowed dropdown before selecting it.
  const chosenAc = boot.acs.find((ac) => ac[0] === acNo);
  if (chosenAc?.[11]) applyPcFilter(String(chosenAc[11]), { fromMap: true, fly: false });
  currentAc = acNo;
  select.value = String(acNo);
  // Keep the comparison card on the district of whichever AC is opened.
  if (chosenAc) renderAssemblyDistrict(chosenAc[2]);
  panel.setAttribute('aria-busy', 'true');
  drillStatus.textContent = 'विधानसभा लोड हो रही है…';
  panel.innerHTML = '<p class="loading">विधानसभा लोड हो रही है…</p>';

  await map.ready;
  if (map.mode !== 'drill') await map.setMode('drill');
  if (fly) await map.focusAc(acNo);
  // Selecting an AC should visibly lead the reader to the village map card.
  if (scrollToVillages) {
    document.getElementById('drill')?.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  }

  try {
    const [detail, gradeInfo] = await Promise.all([getDetail(acNo), getBoothGrades(acNo)]);
    if (currentAc === acNo) {
      renderPanel(detail, gradeInfo);
      panel.setAttribute('aria-busy', 'false');
      drillStatus.textContent =
        `${detail.ac.name}, ${detail.ac.district}: ${n(detail.ac.booths)} बूथ, ` +
        `${n(detail.ac.villages)} गाँव लोड हुए · गाँव नक्शा तैयार।`;
      if (focusPanel) panel.querySelector('#panel-title')?.focus({ preventScroll: true });
    }
  } catch (error) {
    console.error(error);
    if (currentAc === acNo) {
      panel.setAttribute('aria-busy', 'false');
      panel.innerHTML = '<p class="loading">डेटा लोड नहीं हो सका। सर्वर लॉग देखें।</p>';
      drillStatus.textContent = 'डेटा लोड नहीं हो सका। सर्वर लॉग देखें।';
      if (focusPanel) panel.focus({ preventScroll: true });
    }
  }
}

function highlightVillage(id) {
  const key = String(id);
  const row = villageRows.get(key);
  if (row) {
    row.classList.add('hot');
    row.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
    for (const other of villageRows.values()) if (other !== row) other.classList.remove('hot');
  }
  map.highlightVillage(key);
}

villageNetwork = createVillageNetwork({
  onVillageClick: async (acNo, id) => {
    await showAc(acNo, { focusPanel: true });
    highlightVillage(id);
    document.getElementById('drill').scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
  },
});

document.querySelector('.layers').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-layer]');
  if (button?.dataset.layer === 'network') villageNetwork.show();
  else villageNetwork.hide();
});

map.setOnAcClick((no) => showAc(no));
map.setOnVillageClick((id) => highlightVillage(id));

select.addEventListener('change', () => {
  if (select.value) showAc(select.value);
});

// ---------------------------------------------------------------------- search
let searchTimer;
let searchController;

async function runSearch(query) {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    results.classList.remove('open');
    results.innerHTML = '';
    searchStatus.textContent = '';
    return;
  }
  searchController?.abort();
  searchController = new AbortController();
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
      signal: searchController.signal,
    });
    if (!response.ok) {
      searchStatus.textContent = 'खोज पूरी नहीं हो सकी।';
      return;
    }
    const payload = await response.json();
    if (!payload.results.length) {
      results.innerHTML = '<button type="button" disabled>कोई परिणाम नहीं</button>';
      results.setAttribute('aria-label', 'खोज परिणाम: कोई परिणाम नहीं');
      results.classList.add('open');
      searchStatus.textContent = 'कोई परिणाम नहीं मिला।';
      return;
    }
    results.innerHTML = payload.results
      .map(
        (item, index) => `
        <button type="button" data-index="${index}">
          <b>${esc(item.label)}</b><br>
          <small>${esc(item.acName)} · ${esc(item.district)} · ${n(item.booths)} बूथ${
            item.villageName ? ` · ${esc(item.villageName)}` : ' · नाम नहीं मिला'
          }</small>
        </button>`,
      )
      .join('');
    results.dataset.items = JSON.stringify(
      payload.results.map((item) => ({ ac: item.ac, villageId: item.villageId })),
    );
    results.setAttribute('aria-label', `खोज परिणाम: ${payload.results.length}`);
    results.classList.add('open');
    searchStatus.textContent = `${payload.results.length} परिणाम मिले। चुनने के लिए Tab और Enter दबाएँ।`;
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error(error);
      searchStatus.textContent = 'खोज विफल रही।';
    }
  }
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(searchInput.value), 180);
});

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    results.classList.remove('open');
    searchStatus.textContent = '';
    searchInput.blur();
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const first = results.querySelector('button[data-index]');
    if (first) first.click();
  }
});

results.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-index]');
  if (!button) return;
  const items = JSON.parse(results.dataset.items || '[]');
  const item = items[Number(button.dataset.index)];
  results.classList.remove('open');
  if (!item) return;
  searchInput.value = button.querySelector('b')?.textContent ?? '';
  searchStatus.textContent = `चयनित: ${button.querySelector('b')?.textContent ?? ''}`;
  await showAc(item.ac, { focusPanel: true });
  if (item.villageId) highlightVillage(item.villageId);
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.search')) results.classList.remove('open');
});

// ------------------------------------------------------------- density scatter
function renderScatter() {
  const host = document.getElementById('scatter');
  if (!host || !window.d3) return;
  const rows = boot.acs
    .map((ac) => ({
      no: ac[0],
      name: ac[1],
      district: ac[2],
      booths: ac[3],
      density: ac[7],
      index: ac[8],
    }))
    .filter((row) => row.density > 0 && Number.isFinite(row.index));
  if (rows.length < 2) return;

  const d3 = window.d3;
  const width = Math.max(280, host.clientWidth || 400);
  const height = 190;
  const margin = { top: 10, right: 8, bottom: 24, left: 30 };

  host.innerHTML = '';
  const svg = d3
    .select(host)
    .append('svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('role', 'img')
    .attr('aria-describedby', 'scatter-desc')
    .attr('aria-label', 'बूथ घनत्व और सैचुरेशन इंडेक्स का वितरण');

  const x = d3
    .scaleSqrt()
    .domain([0, d3.max(rows, (row) => row.density)])
    .nice()
    .range([margin.left, width - margin.right]);
  const y = d3.scaleLinear().domain([0, 100]).range([height - margin.bottom, margin.top]);

  const color = d3
    .scaleThreshold()
    .domain([40, 60, 80])
    .range(['#e03a2f', '#f5c518', '#8fcf6a', '#1a8f5a']);

  svg
    .append('g')
    .attr('class', 'axis')
    .attr('transform', `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(4).tickSizeOuter(0));

  svg
    .append('g')
    .attr('class', 'axis')
    .attr('transform', `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSizeOuter(0));

  svg
    .append('g')
    .attr('class', 'axis')
    .selectAll('line.gridline')
    .data(y.ticks(4))
    .join('line')
    .attr('class', 'gridline')
    .attr('x1', margin.left)
    .attr('x2', width - margin.right)
    .attr('y1', (tick) => y(tick))
    .attr('y2', (tick) => y(tick));

  svg
    .selectAll('circle.dot')
    .data(rows)
    .join('circle')
    .attr('class', 'dot')
    .attr('cx', (row) => x(row.density))
    .attr('cy', (row) => y(row.index))
    .attr('r', 2.6)
    .attr('fill', (row) => color(row.index))
    .attr('fill-opacity', 0.85)
    .append('title')
    .text(
      (row) =>
        `${row.name} · ${row.district}\n${d(row.density, 2)} बूथ/वर्ग किमी · सूचकांक ${d(row.index, 1)}`,
    );

  const labelled = [...rows].sort((a, b) => b.density - a.density).slice(0, 3);
  svg
    .append('g')
    .selectAll('text.lbl')
    .data(labelled)
    .join('text')
    .attr('class', 'lbl')
    .attr('x', (row) => Math.min(width - margin.right - 4, x(row.density) + 5))
    .attr('y', (row) => y(row.index) + 3)
    .attr('text-anchor', (row) => (x(row.density) > width - 90 ? 'end' : 'start'))
    .attr('dx', (row) => (x(row.density) > width - 90 ? -5 : 0))
    .text((row) => row.name);
}

// ----------------------------------------------------------------------- start
let lastScatterWidth = 0;
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const host = document.getElementById('scatter');
    if (host && Math.abs(host.clientWidth - lastScatterWidth) > 24) {
      lastScatterWidth = host.clientWidth;
      renderScatter();
    }
  }, 200);
});

map.ready.then(() => {
  setActiveTier(map.tier);
  // The map has just finished its first paint; force the current scroll step
  // to sync instead of skipping because it was marked current while loading.
  applyScrollState(true);
  renderScatter();
  lastScatterWidth = document.getElementById('scatter')?.clientWidth ?? 0;
});

window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('orientationchange', () => setTimeout(applyScrollState, 250));

// Deep link: /#ac-135 opens the drill-down straight away.
const deepLink = /^#ac-(\d{1,3})$/.exec(window.location.hash);
if (deepLink) {
  showAc(deepLink[1]).catch((error) => console.error(error));
}
