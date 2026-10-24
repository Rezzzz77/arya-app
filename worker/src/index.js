// Arya Beauty Advisor API — Cloudflare Worker
// D1 for users/sessions/jobs, KV for rate limiting, Queues for AI jobs.
import { CATALOG, CATALOG_META } from './catalog.js';
import ADMIN_HTML from './admin.html';
import { IRIS_SYSTEM_PROMPT } from './iris-prompt.js';

const VERSION = '2026-10-24-v3';
const TOKEN_TTL_DAYS = 30;
const SESSION_CLEAN_EVERY = 20; // approximate

const enc = new TextEncoder();

const json = (obj, status = 200, cors = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }, cors),
});

const nowIso = () => new Date().toISOString();
const todayTehran = () => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
};

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(String(hex).match(/.{1,2}/g) || [], (b) => parseInt(b, 16));
const randomHex = (bytes = 32) => {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return toHex(a.buffer);
};
async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}
async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', salt: fromHex(saltHex), iterations: 30000, hash: 'SHA-256',
  }, key, 256);
  return toHex(bits);
}
const normalizeEmail = (s) => String(s || '').trim().toLowerCase();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- CORS ---------------- */
const ORIGIN_OK = [
  /^https:\/\/arya-app\.pages\.dev$/i,
  /^https:\/\/[a-z0-9-]+\.arya-app\.pages\.dev$/i,
  /^https:\/\/aryamlm\.ir$/i,
  /^https:\/\/[a-z0-9-]+\.aryamlm\.ir$/i,
  /^https:\/\/[a-z0-9-]+\.pages\.dev$/i,
  /^https:\/\/[a-z0-9-]+\.workers\.dev$/i,
  /^http:\/\/localhost(:\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/i,
];
function corsFor(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Admin-Token',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && ORIGIN_OK.some((r) => r.test(origin))) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Vary'] = 'Origin';
  }
  return h;
}

async function readJson(req) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > 3000000) throw new Error('too_large');
  try { return await req.json(); } catch { return null; }
}

function tokenFrom(req, body) {
  const h = req.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  return body && typeof body.token === 'string' ? body.token.trim() : '';
}

async function authUser(env, token) {
  if (!token || token.length < 20) return null;
  const token_hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    'SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
  ).bind(token_hash).first();
  if (!row) return null;
  if (row.session_expires < nowIso()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(token_hash).run();
    return null;
  }
  if (row.status !== 'approved') return { ...row, blocked: true };
  return row;
}

function publicUser(u) {
  return { id: u.id, email: u.email, role: u.role, status: u.status, daily_limit: u.daily_limit || null };
}

async function quotaInfo(env, user) {
  let globalLimit = Number(env.DAILY_LIMIT || 10);
  try {
    const s = await env.DB.prepare("SELECT value FROM settings WHERE key = 'daily_limit'").first();
    if (s && Number(s.value)) globalLimit = Number(s.value);
  } catch (e) {}
  const limit = Number(user.daily_limit || globalLimit);
  const day = todayTehran();
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND day = ? AND status != 'failed'"
  ).bind(user.id, day).first();
  const used = Number(row && row.n || 0);
  return { day, limit, used, remaining: Math.max(0, limit - used) };
}

async function logEvent(env, userId, kind, meta) {
  try {
    await env.DB.prepare('INSERT INTO events (user_id, kind, meta, created_at) VALUES (?,?,?,?)')
      .bind(userId || null, kind, meta ? JSON.stringify(meta).slice(0, 2000) : null, nowIso()).run();
  } catch (e) {}
}

async function rateLimit(env, req, bucket, max) {
  if (!env.CACHE || typeof env.CACHE.get !== 'function') return true;
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `rl:${bucket}:${ip}:${todayTehran()}`;
  try {
    const v = Number(await env.CACHE.get(key) || 0);
    if (v >= max) return false;
    await env.CACHE.put(key, String(v + 1), { expirationTtl: 86400 });
    return true;
  } catch (e) { return true; }
}

