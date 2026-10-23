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

const secretName = process.argv[2] || 'AI_API_KEY';
const value = String(env[secretName] || '').trim();
if (!value) {
  console.error(`مقدار ${secretName} پیدا نشد. آن را در arya-app/.env.local بگذارید.`);
  process.exit(1);
}
const token = String(env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN || '').trim();
const account = String(env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID || '').trim();
const worker = String(env.WORKER_NAME || 'arya-api').trim();
if (!token || !account) {
  console.error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (یا CF_API_TOKEN / CF_ACCOUNT_ID) لازم است.');
  process.exit(1);
}

const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/secrets`;
const res = await fetch(url, {
  method: 'PUT',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: secretName, text: value, type: 'secret_text' }),
});
const text = await res.text();
let data;
try { data = JSON.parse(text); } catch { data = { raw: text }; }
if (!res.ok || !data.success) {
  console.error('خطا در تنظیم Secret:', res.status, data.errors || data);
  process.exit(1);
}
console.log(`✅ Secret «${secretName}» برای Worker «${worker}» تنظیم شد. (مقدار چاپ نشد)`);
