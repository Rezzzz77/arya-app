# Arya Beauty Advisor — Handoff & Development Guide

> راهنمای کامل پروژه برای ادامهٔ توسعه توسط انسان یا هوش مصنوعی دیگر.
> آخرین به‌روزرسانی: 2026-10-23

---

## 1) این پروژه چیست؟

«مشاور زیبایی آریا» یک PWA فارسی (RTL) برای تحلیل پوست، مو و عنبیه و پیشنهاد روتین/پکیج از محصولات رسمی **آریا پژوهش یکتا** (`aryamlm.ir`) است.

- عکس در مرورگر فشرده می‌شود و همراه آمار پیکسلی برای تحلیل **ویژن** به مدل `deepseek-flash` می‌رود.
- خروجی استاندارد شامل: مشخصات اولیه، ۱۲ شاخص ساختاری، تیپ شخصیتی/روان‌تنی، و پکیج درمانی.
- فقط محصولات کاتالوگ آریا پیشنهاد می‌شوند؛ قیمت‌ها با کاتالوگ اصلاح/تکمیل می‌شوند.
- احراز هویت، سهمیه روزانه، تاریخچه، پنل مدیر و صفحهٔ ادمین مستقل دارد.

---

## 2) آدرس‌های زنده

| بخش | آدرس |
|---|---|
| اپ اصلی (PWA) | https://arya-app.pages.dev |
| API (Worker) | https://arya-api.arshadirad7475.workers.dev |
| پنل ادمین مستقل | https://arya-api.arshadirad7475.workers.dev/admin |
| ریپازیتوری | https://github.com/Rezzzz77/arya-app |

---

## 3) معماری

```
[مرورگر / PWA روی Cloudflare Pages]
        │  (فقط آمار پیکسلی + تصویر فشرده JPEG 800–900px)
        ▼
[Cloudflare Worker: arya-api]
   ├─ D1: users / sessions / jobs / feedback / events / settings
   ├─ KV: rate limit + تصویر موقت jobimg:{jobId} (TTL 1h)
   └─ Queue: arya-ai (پردازش async تحلیل)
        │
        ▼
[DeepSeek API: deepseek-flash — vision + text]
        │
        ▼
[نتیجه در D1] ← polling فرانت با GET /status/{jobId}
```

### جریان تحلیل
1. کاربر عکس را انتخاب می‌کند.
2. فرانت با Canvas تحلیل پیکسلی می‌کند (رنگ، لکه، چربی، بافت، نقشه ۱۲ ساعتی عنبیه).
3. عکس به JPEG فشرده (۸۰۰px برای پوست/مو، ۹۰۰px برای عنبیه) تبدیل می‌شود.
4. `POST /api/analyze` با `{type, metrics, image, answers, profile}`.
5. Worker یک job در D1 می‌سازد، تصویر را در KV می‌گذارد و به Queue می‌فرستد.
6. مصرف‌کنندهٔ Queue پرامپت را به `deepseek-flash` می‌فرستد.
7. پاسخ فارسی بررسی، قیمت‌ها با کاتالوگ اصلاح و جدول قیمت اضافه می‌شود.
8. فرانت هر ۳ ثانیه `/status/{jobId}` را می‌پرسد و نتیجه را نمایش می‌دهد.

---

## 4) نقشهٔ فایل‌ها

