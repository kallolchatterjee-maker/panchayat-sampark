// Express 5 + EJS. The story page is rendered on the server; D3 hydrates the
// map and the drill-down panel in the browser.
import express from 'express';
import compression from 'compression';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { loadStore } from './lib/store.mjs';
import { buildViewModel } from './lib/viewmodel.mjs';
import { num, pct, decimal, place } from './lib/format.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Session cookies are HMAC-signed; no server-side session store is needed.
// Set SESSION_SECRET in production so sessions survive a restart.
const SESSION_COOKIE = 'ps_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function issueSession() {
  const payload = `${Date.now() + SESSION_TTL_SECONDS * 1000}.${crypto.randomBytes(16).toString('hex')}`;
  return `${payload}.${sign(payload)}`;
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function isAuthenticated(req) {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE);
  const [expiresAt, nonce, signature] = token.split('.');
  if (!expiresAt || !nonce || !signature) return false;
  const expected = sign(`${expiresAt}.${nonce}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(expiresAt) > Date.now();
}

function safeNext(value) {
  const next = typeof value === 'string' ? value : '';
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function createApp({ root = ROOT } = {}) {
  const store = loadStore(root);
  const vm = buildViewModel(store);

  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', join(ROOT, 'views'));
  app.locals.num = num;
  app.locals.pct = pct;
  app.locals.decimal = decimal;
  app.locals.place = place;

  app.use(compression());
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // Generated map assets (hash-busted with ?v=).
  app.use(
    '/data',
    express.static(join(root, 'build', 'map'), {
      maxAge: '365d',
      immutable: true,
      etag: true,
      fallthrough: false,
    }),
  );
  app.use(
    '/vendor',
    express.static(join(ROOT, 'public', 'vendor'), {
      maxAge: '365d',
      immutable: true,
    }),
  );
  app.use(
    express.static(join(ROOT, 'public'), {
      maxAge: '1h',
      etag: true,
    }),
  );

  // ---------------------------------------------------------------- login
  // The demo credentials are the same ones used by the static GitHub Pages
  // build; the Node server enforces them with an HttpOnly signed cookie.
  app.get('/login', (req, res) => {
    res.set('Cache-Control', 'no-store').sendFile(join(ROOT, 'public', 'login.html'));
  });

  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const username = String(req.body?.username ?? '');
    const password = String(req.body?.password ?? '');
    const next = safeNext(req.body?.next ?? req.query.next);
    if (username !== 'admin' || password !== 'admin123') {
      res.redirect(303, `/login?error=1&next=${encodeURIComponent(next)}`);
      return;
    }
    res.cookie(SESSION_COOKIE, issueSession(), {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      maxAge: SESSION_TTL_SECONDS * 1000,
      path: '/',
    });
    res.redirect(303, next);
  });

  app.get('/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.redirect(303, '/login');
  });

  app.use((req, res, next) => {
    if (req.path === '/healthz' || isAuthenticated(req)) {
      next();
      return;
    }
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }
    res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  });

  let cachedHtml = null;
  app.get('/', (req, res, next) => {
    if (cachedHtml) {
      res.type('html').set('Cache-Control', 'no-cache').send(cachedHtml);
      return;
    }
    app.render('index', { vm }, (error, html) => {
      if (error) {
        next(error);
        return;
      }
      cachedHtml = html;
      res.type('html').set('Cache-Control', 'no-cache').send(html);
    });
  });

  app.get('/api/ac/:no', (req, res) => {
    const detail = store.villageDetail(req.params.no);
    if (!detail) {
      res.status(404).json({ error: 'unknown assembly constituency' });
      return;
    }
    res.set('Cache-Control', 'public, max-age=300').json(detail);
  });

  app.get('/api/search', (req, res) => {
    const query = String(req.query.q ?? '').slice(0, 80);
    const results = store.search(query, 24);
    res.set('Cache-Control', 'public, max-age=300').json({ query, results });
  });

  app.get('/api/village-network/index', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(store.villageNetworkIndex);
  });

  app.get('/api/village-network/:id', (req, res) => {
    const network = store.villageNetwork(req.params.id);
    if (!network) {
      res.status(404).json({ error: 'unknown village network block' });
      return;
    }
    res.set('Cache-Control', 'public, max-age=300').json(network);
  });

  app.get('/api/progress', (req, res) => {
    res.set('Cache-Control', 'public, max-age=60').json(store.progress());
  });

  app.get('/api/booth-grades/:ac', (req, res) => {
    const ac = Number(req.params.ac);
    if (!Number.isFinite(ac)) {
      res.status(400).json({ error: 'invalid assembly constituency' });
      return;
    }
    const byAc = store.boothGrades.byAc.get(ac) || { A: 0, B: 0, C: 0, D: 0, total: 0 };
    res.set('Cache-Control', 'public, max-age=300').json({ ac, grades: byAc });
  });

  app.get('/healthz', (req, res) => {
    res.json({
      ok: true,
      builtAt: store.meta.builtAt,
      acs: store.meta.totals.acs,
      booths: store.meta.totals.booths,
    });
  });

  app.use((req, res) => {
    res.status(404).type('text').send('Not found');
  });

  app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(500).type('text').send('Server error');
  });

  return { app, store, vm };
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  let created;
  try {
    created = createApp();
  } catch (error) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 3000;
  created.app.listen(port, () => {
    const { meta } = created.store;
    console.log(`Panchayat Sampark → http://localhost:${port}`);
    console.log(
      `403 AC · ${meta.totals.villages.toLocaleString('en-IN')} villages · ` +
        `${meta.totals.booths.toLocaleString('en-IN')} booths · build ${meta.builtAt}`,
    );
  });
}
