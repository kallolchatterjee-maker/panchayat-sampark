// Builds a GitHub-Pages-ready static snapshot of the Express/EJS app.
// Pages cannot run Node, so every API response is materialised as JSON and
// public/js/static-api.js redirects the browser's fetches to those files.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

import { loadStore } from '../lib/store.mjs';
import { buildViewModel } from '../lib/viewmodel.mjs';
import { num, pct, decimal, place } from '../lib/format.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs');
const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
};

async function build() {
  const started = Date.now();
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const store = loadStore(ROOT);
  const vm = buildViewModel(store);

  // 1. Server-render the story page exactly as the Express app does.
  let html = await ejs.renderFile(
    join(ROOT, 'views', 'index.ejs'),
    { vm, num, pct, decimal, place },
    {},
  );
  // Root-relative URLs must work from /<repo>/ on project Pages sites.
  html = html.replace(/(href|src)="\//g, '$1="./');
  html = html.replace(
    '<body>',
    '<body>\n<script src="./js/auth-gate.js"></script>',
  );
  html = html.replace(
    /(<script type="module" src="\.\/js\/main\.js)/,
    '<script src="./js/static-api.js"></script>\n$1',
  );
  await writeFile(join(OUT, 'index.html'), html);

  // 2. Copy browser assets and generated map geometry.
  await cp(join(ROOT, 'public'), OUT, { recursive: true });
  await cp(join(ROOT, 'build', 'map'), join(OUT, 'data'), { recursive: true });
  await writeFile(join(OUT, '.nojekyll'), '');

  // 3. Materialise every /api/* response the page can request.
  await writeJson(join(OUT, 'api', 'progress.json'), store.progress());
  await writeJson(join(OUT, 'api', 'search-index.json'), store.searchIndex);
  await writeJson(join(OUT, 'api', 'village-network', 'index.json'), store.villageNetworkIndex);

  for (const ac of store.acs) {
    await writeJson(join(OUT, 'api', 'ac', `${ac.no}.json`), store.villageDetail(ac.no));
    await writeJson(join(OUT, 'api', 'booth-grades', `${ac.no}.json`), {
      ac: ac.no,
      grades: store.boothGrades.byAc.get(ac.no) || { A: 0, B: 0, C: 0, D: 0, total: 0 },
    });
  }
  for (const district of store.villageNetworkIndex) {
    for (const block of district.blocks) {
      await writeJson(
        join(OUT, 'api', 'village-network', `${block.id}.json`),
        store.villageNetwork(block.id),
      );
    }
  }

  // Sanity-check the rewritten page before reporting success.
  const rendered = await readFile(join(OUT, 'index.html'), 'utf8');
  if (rendered.includes('src="/') || rendered.includes('href="/') || rendered.includes('<%')) {
    throw new Error('static snapshot still has root-relative URLs or unresolved EJS');
  }
  for (const needle of ['./js/static-api.js', './js/auth-gate.js', 'id="boot"']) {
    if (!rendered.includes(needle)) throw new Error(`static snapshot is missing ${needle}`);
  }

  console.log(`Static snapshot → docs/ (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(
    `  ${store.acs.length} AC details · ${store.acs.length} booth-grade files · ` +
      `${store.villageNetworkIndex.reduce((n, d) => n + d.blocks.length, 0)} network blocks`,
  );
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