```
arya-app/
  public/
    index.html              کل اپ اصلی (تک‌فایلی، inline CSS/JS)
    sw.js                   Service Worker (cache v3)
    manifest.webmanifest
    icon-192.svg, icon-512.svg
    _headers                هدرهای امنیتی Cloudflare Pages + CSP
    robots.txt
    data/products.json      کاتالوگ کامپکت برای فرانت
  worker/
    wrangler.toml            bindings: D1 + KV + Queue + vars + Text rule
    schema.sql               D1 schema + seed settings
    src/
      index.js               API، auth، سهمیه، صف، AI، قیمت‌گذاری
      catalog.js             کاتالوگ تولیدشده برای پرامپت (scraper می‌سازد)
      admin.html             صفحهٔ ادمین مستقل (Text module)
  data/
    products.json            کاتالوگ کامل اسکرپ‌شده
    scrape-report.txt        گزارش اسکرپ
    knowledge/
      standard-analysis-template.md   قالب استاندارد تحلیل (بدون داده شخصی)
  scripts/
    scrape-arya.js           اسکرپ صفحه‌های عمومی aryamlm.ir
    deploy-worker.js         استیج به temp + deploy Worker
    deploy-pages.js          استیج به temp + deploy Pages
    set-secret.js            تنظیم Secret با Cloudflare API
    admin.js                 CLI مدیریت کاربران
  package.json
  .env.example
  README.md
  HANDOFF.md
```

> ⚠️ روی ویندوز اگر مسیر پروژه فاصله داشته باشد (`Default Project`)، `wrangler deploy` ممکن است hang کند. `deploy-worker.js` و `deploy-pages.js` فایل‌ها را به `%TEMP%` بدون فاصله کپی و از آنجا deploy می‌کنند.

---

## 5) اجرای محلی

```bash
cd arya-app
npm install
npm run scrape          # کاتالوگ را از aryamlm.ir می‌گیرد
npm run dev:worker      # wrangler dev (برای KV/D1/Queue لوکال)
```

فرانت را با یک static server ساده (مثلاً `npx serve public`) باز کنید. اگر روی `localhost` باشد، `CONFIG.API` به‌صورت پیش‌فرض `http://127.0.0.1:8788` است (قابل override با `localStorage.arya_api`).

---

## 6) منابع Cloudflare

| منبع | نام | شناسه |
|---|---|---|
| D1 | `arya-app-db` | `5a4cf38f-fb45-4bf1-af0b-8e045758a4ce` |
| KV | `arya-app-kv` | `bf10c19e7a32477390d7f853a351a053` |
| Queue | `arya-ai` | — |
| Worker | `arya-api` | — |
| Pages | `arya-app` | — |

اعمال schema:

```bash
wrangler d1 execute arya-app-db --remote --file=worker/schema.sql
```

---

## 7) Secretها و متغیرها

**هرگز `.env` یا `.env.local` را کامیت نکنید.**

| نام | محل | توضیح |
|---|---|---|
| `AI_API_KEY` | Worker Secret | کلید DeepSeek |
| `ADMIN_TOKEN` | Worker Secret | توکن بک‌دور CLI ادمین |
| `CF_API_TOKEN` / `CF_ACCOUNT_ID` | `.env` محلی | برای wrangler |
| `ARYA_API` | `.env.local` | آدرس API برای اسکریپت Pages |
| `PAGES_PROJECT` | `.env.local` | نام پروژه Pages (`arya-app`) |
| `AI_PROVIDER` | `wrangler.toml` vars | `deepseek` یا `gemini` |
| `AI_BASE_URL` | `wrangler.toml` vars | `https://api.deepseek.com` |
| `AI_MODEL` | `wrangler.toml` vars | `deepseek-flash` |
| `DAILY_LIMIT` | `wrangler.toml` vars | سهمیه پیش‌فرض (پیش‌فرض ۱۰) |

تنظیم Secret بدون چاپ مقدار:

```bash
node scripts/set-secret.js AI_API_KEY
node scripts/set-secret.js ADMIN_TOKEN
```

---

## 8) قرارداد API

همه پاسخ‌ها JSON هستند: `{ ok: true, ... }` یا `{ ok: false, error: '...' }`.

