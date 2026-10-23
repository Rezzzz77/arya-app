# مشاور زیبایی آریا — Arya Beauty Advisor

اپلیکیشن PWA فارسی (RTL) برای تحلیل پوست و مو و پیشنهاد محصولات رسمی **آریا پژوهش یکتا** (`aryamlm.ir`).

> 📘 راهنمای کامل توسعه، معماری، API و تحویل به هوش مصنوعی دیگر: [HANDOFF.md](./HANDOFF.md)

- تحلیل پیکسلی عکس **روی گوشی** انجام می‌شود؛ عکس آپلود نمی‌شود.
- تفسیر و پک پیشنهادی با AI (DeepSeek یا Gemini) ساخته می‌شود.
- فقط محصولات کاتالوگ آریا پیشنهاد داده می‌شوند و قیمت‌ها با کاتالوگ اصلاح می‌شوند.
- ورود/ثبت‌نام، تأیید مدیر، سهمیه روزانه، تاریخچه و پنل مدیر.

## معماری

```
public/                 فرانت PWA (Cloudflare Pages)
  index.html            کل اپ تک‌فایلی
  manifest.webmanifest, sw.js, icons, _headers
  data/products.json    کاتالوگ کامپکت برای فرانت
worker/                 Cloudflare Worker API
  src/index.js          auth + quota + jobs + AI adapter + price guard
  src/catalog.js        کاتالوگ تولیدشده (برای پرامپت)
  schema.sql            D1 schema
  wrangler.toml         bindings: D1 + KV + Queue
data/products.json      کاتالوگ کامل اسکرپ‌شده
scripts/scrape-arya.js  اسکرپ صفحه‌های عمومی aryamlm.ir
scripts/admin.js        مدیریت کاربران از CLI
```

جریان:

1. کاربر عکس را انتخاب می‌کند → تحلیل رنگ/بافت روی `canvas` انجام می‌شود.
2. فقط `metrics` عددی + پاسخ‌ها + پروفایل به `POST /api/analyze` می‌رود.
3. Worker یک job در D1 می‌سازد و به Queue می‌فرستد.
4. مصرف‌کنندهٔ Queue پرامپت را به AI می‌فرستد، پاسخ فارسی را بررسی و قیمت‌ها را با کاتالوگ اصلاح می‌کند.
5. فرانت با `GET /status/{jobId}` نتیجه را می‌گیرد.

## پیش‌نیاز

- Node.js 20+
- Wrangler 4+
- حساب Cloudflare با Workers / D1 / KV / Queues
- کلید AI (DeepSeek یا Gemini یا هر API سازگار با OpenAI)

## نصب

```bash
npm install
npm run scrape          # کاتالوگ را از aryamlm.ir می‌گیرد
```

اگر صفحه‌های آریا تغییر کردند، فقط `scripts/scrape-arya.js` را به‌روز کنید.

## ساخت منابع Cloudflare

```bash
wrangler d1 create arya-app-db
wrangler kv namespace create arya-app-kv
wrangler queues create arya-ai
```

خروجی دستورها `database_id` و `id` را در `worker/wrangler.toml` جای `REPLACE_ME` بگذارید.

```bash
wrangler d1 execute arya-app-db --remote --file=worker/schema.sql
```

## کلیدها (Secrets)

کلیدها را در `.env` محلی یا به‌صورت Secret در Worker بگذارید. **هرگز در گیت یا چت عمومی نگذارید.**

```bash
# در arya-app/.env.local
# AI_API_KEY=sk-...
node scripts/set-secret.js AI_API_KEY
```

اسکریپت `set-secret.js` از Cloudflare API استفاده می‌کند و بدون نیاز به دیپلوی مجدد، Secret را تنظیم می‌کند. برای `ADMIN_TOKEN` هم همین کار را می‌توان کرد:

```bash
node scripts/set-secret.js ADMIN_TOKEN
```

اگر DeepSeek کیفیت خوبی نداشت، کلید Gemini را در `.env.local` بگذارید:

```bash
AI_API_KEY=...
```

و در `worker/wrangler.toml` این سه مقدار را عوض کنید و `npm run deploy:worker` بزنید:

```toml
AI_PROVIDER = "gemini"
AI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
AI_MODEL = "gemini-2.5-flash"
```

> مدل `deepseek-flash` از vision پشتیبانی می‌کند. اپ نسخهٔ فشردهٔ عکس (۸۰۰ تا ۹۰۰ پیکسل، JPEG) را برای تحلیل بصری به AI می‌فرستد؛ تصویر اصلی آپلود نمی‌شود و نسخهٔ فشرده بعد از پردازش از KV حذف می‌شود.

تنظیمات غیرحساس در `worker/wrangler.toml`:

```toml
[vars]
AI_PROVIDER = "deepseek"
AI_BASE_URL = "https://api.deepseek.com"
AI_MODEL = "deepseek-flash"
DAILY_LIMIT = "10"
```

برای Gemini:

