// B4L (Bead For Less) Refine bar — nightly data build.
// Reads visible products + filter custom fields from BigCommerce and writes small JSON files
// into ./docs (served by GitHub Pages):
//   docs/index.json      category address -> id (c), id -> exact address (u), JPG landing pages with counts (l)
//   docs/c/<id>.json     products of one category
//   docs/p/<n>.json      product id -> [family category, list page category]  (for product pages)
//
// Row format (B4L 3-tier pricing):
// [0:id, 1:name, 2:url, 3:image, 4:price, 5:size, 6:shape, 7:color, 8:treatment, 9:material, 10:priceA, 11:priceB, 12:priceC, 13:minQty, 14:stone]

import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';

const STORE = process.env.BC_STORE_HASH;
const TOKEN = process.env.BC_TOKEN;
const API = process.env.BC_API_BASE || `https://api.bigcommerce.com/stores/${STORE}/v3`;
const OUT = 'docs';
const MIN_LIST = 12;      // a landing page needs at least this many products
const MAX_LIST = 10000;   // larger landing pages are skipped to keep pages fast

if (!process.env.BC_API_BASE && (!STORE || !TOKEN)) {
  console.error('Missing BC_STORE_HASH or BC_TOKEN');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(API + path, { headers: { 'X-Auth-Token': TOKEN || '', Accept: 'application/json' } });
    if (res.status === 429) {
      await sleep(Number(res.headers.get('X-Rate-Limit-Time-Reset-Ms') || 2000) + 200);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  throw new Error(`Rate limited too many times: ${path}`);
}

async function getAll(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const j = await api(`${path}${sep}limit=250&page=${page}`);
    out.push(...(j.data || []));
    const p = j.meta && j.meta.pagination;
    if (!p || page >= p.total_pages) break;
  }
  return out;
}

const normPath = (p) => ('/' + String(p || '').trim()
  .replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '')).toLowerCase();

function suggestSize(name) {
  const m = String(name || '').match(/(\d+(?:\.\d+)?)\s*(?:x\s*(\d+(?:\.\d+)?)\s*)?mm/i);
  if (!m) return '';
  const n = Math.max(parseFloat(m[1]), m[2] ? parseFloat(m[2]) : 0);
  const std = [2, 3, 4, 6, 8, 10, 12, 14, 15, 16, 18, 20, 25, 30, 35, 40, 45, 50];
  let best = std[0];
  for (const s of std) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  return best + 'mm';
}

const SHAPES = [
  ['rondelle faceted', 'Rondelle Faceted'], ['round faceted', 'Round Faceted'],
  ['rondelle', 'Rondelle'], ['roundel', 'Rondelle'], ['round bead', 'Round Bead'],
  ['round', 'Round'], ['oval', 'Oval'], ['rice', 'Rice'], ['tube', 'Tube'],
  ['cube', 'Cube'], ['coin', 'Coin'], ['heart', 'Heart'], ['teardrop', 'Teardrop'],
  ['nugget', 'Nugget'], ['chips', 'Chips'], ['chip', 'Chip'], ['bicone', 'Bicone'],
  ['donut', 'Donut'], ['polygon', 'Polygon'], ['pear', 'Pear'], ['carved', 'Carved'],
  ['bracelet', 'Bracelet'], ['heishi', 'Heishi'], ['rectangle', 'Rectangle'],
  ['square', 'Square'], ['hexagon', 'Hexagon'], ['animal', 'Animal'],
  ['plant', 'Plant'], ['symbol', 'Symbol'], ['earring', 'Earring'],
  ['ring', 'Ring'], ['rope', 'Rope'], ['mix shape', 'Mix Shape'],
  ['clasp', 'Clasp'], ['pendant', 'Pendant']
];
function suggestShape(name) {
  const n = String(name || '').toLowerCase();
  for (const s of SHAPES) {
    if (n.includes(s[0])) return s[1];
  }
  return '';
}

function suggestTreatment(name) {
  const n = String(name || '').toLowerCase();
  if (/\b(natural dyed|dyed natural)\b/.test(n)) return 'Natural Dyed';
  if (/\bdyed?\b/.test(n)) return 'Dyed';
  if (/\bheat(ed)?\b/.test(n)) return 'Heated';
  if (/\b100%\s*natural\b/.test(n)) return '100% Natural';
  if (/\bnatural\b/.test(n)) return 'Natural';
  if (/\bsynthetic\b/.test(n)) return 'Synthetic';
  if (/\b(man\s*made|manmade)\b/.test(n)) return 'Man Made';
  if (/\breconstructed\b/.test(n)) return 'Reconstructed';
  if (/\bstabilized\b/.test(n)) return 'Stabilized';
  return '';
}

