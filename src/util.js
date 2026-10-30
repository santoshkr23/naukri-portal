const RESERVED = new Set(['admin', 'static', 'search', 'og', 'feed', 'sitemap', 'robots', 'about-us', 'contact-us',
  'disclaimer', 'privacy-policy', 'latest-jobs', 'admit-card', 'result', 'answer-key', 'admission', 'syllabus', 'exam-date']);

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 90).replace(/-+$/, '');
}

function uniqueSlug(db, base, excludeId) {
  base = slugify(base) || 'post';
  let s = base, i = 2;
  const q = db.prepare('SELECT id FROM posts WHERE slug=?');
  while (RESERVED.has(s) || (() => { const r = q.get(s); return r && r.id !== excludeId; })()) s = `${base}-${i++}`;
  return s;
}

// "Label | Value" lines <-> [[label, value]]
function parseRows(text) {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .map(l => l.split('|').map(x => x.trim()));
}
function rowsToText(rows) {
  return (rows || []).map(r => (Array.isArray(r) ? r.join(' | ') : r)).join('\n');
}
function parseLines(text) {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

const STOP = new Set(('how to apply download check online form out released notification link direct now available ' +
  'the for and of a an in at on is new latest update updated date extended start started various post posts apply ' +
  'offline pdf official website vacancy bharti recruitment').split(' '));

// Same job announced by different sites should produce the same fingerprint
function fingerprint(title, category) {
  const tokens = String(title || '').toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/).filter(t => t && !STOP.has(t));
  return `${category || ''}:${[...new Set(tokens)].sort().join('-')}`;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// Loose date parser -> 'YYYY-MM-DD' or null
function parseDateLoose(s) {
  if (!s) return null;
  s = String(s);
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/);
  if (m) return iso(+m[3], +m[2] - 1, +m[1]);
  m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) return iso(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) return iso(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  return null;
}
function iso(y, mo, d) {
  if (y < 2000 || y > 2100 || mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function fmtDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr.length === 10 ? isoStr + 'T00:00:00' : isoStr.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return isoStr;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
function nowSql() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function truncate(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }

module.exports = { slugify, uniqueSlug, parseRows, rowsToText, parseLines, fingerprint, parseDateLoose, fmtDate, nowSql, pick, truncate, RESERVED };
