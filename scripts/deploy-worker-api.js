// دیپلوی ورکر با REST API کلودفلر — برای دستگاه‌هایی که wrangler اجرا نمی‌شود
// (مثلاً Termux/Android: بستهٔ workerd از پلتفرم android arm64 پشتیبانی نمی‌کند)
//
// استفاده:
//   CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/deploy-worker-api.js
// یا با arya-app/.env.local (همان کلیدهایی که scripts/deploy-worker.js می‌خواند)
//
// نکته‌ها:
//  - سکرت‌ها با keep_bindings حفظ می‌شوند و هرگز فرستاده/چاپ نمی‌شوند.
//  - vars از بخش [vars] فایل worker/wrangler.toml خوانده می‌شود.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
for (const p of [path.join(root, '.env'), path.join(root, '.env.local'), path.join(root, '..', '.env')]) {
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && (!env[m[1]] || !String(env[m[1]]).trim())) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}

const token = String(env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN || '').trim();
const account = String(env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID || '').trim();
const worker = String(env.WORKER_NAME || 'arya-api').trim();
if (!token || !account) {
  console.error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (یا CF_API_TOKEN / CF_ACCOUNT_ID) لازم است.');
  process.exit(1);
}

const toml = fs.readFileSync(path.join(root, 'worker', 'wrangler.toml'), 'utf8');
const varsSection = /\[vars\]([\s\S]*?)(?:\n\[|$)/.exec(toml);
const vars = {};
if (varsSection) {
  for (const line of varsSection[1].split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
}
const main = (/^main\s*=\s*"([^"]+)"/m.exec(toml) || [])[1] || 'src/index.js';
const compatibilityDate = (/^compatibility_date\s*=\s*"([^"]+)"/m.exec(toml) || [])[1] || '2026-09-01';
const compatibilityFlags = Array.from(toml.matchAll(/^compatibility_flags\s*=\s*\[(.*)\]/gm))
  .flatMap((m) => Array.from(m[1].matchAll(/"([^"]+)"/g)).map((x) => x[1]));
// قواعد ماژول (مثل Text برای فایل‌های html)
const rules = Array.from(toml.matchAll(/\[\[rules\]\]([\s\S]*?)(?=\n\[|$)/g)).map((m) => {
  const type = (/type\s*=\s*"([^"]+)"/.exec(m[1]) || [])[1];
  const globs = ((/globs\s*=\s*\[(.*)\]/.exec(m[1]) || [])[1] || '');
  const fallthrough = /fallthrough\s*=\s*true/.test(m[1]);
  return { type, globs: Array.from(globs.matchAll(/"([^"]+)"/g)).map((x) => x[1]), fallthrough };
}).filter((r) => r.type && r.globs.length);

const api = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}`;
const headers = { Authorization: 'Bearer ' + token };

const settingsRes = await fetch(api + '/settings', { headers });
const settings = await settingsRes.json();
if (!settings.success) {
  console.error('خواندن تنظیمات ورکر ناموفق:', JSON.stringify(settings.errors).slice(0, 300));
  process.exit(1);
}

// بایندینگ‌های غیرسکرتی را از تنظیمات فعلی نگه می‌داریم و فقط vars را به‌روز می‌کنیم.
const bindings = settings.result.bindings
  .filter((b) => b.type !== 'secret_text')
  .map((b) => {
    const out = { type: b.type, name: b.name };
    if (b.type === 'plain_text') out.text = vars[b.name] !== undefined ? vars[b.name] : b.text;
    if (b.type === 'kv_namespace') out.namespace_id = b.namespace_id;
    if (b.type === 'd1') out.id = b.database_id || b.id;
    if (b.type === 'queue') out.queue_name = b.queue_name;
    return out;
  });

const metadata = {
  main_module: path.basename(main),
  compatibility_date: compatibilityDate,
  compatibility_flags: compatibilityFlags,
  keep_bindings: ['secret_text'],
  observability: { enabled: true },
  rules,
  bindings,
};

const srcDir = path.join(root, 'worker', 'src');
const form = new FormData();
form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
for (const file of fs.readdirSync(srcDir)) {
  const full = path.join(srcDir, file);
  if (!fs.statSync(full).isFile()) continue;
  // فقط ماژول‌هایی که ورکر واقعاً import می‌کند
  if (!/\.(js|html)$/.test(file)) continue;
  // ماژول Text باید text/plain باشد؛ application/javascript+module فقط برای .js
  const type = file.endsWith('.js') ? 'application/javascript+module' : 'text/plain';
  form.set(file, new Blob([fs.readFileSync(full)], { type }), file);
}

console.log('آپلود', worker, '| vars:', Object.keys(vars).map((k) => `${k}=${vars[k]}`).join(' '));
const res = await fetch(api, { method: 'PUT', headers, body: form });
const out = await res.json();
if (!res.ok || !out.success) {
  console.error('دیپلوی ناموفق:', res.status, JSON.stringify(out.errors || out).slice(0, 500));
  process.exit(1);
}
console.log('✅ دیپلوی شد. deployment_id =', out.result && out.result.deployment_id);