function suggestMaterial(name) {
  const t = String(name || '').toLowerCase();
  if (/\bmatte\b/.test(t) && /gemstone|quartz|agate|jasper|jade/.test(t)) return 'Gemstone Matte';
  if (/crystal\s*glass|glass\s*crystal|\bglass\b/.test(t)) return 'Crystal Glass';
  if (/\bamber\s*horn\b/.test(t)) return 'Amber Horn';
  if (/\bbuffalo\s*horn\b|\bhorn\b/.test(t)) return 'Buffalo Horn';
  if (/\bbuffalo\s*bone\b|\bbone\b/.test(t)) return 'Buffalo Bone';
  if (/\bpearl\b/.test(t)) return 'Pearl';
  if (/\b(clasp|finding|part|wire|chain)\b/.test(t)) return 'Finding';
  if (/\b(metal|alloy|brass|silver|gold\s*plated)\b/.test(t)) return 'Metal';
  return 'Gemstone';
}

const COLORS = [
  'Multicolor', 'Multi Color', 'Mix', 'Amethyst', 'Turquoise', 'Crystal', 'Clear',
  'Black', 'Blue', 'Brown', 'Green', 'Grey', 'Orange', 'Pink', 'Purple', 'Red', 'White', 'Yellow'
];
function suggestColor(name) {
  const n = String(name || '').toLowerCase();
  for (const c of COLORS) {
    if (new RegExp('\\b' + c.toLowerCase() + '\\b', 'i').test(n)) return c;
  }
  return '';
}

const STONES_96 = [
  '7 Chakra', 'Agate', 'Amazonite', 'Amber Horn', 'Amethyst', 'Apatite',
  'Aquamarine', 'Aventurine', 'Azurite', 'Banded Agate', 'Black Agate',
  'Blood Agate', 'Bone', 'Boulder opal', 'Bronzite', 'Brown Snowflake',
  'Buffalo Horn', 'Calcite', 'Carnelian', 'Chalcedony', 'Charoite',
  'Cherry Quartz', 'Chrysanthemum', 'Chrysprase', 'Citrine', 'Coral',
  'Crazy Lace Agate', 'Crystal Natural', 'Crystal Synthetic',
  'Dalmatian Jasper', 'Denim Lapis', 'Druzy Agate', 'Epidot', 'Fire Agate',
  'Fluorite', 'Fossil Agate', 'Fossil Jasper', 'Freshwater Pearl', 'Garnet',
  'Glass Crystal', 'Golden Obsidian', 'Goldstone', 'Green Turquoise',
  'Hematite', 'Howlite', 'Jade dyed', 'Jade Natural', 'Jasper', 'Kiwi Agate',
  'Labradorite', 'Lapis Lazuli', 'Larimar', 'Lava', 'Lemon Agate',
  'Leopard Skin', 'Lepidolite', 'Magnesite', 'Mahogany Obsidian',
  'Malachite', 'Mix', 'Mookaite', 'Moss Agate', 'Mother Of Pearl',
  'Nephrite Jade', 'Onyx', 'Opalite', 'Other Stones', 'Petrified Wood',
  'Picasso Agate', 'Picture Jasper', 'Poppy Jasper', 'Quartz',
  'Red Aventurine', 'Red Creek Jasper', 'Red Jasper', 'Rhodonite',
  'River Fossil', 'Ruby Zoisite', 'Rutilated', 'Sea Sediment', 'Serpentine',
  'Sesame Agate', 'Smoky Topaz', 'Snow Quartz', 'Snowflake Obsidian',
  'Sodalite', 'Sunstone', 'Tiger Eye', 'Topaz Synthetic', 'Tourmaline',
  'Turquoise', 'Unakite', 'White Obsidian', 'White Turquoise',
  'Yellow Chalcedony', 'Zebra Agate'
].sort((a, b) => b.length - a.length);

function matchStone(name) {
  const n = ' ' + String(name || '').toLowerCase() + ' ';
  for (const s of STONES_96) {
    if (new RegExp('\\b' + s.toLowerCase().replace(/\\s+/g, '\\s+') + '\\b', 'i').test(n)) return s;
  }
  return '';
}

