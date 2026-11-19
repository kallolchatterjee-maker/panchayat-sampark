# उत्तर प्रदेश पंचायत अभियान · Scrollytelling map

Server-rendered scrollytelling page for the 2026 panchayat campaign, built on the
real files in `Data/` plus Survey of India village boundaries: 403 assembly
constituencies, 75 districts, 80 parliament seats, 310 subdistricts, 1,01,653
village polygons, 55,906 gram panchayats and 1,77,516 booths from the 2026
AC/booth list. The map is D3; the prose is EJS.

## Run it

```bash
npm install        # also copies the D3 browser builds into public/vendor
npm run data       # Data/ → build/ (about a minute; rebuild only when Data/ changes)
npm start          # http://localhost:3000
```

`npm run data` reads `Data/` and the root-level `vb_soi_up.GeoJSON`. The Amethi
Panchayat summary in `Data/amethi-panchayat.json` is a normalized export of the
supplied dashboard workbook; it is a district sample, not statewide Panchayat data.
The server reads `build/` at boot, so a deploy only needs `build/` plus the app
— not the raw GeoJSON sources.

## Login

Both deployments use the demo credentials **`admin` / `admin123`**:

- **Local Express app** — `/` and all `/api/*` routes require an HttpOnly,
  HMAC-signed cookie issued by `POST /login`. Set `SESSION_SECRET` in the
  environment to keep sessions valid across restarts. `GET /logout` clears it.
- **Static GitHub Pages site** — `/login.html` checks the same credentials and
  sets an 8-hour browser flag; `auth-gate.js` redirects visitors to it. This is
  a demo gate only: anyone with devtools can bypass a client-side check. Do not
  put real secrets behind it.

## GitHub Pages (static snapshot)

GitHub Pages has no Node runtime, so the EJS app is rendered to static files:

```bash
npm run data         # once, when Data/ changes
npm run build:static # writes docs/
```

`docs/` contains the prerendered `index.html`, browser assets, map geometry,
prematerialised `/api/*` JSON and the login page. `public/js/static-api.js`
translates the page's API fetches to those JSON files, including the same
fold-and-rank search used by the Express server. Publish the repo with Pages
source **main / docs** (or deploy `docs/` with the official Pages action).

## Scripts

| Script | What it does |
| --- | --- |
| `npm run data` | Parses booth and village sources, emits per-AC TopoJSON, per-block SOI village-boundary TopoJSON, simplified state layers, a 0.05° village grid, and reports. |
| `npm run build:static` | Prerenders the EJS page and all API responses into `docs/` for GitHub Pages. |
| `npm run check` | Validates `build/` (counts, areas, index ranges, chunk sizes, grid bounds, report rows). Non-zero exit on failure. |
| `npm run smoke` | Boots the app on a random port and exercises every route the browser calls: page, `/healthz`, `/api/ac/:no`, `/api/search`, static geometry, gzip. |
| `npm start` / `npm run dev` | Start the server / start it with `--watch`. |

## How the page is put together

- `server.mjs` — Express 5, SSR via EJS, gzip, immutable caching for `/data/*`.
- `lib/store.mjs` — loads `build/` once, caches AC detail, folds search queries.
- `lib/viewmodel.mjs` — totals, histogram, top/bottom lists, and a compact
  `boot` payload (403 rows) for the map.
- `views/` — hero, campaign-deck cards, real-data sections, drill-down, notes.
- `public/js/map.js` — D3 map: district/parliament/AC/subdistrict layers,
  booth-count choropleth, density choropleth, saturation index, 0.05° village
  grid, and per-AC village polygons with GP mesh, zoom and tooltips.
- `public/js/main.js` — scroll → map mode orchestration, search, drill-down
  panel, density scatter.

Map modes: campaign success · districts (booths) · three-tier panchayat ·
parliament · assembly · subdistricts · booth density · saturation index ·
villages. Scrolling picks the mode; the layer buttons override it. The default
campaign layer fills every district by its booth-weighted booth→village link
coverage (a real success measure), and the fill deepens with the live
`/api/progress` percentage — so the choropleth visibly fills as the campaign
approaches target. The statewide demo progress numbers themselves are *not*
fabricated down to districts. The drill-down section (`#drill`) enables
click-to-open ACs, and `/#ac-135` deep-links into a constituency.

