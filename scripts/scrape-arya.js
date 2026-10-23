import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const BASE = 'https://aryamlm.ir';
const CATEGORIES = {
  2: 'پاک کننده و لایه بردار',
  3: 'آبرسان و مرطوب کننده',
  4: 'سرم های تخصصی',
  5: 'مو، مژه و ابرو',
  6: 'دهان و دندان',
  8: 'پک تخصصی محصولات',
  9: 'نانو وگان',
};

// برچسب‌گذاری دستی برای ۱۶ محصول فعلی — دقیق‌تر از حدس کلیدواژه‌ای
const OVERRIDES = {
  '266': {
    tags: ['cleanser', 'hydration', 'soothing'], skin: ['all'],
    highlights: ['پاک‌کننده و آبرسان ملایم', 'مناسب انواع پوست', 'کمک به پاکسازی آلودگی و چربی اضافی'],
  },
  '89': { tags: ['cleanser', 'exfoliant', 'brightening', 'oil-control'], skin: ['all', 'oily', 'combination'] },
  '51': { tags: ['cleanser', 'makeup-remover', 'soothing'], skin: ['all'] },
  '9': { tags: ['cleanser', 'makeup-remover', 'oil-control'], skin: ['all', 'oily', 'combination'] },
  '88': { tags: ['hydration', 'anti-aging', 'soothing'], skin: ['all', 'sensitive', 'dry'] },
  '1': {
    tags: ['hydration', 'toner', 'soothing'], skin: ['normal', 'dry', 'sensitive'],
    highlights: ['آبرسان و مرطوب‌کننده', 'مناسب پوست نرمال', 'کمک به حفظ رطوبت پوست'],
  },
  '10': { tags: ['anti-aging', 'brightening', 'hydration', 'soothing'], skin: ['all'] },
  '13': { tags: ['brightening', 'anti-aging', 'vitamin-c', 'antioxidant'], skin: ['all', 'sensitive'] },
  '49': { tags: ['brightening', 'acne', 'oil-control', 'anti-pigmentation'], skin: ['all', 'oily', 'sensitive'] },
  '11': { tags: ['brightening', 'anti-pigmentation', 'soothing'], skin: ['all', 'sensitive'] },
  '8': { tags: ['acne', 'oil-control', 'soothing'], skin: ['all', 'oily', 'sensitive'] },
  '30': { tags: ['hair', 'eyelash', 'eyebrow', 'growth'], skin: ['hair'] },
  '7': { tags: ['hair', 'hair-growth', 'strengthening'], skin: ['hair'] },
  '87': { tags: ['hair', 'hydration', 'argan', 'nails'], skin: ['all', 'dry'] },
  '31': { tags: ['hair', 'conditioner', 'smoothing'], skin: ['hair'] },
  '12': { tags: ['vegan', 'nano', 'hydration', 'brightening'], skin: ['all'] },
};

const SPEC_LABELS = ['نوع', 'بافت', 'رنگ', 'حجم', 'سن', 'مناسب نوع پوست', 'مناسب برای', 'نواحی قابل استفاده', 'نوع محفظه نگهدارنده', 'مبدا برند'];

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      last = e;
      await sleep(500 * (i + 1));
    }
  }
  throw last;
}

const norm = (s) => String(s || '')
  .replace(/\u200c/g, ' ')
  .replace(/[\u200e\u200f]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const clean = (s) => String(s || '')
  .replace(/\r/g, '')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const digits = (s) => String(s || '').replace(/[^\d]/g, '');
const toToman = (rial) => Math.round(Number(rial || 0) / 10);

function parasOf($, selector) {
  const out = [];
  $(selector).find('p, li').each((_, el) => {
    const t = norm($(el).text());
    if (t) out.push(t);
  });
  if (!out.length) {
    const t = clean($(selector).text());
    if (t) out.push(...t.split('\n').map(norm).filter(Boolean));
  }
  return [...new Set(out)];
}

function parseSpecs(lines) {
  const specs = {};
  for (const label of SPEC_LABELS) {
    const re = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.+)$', 'i');
    for (const line of lines) {
      const m = re.exec(line);
      if (m) {
        // بعضی خطوط چند فیلد را پشت هم دارند؛ تا فیلد بعدی جدا کن
        let value = m[1];
        for (const other of SPEC_LABELS) {
          if (other === label) continue;
          const idx = value.indexOf(other + ':');
          if (idx > 0) { value = value.slice(0, idx); break; }
        }
        specs[label] = norm(value).slice(0, 140);
        break;
      }
    }
  }
  return {
    type: specs['نوع'] || '',
    texture: specs['بافت'] || '',
    color: specs['رنگ'] || '',
    volume: specs['حجم'] || '',
    age: specs['سن'] || '',
    skin: specs['مناسب نوع پوست'] || '',
    audience: specs['مناسب برای'] || '',
    area: specs['نواحی قابل استفاده'] || '',
    origin: specs['مبدا برند'] || '',
  };
}