async function main() {
  console.log(`Connecting to BigCommerce store ${STORE}...`);

  // 1) Categories
  const cats = await getAll('/catalog/trees/categories');
  const catPath = {}, pathCat = {}, links = {}, catUrl = {};
  for (const c of cats) {
    if (c.is_visible === false) continue;
    const path = c.url && (c.url.path || c.url.url);
    if (!path) continue;
    catPath[c.category_id] = normPath(path);
    catUrl[c.category_id] = String(path).replace(/^https?:\/\/[^/]+/i, '');
    pathCat[normPath(path)] = c.category_id;
  }
  for (const c of cats) {
    if (!catPath[c.category_id]) continue;
    const found = new Set();
    const re = /href\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(c.description || ''))) {
      const target = pathCat[normPath(m[1])];
      if (target && target !== c.category_id) found.add(target);
    }
    if (found.size) links[c.category_id] = [...found];
  }

  // 2) Products
  console.log('Fetching visible products with custom fields and images...');
  const products = await getAll(
    '/catalog/products?is_visible=true&include=custom_fields,primary_image' +
    '&include_fields=id,name,price,categories,custom_url,order_quantity_minimum'
  );
  console.log(`Retrieved ${products.length} products.`);

  let skuStone = {};
  try {
    skuStone = JSON.parse(await readFile('sku-to-stone.json', 'utf8'));
  } catch (e) {
    console.warn('Could not read sku-to-stone.json');
  }

  // Row format for B4L (keep in sync with B4L storefront scripts):
  // [0:id, 1:name, 2:url, 3:image, 4:price, 5:size, 6:shape, 7:color, 8:treatment, 9:material, 10:priceA, 11:priceB, 12:priceC, 13:minQty, 14:stone]
  const byCat = {};
  for (const p of products) {
    const cf = {};
    for (const f of p.custom_fields || []) cf[f.name] = f.value;
    const img = p.primary_image ? (p.primary_image.url_standard || p.primary_image.url_thumbnail || '') : '';
    const minQty = p.order_quantity_minimum > 0 ? p.order_quantity_minimum : (/bracelet/i.test(p.name) ? 30 : 1);
    const skuMatch = String(p.name || '').match(/\[([^\]]+)\]/);
    const sku = (skuMatch ? skuMatch[1] : (p.custom_url && p.custom_url.url ? p.custom_url.url.replace(/\//g, '') : '')).trim().toLowerCase();
    const stone = cf['Stone'] || cf['Stone Name'] || skuStone[sku] || matchStone(p.name) || '';
    const row = [
      p.id,
      p.name,
      (p.custom_url && p.custom_url.url) || '',
      img,
      Number(p.price) || 0,
      cf['Bead Size'] || suggestSize(p.name),
      cf['Shape'] || suggestShape(p.name),
      cf['Color'] || suggestColor(p.name),
      cf['Treatment'] || suggestTreatment(p.name),
      cf['Material'] || suggestMaterial(p.name),
      cf['Unit Price A'] || '',
      cf['Unit Price B'] || '',
      cf['Unit Price C'] || '',
      minQty,
      stone
    ];
    for (const cid of p.categories || []) {
      if (!catPath[cid]) continue;
      (byCat[cid] = byCat[cid] || []).push(row);
    }
  }

  // 3) Landing pages: all products behind the JPG links (followed through several levels)
  const landing = {};
  for (const cid of Object.keys(links).map(Number)) {
    const seen = new Set([cid]), stack = [cid], rows = new Map();
    while (stack.length) {
      const cur = stack.pop();
      for (const r of byCat[cur] || []) rows.set(r[0], r);
      for (const next of links[cur] || []) if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
    if (rows.size >= MIN_LIST && rows.size <= MAX_LIST) landing[cid] = [...rows.values()];
  }

  // 4) Write files
  await rm(`${OUT}/c`, { recursive: true, force: true });
  await mkdir(`${OUT}/c`, { recursive: true });
  const index = {}, urls = {};
  const lists = { ...byCat, ...landing };
  for (const [cid, rows] of Object.entries(lists)) {
    index[catPath[cid]] = Number(cid);
    urls[cid] = catUrl[cid];
    await writeFile(`${OUT}/c/${cid}.json`, JSON.stringify(rows));
  }

  // Product pages: family = smallest real category; list = smallest landing page that contains the product
  const inLanding = {};
  for (const [cid, rows] of Object.entries(landing)) {
    for (const r of rows) {
      const cur = inLanding[r[0]];
      if (!cur || landing[cur].length > rows.length) inLanding[r[0]] = Number(cid);
    }
  }
  const count = (cid) => (byCat[cid] ? byCat[cid].length : 0);
  const buckets = {};
  for (const p of products) {
    const cs = (p.categories || []).filter((cid) => byCat[cid]);
    if (!cs.length) continue;
    const fam = cs.slice().sort((a, b) => count(a) - count(b))[0];
    const list = inLanding[p.id] || cs.slice().sort((a, b) => count(b) - count(a))[0];
    const b = Math.floor(p.id / 1000);
    (buckets[b] = buckets[b] || {})[p.id] = [fam, list];
  }
  await rm(`${OUT}/p`, { recursive: true, force: true });
  await mkdir(`${OUT}/p`, { recursive: true });
  for (const [b, map] of Object.entries(buckets)) await writeFile(`${OUT}/p/${b}.json`, JSON.stringify(map));

  await writeFile(`${OUT}/index.json`, JSON.stringify({
    updated: new Date().toISOString(), c: index, u: urls,
    l: Object.fromEntries(Object.entries(landing).map(([cid, rows]) => [cid, rows.length]))
  }));
  await writeFile(`${OUT}/.nojekyll`, '');
  console.log(`Done: ${products.length} products, ${Object.keys(index).length} lists, ${Object.keys(landing).length} JPG landing pages.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
