import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const env = { ...process.env };
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const API = String(env.ARYA_API || '').replace(/\/+$/, '');
const TOKEN = env.ADMIN_TOKEN || '';
const cmd = process.argv[2] || 'stats';
const arg1 = process.argv[3];
const arg2 = process.argv[4];

if (!API) {
  console.error('ARYA_API را تنظیم کنید، مثلاً: ARYA_API=https://arya-api.xxx.workers.dev');
  process.exit(1);
}
if (!TOKEN) {
  console.error('ADMIN_TOKEN را در .env یا محیط تنظیم کنید.');
  process.exit(1);
}

const headers = { 'Content-Type': 'application/json', 'x-admin-token': TOKEN, Authorization: 'Bearer ' + TOKEN };

async function call(pathname, body) {
  const r = await fetch(API + pathname, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    console.error('HTTP', r.status, data.error || data);
    process.exit(1);
  }
  return data;
}

(async () => {
  if (cmd === 'stats') {
    console.log(await call('/api/admin/stats'));
  } else if (cmd === 'list') {
    const d = await call('/api/admin/users');
    for (const u of d.users || []) console.log([u.email, u.status, u.role, u.daily_limit || '-'].join('\t'));
  } else if (cmd === 'approve' || cmd === 'block' || cmd === 'pending') {
    if (!arg1) { console.error('ایمیل را وارد کنید.'); process.exit(1); }
    const status = cmd === 'approve' ? 'approved' : cmd === 'block' ? 'blocked' : 'pending';
    console.log(await call('/api/admin/approve', { email: arg1, status }));
  } else if (cmd === 'limit') {
    if (!arg1 || !arg2) { console.error('فرمت: node scripts/admin.js limit email 20'); process.exit(1); }
    console.log(await call('/api/admin/limit', { email: arg1, limit: Number(arg2) }));
  } else {
    console.log('دستورها: stats | list | approve <email> | block <email> | pending <email> | limit <email> <n>');
  }
})();