/* ---------------- text helpers ---------------- */
const GENERIC = new Set([
  'آریا', 'ariya', 'arya', 'سرم', 'محلول', 'تونیک', 'ژل', 'مایع', 'پک', 'بسته', 'محصول',
  'مناسب', 'انواع', 'پوست', 'مو', 'صورت', 'چشم', 'ابرو', 'مژه', 'صورتی', 'خالص',
  'میلی', 'لیتر', 'گرم', 'گرمی', 'عددی', 'عددی', 'همراه', 'حاوی', 'برای', 'با', 'و',
  'تقویت', 'کننده', 'نرم', 'پاک', 'کننده', 'آرایش', 'پاکسازی', 'مرطوب', 'آبرسان',
  'روشن', 'ضد', 'لایه', 'بردار', 'شستشو', 'تک', 'فاز', 'دو', 'دوفاز', 'سلول', 'بنیادی',
  'گل', 'روغن', 'کرم', 'پمپ', 'بطری', 'شیشه', 'ای', 'ml', 'نیوشا', 'خالص',
]);
const normalize = (s) => String(s || '')
  .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
  .replace(/[٬,،.]/g, ' ')
  .replace(/\u200c|\u200e|\u200f/g, ' ')
  .replace(/[()«»"']/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

function nameTokens(name) {
  return normalize(name).split(' ').filter((t) => t.length > 2 && !GENERIC.has(t) && !/^\d+$/.test(t));
}
const PRODUCT_TOKENS = CATALOG.map((p) => ({ p, tokens: [...new Set(nameTokens(p.name))] }));

// توکن‌هایی که فقط در یک محصول آمده‌اند؛ برای تطبیق مطمئن
const TOKEN_COUNT = new Map();
for (const { tokens } of PRODUCT_TOKENS) for (const t of tokens) TOKEN_COUNT.set(t, (TOKEN_COUNT.get(t) || 0) + 1);

function matchProduct(text) {
  const t = ' ' + normalize(text) + ' ';
  let best = null, bestScore = 0;
  for (const { p, tokens } of PRODUCT_TOKENS) {
    if (!tokens.length) continue;
    let hit = 0, distinctive = 0;
    for (const tok of tokens) {
      if (t.includes(' ' + tok + ' ')) {
        hit++;
        if (TOKEN_COUNT.get(tok) === 1 && tok.length >= 4) distinctive++;
      }
    }
    const score = hit / tokens.length;
    if (distinctive && score >= 0.2) return p;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= 0.6 ? best : null;
}

const fmtT = (n) => {
  try { return Number(n).toLocaleString('fa-IR'); }
  catch { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
};
const byId = new Map(CATALOG.map((p) => [String(p.id), p]));
const priceLine = (p) => `${fmtT(p.price_toman)} تومان`;

function fixPrices(text) {
  if (!text) return text;
  let fixed = 0, removed = 0;
  let out = text.split('\n').map((line) => {
    // ریال → تومان
    let m = /([۰-۹\d][۰-۹\d٬,\.\s]{2,})\s*ریال/.exec(line);
    if (m) {
      const rial = Number(String(m[1]).replace(/[^\d]/g, ''));
      if (rial > 0) {
        const name = line.slice(0, m.index);
        const p = matchProduct(name);
        if (p) { fixed++; return line.slice(0, m.index) + priceLine(p) + line.slice(m.index + m[0].length); }
        if (rial / 10 < 100000) return line;
      }
    }
    // تومان (عدد کامل یا میلیون)
    m = /([۰-۹\d][۰-۹\d٬,\.\s]{2,})\s*(?:تومان|ت\b)/.exec(line);
    let said = 0, priceStart = 0, priceLen = 0;
    if (m) {
      said = Number(String(m[1]).replace(/[^\d]/g, ''));
      priceStart = m.index; priceLen = m[0].length;
    } else {
      m = /([۰-۹\d.]+)\s*میلیون\s*(?:تومان)?/.exec(line);
      if (m) {
        said = Math.round(Number(String(m[1]).replace(/[^\d.]/g, '')) * 1000000);
        priceStart = m.index; priceLen = m[0].length;
      }
    }
    if (!said || said < 50000) return line;
    const name = line.slice(0, priceStart);
    const p = matchProduct(name);
    if (!p) {
      if (/سرم|دمنوش|شامپو|روغن|تونیک|محلول|پک|کرم/.test(line)) removed++;
      return line;
    }
    if (p.price_toman !== said) {
      fixed++;
      return line.slice(0, priceStart) + priceLine(p) + line.slice(priceStart + priceLen);
    }
    return line;
  }).join('\n');
  if (fixed || removed) {
    out += `\n\n> 🔧 ${fixed ? `${fixed} قیمت با کاتالوگ آریا اصلاح شد. ` : ''}${removed ? `${removed} قلم خارج از کاتالوگ آریا علامت خورد.` : ''}`;
  }
  return out;
}

function ensurePrices(text) {
  if (!text) return text;
  const mentioned = [];
  for (const p of CATALOG) {
    if (text.includes(p.name)) { mentioned.push(p); continue; }
    const toks = nameTokens(p.name);
    if (toks.length >= 2 && toks.every((t) => text.includes(t))) mentioned.push(p);
  }
  if (!mentioned.length) return text;
  const already = mentioned.every((p) => text.includes(fmtT(p.price_toman)) || text.includes(String(p.price_toman)));
  if (already) return text;
  const uniq = [...new Map(mentioned.map((p) => [p.id, p])).values()].slice(0, 6);
  let out = text + '\n\n### 💰 قیمت‌های به‌روز (منبع: aryamlm.ir)\n';
  out += '| محصول | قیمت |\n|---|---|\n';
  for (const p of uniq) out += `| ${p.name} | ${priceLine(p)} |\n`;
  return out;
}

function isPersianEnough(text) {
  if (!text || text.length < 40) return false;
  const fa = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const la = (text.match(/[A-Za-z]/g) || []).length;
  if (fa < 30) return false;
  const ratio = fa / Math.max(1, fa + la);
  if (text.length > 160 && ratio < 0.45) return false;
  const longLatin = text.split('\n').filter((l) => l.trim().length >= 45 && !/[\u0600-\u06FF]/.test(l)).length;
  if (longLatin >= 2) return false;
  return true;
}

/* ---------------- prompts ---------------- */
const SYSTEM_PROMPT = `تو «مشاور زیبایی آریا» هستی؛ متخصص تحلیل عنبیه، پوست، مو و روتین مراقبتی برای برند آریا پژوهش یکتا.
قواعد الزامی:
1) فقط فارسی روان و کامل بنویس. هیچ جمله یا پاراگراف انگلیسی ننویس (نام محصول و ml مجاز است).
2) تشخیص پزشکی یا روان‌شناختی قطعی نده. تحلیل‌های طب سنتی/عنبیه را با عبارت «احتمالی»، «نشانه» و «برداشت» بنویس. برای علائم شدید، درد، عفونت، ضایعه مشکوک، بارداری/شیردهی یا مصرف دارو، به پزشک ارجاع بده.
3) فقط محصولاتی را پیشنهاد بده که در «کاتالوگ آریا»ی پیام کاربر آمده‌اند. هیچ محصول یا برند بیرونی پیشنهاد نکن. اگر محصول مناسبی در کاتالوگ نیست (مثلاً کرم آبرسان، ضدآفتاب یا دهان‌شویه)، صریح بنویس «در کاتالوگ فعلی آریا موجود نیست» و در صورت امکان جایگزین از کاتالوگ بده.
4) قیمت هر محصول پیشنهادی را دقیقاً همان عدد تومانی کاتالوگ بنویس. قیمت از خودت نساز.
5) برای پوست حساس، آلرژی، بارداری/شیردهی، کودکان زیر ۱۲ سال و مصرف دارو، احتیاط و تست پچ را یادآوری کن. از تماس محصولات لایه‌بردار با دور چشم پرهیز کن.
6) ادعای درمان قطعی، پاکسازی سموم، جوانسازی تضمینی، درمان سرطان یا جایگزینی دارو نکن.
7) اگر داده کافی نیست، صادقانه بگو و ۲ تا ۳ سؤال مکمل بپرس؛ ولی در همین پاسخ یک تحلیل اولیه و روتین محتاطانه بده.
8) اگر تصویر پیوست شده است، از آن برای تحلیل بصری استفاده کن: رنگ، بافت، نواحی، لکه‌ها، قرمزی، منافذ، خطوط، شوره، تراکم مو و نشانه‌های قابل مشاهده. اگر تصویر واضح نیست یا با داده‌های عددی تناقض دارد، هر دو را با احتیاط ذکر کن و تشخیص قطعی نده.
9) لحن: محترمانه، حرفه‌ای، همدلانه و بدون ترساندن. کاربر را «شما» خطاب کن.
10) اگر profile['نام'] موجود است، عنوان گزارش را «تحلیل اختصاصی [نام]» بگذار.
11) ساختار پاسخ را دقیقاً به این شکل بنویس (Markdown):
## مشخصات اولیه اسکن بالینی
- موقعیت چشم: [راست/چپ/نامشخص] — بر اساس انتخاب کاربر و نشانه‌های تصویر (مجرای اشکی، خطوط بینی، ابرو). اگر قطعی نیست صادقانه بگو.
- تیپ کلی ساختار پوست و مو: [خلاصه ۲ تا ۳ جمله‌ای از رنگ و تراکم عنبیه، منافذ، چربی، خطوط و وضعیت مو]
## بخش اول: بررسی تخصصی ۱۲ شاخص ساختاری پوست و مو
۱. تیپ کلی ساختار پوست و مو: ...
۲. حلقه پوستی و تنفس سطحی پوست (حاشیه بیرونی عنبیه - ساعت ۱ تا ۱۲): ...
۳. کبد و لک‌های پوستی (ساعت ۴ در چشم راست): ...
۴. سیستم گوارش، معده و جذب املاح (حلقه اول و دوم اطراف مردمک): ...
۵. گردش خون مویرگی، اکسیژن‌رسانی و تغذیه فولیکول مو (ساعت ۱۱ تا ۱ + صلبیه): ...
۶. تعادل چربی، منافذ باز و سیستم لنفاوی (حلقه ششم عنبیه): ...
۷. تعادل هورمونی و غدد درون‌ریز (ساعت ۲ و ۱۰، ۱۱ و ۱، ۵ و ۷): ...
۸. استرس اکسیداتیو، حلقه‌های عصبی و پیری زودرس: ...
۹. رطوبت، کلاژن‌سازی و بافت الاستیسیته پوست: ...
۱۰. کلیه‌ها، مجاری ادراری و تیرگی دور چشم (ساعت ۵ در چشم راست): ...
۱۱. التهاب و حرارت پنهان و حساسیت‌های پوستی: ...
۱۲. خلاصه بالینی وضعیت پوست و مو: ...
- هر شاخص ۲ تا ۴ جمله. اگر نشانه‌ای در تصویر/داده‌ها نیست، حدس نزن و صریح بگو داده کافی نیست.
- نقشه برای چشم راست است؛ برای چشم چپ موقعیت‌ها را آینه‌ای تفسیر کن.
- اگر نوع درخواست پوست/مو/پرسش‌نامه است و داده عنبیه نداری، در ابتدای بخش اول بنویس «این تحلیل بر پایه پوست/مو است، نه عنبیه» و شاخص‌ها را با نشانه‌های پوست/مو تطبیق بده.
## بخش دوم: بررسی تیپ شخصیتی، رفتاری و ریشه‌یابی روان‌تنی (سایکوسوماتیک)
### ویژگی‌های رفتاری و اخلاقی
- ۴ تا ۶ ویژگی کوتاه بر اساس نشانه‌های ظاهری (تراکم/رنگ عنبیه، نگاه، خطوط دور چشم، ابرو/مژه) — با عبارت احتمالی.
### ریشه‌یابی روان‌تنی عمیق و احساسی
یک پاراگراف همدلانه (۳ تا ۵ جمله) درباره ارتباط تنش/کنترل/خستگی با پوست و مو؛ بدون تشخیص روان‌شناختی و بدون ترساندن.
## بخش سوم: پکیج درمانی و روتین تخصصی مراقبت پوست، مو و زیبایی (اختصاصی محصولات شرکت آریا پژوهش یکتا)
### روتین تخصصی مراقبت پوست، مو و بهداشت (محصولات آریا پژوهش یکتا)
معرفی دقیق محصولات متناسب با عارضه‌های استخراج‌شده از عنبیه از میان سبد کالایی آریا پژوهش یکتا (شامل ژل لایه‌بردار حاوی پودر هسته زردآلو، سرم‌های تخصصی پوست مثل ویتامین C و هیالورونیک اسید، کرم‌های آبرسان و تخصصی، شوینده‌ها و تونرها، تونیک تقویت مژه و ابرو، محلول‌ها و محصولات تقویت و نرم‌کننده مو، و دهان‌شویه گیاهی غرغره برای رفع التهابات و بوی دهان و گلو) به شرح زیر:
تعداد محصولات را بر اساس نیاز واقعی فرد بین ۲ تا ۵ مورد تنظیم کن.
برای هر محصول دقیقاً یک خط با این الگو بنویس:
۱. [نام دقیق محصول آریا پژوهش یکتا] - [زمان و نحوه مصرف دقیق صبح/شب] - [دلیل انتخاب بر اساس ساعت و نشانه دیده‌شده در عنبیه + شماره شاخص‌های بخش اول]
۲. [نام دقیق محصول آریا پژوهش یکتا] - [زمان و نحوه مصرف دقیق صبح/شب] - [دلیل انتخاب بر اساس ساعت و نشانه دیده‌شده در عنبیه + شماره شاخص‌های بخش اول]
۳. [نام دقیق محصول آریا پژوهش یکتا] - [زمان و نحوه مصرف دقیق صبح/شب] - [دلیل انتخاب بر اساس ساعت و نشانه دیده‌شده در عنبیه + شماره شاخص‌های بخش اول]
- اگر تحلیل پوست/مو/پرسش‌نامه است، به‌جای «عنبیه» نشانهٔ همان تحلیل را در دلیل بنویس.
- نام دقیق محصول را فقط از کاتالوگ بردار؛ اگر محصولی (مثل کرم آبرسان، ضدآفتاب یا دهان‌شویه) در کاتالوگ نیست، جای آن صریح بنویس «در کاتالوگ فعلی آریا موجود نیست».
- دلیل انتخاب هر محصول را حداکثر ۲۰ کلمه بنویس. جدول قیمت را خودت ننویس؛ قیمت‌ها خودکار اضافه می‌شوند.
### تکنیک ماساژ و جذب (مکمل روتین)
توضیح کوتاه درباره نحوه صحیح ماساژ پوست صورت یا کف سر هنگام استفاده از محصولات آریا پژوهش یکتا برای افزایش گردش خون مویرگی و جذب حداکثری.
### نسخه خانگی مکمل (کمک به اصلاح مزاج از درون و بیرون)
یک ترکیب ساده، طبیعی و در دسترس در خانه (مثلاً یک نوشیدنی سنتی خانگی برای پاکسازی کبد و معده یا یک ماسک ساده خانگی) برای تسریع نتیجه‌گیری در کنار پکیج آریا؛ ادعای درمان قطعی نکن.
### سبک زندگی و تغذیه زیبایی (بایدها و نبایدها بر اساس مزاج فرد)
- بخورید: [غذاها و میوه‌های مفید برای طبع، کبد و شادابی پوست و موی فرد]
- نخورید: [پرهیزات غذایی که اخلاط را به هم ریخته و پوست و موی فرد را خراب می‌کند]
- راهکار طلایی سبک زندگی: [توصیه عملی مربوط به تنظیم خواب، آب‌رسانی سلولی یا مدیریت استرس]
### ⚠️ هشدارهای ایمنی و ملاحظات مصرف
(توصیه به تست حساسیت پوستی روی بازو قبل از مصرف محصولات موضعی، ملاحظات دوران بارداری یا شیردهی و پرهیز از تماس محصولات لایه‌بردار با دور چشم.)
### توجه
جهت تهیه پکیج اصلی محصولات آریا پژوهش یکتا و تنظیم دقیق‌ترین نحوه مصرف، حتماً از مشاور خود راهنمایی بخواهید.
12) در بخش سوم، دلیل هر محصول را به شماره شاخص‌های بخش اول وصل کن (مثل «شاخص ۲ و ۶»).
13) همه بخش‌ها را کامل و به ترتیب بنویس؛ هیچ بخشی را حذف نکن و در نیمهٔ جمله رها نکن.
14) اگر داده‌های پیکسلی با پاسخ‌های پرسش‌نامه تناقض داشت، هر دو را ذکر کن و با احتیاط جمع‌بندی کن.
15) بخش دوم را فقط به‌عنوان برداشت احتمالی از نشانه‌های ظاهری بنویس، نه تشخیص روان‌شناختی.`;

function userPrompt(input, hasImage) {
  const typeLabel = input.type === 'iris' ? 'تحلیل عنبیه (نشانه‌ها و نقشه ۱۲ ساعتی)' : input.type === 'skin' ? 'تحلیل پوست' : input.type === 'hair' ? 'تحلیل مو' : 'پرسش‌نامه پوست و مو';
  const source = input.type === 'iris' ? 'عنبیه و نقشه ۱۲ ساعتی' : input.type === 'skin' ? 'پوست' : input.type === 'hair' ? 'مو' : 'پرسش‌نامه';
  const lines = [];
  lines.push('نوع درخواست: ' + typeLabel);
  lines.push('منبع تحلیل: ' + source);
  if (input.profile && input.profile['نام']) lines.push('نام کاربر: ' + input.profile['نام']);
  if (input.metrics && input.metrics.eye) lines.push('چشم انتخاب‌شده: ' + (input.metrics.eye === 'right' ? 'راست' : 'چپ'));
  if (hasImage) {
    lines.push('تصویر فشرده‌شده برای تحلیل ویژن پیوست شده است. از آن برای تشخیص رنگ، بافت، نواحی، لکه‌ها، قرمزی، منافذ، خطوط و نشانه‌های قابل مشاهده استفاده کن. اگر بخشی واضح نیست، حدس نزن و صادقانه بگو.');
  } else {
    lines.push('تصویری پیوست نشده؛ فقط از داده‌های عددی و پاسخ‌ها استفاده کن.');
  }
  if (input.type === 'iris') {
    lines.push('این تحلیل عنبیه است؛ بخش اول باید هر ۱۲ شاخص را کامل داشته باشد و در بخش سوم هر محصول را به شماره شاخص‌های بخش اول ارجاع بده.');
  } else {
    lines.push('این تحلیل بر پایه ' + source + ' است، نه عنبیه؛ در ابتدای بخش اول صریح بگو داده عنبیه در دسترس نیست و شاخص‌ها را با نشانه‌های ' + source + ' تطبیق بده. در بخش سوم هر محصول را به شماره شاخص‌های بخش اول ارجاع بده.');
  }
  lines.push('در بخش «روتین تخصصی»، دلیل انتخاب هر محصول را بر اساس ' +
    (input.type === 'iris' ? 'ساعت و نشانه دیده‌شده در عنبیه' : 'نشانه‌های تحلیل ' + source) + ' بنویس.');
  if (input.profile && Object.keys(input.profile).length) {
    lines.push('\nپروفایل کاربر:\n' + Object.entries(input.profile).map(([k, v]) => `- ${k}: ${v}`).join('\n'));
  }
  if (input.metrics && Object.keys(input.metrics).length) {
    lines.push('\nداده‌های تحلیل تقریبی (از عکس سمت گوشی؛ ' + (hasImage ? 'نسخه فشرده برای ویژن پیوست شده' : 'بدون تصویر') + '):\n' + JSON.stringify(input.metrics));
    if (input.metrics.clock) lines.push('\nنقشه ساعتی عنبیه (برای دلیل محصولات از همین استفاده کن):\n' + String(input.metrics.clock));
  }
  if (input.answers && Object.keys(input.answers).length) {
    lines.push('\nپاسخ‌های پرسش‌نامه:\n' + Object.entries(input.answers).map(([k, v]) => `- ${k}: ${v}`).join('\n'));
    if (input.answers['بودجه و ترجیح روتین']) lines.push('\nترجیح پکیج کاربر: ' + input.answers['بودجه و ترجیح روتین']);
  }
  lines.push('\nکاتالوگ رسمی آریا (فقط از این لیست انتخاب کن):');
  for (const p of CATALOG) {
    const bits = [
      `[${p.id}] ${p.name}`,
      p.category,
      priceLine(p),
      'تگ: ' + (p.tags || []).join(', '),
      'پوست: ' + ((p.skin_types || []).join(', ') || '-'),
    ];
    if (p.highlights && p.highlights.length) bits.push('ویژگی: ' + p.highlights.slice(0, 4).join('؛ '));
    if (p.warnings) bits.push('هشدار: ' + p.warnings.replace(/\n/g, ' ').slice(0, 160));
    lines.push('- ' + bits.join(' | '));
  }
  lines.push('\nحالا بر اساس داده‌ها و این کاتالوگ، گزارش کامل را دقیقاً با ساختار خواسته‌شده بده. برای هر محصول فقط از نام دقیق کاتالوگ استفاده کن.');
  return lines.join('\n');
}

/* ---------------- AI providers ---------------- */
function aiKey(env) {
  return env.AI_API_KEY || env.DEEPSEEK_API_KEY || env.GEMINI_API_KEY || '';
}
function aiConfig(env) {
  const provider = String(env.AI_PROVIDER || 'deepseek').toLowerCase();
  const key = aiKey(env);
  const base = String(env.AI_BASE_URL || (provider === 'gemini'
    ? 'https://generativelanguage.googleapis.com/v1beta'
    : 'https://api.deepseek.com')).replace(/\/+$/, '');
  const model = String(env.AI_MODEL || (provider === 'gemini' ? 'gemini-2.5-flash' : 'deepseek-flash'));
  return { provider, key, base, model };
}

async function callAI(env, system, user, imageUrl) {
  const cfg = aiConfig(env);
  if (!cfg.key) throw new Error('ai_key_missing');
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let url, headers, body;
      if (cfg.provider === 'gemini') {
        const model = cfg.model.replace(/^models\//, '');
        const parts = [{ text: user }];
        if (imageUrl) {
          const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(imageUrl);
          if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
        }
        url = `${cfg.base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.key)}`;
        headers = { 'Content-Type': 'application/json' };
        body = JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0.35,
            maxOutputTokens: 10000,
            // flash-lite پیش‌فرض minimal است؛ صریح می‌نویسیم تا هزینه/تأخیر پایین بماند
            // (سهمیهٔ این مدل با اپ نیوشانک مشترک است)
            thinkingConfig: { thinkingLevel: 'minimal' },
          },
        });
      } else {
        const userContent = imageUrl
          ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: imageUrl } }]
          : user;
        url = `${cfg.base}/chat/completions`;
        headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key };
        body = JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: userContent }],
          temperature: 0.35,
          max_tokens: 10000,
          stream: false,
        });
      }
      const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(120000) });
      const raw = await r.text();
      if (!r.ok) {
        lastErr = new Error('AI HTTP ' + r.status + ' ' + raw.slice(0, 300));
        // ۴۲۹ = سهمیهٔ مدل تمام شده. کلید جمینای این اپ با نیوشانک مشترک است،
        // پس تلاش دوباره فقط سهمیهٔ آن اپ را می‌سوزاند → بلافاصله گزارش محلی.
        if (r.status === 429) { lastErr.quota = true; throw lastErr; }
        if (r.status >= 500) { await sleep(1200 * (attempt + 1)); continue; }
        throw lastErr;
      }
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('AI bad json'); }
      if (data && data.error) throw new Error('AI error: ' + (data.error.message || JSON.stringify(data.error)).slice(0, 300));
      let text = '';
      if (cfg.provider === 'gemini') {
        text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [])
          .filter((p) => p && p.text && !p.thought) // بخش‌های reasoning نباید داخل گزارش بیایند
          .map((p) => p.text).join('').trim();
      } else {
        text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
      }
      if (!text) throw new Error('AI empty response');
      return text;
    } catch (e) {
      lastErr = e;
      if (e && e.quota) throw e;
      if (attempt === 0) await sleep(900);
    }
  }
  throw lastErr || new Error('AI failed');
}

