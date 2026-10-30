// Social media image for a news story: Hindi headline on a branded card.
// 1080x1080 (Instagram, Facebook, Telegram, X) and 1000x1500 (Pinterest). JPEG, because Instagram accepts only JPEG.
// Text is drawn with the bundled Hind font (Hindi + English), so it renders the same on any server.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { DATA_DIR, getSettings, siteUrl } = require('../db');

const FONT_BOLD = path.join(__dirname, '..', '..', 'assets', 'fonts', 'Hind-Bold.ttf');
const FONT_SEMI = path.join(__dirname, '..', '..', 'assets', 'fonts', 'Hind-SemiBold.ttf');
const DIR = path.join(DATA_DIR, 'social');
const SIZES = { square: [1080, 1080], tall: [1000, 1500], wide: [1200, 675] };

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function text(str, { size, color = '#ffffff', width, bold = true, align = 'left', spacing }) {
  const { data, info } = await sharp({
    text: { text: `<span foreground="${color}">${esc(str)}</span>`, font: `Hind ${bold ? 'Bold' : 'SemiBold'} ${size}`, fontfile: bold ? FONT_BOLD : FONT_SEMI,
      width, rgba: true, align, spacing: spacing ?? Math.round(size * 0.18) }
  }).png().toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}

// Largest headline size that fits the box
async function fit(str, width, maxHeight, from, to) {
  for (let size = from; size >= to; size -= 4) {
    const t = await text(str, { size, width, spacing: 0 });
    if (t.height <= maxHeight) return t;
  }
  return text(str, { size: to, width, spacing: 0 });
}

function label(keyword) {
  const k = String(keyword || '').toLowerCase();
  if (/answer key/.test(k)) return 'आंसर-की';
  if (/admit card|hall ticket/.test(k)) return 'एडमिट कार्ड';
  if (/result|merit|cut ?off/.test(k)) return 'रिजल्ट';
  if (/syllabus|pattern/.test(k)) return 'सिलेबस';
  if (/exam date|schedule|time ?table/.test(k)) return 'परीक्षा तिथि';
  if (/admission|online form/.test(k) && !/recruit/.test(k)) return 'आवेदन';
  if (/recruit|vacanc|bharti|apprentice/.test(k)) return 'भर्ती';
  return 'सरकारी नौकरी';
}

function hostOf(base) { try { return new URL(base).hostname.replace(/^www\./, ''); } catch { return ''; } }

// Colour styles; each story takes the next one (by its id), so neighbouring posts look different
const THEMES = [
  { name: 'Teal', bg1: '#0b3d3a', bg2: '#0f5a54', bar: '#082e2c', accent: '#f2a516', ink: '#0b3d3a', pill: '#be123c', pts: '#fde68a' },
  { name: 'Royal blue', bg1: '#1e3a8a', bg2: '#2563eb', bar: '#172554', accent: '#facc15', ink: '#1e3a8a', pill: '#dc2626', pts: '#fde68a' },
  { name: 'Maroon', bg1: '#7f1d1d', bg2: '#b91c1c', bar: '#450a0a', accent: '#fbbf24', ink: '#7f1d1d', pill: '#1d4ed8', pts: '#fef3c7' },
  { name: 'Purple', bg1: '#4c1d95', bg2: '#7c3aed', bar: '#2e1065', accent: '#f9a8d4', ink: '#3b0764', pill: '#ea580c', pts: '#fbcfe8' },
  { name: 'Green', bg1: '#14532d', bg2: '#15803d', bar: '#052e16', accent: '#bef264', ink: '#14532d', pill: '#dc2626', pts: '#ecfccb' },
  { name: 'Breaking', bg1: '#111827', bg2: '#1f2937', bar: '#000000', accent: '#ef4444', ink: '#ffffff', pill: '#ef4444', pts: '#fde68a' }
];
const themeFor = news => THEMES[(Number(news.id) || [...String(news.slug)].reduce((a, c) => a + c.charCodeAt(0), 0)) % THEMES.length];

