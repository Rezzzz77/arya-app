// دیپلوی Pages با REST API کلودفلر (Direct Upload) — برای دستگاه‌هایی که wrangler اجرا نمی‌شود
// (Termux/Android: بستهٔ workerd از android arm64 پشتیبانی نمی‌کند)
//
// استفاده:
//   CF_API_TOKEN=... CF_ACCOUNT_ID=... node scripts/deploy-pages-api.js
// یا با arya-app/.env.local
//
// روش: upload-token → check-missing → upload → upsert-hashes → deployments(manifest)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
const project = String(env.PAGES_PROJECT || 'arya-app').trim();
const branch = String(env.PAGES_BRANCH || 'main').trim();
const apiBase = String(env.ARYA_API || 'https://arya-api.arshadirad7475.workers.dev').replace(/\/+$/, '');
if (!token || !account) {
  console.error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (یا CF_API_TOKEN / CF_ACCOUNT_ID) لازم است.');
  process.exit(1);
}

const TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  woff2: 'font/woff2',
};

const pub = path.join(root, 'public');
if (!fs.existsSync(pub)) {
  console.error('پوشهٔ public پیدا نشد.');
  process.exit(1);
}

function walk(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else if (!/\.bak$/.test(name)) out.push({ rel, full });
  }
  return out;
}

const files = walk(pub).map(({ rel, full }) => {
  let content = fs.readFileSync(full);
  if (rel === 'index.html') content = Buffer.from(content.toString('utf8').replace(/https:\/\/arya-api\.[a-z0-9-]+\.workers\.dev/g, apiBase));
  const ext = rel.includes('.') ? rel.split('.').pop() : '';
  // کلودفلر: asset key = sha256(content + ext) کوتاه‌شده
  const hash = crypto.createHash('sha256').update(Buffer.concat([content, Buffer.from(ext)])).digest('hex').slice(0, 32);
  return { rel: '/' + rel, content, hash, ct: TYPES[ext] || 'application/octet-stream' };
});

console.log(`پوشه: public | ${files.length} فایل | ${(files.reduce((s, f) => s + f.content.length, 0) / 1024).toFixed(1)} KB | API: ${apiBase}`);

const json = async (res) => {
  const text = await res.text();
  try { return { status: res.status, ok: res.ok, data: JSON.parse(text), text }; }
  catch { return { status: res.status, ok: res.ok, data: null, text }; }
};
const cf = `https://api.cloudflare.com/client/v4/accounts/${account}`;

/* 1) upload-token */
const t = await json(await fetch(`${cf}/pages/projects/${project}/upload-token`, { headers: { Authorization: 'Bearer ' + token } }));
if (!t.data || !t.data.success) {
  console.error('❌ upload-token:', t.status, t.text.slice(0, 300));
  process.exit(1);
}
const jwt = t.data.result.jwt;
const jh = { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' };
console.log('✅ upload-token');

/* 2) check-missing */
const byHash = {};
files.forEach((f) => { byHash[f.hash] = f; });
const hashes = files.map((f) => f.hash);
const cm = await json(await fetch('https://api.cloudflare.com/client/v4/pages/assets/check-missing', { method: 'POST', headers: jh, body: JSON.stringify({ hashes }) }));
let missing = [];
if (cm.data && cm.data.success) {
  (cm.data.result || []).forEach((g) => { if (Array.isArray(g)) missing = missing.concat(g); else missing.push(g); });
}
console.log(`check-missing: ${cm.status} — ${missing.length} فایل جدید از ${hashes.length}`);

/* 3) آپلود — تک‌فایل با retry (payload بزرگ روی HTTP/2 با NGHTTP2_PROTOCOL_ERROR می‌شکند) */
let sent = 0;
for (const h of missing) {
  const f = byHash[h];
  if (!f) continue;
  const payload = JSON.stringify([{
    key: h,
    value: f.content.toString("base64"),
    metadata: { contentType: f.ct },
    base64: true,
  }]);
  let done = false;
  for (let attempt = 0; attempt < 4 && !done; attempt++) {
    try {
      const up = await json(await fetch("https://api.cloudflare.com/client/v4/pages/assets/upload", { method: "POST", headers: jh, body: payload }));
      if (up.data && up.data.success) { done = true; break }
      console.error("   upload خطا:", up.status, up.text.slice(0, 200));
    } catch (e) {
      console.error("   upload تلاش", attempt + 1, "شکست:", String(e.message).slice(0, 80));
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  if (!done) { console.error("❌ آپلود", f.rel, "ناموفق ماند"); process.exit(1) }
  sent++;
  console.log("   uploaded " + sent + "/" + missing.length + " — " + f.rel);
}

/* 4) upsert-hashes */
await fetch('https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes', { method: 'POST', headers: jh, body: JSON.stringify({ hashes }) });

/* 5) ساخت deployment با manifest */
const manifest = {};
files.forEach((f) => { manifest[f.rel] = f.hash; });
const fd = new FormData();
fd.set('manifest', JSON.stringify(manifest));
fd.set('branch', branch);
const dep = await json(await fetch(`${cf}/pages/projects/${project}/deployments`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd }));
if (!dep.data || !dep.data.success) {
  console.error('❌ deployment:', dep.status, dep.text.slice(0, 500));
  process.exit(1);
}
const id = dep.data.result.id;
const url = dep.data.result.url;
console.log('🚀 deployment ساخته شد:', url);

/* 6) انتظار تا پایان استیج */
let stage = '';
for (let k = 0; k < 40; k++) {
  await new Promise((r) => setTimeout(r, 3000));
  const g = await json(await fetch(`${cf}/pages/projects/${project}/deployments/${id}`, { headers: { Authorization: 'Bearer ' + token } }));
  if (g.data && g.data.success) {
    stage = (g.data.result.latest_stage || {}).status || '';
    if (stage === 'success' || stage === 'failed') break;
  }
}
console.log('stage:', stage);
if (stage === 'failed') process.exit(1);

/* 7) بررسی زنده */
const live = await fetch(`${url}/?cb=${Date.now()}`, { headers: { 'User-Agent': 'Mozilla/5.0 aether-verify' } });
const html = await live.text();
console.log(`زنده: HTTP ${live.status} | ${html.length} B | آدرس API درست: ${html.includes(apiBase)}`);
console.log('🌐', url);