/* ---------------- local fallback ---------------- */
function clamp(n, lo = 0, hi = 100) { n = Number(n); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0; }
function pickProducts(ids) {
  return [...new Set(ids)].map((id) => byId.get(String(id))).filter(Boolean);
}
function productLine(p) { return `${p.name} — ${priceLine(p)}`; }

function faNum(n) { return String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]); }
function usageFor(p) {
  const t = (p.tags || []).join(' ');
  if (/exfoliant/.test(t)) return 'هفته‌ای ۱ تا ۲ بار، بعد از شستشو و قبل از آبرسان';
  if (/cleanser/.test(t)) return 'صبح و شب، روی پوست مرطوب، ماساژ ملایم و آبکشی';
  if (/eyelash|eyebrow/.test(t)) return 'شب، با برس روی مژه یا ابرو، بدون تماس با چشم';
  if (/oil/.test(t)) return 'شب، چند قطره روی پوست یا مو با ماساژ ملایم';
  if (/hair/.test(t)) return 'شب، روی کف سر یا مو، ماساژ ملایم';
  if (/toner/.test(t)) return 'بعد از شستشو، با پد پنبه‌ای یا دست روی پوست';
  if (/hydration|anti-aging|brightening|acne|anti-pigmentation|vitamin-c/.test(t)) return 'بعد از شستشو، صبح و/یا شب، ۲ تا ۳ قطره';
  return 'طبق دستور روی بسته، صبح و شب';
}
function reasonFor(p, type, m) {
  const hl = (p.highlights || []).find((x) => x && x.length > 8 && !x.endsWith(':'));
  const base = hl || (p.tags || []).slice(0, 3).join('، ') || 'مناسب روتین شما';
  if (type === 'iris') {
    const clock = String(m.clock || '').split('\n')[0].replace(/^—\s*/, '').slice(0, 90);
    return (clock ? 'بر اساس نقشه عنبیه: ' + clock + '؛ ' : 'بر اساس نشانه‌های عنبیه؛ ') + base;
  }
  return base;
}
function indicatorRefs(p) {
  const t = (p.tags || []).join(' ');
  if (/cleanser|exfoliant/.test(t)) return 'شاخص ۲ و ۶';
  if (/hydration/.test(t)) return 'شاخص ۹';
  if (/brightening|anti-pigmentation/.test(t)) return 'شاخص ۳';
  if (/acne|oil-control/.test(t)) return 'شاخص ۶';
  if (/anti-aging/.test(t)) return 'شاخص ۸';
  if (/hair|eyelash|eyebrow/.test(t)) return 'شاخص ۵ و ۷';
  return 'شاخص ۱';
}