The village-network view remains a separate full-map visualization: district
and block selectors load per-block village/GP clusters, team-member circles
sized by influence, assembly links, and a grey level-of-influence bubble chart
on member click. Its controls live in `views/partials/network.ejs`; the SVG and
influence panel live in `views/partials/map.ejs`.

The three-tier panchayat card replaces the static post table with a log-scaled
bar chart of all six elected posts plus a share bar for the 8,76,980 total. The
same `vm.tiers` definition drives a map overlay: picking a tier recolors the
75 district polygons by that tier's district-level metric (villages → blocks →
GPs) and resizes one bubble per district. The chart appears both in the card
and on the map; clicking either copy, or a district polygon/bubble, keeps the
two in sync and echoes the selected district's numbers back into the card.

The assembly comparison card is district-aware. It defaults to Amethi for
no-JS rendering, but the district selector in the preceding three-tier card —
or a district click on the map, or opening any AC — replaces the list with
every assembly constituency of that district, using booth-list and
village-boundary metrics. Selecting a row opens the AC drill-down and focuses
the map. Workbook GP summaries remain at district/block level because they do
not include an AC mapping.

The Lok Sabha filter is projected directly from `Data/UTTAR PRADESH_parliament.geojson`
(`PC_NO` / `PC_NAME`) into both the map control and the drill-down card. Choosing a
seat (or clicking a parliament polygon) focuses that constituency, highlights the
ACs it contains, and narrows the AC dropdown to those constituencies; opening an
AC or searching for a village keeps the filter in sync. The source file is only
read at build/store load time — the browser receives a compact 80-row list.

## Data caveats (shown in the UI, not hidden)

- **The village ↔ booth join is approximate.** Booth rows carry transliterated
  village labels and no LGD code. Matching is blocked by AC number, folded for
  transliteration, and scored on consonant skeletons + edit distance
  (auto ≥ 0.86, review 0.74–0.86). It links **62.2% of booth rows** and
  **76.9% of AC/label pairs**. Every pair, score and runner-up is in
  `reports/village-match-report.csv`. Treat linked counts as indicative.
- **Urban seats have no village polygons.** Lucknow West (171), Sishamau (213)
  and Varanasi South (389) are flagged as fully urban; their index renormalises
  over available components.
- **Boundaries are Census 2011, booths are 2026.** Different vintages; the join
  is by AC number, not by boundary.
- **3 villages** with failed geometry and **5,439 blank village names** are
  counted but not drawn/labelled.
- **Campaign-deck numbers** (8,76,980 elected representatives, 2,121 ground
  team, the November–January timeline) are static narrative cards. The progress
  gauge is demo-only. The campaign choropleth uses real district link-coverage
  for colour and the demo progress only for fill intensity; it does not claim
  district-level demo reach. Every other number on the page is computed from
  `Data/`.
- The Panchayat tier explorer is based only on the Amethi workbook sample. It
  distinguishes source rows from distinct GP names (the GP sheet has repeated
  names) and must not be interpreted as totals for Uttar Pradesh.
- The three-tier map uses `build/districts.json`. Block counts are missing for
  Mahrajganj, Sant Kabir Nagar and Shrawasti; those districts are left dark in
  the क्षेत्र पंचायत view and labelled "ब्लॉक-गणना नहीं" in tooltips. The 75 / 826 /
  57,694 unit counts in the chart are campaign-deck figures; the map's statewide
  GP and block sums are the dataset counts and are labelled as such.

## Booth Saturation Index

Weighted percentile ranks across 403 ACs: booths/village 25%, booths/km² 30%,
matched booth coverage 20%, GP density 15%, booths/GP 10%. Missing components
(e.g. urban seats) drop out and the remaining weights renormalise. The weights
are printed on the card and in `build/meta.json` (`indexWeights`).

## Performance notes

- State layers are mapshaper-simplified to 2–4% and quantized: 89 KB districts,
  88 KB parliament, 248 KB assembly, 150 KB subdistricts.
- Villages never ship as one file: 400 per-AC TopoJSON chunks, 25 MB total,
  median ~15 KB gzipped; only the opened AC is fetched.
- The state-wide village view is a 0.05° grid (8.9k cells, 203 KB) instead of
  101k polygons.
- SOI village boundaries are reprojected from EPSG:7755 to WGS84, simplified,
  matched to network nodes by LGD village code, and served only for the selected
  block; the 578 MB source file is never sent to the browser.
