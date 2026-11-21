// Everything the templates need, computed once per build. All numbers come
// from build/, never from the campaign deck (those cards carry their own text).
import { num } from './format.mjs';

const median = (sorted) => {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Elected-post counts come from the Zila-wise Panchayat Summary total row in
// Data/Tracker.xlsx, materialised by build-panchayat-summaries.py. The geographic
// metrics are indices into boot.districts, which are computed from
// build/districts.json. Keeping both in one place lets the card chart and the
// district choropleth share exactly the same tier definitions.
const TIER_DECK = [
  {
    id: 'zila',
    no: '01',
    label: 'ज़िला पंचायत',
    units: 75,
    unitLabel: 'ज़िले',
    headLabel: 'अध्यक्ष',
    head: 75,
    memberLabel: 'सदस्य',
    member: 3019,
    metric: 'villages',
    metricIndex: 2,
    metricLabel: 'गाँव प्रति ज़िला',
    districtMetric: 'गाँव',
  },
  {
    id: 'kshetra',
    no: '02',
    label: 'क्षेत्र पंचायत',
    units: 826,
    unitLabel: 'ब्लॉक',
    headLabel: 'प्रमुख',
    head: 826,
    memberLabel: 'सदस्य',
    member: 75014,
    metric: 'blocks',
    metricIndex: 6,
    metricLabel: 'क्षेत्र पंचायतें प्रति ज़िला',
    districtMetric: 'ब्लॉक',
  },
  {
    id: 'gram',
    no: '03',
    label: 'ग्राम पंचायत',
    units: 57694,
    unitLabel: 'ग्राम पंचायतें',
    headLabel: 'प्रधान',
    head: 57694,
    memberLabel: 'सदस्य',
    member: 740352,
    metric: 'gps',
    metricIndex: 5,
    metricLabel: 'ग्राम पंचायतें प्रति ज़िला',
    districtMetric: 'ग्राम पंचायतें',
  },
];

function buildTiers(summaries = {}) {
  const workbook = summaries.threeTier || {};
  const deck = TIER_DECK.map((tier) => {
    const values = workbook[tier.id];
    if (!values) return tier;
    return {
      ...tier,
      units: values.units ?? tier.units,
      head: values.head ?? tier.head,
      member: values.members ?? tier.member,
    };
  });
  const postValues = deck.flatMap((tier) => [tier.head, tier.member]);
  const maxPost = Math.max(...postValues);
  // A log scale keeps the 75-seat bar legible next to the lakh-scale bar;
  // exact values are always printed on the bar itself.
  const barWidth = (value) => Math.max(4, (Math.log10(value) / Math.log10(maxPost)) * 100);
  const totalReps = deck.reduce((sum, tier) => sum + tier.head + tier.member, 0);

  const tiers = deck.map((tier) => {
    const total = tier.head + tier.member;
    return {
      ...tier,
      total,
      share: (total / totalReps) * 100,
      posts: [
        { label: tier.headLabel, value: tier.head, width: barWidth(tier.head) },
        { label: tier.memberLabel, value: tier.member, width: barWidth(tier.member) },
      ],
    };
  });
  return { tiers, totalReps };
}

function histogram(values, step = 100) {
  if (!values.length) return { bins: [], max: 1 };
  const start = Math.floor(Math.min(...values) / step) * step;
  const end = Math.ceil(Math.max(...values) / step) * step;
  const bins = [];
  for (let from = start; from < end; from += step) {
    bins.push({
      from,
      to: from + step,
      count: values.filter((v) => v >= from && v < from + step).length,
    });
  }
  return { bins, max: Math.max(...bins.map((b) => b.count), 1) };
}

export function buildViewModel(store) {
  const { meta, acs, districts, parliamentFilter = [] } = store;
  const { tiers, totalReps } = buildTiers(store.panchayatSummaries);
  const districtWards = (store.panchayatSummaries.districtWards || []).map((entry) => ({ ...entry }));
  const maxWards = Math.max(...districtWards.map((entry) => entry.wards), 1);
  districtWards.forEach((entry) => {
    entry.width = (entry.wards / maxWards) * 100;
  });
  const booths = acs.map((ac) => ac.booths).sort((a, b) => a - b);
  const hist = histogram(booths);
  const maxAc = acs.reduce((best, ac) => (ac.booths > best.booths ? ac : best), acs[0]);
  const minAc = acs.reduce((best, ac) => (ac.booths < best.booths ? ac : best), acs[0]);

  const density = acs
    .filter((ac) => ac.boothsPerKm2 > 0)
    .sort((a, b) => b.boothsPerKm2 - a.boothsPerKm2);
  const byIndex = [...acs].sort((a, b) => b.index - a.index);
  const acOptions = [...acs].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', 'en'),
  );
  const topDistricts = [...districts]
    .filter((d) => d.name)
    .sort((a, b) => b.booths - a.booths)
    .slice(0, 6);
  const topDistrictsMax = Math.max(...topDistricts.map((d) => d.booths), 1);
  const amethiAcs = acs
    .filter((ac) => ac.district === 'Amethi')
    .sort((a, b) => a.no - b.no);
  const amethiVillageMax = Math.max(...amethiAcs.map((ac) => ac.villages), 1);

  // District-level campaign success proxy: the booth→village link coverage,
  // weighted by booths so a large AC counts for more than a small one. This is
  // real data (unlike the statewide demo progress gauge) and is what fills the
  // district choropleth; the progress gauge controls the colour intensity.
  const districtCoverage = new Map();
  for (const ac of acs) {
    if (!ac.district) continue;
    const row = districtCoverage.get(ac.district) || { booths: 0, linked: 0 };
    row.booths += ac.booths || 0;
    row.linked += (ac.booths || 0) * (ac.coverage || 0);
    districtCoverage.set(ac.district, row);
  }

  // Lok Sabha filter options come from Data/UTTAR PRADESH_parliament.geojson
  // via store.parliamentFilter; build/pc.json only supplies already-computed
  // seat totals for the labels.
  const pcStats = new Map(store.pc.map((row) => [row.no, row]));
  const acCountByPc = new Map();
  for (const ac of acs) {
    if (!ac.pcNo) continue;
    acCountByPc.set(ac.pcNo, (acCountByPc.get(ac.pcNo) || 0) + 1);
  }
  const pcOptions = parliamentFilter.map((pc) => {
    const stats = pcStats.get(pc.no);
    return {
      ...pc,
      acCount: acCountByPc.get(pc.no) ?? stats?.acs ?? 0,
      booths: stats?.booths ?? 0,
      label: `PC ${pc.no} · ${pc.name}`,
    };
  });

  // Compact transport form for the map tooltips and the district comparison:
  // [no, name, district, booths, villages, gps, areaKm2, boothsPerKm2, index,
  //  coverage, blocks, pcNo]
  const acsCompact = acs.map((ac) => [
    ac.no,
    ac.name,
    ac.district,
    ac.booths,
    ac.villages,
    ac.gps,
    ac.areaKm2,
    ac.boothsPerKm2,
    ac.index,
    ac.coverage,
    ac.blocks || 0,
    ac.pcNo || null,
  ]);

  const progress = store.progress();
  const boot = {
    v: store.version,
    meta: {
      builtAt: meta.builtAt,
      totals: meta.totals,
      match: meta.match,
      layers: meta.layers,
      urbanAcs: meta.urbanAcs,
      indexWeights: meta.indexWeights,
      blankVillageNames: meta.blankVillageNames,
      villagesWithoutGp: meta.villagesWithoutGp,
    },
    panchayat: store.panchayat,
    progress,
    acs: acsCompact,
    tiers,
    // [name, booths, villages, acCount, layerName, gps, blocks, success]
    // gps/blocks index 5/6 drive the three-tier map; success index 7 is the
    // booth-weighted link coverage used by the campaign-success choropleth.
    districts: districts
      .filter((d) => d.name)
      .map((d) => {
        const cov = districtCoverage.get(d.name);
        return [
          d.name,
          d.booths,
          d.villages,
          d.acs.length,
          d.layerName,
          d.gps || 0,
          d.blocks || 0,
          cov?.booths ? cov.linked / cov.booths : 0,
        ];
      }),
    // [no, name, booths, villages, acCount]
    pc: store.pc.map((p) => [p.no, p.name, p.booths, p.villages, p.acs]),
    // [no, name, acCount, booths] — PC_NO / PC_NAME from the GeoJSON filter source.
    pcOptions: pcOptions.map((pc) => [pc.no, pc.name, pc.acCount, pc.booths]),
  };
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');

  return {
    v: store.version,
    meta,
    progress,
    boot,
    bootJson,
    tiers,
    tierTotals: {
      reps: totalReps,
      withRunnersUp: totalReps * 3,
    },
    hist: {
      ...hist,
      bars: hist.bins.map((bin) => ({
        ...bin,
        label: `${num(bin.from)}–${num(bin.to - 1)}`,
        width: (bin.count / hist.max) * 100,
        height: Math.max(2, (bin.count / hist.max) * 100),
      })),
    },
    median: median(booths),
    maxAc,
    minAc,
    densityTop: density.slice(0, 5),
    densityBottom: density.slice(-5).reverse(),
    indexTop: byIndex.slice(0, 5),
    indexBottom: byIndex.slice(-5).reverse(),
    amethiAcs: amethiAcs.map((ac) => ({
      ...ac,
      villageWidth: (ac.villages / amethiVillageMax) * 100,
    })),
    topDistricts: topDistricts.map((d) => ({
      ...d,
      width: (d.booths / topDistrictsMax) * 100,
    })),
    acOptions,
    pcOptions,
    districtOptions: [...new Set(acs.map((ac) => ac.district))].sort((a, b) =>
      a.localeCompare(b, 'en'),
    ),
    weights: meta.indexWeights,
    team: {
      totals: store.teamAppointments.totals,
      zoneOrder: store.teamAppointments.zoneOrder,
    },
    panchayatSummaries: store.panchayatSummaries,
    districtWards,
  };
}