function localFallback(input) {
  const m = input.metrics || {};
  const a = input.answers || {};
  const profile = input.profile || {};
  const type = input.type || 'survey';
  const pref = String(a['بودجه و ترجیح روتین'] || '');
  let maxProducts = 4;
  if (/پایه|اقتصادی/.test(pref)) maxProducts = 3;
  if (/جامع|۳۶۰|360/.test(pref)) maxProducts = 5;

  const oil = clamp(m.oiliness);
  const hyd = clamp(m.hydration);
  const sens = clamp(Math.max(m.redness || 0, a['حساسیت و قرمزی'] === 'بله' ? 70 : 0));
  const spots = clamp(Math.max(m.spots || 0, m.pigmentation || 0));
  const texture = clamp(m.texture);
  const acne = clamp(Math.max(m.acne || 0, m.redness || 0));
  const wrinkles = clamp(m.wrinkles);
  const isHair = type === 'hair' ||
    (type === 'survey' && (a['دغدغه اصلی'] === 'تقویت مو' || a['ریزش مو'] === 'بله' || a['شوره یا خارش کف سر'] === 'بله'));

  let skinType = 'متعادل';
  if (oil >= 60 && hyd < 55) skinType = 'چرب';
  else if (oil < 35 && hyd < 45) skinType = 'خشک';
  else if (oil >= 50 && hyd < 50) skinType = 'مختلط';
  if (sens >= 60) skinType += ' و حساس';

  const concerns = [];
  if (type === 'iris') {
    const ring = clamp(m.ringIndicator);
    const dark = Number(m.darkSpots || 0);
    const light = Number(m.lightSpots || 0);
    const fib = clamp(m.radialFibrils);
    const edge = clamp(m.edgeDensity);
    if (ring >= 35) concerns.push('نشانه احتمالی حلقه کلسترول/چربی خون در عنبیه');
    if (dark >= 8) concerns.push('تجمع رنگدانه و لکه‌های تیره در عنبیه');
    if (light >= 8) concerns.push('نشانه ضعف یا فرسودگی بافتی در عنبیه');
    if (fib >= 45) concerns.push('الیاف شعاعی و نشانه التهاب/تنش');
    if (edge >= 55) concerns.push('چگالی لبه و بافت نامنظم عنبیه');
    if (!concerns.length) concerns.push('نشانه ساختاری شدیدی دیده نشد؛ تمرکز بر پیشگیری و آبرسانی');
  } else {
    if (acne >= 40) concerns.push('جوش و التهاب');
    if (spots >= 40) concerns.push('لک و تیرگی');
    if (wrinkles >= 40 || texture >= 55) concerns.push('خطوط ریز و کاهش استحکام');
    if (hyd < 40) concerns.push('کم‌آبی و خشکی');
    if (oil >= 55) concerns.push('چربی و منافذ باز');
    if (!concerns.length) concerns.push('نیاز اصلی فعلی، حفظ تعادل و پیشگیری است.');
  }

  let ids = ['266'];
  if (type === 'iris') {
    const ring = clamp(m.ringIndicator);
    const dark = Number(m.darkSpots || 0);
    const light = Number(m.lightSpots || 0);
    const fib = clamp(m.radialFibrils);
    if (ring >= 35) ids.push('10', '11', '49');
    if (dark >= 8) ids.push('11', '49', '13');
    if (light >= 8) ids.push('10', '88', '1');
    if (fib >= 45) ids.push('8', '51');
    if (ids.length === 1) ids.push('88', '49');
  } else if (isHair) {
    ids = ['7', '31', '87'];
    if (/مژه|ابرو/.test(JSON.stringify(a))) ids.push('30');
  } else {
    if (oil >= 55) ids.push('9');
    if (sens >= 55) ids.push('51');
    if (acne >= 40) ids.push('8');
    if (spots >= 35) ids.push('11', '49');
    if (wrinkles >= 35) ids.push('10');
    if (hyd < 45) ids.push('88');
    if (sens >= 50) ids.push('1');
    if (a['دغدغه اصلی'] === 'روشن‌سازی' || a['دغدغه اصلی'] === 'روشن سازی') ids.push('13');
    if (!ids.some((id) => ['10', '11', '13', '49'].includes(id))) ids.push('49');
  }
  const products = pickProducts(ids).slice(0, maxProducts);

  const lines = [];
  const name = profile['نام'] ? 'تحلیل اختصاصی ' + profile['نام'] : 'تحلیل اختصاصی';
  lines.push('# ' + name);
  lines.push('\n## مشخصات اولیه اسکن بالینی');
  if (type === 'iris') {
    lines.push('- موقعیت چشم: ' + (m.eye === 'left' ? 'چپ' : 'راست') + ' — بر اساس انتخاب کاربر و نشانه‌های تصویر (احتمالی).');
  } else {
    lines.push('- موقعیت چشم: داده عنبیه در دسترس نیست؛ این تحلیل بر پایه ' + (type === 'hair' ? 'مو' : 'پوست') + ' است.');
  }
  lines.push('- تیپ کلی ساختار پوست و مو: ' + (type === 'hair'
    ? 'وضعیت مو و کف سر با تراکم/چربی/شوره نیازمند مراقبت تقویتی است.'
    : 'پوست شما بیشتر به «' + skinType + '» نزدیک است؛ ' + (oil >= 55 ? 'چربی سطحی' : 'چربی نسبی') + ' و ' + (hyd < 45 ? 'کم‌آبی' : 'رطوبت نسبی') + ' دیده می‌شود.'));

  const clockText = String(m.clock || '');
  const hasClock = (h) => new RegExp('(^|[^۰-۹0-9])' + h + '([^۰-۹0-9]|$)').test(clockText);
  const ind = [];
  ind.push('۱. تیپ کلی ساختار پوست و مو: ' + (type === 'hair' ? 'ساختار مو و کف سر' : 'پوست ' + skinType) + ' با ' + (oil >= 55 ? 'چربی سطحی' : 'چربی نسبی') + ' و ' + (hyd < 45 ? 'کم‌آبی' : 'رطوبت نسبی') + '؛ این برداشت تقریبی است.');
  ind.push('۲. حلقه پوستی و تنفس سطحی پوست (حاشیه بیرونی عنبیه - ساعت ۱ تا ۱۲): ' + (clamp(m.edgeDensity) >= 45 || clamp(m.ringIndicator) >= 35 ? 'نشانه احتمالی گرفتگی و تنفس سطحی پوست؛ منافذ و بافت نیاز به پاکسازی ملایم دارند.' : 'الگوی لبه‌ها بدون نشانه شدید؛ تمرکز بر پیشگیری و پاکسازی ملایم.'));
  ind.push('۳. کبد و لک‌های پوستی (ساعت ۴ در چشم راست): ' + (spots >= 40 || hasClock(4) ? 'نشانه احتمالی درگیری کبد/تجمع رنگدانه و لک؛ نیاز به مراقبت روشن‌کننده و اصلاح رژیم.' : 'نشانه خاصی از لک یا درگیری کبد در داده‌ها دیده نشد.'));
  ind.push('۴. سیستم گوارش، معده و جذب املاح (حلقه اول و دوم اطراف مردمک): ' + (hyd < 45 || acne >= 40 ? 'نشانه احتمالی هضم سنگین/کم‌آبی و نیاز به بهبود جذب و رطوبت.' : 'گوارش و جذب بدون نشانه شدید در داده‌های فعلی.'));
  ind.push('۵. گردش خون مویرگی، اکسیژن‌رسانی و تغذیه فولیکول مو (ساعت ۱۱ تا ۱ + صلبیه): ' + (sens >= 50 || clamp(m.sclera) > 0 ? 'نشانه احتمالی رگه‌های خونی/تنش و نیاز به بهبود گردش خون مویرگی.' : 'گردش خون و تغذیه فولیکول بدون نشانه شدید.'));
  ind.push('۶. تعادل چربی، منافذ باز و سیستم لنفاوی (حلقه ششم عنبیه): ' + (oil >= 55 || clamp(m.pores) >= 50 ? 'چربی و منافذ باز؛ نیاز به کنترل سبوم و پاکسازی ملایم.' : 'تعادل چربی و منافذ در محدوده نسبی.'));
  ind.push('۷. تعادل هورمونی و غدد درون‌ریز (ساعت ۲ و ۱۰، ۱۱ و ۱، ۵ و ۷): داده هورمونی مستقیم نداریم؛ بر اساس نشانه‌های پوست/مو و پاسخ‌ها، اختلال شدید دیده نمی‌شود و بررسی تخصصی لازم است.');
  ind.push('۸. استرس اکسیداتیو، حلقه‌های عصبی و پیری زودرس: ' + (wrinkles >= 40 || texture >= 55 ? 'خطوط ریز/تنش و نشانه احتمالی استرس اکسیداتیو؛ خواب و مدیریت استرس مهم است.' : 'نشانه شدید پیری زودرس در داده‌ها دیده نشد.'));
  ind.push('۹. رطوبت، کلاژن‌سازی و بافت الاستیسیته پوست: ' + (hyd < 45 || clamp(m.evenness) < 50 ? 'کم‌آبی و کاهش نسبی یکنواختی؛ آبرسانی و مرطوب‌کننده ملایم توصیه می‌شود.' : 'رطوبت و یکنواختی نسبی؛ ادامه مراقبت پیشگیرانه.'));
  ind.push('۱۰. کلیه‌ها، مجاری ادراری و تیرگی دور چشم (ساعت ۵ در چشم راست): ' + (clamp(m.darkCircles) >= 30 || hasClock(5) ? 'تیرگی/پف خفیف دور چشم و نشانه احتمالی نیاز به آب‌رسانی و استراحت.' : 'تیرگی دور چشم در داده‌ها برجسته نیست.'));
  ind.push('۱۱. التهاب و حرارت پنهان و حساسیت‌های پوستی: ' + (sens >= 55 || clamp(m.redness) >= 45 ? 'قرمزی/حساسیت نسبی و نشانه احتمالی التهاب پنهان؛ محصولات ملایم و تست پچ.' : 'التهاب واضحی در داده‌ها دیده نشد.'));
  ind.push('۱۲. خلاصه بالینی وضعیت پوست و مو: ' + (concerns.length ? concerns.join('؛ ') + '؛ این تحلیل احتمالی است و جای معاینه پزشک را نمی‌گیرد.' : 'وضعیت نسبتاً متعادل؛ تمرکز بر پیشگیری، آبرسانی و مراقبت ملایم.'));
  lines.push('\n## بخش اول: بررسی تخصصی ۱۲ شاخص ساختاری پوست و مو');
  if (type !== 'iris') lines.push('توجه: داده عنبیه در دسترس نیست؛ عناوین ساعت/حلقه به‌صورت تمثیلی و بر پایه نشانه‌های پوست/مو تفسیر شده‌اند.');
  lines.push(ind.join('\n'));

  lines.push('\n## بخش دوم: بررسی تیپ شخصیتی، رفتاری و ریشه‌یابی روان‌تنی (سایکوسوماتیک)');
  lines.push('### ویژگی‌های رفتاری و اخلاقی');
  lines.push('- برداشت احتمالی: تمرکز و ارادهٔ نسبی بالا؛ در تصمیم‌ها جدی و پیگیر.');
  lines.push('- حساسیت به جزئیات و تمایل به کنترل محیط؛ نیاز به کاهش فشار ذهنی.');
  lines.push('- سبک تعامل محتاطانه و حریم خصوصی قوی؛ اعتماد تدریجی.');
  lines.push('- در مواجهه با چالش، تمایل به حل درونی و پرهیز از نشان دادن ضعف.');
  lines.push('### ریشه‌یابی روان‌تنی عمیق و احساسی');
  lines.push('این بخش برداشت احتمالی از نشانه‌های ظاهری است، نه تشخیص روان‌شناختی. تنش و کنترل زیاد می‌تواند با خواب، خستگی و رطوبت پوست ارتباط داشته باشد؛ آرام‌سازی ذهن و استراحت منظم می‌تواند به پوست و مو کمک کند.');

  lines.push('\n## بخش سوم: پکیج درمانی و روتین تخصصی مراقبت پوست، مو و زیبایی (اختصاصی محصولات شرکت آریا پژوهش یکتا)');
  lines.push('### روتین تخصصی مراقبت پوست، مو و بهداشت (محصولات آریا پژوهش یکتا)');
  lines.push('محصولات زیر از کاتالوگ آریا انتخاب شده‌اند و بر اساس نشانه‌های همین تحلیل پیشنهاد می‌شوند:');
  products.forEach((p, i) => {
    lines.push(`${faNum(i + 1)}. ${p.name} - ${usageFor(p)} - ${reasonFor(p, type, m)} (${indicatorRefs(p)})`);
  });
  lines.push('\n### تکنیک ماساژ و جذب (مکمل روتین)');
  lines.push(type === 'hair'
    ? 'هنگام استفاده از تونیک یا محلول مو، کف سر را با نوک انگشتان ۳ تا ۵ دقیقه ماساژ دهید؛ از ناخن و فشار زیاد پرهیز کنید. ماساژ ملایم گردش خون مویرگی را بهتر می‌کند.'
    : 'سرم یا آبرسان را با نوک انگشتان و به‌صورت رو به بالا و ملایم ۱ تا ۲ دقیقه ماساژ دهید؛ از کشیدن شدید و تماس با دور چشم پرهیز کنید. ماساژ ملایم جذب و گردش خون مویرگی را بهتر می‌کند.');
  lines.push('\n### نسخه خانگی مکمل (کمک به اصلاح مزاج از درون و بیرون)');
  lines.push(type === 'hair'
    ? 'ماسک ساده خانگی: یک قاشق روغن زیتون + یک قاشق عسل را مخلوط کنید، ۲۰ دقیقه روی مو بگذارید و بعد بشویید. قبل از مصرف تست حساسیت بدهید.'
    : 'نوشیدنی ساده خانگی: یک لیوان آب ولرم + چند قطره لیمو (یا یک قاشق عسل)؛ یا ماسک ساده یک قاشق ماست + نصف قاشق عسل برای ۱۰ دقیقه. تست حساسیت فراموش نشود.');
  lines.push('\n### سبک زندگی و تغذیه زیبایی (بایدها و نبایدها بر اساس مزاج فرد)');
  lines.push('- بخورید: سبزیجات تازه، میوه‌های فصل، پروتئین کافی، مغزها و آب کافی.');
  lines.push('- نخورید: قندهای ساده، نوشیدنی‌های شیرین، غذاهای سرخ‌کردنی و بسیار فرآوری‌شده.');
  lines.push('- راهکار طلایی سبک زندگی: خواب منظم ۷ تا ۸ ساعت، مدیریت استرس و ضدآفتاب روزانه (حتی در روزهای ابری).');
  lines.push('\n### ⚠️ هشدارهای ایمنی و ملاحظات مصرف');
  lines.push('- قبل از مصرف محصولات موضعی، روی بازو یا پشت گوش تست حساسیت بدهید و ۲۴ ساعت صبر کنید.');
  lines.push('- در بارداری/شیردهی یا مصرف دارو، ترکیبات را با پزشک هماهنگ کنید.');
  lines.push('- محصولات لایه‌بردار را به دور چشم نزنید و از اسکراب شدید پرهیز کنید.');
  lines.push('- در صورت سوزش، قرمزی پایدار یا بدتر شدن جوش/ضایعه، مصرف را قطع و به پزشک مراجعه کنید.');
  lines.push('\n### توجه');
  lines.push('جهت تهیه پکیج اصلی محصولات آریا پژوهش یکتا و تنظیم دقیق‌ترین نحوه مصرف، حتماً از مشاور خود راهنمایی بخواهید.');
  return lines.join('\n');
}

