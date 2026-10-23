import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
for (const p of [path.join(root, '.env'), path.join(root, '.env.local'), path.join(root, '..', '.env')]) {
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && (!env[m[1]] || !String(env[m[1]]).trim())) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
env.CLOUDFLARE_API_TOKEN = String(env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN || '').trim();
env.CLOUDFLARE_ACCOUNT_ID = String(env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID || '').trim();

const project = env.PAGES_PROJECT || 'arya-app';
const api = (env.ARYA_API || 'https://arya-api.arshadirad7475.workers.dev').replace(/\/+$/, '');
const stage = path.join(os.tmpdir(), 'arya-pages-deploy');
fs.rmSync(stage, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), stage, { recursive: true });

// آدرس API را در نسخهٔ استیج‌شده جایگزین کن (اگر ARYA_API تنظیم شده باشد)
const idx = path.join(stage, 'index.html');
if (fs.existsSync(idx)) {
  let html = fs.readFileSync(idx, 'utf8');
  html = html.replace(/https:\/\/arya-api\.[a-z0-9-]+\.workers\.dev/g, api);
  fs.writeFileSync(idx, html, 'utf8');
}

const wrangler = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';
console.log('Staging pages in', stage);
spawnSync(wrangler, ['pages', 'project', 'create', project, '--production-branch', 'main'], {
  cwd: stage, stdio: 'ignore', shell: process.platform === 'win32', env,
});
const r = spawnSync(wrangler, ['pages', 'deploy', '.', '--project-name', project, '--branch', 'main', '--commit-dirty=true'], {
  cwd: stage, stdio: 'inherit', shell: process.platform === 'win32', env,
});
process.exit(r.status || 0);