| Method | Path | توضیح |
|---|---|---|
| GET | `/health` | وضعیت سرویس/AI/کاتالوگ/تعداد کاربر |
| GET | `/api/products` | کاتالوگ |
| POST | `/api/register` | `{email,password}` — اولین کاربر admin می‌شود |
| POST | `/api/login` | `{email,password}` → `{token,user,limit,remaining,used}` |
| POST | `/api/me` | `{token}` → user + quota + history |
| POST | `/api/logout` | `{token}` |
| POST | `/api/analyze` | `{type,metrics,image?,answers,profile}` → `{jobId}` |
| GET | `/status/{jobId}` | وضعیت/نتیجه |
| POST | `/api/feedback` | `{rating,note,jobId}` |
| GET | `/api/admin/overview` | آمار کلی |
| GET | `/api/admin/users` | لیست کاربران |
| POST | `/api/admin/approve` | `{email,status}` |
| POST | `/api/admin/limit` | `{email,limit}` |
| GET | `/api/admin/jobs` | `?limit=&type=&status=&q=` |
| POST | `/api/admin/job` | `{id,action:'retry'|'delete'}` |
| GET | `/api/admin/feedback` | بازخوردها |
| GET/POST | `/api/admin/settings` | سهمیه سراسری / وضعیت |
| GET | `/admin` | صفحهٔ ادمین مستقل (HTML) |

`type` یکی از `skin` / `iris` / `hair` / `survey` است.
`image` باید data URL معتبر `data:image/(jpeg|jpg|png|webp);base64,...` باشد (حداکثر ~۲.۵MB).

نمونه:

```json
POST /api/analyze
{
  "type": "iris",
  "metrics": { "irisRatio": 30, "sclera": 18, "pupil": 6, "ringIndicator": 20,
               "radialFibrils": 30, "darkSpots": 5, "lightSpots": 4,
               "clock": "— تیره‌ترین نواحی ...", "eye": "right" },
  "image": "data:image/jpeg;base64,...",
  "answers": { "بودجه و ترجیح روتین": "روتین تخصصی و کامل" },
  "profile": { "نام": "کاربر", "سن": "35", "جنسیت": "زن" }
}
```

---

## 9) D1 Schema

- **users**: `id, email, pass_hash, salt, status(pending|approved|blocked), role(user|admin), daily_limit, created_at, approved_at`
- **sessions**: `token_hash, user_id, expires_at, created_at`
- **jobs**: `id, user_id, type, status(pending|processing|completed|failed), day, input_json, result, error, engine, created_at, updated_at`
- **feedback**: `id, user_id, job_id, rating, note, created_at`
- **events**: `id, user_id, kind, meta, created_at`
- **settings**: `key, value, updated_at` — کلید `daily_limit`

سهمیه: تعداد jobهای امروز (به وقت تهران) با `status != 'failed'`؛ سقف = `users.daily_limit` یا `settings.daily_limit` یا `DAILY_LIMIT`.

---

## 10) قرارداد پرامپت هوش مصنوعی

### قواعد
- فقط فارسی؛ فقط محصولات کاتالوگ； قیمت دقیق تومانی； بدون تشخیص قطعی پزشکی/روان‌شناختی.
- تحلیل طب سنتی با «احتمالی/نشانه/برداشت».
- تست پچ، بارداری/شیردهی، دور چشم، علائم شدید → ارجاع پزشک.
- اگر محصول در کاتالوگ نیست: «در کاتالوگ فعلی آریا موجود نیست».
- دلیل هر محصول به شماره شاخص‌های بخش اول ارجاع داده شود.

### ساختار خروجی
1. `## مشخصات اولیه اسکن بالینی` — موقعیت چشم + تیپ کلی پوست/مو
2. `## بخش اول: بررسی تخصصی ۱۲ شاخص ساختاری پوست و مو`
   1. تیپ کلی
   2. حلقه پوستی و تنفس سطحی (حاشیه بیرونی عنبیه، ۱ تا ۱۲)
   3. کبد و لک (ساعت ۴ چشم راست)
   4. گوارش/معده/جذب (حلقه اول و دوم اطراف مردمک)
   5. گردش خون مویرگی/فولیکول (۱۱ تا ۱ + صلبیه)
   6. چربی/منافذ/لنفاوی (حلقه ششم)
   7. هورمونی/غدد (۲، ۱۰، ۱۱، ۱، ۵، ۷)
   8. استرس اکسیداتیو/پیری زودرس
   9. رطوبت/کلاژن/الاستیسیته
   10. کلیه/ادراری/تیرگی دور چشم (ساعت ۵ چشم راست)
   11. التهاب/حرارت پنهان/حساسیت
   12. خلاصه بالینی