/* ---------------- job processing ---------------- */
async function processJob(env, jobId) {
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
  if (!job || job.status === 'completed') return;
  await env.DB.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?')
    .bind('processing', nowIso(), jobId).run();

  let input;
  try { input = JSON.parse(job.input_json); }
  catch (e) { input = { type: job.type, answers: {}, metrics: {}, profile: {} }; }

  let imageUrl = '';
  try { if (env.CACHE) imageUrl = (await env.CACHE.get('jobimg:' + jobId)) || ''; } catch (e) {}
  input.has_image = !!imageUrl;

  let text = '';
  let engine = 'local-fallback';
  const key = aiKey(env);
  if (key) {
    try {
      // عنبیه پرامپت اختصاصی خودش را دارد؛ پوست/مو/پرسش‌نامه از SYSTEM_PROMPT استفاده می‌کنند
      const sysPrompt = input.type === 'iris' ? IRIS_SYSTEM_PROMPT : SYSTEM_PROMPT;
      text = await callAI(env, sysPrompt, userPrompt(input, !!imageUrl), imageUrl);
      engine = aiConfig(env).provider + ':' + aiConfig(env).model;
      if (!isPersianEnough(text)) {
        text = await callAI(env, sysPrompt + '\n\n⚠️ پاسخ قبلی فارسی نبود. این بار فقط فارسی بنویس.', userPrompt(input, !!imageUrl), imageUrl);
      }
    } catch (e) {
      text = '';
    }
  }
  try { if (imageUrl && env.CACHE) await env.CACHE.delete('jobimg:' + jobId); } catch (e) {}
  if (!text || !isPersianEnough(text)) {
    text = localFallback(input);
    engine = 'local-fallback';
  }
  text = ensurePrices(fixPrices(text)).slice(0, 24000);
  try {
    await env.DB.prepare(
      'UPDATE jobs SET status = ?, result = ?, error = NULL, engine = ?, updated_at = ? WHERE id = ?'
    ).bind('completed', text, engine, nowIso(), jobId).run();
  } catch (e) {
    try {
      await env.DB.prepare('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .bind('failed', 'db_update_failed', nowIso(), jobId).run();
    } catch (e2) {}
  }
}

/* ---------------- handlers ---------------- */
async function handleRegister(req, env, cors) {
  if (!(await rateLimit(env, req, 'register', 20))) return json({ ok: false, error: 'تلاش بیش از حد؛ بعداً دوباره امتحان کنید.' }, 429, cors);
  const body = await readJson(req);
  if (!body) return json({ ok: false, error: 'بدنه درخواست نامعتبر است.' }, 400, cors);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  if (!validEmail(email)) return json({ ok: false, error: 'ایمیل معتبر نیست.' }, 400, cors);
  if (password.length < 6 || password.length > 200) return json({ ok: false, error: 'رمز عبور باید حداقل ۶ کاراکتر باشد.' }, 400, cors);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return json({ ok: false, error: 'این ایمیل قبلاً ثبت شده است.' }, 409, cors);

  const first = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  const isFirst = Number(first && first.n || 0) === 0;
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const status = isFirst ? 'approved' : 'pending';
  const role = isFirst ? 'admin' : 'user';
  const created = nowIso();
  await env.DB.prepare(
    'INSERT INTO users (email, pass_hash, salt, status, role, created_at, approved_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(email, hash, salt, status, role, created, isFirst ? created : null).run();
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  await logEvent(env, user.id, 'register', { role, first: isFirst });
  return json({
    ok: true,
    approved: isFirst,
    role,
    message: isFirst
      ? 'حساب شما به‌عنوان مدیر ساخته و تأیید شد. حالا وارد شوید.'
      : 'ثبت‌نام انجام شد؛ پس از تأیید مدیر می‌توانید وارد شوید.',
  }, 201, cors);
}

async function handleLogin(req, env, cors) {
  if (!(await rateLimit(env, req, 'login', 60))) return json({ ok: false, error: 'تلاش بیش از حد؛ بعداً دوباره امتحان کنید.' }, 429, cors);
  const body = await readJson(req);
  if (!body) return json({ ok: false, error: 'بدنه درخواست نامعتبر است.' }, 400, cors);
  const email = normalizeEmail(body.email);
  const password = String(body.password || '');
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user) return json({ ok: false, error: 'ایمیل یا رمز عبور اشتباه است.' }, 401, cors);
  const hash = await hashPassword(password, user.salt);
  if (hash !== user.pass_hash) return json({ ok: false, error: 'ایمیل یا رمز عبور اشتباه است.' }, 401, cors);
  if (user.status === 'pending') return json({ ok: false, error: 'حساب شما در انتظار تأیید مدیر است.' }, 403, cors);
  if (user.status !== 'approved') return json({ ok: false, error: 'حساب شما غیرفعال است.' }, 403, cors);

  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowIso()).run();
  const token = randomHex(32);
  const token_hash = await sha256Hex(token);
  const expires = new Date(Date.now() + TOKEN_TTL_DAYS * 86400000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)')
    .bind(token_hash, user.id, expires, nowIso()).run();
  const quota = await quotaInfo(env, user);
  await logEvent(env, user.id, 'login', {});
  return json({ ok: true, token, user: publicUser(user), ...quota }, 200, cors);
}

