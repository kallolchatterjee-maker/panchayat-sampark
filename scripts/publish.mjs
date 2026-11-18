// Creates a new GitHub repo, pushes the snapshot and enables Pages from /docs.
// Usage (PowerShell):
//   $env:GITHUB_TOKEN = 'ghp_...'
//   $env:GITHUB_OWNER = 'your-username'
//   $env:REPO_NAME = 'panchayat-sampark'   # optional
//   npm run publish
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.GITHUB_TOKEN;
const owner = process.env.GITHUB_OWNER;
const repo = process.env.REPO_NAME || 'panchayat-sampark';

if (!token || !owner) {
  console.error('Set GITHUB_TOKEN and GITHUB_OWNER before running npm run publish.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
};

async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} → ${response.status}: ${body.message || 'unknown error'}`);
  }
  return body;
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.trim() || result.stdout?.trim()}`);
  }
  return result;
}

async function main() {
  if (!existsSync(join(ROOT, 'docs', 'index.html'))) {
    throw new Error('docs/ is missing — run npm run build:static first.');
  }

  let created = true;
  try {
    await api('/user/repos', {
      method: 'POST',
      body: JSON.stringify({
        name: repo,
        description: 'उत्तर प्रदेश पंचायत अभियान — scrollytelling map with admin login',
        private: false,
        auto_init: false,
      }),
    });
  } catch (error) {
    if (!String(error.message).includes('already exists')) throw error;
    created = false;
  }
  console.log(created ? `Created ${owner}/${repo}` : `Using existing ${owner}/${repo}`);

  if (!existsSync(join(ROOT, '.git'))) git(['init', '-b', 'main']);
  git(['remote', 'remove', 'origin'], { allowFailure: true });
  // Keep the token out of the committed remote config.
  git(['remote', 'add', 'origin', `https://x-access-token:${token}@github.com/${owner}/${repo}.git`]);
  git(['add', '-A']);
  const staged = git(['diff', '--cached', '--name-only']).stdout.trim();
  const committing = git(['diff', '--cached', '--quiet'], { allowFailure: true }).status === 1;
  if (committing) {
    git(['commit', '-m', 'Add Panchayat Sampark static site with admin login']);
  }
  git(['push', '-u', 'origin', 'main']);
  git(['remote', 'set-url', 'origin', `https://github.com/${owner}/${repo}.git`]);

  let pagesExist = true;
  try {
    await api(`/repos/${owner}/${repo}/pages`);
  } catch {
    pagesExist = false;
  }
  await api(`/repos/${owner}/${repo}/pages`, {
    method: pagesExist ? 'PUT' : 'POST',
    body: JSON.stringify({ source: { branch: 'main', path: '/docs' } }),
  });
  console.log(`Pushed ${staged.split('\n').length} file(s) to main.`);
  console.log(`GitHub Pages → https://${owner.toLowerCase()}.github.io/${repo}/`);
  console.log('Login: admin / admin123');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