function parseSpecsFromText(text) {
  const t = norm(text);
  const idx = t.indexOf('مشخصات اصلی');
  const seg = idx >= 0 ? t.slice(idx) : t;
  const labels = [...SPEC_LABELS].sort((a, b) => b.length - a.length);
  const alt = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp('(' + alt + ')\\s*:\\s*([\\s\\S]*?)(?=\\s*(?:' + alt + ')\\s*:|$)', 'g');
  const specs = {};
  let m;
  while ((m = re.exec(seg))) {
    const key = m[1];
    if (!specs[key]) specs[key] = norm(m[2]).slice(0, 140);
  }
  return {
    type: specs['نوع'] || '',
    texture: specs['بافت'] || '',
    color: specs['رنگ'] || '',
    volume: specs['حجم'] || '',
    age: specs['سن'] || '',
    skin: specs['مناسب نوع پوست'] || '',
    audience: specs['مناسب برای'] || '',
    area: specs['نواحی قابل استفاده'] || '',
    origin: specs['مبدا برند'] || '',
  };
}

function parseSkinTypes(text) {
  const t = norm(text);
  const out = new Set();
  if (/انواع پوست|همه انواع|تمام انواع/.test(t)) out.add('all');
  if (/(?:^|\s)چرب(?:\s|$|،|,)/.test(t) || /پوست\s*چرب/.test(t)) out.add('oily');
  if (/(?:^|\s)خشک(?:\s|$|،|,)/.test(t) || /پوست\s*خشک/.test(t)) out.add('dry');
  if (/مختلط/.test(t)) out.add('combination');
  if (/حساس/.test(t)) out.add('sensitive');
  if (/نرمال|معمولی/.test(t)) out.add('normal');
  return [...out];
}

function autoTags(name, description, ingredients) {
  const t = norm([name, description.slice(0, 1200), ingredients.slice(0, 900)].join(' '));
  const tags = new Set();
  const has = (arr) => arr.some((k) => t.includes(k));
  if (has(['ضد جوش', 'ضدجوش', 'جوش', 'آکنه'])) tags.add('acne');
  if (has(['ضد لک', 'ضدلک', 'لک', 'روشن کننده', 'روشن‌کننده', 'ویتامین C', 'اسکوربیک', 'نیاسینامید'])) tags.add('brightening');
  if (has(['آبرسان', 'مرطوب', 'هیالورون', 'خشکی', 'کم آب', 'کم‌آب'])) tags.add('hydration');
  if (has(['ضد پیری', 'ضدپیری', 'جوان ساز', 'جوان‌ساز', 'چروک', 'کلاژن', 'سلول های بنیادی', 'سلول‌های بنیادی'])) tags.add('anti-aging');
  if (has(['چربی', 'سبوم', 'منافذ'])) tags.add('oil-control');
  if (has(['حساس', 'التهاب', 'تسکین', 'قرمزی'])) tags.add('soothing');
  if (has(['مژه', 'ابرو', 'ریزش مو', 'رشد مو', 'شامپو'])) tags.add('hair');
  if (has(['پاک', 'پاک کننده', 'پاک‌کننده', 'لایه بردار', 'لایه‌بردار', 'شوینده', 'فوم'])) tags.add('cleanser');
  if (has(['وگان', 'نانو'])) tags.add('vegan');
  return [...tags];
}

function parseWarnings(usageLines) {
  const joined = usageLines.join('\n');
  const idx = joined.search(/احتیاط|منع مصرف|هشدار/);
  if (idx < 0) return '';
  return clean(joined.slice(idx)).slice(0, 1600);
}

function extractHighlights(descriptionLines) {
  const start = descriptionLines.findIndex((l) => /بخشی از ویژگی|ویژگی\s*ها|مزایا|خواص/.test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < descriptionLines.length; i++) {
    const l = descriptionLines[i];
    if (/مشخصات اصلی|پیشنهادات آریایی|روش مصرف|ترکیبات/.test(l)) break;
    if (l.length >= 4 && l.length <= 90) out.push(l.replace(/^[•\-*]\s*/, ''));
    if (out.length >= 12) break;
  }
  return out;
}

function parseFaq($) {
  const out = [];
  $('#faq .accordion-item').each((_, el) => {
    const q = norm($(el).find('.accordion-header').text()).replace(/[+−-]\s*$/, '').trim();
    const a = norm($(el).find('.accordion-content').text());
    if (q && a && q.length > 3) out.push({ q, a: a.slice(0, 700) });
  });
  return out.slice(0, 16);
}

