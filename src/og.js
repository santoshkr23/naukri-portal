// Generates an original share image per post (no third-party photos are ever used)
const fs = require('fs');
const path = require('path');
const { DATA_DIR, CATEGORIES } = require('./db');

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function wrap(text, max) {
  const words = text.split(/\s+/); const lines = []; let line = '';
  for (const w of words) { if ((line + ' ' + w).trim().length > max) { lines.push(line.trim()); line = w; } else line += ' ' + w; }
  if (line.trim()) lines.push(line.trim());
  return lines.slice(0, 4);
}

async function ogImage(post, siteName) {
  const dir = path.join(DATA_DIR, 'og'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${post.slug}.png`);
  if (fs.existsSync(file)) return file;
  const cat = (CATEGORIES[post.category] || { name: 'Update' }).name.toUpperCase();
  let data = {}; try { data = typeof post.data === 'string' ? JSON.parse(post.data) : post.data || {}; } catch {}
  const text = post.category === 'news' && data.keyword ? data.keyword : post.title;
  // shrink the type until the longest line fits the 1080px text area (bold DejaVu is ~0.64em per character)
  let size = 58, lines = wrap(text, 30);
  while (size > 36 && Math.max(...lines.map(l => l.length)) * size * 0.64 > 1080) { size -= 2; lines = wrap(text, Math.floor(1080 / (size * 0.64))); }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b3d3a"/><stop offset="1" stop-color="#12655f"/></linearGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <rect x="0" y="560" width="1200" height="70" fill="#f2a516"/>
  <rect x="60" y="60" rx="10" width="${cat.length * 22 + 50}" height="54" fill="#f2a516"/>
  <text x="85" y="98" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="28" fill="#0b3d3a">${xml(cat)}</text>
  ${lines.map((l, i) => `<text x="60" y="${210 + i * Math.round(size * 1.34)}" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${size}" fill="#ffffff">${xml(l)}</text>`).join('')}
  <text x="60" y="606" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="30" fill="#0b3d3a">${xml(siteName)}</text>
  <text x="1140" y="606" text-anchor="end" font-family="DejaVu Sans, Arial, sans-serif" font-size="26" fill="#0b3d3a">Dates • Eligibility • Official Links</text>
</svg>`;
  const sharp = require('sharp');
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(file);
  return file;
}

module.exports = { ogImage };
