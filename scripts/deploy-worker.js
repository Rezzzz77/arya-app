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

// Wrangler روی ویندوز با مسیرهای دارای فاصله مشکل دارد؛ در پوشهٔ temp (بدون فاصله) دیپلوی می‌کنیم.
const stage = path.join(os.tmpdir(), 'arya-worker-deploy');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(path.join(root, 'worker', 'src', 'index.js'), path.join(stage, 'index.js'));
fs.copyFileSync(path.join(root, 'worker', 'src', 'catalog.js'), path.join(stage, 'catalog.js'));
fs.copyFileSync(path.join(root, 'worker', 'src', 'admin.html'), path.join(stage, 'admin.html'));
let toml = fs.readFileSync(path.join(root, 'worker', 'wrangler.toml'), 'utf8');
toml = toml.replace(/main\s*=\s*"[^"]+"/, 'main = "index.js"');
fs.writeFileSync(path.join(stage, 'wrangler.toml'), toml, 'utf8');

const wrangler = process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler';
console.log('Staging worker in', stage);
const r = spawnSync(wrangler, ['deploy', '--config', 'wrangler.toml'], { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32', env });
process.exit(r.status || 0);