```toml
AI_PROVIDER = "gemini"
AI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
AI_MODEL = "gemini-2.5-flash"
```

> مدل پیش‌فرض `deepseek-flash` است و vision آن فعال است. برای هر تحلیل عکس، نسخهٔ فشرده + آمار پیکسلی به AI می‌رود؛ تصویر اصلی روی سرور ذخیره نمی‌شود.

## پنل مدیریت جدا

- آدرس: **https://arya-api.arshadirad7475.workers.dev/admin**
- صفحهٔ مستقل از اپ اصلی؛ با ایمیل/رمز حساب مدیر وارد می‌شود.
- فایل: `worker/src/admin.html` (به‌صورت Text module در Worker باندل می‌شود).
- امکانات: آمار، کاربران (تأیید/مسدود/سهمیه)، تحلیل‌ها (مشاهده/تلاش دوباره/حذف)، بازخورد، تنظیمات سهمیهٔ سراسری.

## دیپلوی

استقرار فعلی:

- فرانت: **https://arya-app.pages.dev**
- API: **https://arya-api.arshadirad7475.workers.dev**

> ⚠️ روی ویندوز، اگر مسیر پروژه فاصله داشته باشد (مثل `Default Project`)، `wrangler deploy` ممکن است hang کند. اسکریپت‌های زیر خودشان فایل‌ها را به یک پوشهٔ temp بدون فاصله کپی و از آنجا دیپلوی می‌کنند:

```bash
npm run deploy:worker
npm run deploy:pages
```

یا:

```bash
node scripts/deploy-worker.js
node scripts/deploy-pages.js
```

آدرس API در `public/index.html` و در `.env.local` با کلید `ARYA_API` قابل تغییر است. اسکریپت Pages در صورت وجود `ARYA_API` آن را در نسخهٔ استیج‌شده جایگزین می‌کند.

برای تغییر تنظیمات غیرحساس (مدل/سقف سهمیه) `worker/wrangler.toml` را ویرایش و دوباره `npm run deploy:worker` را اجرا کنید.

## اولین ورود

- **اولین کسی که ثبت‌نام می‌کند، خودکار مدیر و تأییدشده می‌شود.**
- بقیه در وضعیت «در انتظار تأیید» می‌مانند.
- مدیر از «حساب من → پنل مدیر» یا با CLI تأیید می‌کند:

```bash
ARYA_API=https://arya-api... ADMIN_TOKEN=... node scripts/admin.js list
ARYA_API=https://arya-api... ADMIN_TOKEN=... node scripts/admin.js approve user@example.com
ARYA_API=https://arya-api... ADMIN_TOKEN=... node scripts/admin.js limit user@example.com 20
```

## API

| Method | Path | توضیح |
|---|---|---|
| GET | `/health` | وضعیت سرویس، AI، کاتالوگ |
| GET | `/api/products` | کاتالوگ |
| POST | `/api/register` | `{email,password}` |
| POST | `/api/login` | `{email,password}` → `{token,...}` |
| POST | `/api/me` | `{token}` → سهمیه + تاریخچه |
| POST | `/api/logout` | `{token}` |
| POST | `/api/analyze` | `{type,metrics,answers,profile}` → `{jobId}` |
| GET | `/status/{jobId}` | وضعیت/نتیجه |
| POST | `/api/feedback` | `{rating,note,jobId}` |
| GET | `/api/admin/users` | مدیر |
| POST | `/api/admin/approve` | `{email,status}` |
| POST | `/api/admin/limit` | `{email,limit}` |
| GET | `/api/admin/stats` | آمار |

## حریم خصوصی و امنیت

- عکس اصلی در مرورگر تحلیل می‌شود و **آپلود نمی‌شود**؛ فقط نسخهٔ فشردهٔ JPEG (۸۰۰–۹۰۰px) برای تحلیل ویژن به AI می‌رود. این نسخه در KV حداکثر ۱ ساعت نگه داشته و بعد از پردازش حذف می‌شود.
- رمزها با PBKDF2 + salt هش می‌شوند؛ توکن نشست هش‌شده در D1 ذخیره می‌شود.
- CORS محدود به دامنه‌های اپ است.
- CSP و هدرهای امنیتی در `public/_headers` تنظیم شده‌اند (روی Cloudflare Pages).
- AI فقط محصولات کاتالوگ را می‌بیند؛ قیمت‌ها بعد از پاسخ با کاتالوگ اصلاح می‌شوند.
- این اپ **تشخیص پزشکی نیست** و در UI هم صریحاً ذکر شده است.

## محدودیت‌ها

- دسته‌های «دهان و دندان» و «پک تخصصی» در سایت آریا در زمان اسکرپ خالی بودند.
- تحلیل پیکسلی تقریبی است؛ برای دقت بیشتر به عکس با نور طبیعی و بدون فلاش نیاز دارد.
- قیمت‌ها ممکن است در سایت تغییر کنند؛ اسکرپ را دوره‌ای اجرا کنید.