async function handleMe(req, env, cors) {
  const body = await readJson(req).catch(() => null);
  const token = tokenFrom(req, body);
  const user = await authUser(env, token);
  if (!user) return json({ ok: false, error: 'نشست منقضی شده؛ دوباره وارد شوید.' }, 401, cors);
  if (user.blocked) return json({ ok: false, error: 'حساب شما تأیید نشده یا غیرفعال است.' }, 403, cors);
  const quota = await quotaInfo(env, user);
  const history = await env.DB.prepare(
    'SELECT id, type, status, engine, created_at, substr(result, 1, 260) AS preview FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
  ).bind(user.id).all();
  await logEvent(env, user.id, 'me', {});
  return json({ ok: true, user: publicUser(user), ...quota, history: history.results || [] }, 200, cors);
}

async function handleLogout(req, env, cors) {
  const body = await readJson(req).catch(() => null);
  const token = tokenFrom(req, body);
  if (token) {
    try { await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run(); } catch (e) {}
  }
  return json({ ok: true }, 200, cors);
}

async function handleProducts(env, cors) {
  return json({ ok: true, meta: CATALOG_META, products: CATALOG }, 200, cors);
}

async function handleAnalyze(req, env, ctx, cors) {
  const body = await readJson(req);
  if (!body) return json({ ok: false, error: 'بدنه درخواست نامعتبر است.' }, 400, cors);
  const token = tokenFrom(req, body);
  const user = await authUser(env, token);
  if (!user) return json({ ok: false, error: 'نشست منقضی شده؛ دوباره وارد شوید.' }, 401, cors);
  if (user.blocked) return json({ ok: false, error: 'حساب شما تأیید نشده یا غیرفعال است.' }, 403, cors);
  if (!(await rateLimit(env, req, 'analyze', 60))) return json({ ok: false, error: 'تلاش بیش از حد؛ بعداً دوباره امتحان کنید.' }, 429, cors);

  const type = ['skin', 'iris', 'hair', 'survey'].includes(body.type) ? body.type : 'survey';
  const image = typeof body.image === 'string' && /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(body.image) ? body.image : '';
  if (body.image && !image) return json({ ok: false, error: 'فرمت تصویر نامعتبر است.' }, 400, cors);
  if (image.length > 2500000) return json({ ok: false, error: 'حجم تصویر بیش از حد است.' }, 413, cors);
  const input = {
    type,
    has_image: !!image,
    metrics: body.metrics && typeof body.metrics === 'object' ? body.metrics : {},
    answers: body.answers && typeof body.answers === 'object' ? body.answers : {},
    profile: body.profile && typeof body.profile === 'object' ? body.profile : {},
  };
  const inputJson = JSON.stringify(input);
  if (inputJson.length > 30000) return json({ ok: false, error: 'حجم داده ورودی بیش از حد است.' }, 413, cors);

  const quota = await quotaInfo(env, user);
  if (quota.remaining <= 0) {
    return json({ ok: false, error: 'سهمیهٔ روزانهٔ شما تمام شده است. فردا دوباره تلاش کنید.', ...quota }, 429, cors);
  }

  const id = crypto.randomUUID();
  const ts = nowIso();
  await env.DB.prepare(
    'INSERT INTO jobs (id, user_id, type, status, day, input_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(id, user.id, type, 'pending', quota.day, inputJson, ts, ts).run();
  await logEvent(env, user.id, 'analyze_start', { type, jobId: id });
  if (image && env.CACHE) {
    try { await env.CACHE.put('jobimg:' + id, image, { expirationTtl: 3600 }); }
    catch (e) { console.error('job image kv put failed', e && e.message); }
  }

  if (env.AI_QUEUE && typeof env.AI_QUEUE.send === 'function') {
    try { await env.AI_QUEUE.send({ jobId: id }); }
    catch (e) { ctx.waitUntil(processJob(env, id)); }
  } else {
    ctx.waitUntil(processJob(env, id));
  }
  return json({ ok: true, jobId: id, type, ...quota, remaining: Math.max(0, quota.remaining - 1) }, 202, cors);
}

async function handleStatus(jobId, env, cors) {
  if (!jobId || !/^[a-f0-9-]{20,}$/i.test(jobId)) return json({ ok: false, error: 'شناسه نامعتبر است.' }, 400, cors);
  const job = await env.DB.prepare(
    'SELECT id, status, result, error, engine, type, created_at, updated_at FROM jobs WHERE id = ?'
  ).bind(jobId).first();
  if (!job) return json({ ok: false, error: 'تحلیل یافت نشد.' }, 404, cors);
  return json({ ok: true, ...job }, 200, cors);
}

async function handleFeedback(req, env, cors) {
  const body = await readJson(req);
  if (!body) return json({ ok: false, error: 'بدنه نامعتبر است.' }, 400, cors);
  const user = await authUser(env, tokenFrom(req, body));
  if (!user) return json({ ok: false, error: 'نشست منقضی شده.' }, 401, cors);
  const rating = Math.max(1, Math.min(5, Number(body.rating) || 0));
  const note = String(body.note || '').slice(0, 1000);
  await env.DB.prepare('INSERT INTO feedback (user_id, job_id, rating, note, created_at) VALUES (?,?,?,?,?)')
    .bind(user.id, String(body.jobId || '').slice(0, 80), rating, note, nowIso()).run();
  return json({ ok: true }, 201, cors);
}

async function isAdmin(req, env, body) {
  const header = req.headers.get('x-admin-token') || '';
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (env.ADMIN_TOKEN && (header === env.ADMIN_TOKEN || bearer === env.ADMIN_TOKEN)) return true;
  const user = await authUser(env, tokenFrom(req, body));
  return !!(user && user.role === 'admin' && !user.blocked);
}

async function handleAdmin(req, env, ctx, cors, action) {
  const body = req.method === 'POST' ? await readJson(req) : null;
  if (!(await isAdmin(req, env, body))) return json({ ok: false, error: 'دسترسی مدیر لازم است.' }, 403, cors);

  if (action === 'users') {
    const rows = await env.DB.prepare(
      'SELECT id, email, status, role, daily_limit, created_at, approved_at FROM users ORDER BY id DESC LIMIT 500'
    ).all();
    return json({ ok: true, users: rows.results || [] }, 200, cors);
  }

  if (action === 'approve') {
    const email = normalizeEmail(body && body.email);
    const status = ['approved', 'pending', 'blocked'].includes(body && body.status) ? body.status : 'approved';
    if (!email) return json({ ok: false, error: 'ایمیل لازم است.' }, 400, cors);
    const r = await env.DB.prepare('UPDATE users SET status = ?, approved_at = ? WHERE email = ?')
      .bind(status, status === 'approved' ? nowIso() : null, email).run();
    if (!r.meta || r.meta.changes === 0) return json({ ok: false, error: 'کاربر یافت نشد.' }, 404, cors);
    await logEvent(env, null, 'admin_approve', { email, status });
    return json({ ok: true, email, status }, 200, cors);
  }

  if (action === 'limit') {
    const email = normalizeEmail(body && body.email);
    const limit = Math.max(1, Math.min(100, Number(body && body.limit) || 10));
    if (!email) return json({ ok: false, error: 'ایمیل لازم است.' }, 400, cors);
    const r = await env.DB.prepare('UPDATE users SET daily_limit = ? WHERE email = ?').bind(limit, email).run();
    if (!r.meta || r.meta.changes === 0) return json({ ok: false, error: 'کاربر یافت نشد.' }, 404, cors);
    return json({ ok: true, email, daily_limit: limit }, 200, cors);
  }

  if (action === 'stats') {
    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'completed'").first();
    const today = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE day = ? AND status != 'failed'").bind(todayTehran()).first();
    return json({ ok: true, users: Number(users && users.n || 0), completed: Number(jobs && jobs.n || 0), today: Number(today && today.n || 0) }, 200, cors);
  }

  if (action === 'overview') {
    const one = async (sql, ...binds) => {
      const r = await env.DB.prepare(sql).bind(...binds).first();
      return Number(r && r.n || 0);
    };
    const stats = {
      users: await one('SELECT COUNT(*) AS n FROM users'),
      pending: await one("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'"),
      approved: await one("SELECT COUNT(*) AS n FROM users WHERE status = 'approved'"),
      blocked: await one("SELECT COUNT(*) AS n FROM users WHERE status = 'blocked'"),
      jobs: await one('SELECT COUNT(*) AS n FROM jobs'),
      completed: await one("SELECT COUNT(*) AS n FROM jobs WHERE status = 'completed'"),
      failed: await one("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'"),
      today: await one("SELECT COUNT(*) AS n FROM jobs WHERE day = ? AND status != 'failed'", todayTehran()),
      feedback: await one('SELECT COUNT(*) AS n FROM feedback'),
    };
    let dailyLimit = Number(env.DAILY_LIMIT || 10);
    try {
      const s = await env.DB.prepare("SELECT value FROM settings WHERE key = 'daily_limit'").first();
      if (s && Number(s.value)) dailyLimit = Number(s.value);
    } catch (e) {}
    return json({
      ok: true,
      stats,
      daily_limit: dailyLimit,
      ai: { configured: !!aiKey(env), provider: aiConfig(env).provider, model: aiConfig(env).model },
      catalog: { count: CATALOG.length, scraped_at: CATALOG_META.scraped_at },
      queue: !!env.AI_QUEUE,
      version: VERSION,
    }, 200, cors);
  }

  if (action === 'jobs') {
    const url = new URL(req.url);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    const type = url.searchParams.get('type') || '';
    const status = url.searchParams.get('status') || '';
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const cond = [], binds = [];
    let sql = 'SELECT j.id, j.user_id, j.type, j.status, j.engine, j.created_at, j.updated_at, substr(j.result, 1, 260) AS preview, CASE WHEN j.input_json LIKE \'%"has_image":true%\' THEN 1 ELSE 0 END AS has_image, u.email FROM jobs j LEFT JOIN users u ON u.id = j.user_id';
    if (type) { cond.push('j.type = ?'); binds.push(type); }
    if (status) { cond.push('j.status = ?'); binds.push(status); }
    if (q) { cond.push('lower(u.email) LIKE ?'); binds.push('%' + q + '%'); }
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY j.created_at DESC LIMIT ?';
    binds.push(limit);
    const rows = await env.DB.prepare(sql).bind(...binds).all();
    return json({ ok: true, jobs: rows.results || [] }, 200, cors);
  }

  if (action === 'job') {
    const id = String(body && body.id || '').trim();
    const what = String(body && body.action || '').trim();
    if (!id) return json({ ok: false, error: 'شناسه لازم است.' }, 400, cors);
    if (what === 'retry') {
      const job = await env.DB.prepare('SELECT id FROM jobs WHERE id = ?').bind(id).first();
      if (!job) return json({ ok: false, error: 'تحلیل یافت نشد.' }, 404, cors);
      await env.DB.prepare('UPDATE jobs SET status = ?, result = NULL, error = NULL, engine = NULL, updated_at = ? WHERE id = ?')
        .bind('pending', nowIso(), id).run();
      if (env.AI_QUEUE && typeof env.AI_QUEUE.send === 'function') {
        try { await env.AI_QUEUE.send({ jobId: id }); } catch (e) { ctx.waitUntil(processJob(env, id)); }
      } else {
        ctx.waitUntil(processJob(env, id));
      }
      return json({ ok: true, id, action: 'retry' }, 200, cors);
    }
    if (what === 'delete') {
      await env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run();
      return json({ ok: true, id, action: 'delete' }, 200, cors);
    }
    return json({ ok: false, error: 'عملیات تحلیل ناشناخته.' }, 400, cors);
  }

  if (action === 'feedback') {
    const rows = await env.DB.prepare(
      'SELECT f.id, f.user_id, f.job_id, f.rating, f.note, f.created_at, u.email FROM feedback f LEFT JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT 200'
    ).all();
    return json({ ok: true, feedback: rows.results || [] }, 200, cors);
  }

  if (action === 'settings') {
    if (req.method === 'GET') {
      let dailyLimit = Number(env.DAILY_LIMIT || 10);
      try {
        const s = await env.DB.prepare("SELECT value FROM settings WHERE key = 'daily_limit'").first();
        if (s && Number(s.value)) dailyLimit = Number(s.value);
      } catch (e) {}
      return json({
        ok: true,
        daily_limit: dailyLimit,
        ai: { configured: !!aiKey(env), provider: aiConfig(env).provider, model: aiConfig(env).model },
        queue: !!env.AI_QUEUE,
        catalog_count: CATALOG.length,
        catalog_scraped_at: CATALOG_META.scraped_at,
        version: VERSION,
      }, 200, cors);
    }
    const limit = Math.max(1, Math.min(100, Number(body && body.daily_limit) || 10));
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('daily_limit', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).bind(String(limit), nowIso()).run();
    return json({ ok: true, daily_limit: limit }, 200, cors);
  }

  return json({ ok: false, error: 'عملیات ناشناخته.' }, 404, cors);
}

async function handleHealth(env, cors) {
  let dbOk = false, users = 0, jobs = 0;
  try {
    const a = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    const b = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first();
    dbOk = true; users = Number(a && a.n || 0); jobs = Number(b && b.n || 0);
  } catch (e) {}
  return json({
    ok: true,
    service: 'arya-api',
    version: VERSION,
    app: env.APP_NAME || 'مشاور زیبایی آریا',
    ai_configured: !!aiKey(env),
    ai_provider: aiConfig(env).provider,
    ai_model: aiConfig(env).model,
    queue: !!env.AI_QUEUE,
    catalog_count: CATALOG.length,
    catalog_scraped_at: CATALOG_META.scraped_at,
    daily_limit: Number(env.DAILY_LIMIT || 10),
    db_ok: dbOk,
    users,
    jobs,
    time: nowIso(),
  }, 200, cors);
}

/* ---------------- exports ---------------- */
export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    const cors = corsFor(req.headers.get('Origin'));
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if ((u.pathname === '/admin' || u.pathname === '/admin/') && req.method === 'GET') {
        return new Response(ADMIN_HTML, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'X-Frame-Options': 'DENY',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'X-Robots-Tag': 'noindex, nofollow',
            'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https://aryamlm.ir; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
          },
        });
      }
      if (u.pathname === '/' || u.pathname === '/health') return await handleHealth(env, cors);
      if (u.pathname === '/api/products' && req.method === 'GET') return await handleProducts(env, cors);
      if (u.pathname === '/api/register' && req.method === 'POST') return await handleRegister(req, env, cors);
      if (u.pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, env, cors);
      if (u.pathname === '/api/me' && (req.method === 'POST' || req.method === 'GET')) return await handleMe(req, env, cors);
      if (u.pathname === '/api/logout' && req.method === 'POST') return await handleLogout(req, env, cors);
      if (u.pathname === '/api/analyze' && req.method === 'POST') return await handleAnalyze(req, env, ctx, cors);
      if (u.pathname === '/api/feedback' && req.method === 'POST') return await handleFeedback(req, env, cors);
      if (u.pathname.startsWith('/status/') && req.method === 'GET') return await handleStatus(u.pathname.slice(8), env, cors);
      if (u.pathname === '/api/admin/users' && req.method === 'GET') return await handleAdmin(req, env, ctx, cors, 'users');
      if (u.pathname === '/api/admin/approve' && req.method === 'POST') return await handleAdmin(req, env, ctx, cors, 'approve');
      if (u.pathname === '/api/admin/limit' && req.method === 'POST') return await handleAdmin(req, env, ctx, cors, 'limit');
      if (u.pathname === '/api/admin/stats' && req.method === 'GET') return await handleAdmin(req, env, ctx, cors, 'stats');
      if (u.pathname === '/api/admin/overview' && req.method === 'GET') return await handleAdmin(req, env, ctx, cors, 'overview');
      if (u.pathname === '/api/admin/jobs' && req.method === 'GET') return await handleAdmin(req, env, ctx, cors, 'jobs');
      if (u.pathname === '/api/admin/job' && req.method === 'POST') return await handleAdmin(req, env, ctx, cors, 'job');
      if (u.pathname === '/api/admin/feedback' && req.method === 'GET') return await handleAdmin(req, env, ctx, cors, 'feedback');
      if (u.pathname === '/api/admin/settings' && (req.method === 'GET' || req.method === 'POST')) return await handleAdmin(req, env, ctx, cors, 'settings');
      return json({ ok: false, error: 'مسیر یافت نشد.' }, 404, cors);
    } catch (e) {
      console.error('arya-api error', e && e.stack || e);
      if (e && e.message === 'too_large') return json({ ok: false, error: 'حجم درخواست بیش از حد است.' }, 413, cors);
      return json({ ok: false, error: 'خطای داخلی سرور.' }, 500, cors);
    }
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        if (msg.body && msg.body.jobId) await processJob(env, msg.body.jobId);
        msg.ack();
      } catch (e) {
        try { msg.retry(); } catch (e2) { msg.ack(); }
      }
    }
  },
};