async function scrapeProduct(id, category) {
  const url = `${BASE}/newportal/Guest/Show/${id}`;
  const html = await get(url);
  const $ = cheerio.load(html);

  const name = norm($('.product_title').first().text());
  const priceText = norm($('.product_price').first().text());
  const rial = Number(digits(priceText));
  const imgSrc = $('.product_img').first().attr('src') || '';
  const image = imgSrc ? new URL(imgSrc, BASE).href : '';

  const descriptionLines = parasOf($, '#description');
  const ingredientLines = parasOf($, '#ingredients');
  const usageLines = parasOf($, '#usage');
  const description = clean(descriptionLines.join('\n'));
  const ingredients = clean(ingredientLines.join('\n'));
  const usageFull = clean(usageLines.join('\n'));
  const warnings = parseWarnings(usageLines);
  const usage = clean(usageLines.filter((l) => !/احتیاط|منع مصرف|هشدار/.test(l)).join('\n')).slice(0, 2500);
  const faq = parseFaq($);
  const specsLine = parseSpecs(descriptionLines);
  const specsText = parseSpecsFromText(description);
  const specs = {};
  for (const k of Object.keys(specsText)) specs[k] = specsLine[k] || specsText[k];
  const override = OVERRIDES[String(id)] || {};
  const tags = override.tags || autoTags(name, description, ingredients);
  const skinTypes = override.skin || parseSkinTypes([specs.skin, description.slice(0, 800)].join(' '));
  const highlights = override.highlights || extractHighlights(descriptionLines);

  return {
    id: String(id),
    name,
    category,
    categoryId: Object.keys(CATEGORIES).find((k) => CATEGORIES[k] === category),
    price_rial: rial,
    price_toman: toToman(rial),
    currency: 'IRT',
    image,
    url,
    tags,
    skin_types: skinTypes,
    specs,
    highlights,
    description: description.slice(0, 6000),
    ingredients: ingredients.slice(0, 4000),
    usage: usage.slice(0, 2500),
    warnings: warnings.slice(0, 1600),
    faq,
    scraped_at: new Date().toISOString(),
  };
}

function compact(p) {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    price_toman: p.price_toman,
    tags: p.tags,
    skin_types: p.skin_types,
    specs: p.specs,
    highlights: p.highlights.slice(0, 8),
    benefits: p.description.slice(0, 700),
    warnings: p.warnings.slice(0, 500),
    url: p.url,
    image: p.image,
  };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const products = [];
  const emptyCats = [];
  const seen = new Set();

  for (const [id, name] of Object.entries(CATEGORIES)) {
    const catUrl = `${BASE}/newportal/Guest/ProductCat/${id}`;
    process.stdout.write(`category ${id} (${name}) ... `);
    let html = '';
    try { html = await get(catUrl); } catch (e) { console.log('ERR', e.message); continue; }
    const $ = cheerio.load(html);
    const ids = new Set();
    $('a[href*="/Guest/Show/"]').each((_, a) => {
      const m = /\/Guest\/Show\/(\d+)/.exec($(a).attr('href') || '');
      if (m) ids.add(m[1]);
    });
    if (!ids.size) { emptyCats.push({ id, name }); console.log('empty'); continue; }
    console.log(ids.size + ' products');
    for (const pid of ids) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      try {
        const p = await scrapeProduct(pid, name);
        if (!p.name) { console.log('  skip', pid, '(no name)'); continue; }
        products.push(p);
        console.log('  ok', pid, p.name.slice(0, 58), p.price_toman + ' T');
      } catch (e) {
        console.log('  ERR', pid, e.message);
      }
      await sleep(250);
    }
  }

  products.sort((a, b) => Number(a.categoryId) - Number(b.categoryId) || a.name.localeCompare(b.name, 'fa'));
  const meta = {
    source: BASE,
    scraped_at: new Date().toISOString(),
    count: products.length,
    empty_categories: emptyCats,
    categories: CATEGORIES,
  };
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.mkdir(path.join(root, 'public', 'data'), { recursive: true });
  await fs.mkdir(path.join(root, 'worker', 'src'), { recursive: true });

  await fs.writeFile(path.join(root, 'data', 'products.json'), JSON.stringify({ ...meta, products }, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'public', 'data', 'products.json'), JSON.stringify({ ...meta, products: products.map(compact) }, null, 2), 'utf8');
  const catalog = products.map(compact);
  await fs.writeFile(
    path.join(root, 'worker', 'src', 'catalog.js'),
    '// Generated by scripts/scrape-arya.js — do not edit by hand.\nexport const CATALOG_META = ' + JSON.stringify(meta, null, 2) + ';\nexport const CATALOG = ' + JSON.stringify(catalog, null, 2) + ';\n',
    'utf8'
  );

  const report = products.map((p) => `${p.id} | ${p.category} | ${p.price_toman} T | ${p.tags.join(',')} | ${p.skin_types.join(',')} | ${p.highlights.length} highlights`).join('\n');
  await fs.writeFile(path.join(root, 'data', 'scrape-report.txt'), report + '\n', 'utf8');
  console.log(`\nDone: ${products.length} products -> data/products.json, public/data/products.json, worker/src/catalog.js`);
  if (emptyCats.length) console.log('Empty categories:', emptyCats.map((c) => c.name).join(', '));
}

main().catch((e) => { console.error(e); process.exit(1); });