async function render(news, kind) {
  const T = themeFor(news);
  const [W, H] = SIZES[kind];
  const s = getSettings();
  const d = news.data || {};
  const site = s.site_name || 'NaukriSetu';
  const pad = 60, top = 150, footer = 150;
  const points = ((d.extra || [])[0]?.items || []).slice(0, kind === 'tall' ? 3 : 2);

  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${T.bg1}"/><stop offset="1" stop-color="${T.bg2}"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    <circle cx="${W - 40}" cy="${top + 40}" r="210" fill="#ffffff" opacity="0.04"/>
    <rect width="${W}" height="${top - 40}" fill="${T.bar}"/>
    <rect y="${top - 44}" width="${W}" height="6" fill="${T.accent}"/>
    <rect y="${H - footer}" width="${W}" height="${footer}" fill="${T.accent}"/>
  </svg>`);

  const layers = [];
  const brand = await text(site, { size: 44, width: W / 2 });
  layers.push({ ...brand, top: Math.round((top - 44 - brand.height) / 2) + 4, left: pad });
  const tag = await text('ताज़ा खबर', { size: 34, color: T.ink });
  const tagBox = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tag.width + 44}" height="${tag.height + 14}"><rect width="100%" height="100%" rx="12" fill="${T.accent}"/></svg>`);
  const tagLeft = W - pad - tag.width - 44, tagTop = Math.round((top - 44 - tag.height - 14) / 2) + 2;
  layers.push({ input: tagBox, top: tagTop, left: tagLeft }, { ...tag, top: tagTop + 9, left: tagLeft + 22 });

  // section pill + headline + key points, centred in the space between the bars
  const pill = await text(label(d.keyword || news.title), { size: 34, color: '#ffffff' });
  const pillBox = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${pill.width + 40}" height="${pill.height + 12}"><rect width="100%" height="100%" rx="10" fill="${T.pill}"/></svg>`);
  const pointsBlock = points.length ? await text(points.map(p => `•  ${p}`).join('\n'), { size: kind === 'tall' ? 40 : 36, color: T.pts, width: W - pad * 2, bold: false, spacing: 8 }) : null;
  const areaTop = top + 10, areaBottom = H - footer - 30;
  const fixed = pill.height + 12 + 28 + (pointsBlock ? 34 + pointsBlock.height : 0);
  const head = await fit(news.title, W - pad * 2, areaBottom - areaTop - fixed - 20, kind === 'tall' ? 88 : kind === 'wide' ? 64 : 80, 34);
  const block = fixed + head.height;
  let y = areaTop + Math.max(10, Math.round((areaBottom - areaTop - block) / 2));
  layers.push({ input: pillBox, top: y, left: pad }, { ...pill, top: y + 7, left: pad + 20 });
  y += pill.height + 12 + 28;
  layers.push({ ...head, top: y, left: pad });
  y += head.height + 34;
  if (pointsBlock) layers.push({ ...pointsBlock, top: y, left: pad });

  const cta = await text(`पूरी खबर पढ़ें:  ${site}`, { size: 42, color: T.ink });
  layers.push({ ...cta, top: H - footer + Math.round((footer - cta.height) / 2) + 4, left: pad });

  return sharp(bg).composite(layers.map(({ input, top, left }) => ({ input, top: Math.max(0, Math.round(top)), left: Math.round(left) })))
    .jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

// Cached on disk; a changed headline makes a new file
async function cardFile(news, kind = 'square') {
  fs.mkdirSync(DIR, { recursive: true });
  const v = require('crypto').createHash('md5').update(news.title + JSON.stringify((news.data.extra || [])[0] || '') + themeFor(news).name).digest('hex').slice(0, 8);
  const file = path.join(DIR, `${news.slug}-${kind}-${v}.jpg`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, await render(news, kind));
  return { file, name: path.basename(file) };
}

module.exports = { cardFile, DIR, label, THEMES };