3. `## بخش دوم: بررسی تیپ شخصیتی، رفتاری و ریشه‌یابی روان‌تنی`
   - ۴ تا ۶ ویژگی احتمالی + یک پاراگراف همدلانه (نه تشخیص روان‌شناختی)
4. `## بخش سوم: پکیج درمانی و روتین تخصصی ...`
   - ۲ تا ۵ محصول، هر خط: `نام دقیق - زمان/نحوه مصرف - دلیل + شماره شاخص`
   - `### تکنیک ماساژ و جذب`
   - `### نسخه خانگی مکمل`
   - `### سبک زندگی و تغذیه زیبایی` (بخورید/نخورید/راهکار طلایی)
   - `### ⚠️ هشدارهای ایمنی و ملاحظات مصرف`
   - `### توجه`

### ویژن
- `callAI(env, system, user, imageUrl)`:
  - OpenAI-compatible: `content: [{type:'text'},{type:'image_url',image_url:{url}}]`
  - Gemini: `inlineData`
- تصویر در KV با کلید `jobimg:{jobId}` ذخیره و بعد از پردازش حذف می‌شود.
- تصویر اصلی آپلود نمی‌شود؛ فقط نسخهٔ فشرده.

### اصلاح قیمت
- `fixPrices` قیمت‌های اشتباه را با کاتالوگ عوض می‌کند.
- `ensurePrices` جدول قیمت محصولات ذکرشده را اضافه می‌کند.

---

## 11) فرانت

- `public/index.html` تک‌فایلی؛ بدون build.
- صفحات: خانه، پوست، عنبیه، مو، پرسش‌نامه (۱۳ سؤال)، محصولات، حساب، پنل ادمین درون‌اپ.
- `computeImageMetrics` / `computeIrisMetrics` تحلیل پیکسلی.
- `compressForAI` عکس را به JPEG فشرده تبدیل می‌کند.
- `submitAnalysis` → `/api/analyze` → `pollJob` → `renderResult`.
- `renderMarkdown` خروجی AI را امن رندر می‌کند.
- Service Worker: `arya-beauty-v3`؛ بعد از هر تغییر UI نسخه را bump کنید.
- پروفایل: نام/سن/جنسیت/بارداری/آلرژی/دارو/آفتاب/روتین (localStorage).

---

## 12) پنل ادمین

- **مستقل:** `https://arya-api.arshadirad7475.workers.dev/admin` — فایل `worker/src/admin.html`، باندل‌شده با Text rule.
- **درون اپ:** `https://arya-app.pages.dev/#admin` یا دکمهٔ «پنل مدیریت درون اپ».
- ورود با ایمیل/رمز حساب `admin`.
- امکانات: آمار، کاربران (تأیید/مسدود/سهمیه)، تحلیل‌ها (مشاهده/تلاش دوباره/حذف/برچسب ویژن)، بازخورد، تنظیم سهمیه سراسری.
- توکن ادمین در `localStorage` با کلید `arya_admin_token` (مستقل از اپ اصلی).

---

## 13) دستورهای مهم

```bash
# اسکرپ کاتالوگ
npm run scrape

# دیپلوی
npm run deploy:worker
npm run deploy:pages

# CLI ادمین (ARYA_API و ADMIN_TOKEN را از .env.local می‌خواند)
node scripts/admin.js stats
node scripts/admin.js list
node scripts/admin.js approve user@example.com
node scripts/admin.js block user@example.com
node scripts/admin.js limit user@example.com 20

# اعمال schema
wrangler d1 execute arya-app-db --remote --file=worker/schema.sql
```

---

## 14) تست

- `GET /health` → `{ok:true, ai:true, model:'deepseek-flash', ...}`
- `GET /admin` → HTML پنل ادمین.
- با Playwright/Chrome: ورود، محصولات، پرسش‌نامه، آپلود عکس، نتیجه، پنل ادمین.
- برای تست AI بدون مصرف سهمیهٔ واقعی، می‌توانید یک کاربر تست بسازید، تأیید کنید، تحلیل بفرستید و بعد کاربر/جاب‌های تست را از D1 پاک کنید.
- مسیرهای خروجی استاندارد: ۱۲ شاخص، بخش دوم، بخش سوم، ماساژ، نسخه خانگی، تغذیه، هشدارها، توجه.

---

## 15) محدودیت‌ها و کارهای بعدی

- دسته‌های «دهان و دندان» و «پک تخصصی» در سایت آریا هنگام اسکرپ خالی بودند؛ محصولات جدید را به `scripts/scrape-arya.js`/کاتالوگ اضافه کنید.
- محصولات «کرم آبرسان/تخصصی، ضدآفتاب، دهان‌شویه» در کاتالوگ فعلی نیستند و در خروجی «موجود نیست» علامت می‌خورند.
- تحلیل‌های قدیمی کاربر ممکن است با پرامپت/ساختار قبلی ذخیره شده باشند؛ برای ساختار جدید تحلیل تازه بفرستید.
- بخش شخصیت/روان‌تنی «برداشت احتمالی» است؛ ادعای تشخیص نکنید.
- هنوز: بازیابی رمز، حذف کاربر، خروجی CSV، تست خودکار CI، محدودیت نرخ پیشرفته، پرداخت/پیامک، دامنهٔ اختصاصی.
- مدل `deepseek-flash` از reasoning استفاده می‌کند؛ `max_tokens` روی ۱۰۰۰۰ تنظیم شده تا خروجی بلند کامل شود.
- بعد از هر تغییر فرانت، `CACHE` در `public/sw.js` را bump کنید (مثلاً v4).

---

## 16) پرامپت آماده برای هوش مصنوعی بعدی

```
این ریپازیتوری را کامل بخوان:
https://github.com/Rezzzz77/arya-app

ابتدا README.md و HANDOFF.md را بخوان. سپس:
- public/index.html (فرانت)
- worker/src/index.js (API + prompt + AI)
- worker/src/admin.html (پنل ادمین)
- worker/schema.sql (D1)
- scripts/ (deploy/scrape/secret/admin)

قواعد:
1) هیچ Secret یا .env را کامیت نکن.
2) تغییرات را بعد از تست با `npm run deploy:worker` و `npm run deploy:pages` دیپلوی کن.
3) خروجی تحلیل باید ساختار ۱۲ شاخص + بخش دوم + بخش سوم را حفظ کند.
4) فقط محصولات کاتالوگ آریا پیشنهاد شوند.
5) برای تغییر پرامپت، worker/src/index.js و برای UI، public/index.html.
6) روی ویندوز از scripts/deploy-worker.js و deploy-pages.js استفاده کن (مسیر دارای فاصله مشکل‌ساز است).
```

---

## 17) امنیت

- `.env` / `.env.local` / `.dev.vars` هرگز کامیت نشوند.
- کلید DeepSeek را در صورت لو رفتن rotate کنید و با `set-secret.js` دوباره تنظیم کنید.
- توکن ادمین (`ADMIN_TOKEN`) را فقط در محیط امن نگه دارید.
- CSP، `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` در `_headers` و صفحهٔ ادمین تنظیم شده‌اند.
- CORS فقط برای دامنه‌های اپ/Pages/لوکال.
- تصویر اصلی آپلود نمی‌شود؛ نسخهٔ فشرده موقتاً در KV است و بعد از پردازش حذف می‌شود.
- تحلیل‌ها مشاورهٔ زیبایی/طب سنتی هستند، نه تشخیص پزشکی.
