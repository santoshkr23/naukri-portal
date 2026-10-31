// Posting API for automation tools (n8n, Make, Zapier, an AI agent…).
// Auth: header  Authorization: Bearer <API key>   (or X-API-Key: <key>). Make the key in Admin → API.
// A post sent here is built exactly like an Excel row: same wording, banner, news story and social posting.
const express = require('express');
const crypto = require('crypto');
const { db, CATEGORIES, getSettings, setSetting, log, parsePost, siteUrl } = require('../db');
const { savePost, getById, getBySlug } = require('../posts');
const { fingerprint, parseDateLoose } = require('../util');
const { buildPost } = require('../seed-jobs');
const { buildUpdate } = require('../seed-updates');
const xl = require('../excel-import');

const router = express.Router();
router.use(express.json({ limit: '1mb' }));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex'); next(); });

// ---------- keys ----------
const hash = k => crypto.createHash('sha256').update(String(k)).digest('hex');
function keyHashes() {
  const s = getSettings();
  return [s.api_key_hash, process.env.API_KEY && hash(process.env.API_KEY)].filter(Boolean);
}
function newKey() {
  const key = 'nsk_' + crypto.randomBytes(24).toString('base64url');
  setSetting('api_key_hash', hash(key));
  setSetting('api_key_hint', key.slice(0, 8) + '…' + key.slice(-4));
  return key;
}
const hits = new Map(); // simple rate limit: 120 requests a minute per key
router.use((req, res, next) => {
  const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.get('x-api-key') || '';
  const h = given && hash(given);
  const ok = h && keyHashes().some(x => x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
  if (!ok) return res.status(401).json({ ok: false, error: keyHashes().length ? 'Missing or wrong API key (send: Authorization: Bearer <key>)' : 'API is off — create a key in Admin → API' });
  const now = Date.now(), w = hits.get(h) || { n: 0, t: now };
  if (now - w.t > 60000) { w.n = 0; w.t = now; }
  if (++w.n > 120) return res.status(429).json({ ok: false, error: 'Too many requests — max 120 per minute' });
  hits.set(h, w);
  next();
});

// ---------- input helpers: accept arrays, objects or "Label: value" lines ----------
const str = v => (v == null ? '' : String(v)).trim();
function pairs(v, sep = /:\s+/) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => Array.isArray(x) ? [str(x[0]), str(x[1])] : typeof x === 'object' ? [str(x.label ?? x.name ?? x.post ?? x.key ?? x.q), str(x.value ?? x.count ?? x.text ?? x.url ?? x.a)] : splitOne(str(x), sep)).filter(([k]) => k);
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => [str(k), str(x)]);
  return String(v).split(/\r?\n/).map(l => l.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, '').trim()).filter(Boolean).map(l => splitOne(l, sep));
}
function splitOne(l, sep) { const m = l.split(sep); return m.length > 1 ? [m[0].trim(), m.slice(1).join(' ').trim()] : [l, '']; }
const list = v => !v ? [] : Array.isArray(v) ? v.map(str).filter(Boolean) : String(v).split(/\r?\n/).map(s => s.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, '').trim()).filter(Boolean);
const tidy = rows => rows.map(([k, v]) => [k, xl.tidyDates(v)]);
const SECTION_ALIASES = { job: 'latest-jobs', jobs: 'latest-jobs', 'latest-job': 'latest-jobs', admitcard: 'admit-card', 'admit-cards': 'admit-card', results: 'result', answerkey: 'answer-key', 'answer-keys': 'answer-key', examdate: 'exam-date', 'exam-dates': 'exam-date' };
function sectionOf(v) {
  const k = String(v || 'latest-jobs').toLowerCase().trim().replace(/[\s_]+/g, '-');
  const c = SECTION_ALIASES[k] || SECTION_ALIASES[k.replace(/-/g, '')] || k;
  return CATEGORIES[c] && c !== 'news' ? c : null;
}

// Body → the same post the Excel import would make
function buildFromBody(b, today) {
  const errors = [];
  const category = sectionOf(b.section || b.category);
  if (!category) errors.push(`section must be one of: ${Object.keys(CATEGORIES).filter(k => k !== 'news').join(', ')}`);
  const title = str(b.title || b.post_name);
  if (!title) errors.push('title is required');
  const org = str(b.organisation || b.organization || b.org);
  const links = pairs(b.links || b.official_links, /:\s+(?=https?:\/\/)|\s+\|\s+/).filter(([, u]) => /^https?:\/\//i.test(u));
  if (!links.length) errors.push('links: at least one official https:// link is required');
  const dates = tidy(pairs(b.dates || b.important_dates));
  if (errors.length) return { errors };

  if (category === 'latest-jobs') {
    const last = parseDateLoose(str(b.last_date)) || parseDateLoose((dates.find(([k]) => /last date(?!.*fee)/i.test(k)) || [])[1]);
    if (!last) return { errors: ['last_date is required for latest-jobs (e.g. "2026-11-30" or "30 November 2026")'] };
    if (last < today && !b.allow_closed) return { errors: [`last_date ${last} has passed — send allow_closed: true to post it anyway`] };
    if (!dates.length || !dates.some(([k]) => /last date/i.test(k))) dates.push(['Last date to apply', xl.longDate(last)]);
    const age = pairs(b.age);
    if (b.min_age) age.unshift(['Minimum age', str(b.min_age)]);
    if (b.max_age) age.push(['Maximum age', str(b.max_age)]);
    const vacancy = pairs(b.vacancy, /\s+[–-]\s+(?=[\d,]+$)|:\s+/);
    const total = str(b.total_posts).replace(/,/g, '');
    const elig = pairs(b.eligibility, /\s+[–-]\s+|:\s+/).map(([k, v]) => (v ? [k, v] : ['All posts', k]));
    const catWise = list(b.category_wise_vacancy);
    const j = {
      base: title, short: '', name: title, org, advt: str(b.advt || b.advt_no), total, last, dates,
      fees: pairs(b.fees || b.application_fee), age, salary: pairs(b.pay || b.salary),
      vacancy: vacancy.length ? vacancy : total ? [['Total', total]] : [], eligibility: elig.length ? elig : [['All posts', 'See official notification']],
      selection: list(b.selection || b.selection_process).length ? list(b.selection || b.selection_process) : ['As per official notification'],
      links, extra: catWise.length ? [{ heading: 'Category-wise vacancy', items: catWise }] : []
    };
    const p = buildPost(j);
    return { post: xl.personalise(p, str(b.short_info || b.intro), list(b.how_to_apply).join('\n'), faqText(b.faqs)) };
  }
  const [short, name] = xl.splitTitle(title, org);
  const pat = Array.isArray(b.exam_pattern) && Array.isArray(b.exam_pattern[0]) ? b.exam_pattern.map(r => r.map(str)) : list(b.exam_pattern).map(l => l.split('|').map(x => x.trim()));
  const u = {
    category, base: title, short, name, org, advt: str(b.advt || b.advt_no), total: str(b.total_posts).replace(/,/g, ''),
    dates, last: parseDateLoose(str(b.last_date)) || parseDateLoose((dates.find(([k]) => /last date/i.test(k)) || [])[1]),
    login: list(b.login || b.login_needed), nextStages: list(b.next_stages), fees: pairs(b.fees),
    eligibility: pairs(b.eligibility, /\s+[–-]\s+|:\s+/).map(([k, v]) => (v ? [k, v] : ['All candidates', k])),
    pattern: pat.length > 1 ? { header: pat[0], rows: pat.slice(1) } : null, notes: list(b.marking || b.notes), topics: pairs(b.topics || b.main_topics), links
  };
  if (!u.login.length && /admit-card|answer-key/.test(category)) u.login = ['Registration number', 'Password or date of birth'];
  return { post: xl.personalise(buildUpdate(u), str(b.short_info || b.intro)) };
}
function faqText(f) {
  if (!f) return '';
  if (typeof f === 'string') return f;
  return (Array.isArray(f) ? f : []).map(x => Array.isArray(x) ? `Q: ${x[0]} A: ${x[1]}` : `Q: ${x.q || x.question} A: ${x.a || x.answer}`).join(' ');
}

const pub = p => {
  const base = siteUrl();
  const news = db.prepare("SELECT slug, status FROM posts WHERE fingerprint=?").get(`news:${p.fingerprint}`);
  return { id: p.id, title: p.title, section: p.category, status: p.status, slug: p.slug, url: `${base}/${p.slug}/`,
    banner: p.category !== 'news' ? `${base}/banner/${p.slug}.jpg` : null, news_url: news && news.status === 'published' ? `${base}/${news.slug}/` : null,
    last_date: p.last_date, total_posts: p.total_posts, organisation: p.organization, published_at: p.published_at, updated_at: p.updated_at };
};
const find = idOrSlug => /^\d+$/.test(idOrSlug) ? getById(+idOrSlug) : getBySlug(idOrSlug);

// ---------- endpoints ----------
router.get('/ping', (req, res) => res.json({ ok: true, site: getSettings().site_name, url: siteUrl(), time: new Date().toISOString() }));
router.get('/sections', (req, res) => res.json({ ok: true, sections: Object.entries(CATEGORIES).filter(([k]) => k !== 'news').map(([k, c]) => ({ id: k, name: c.name })) }));

// Create or update (matched by title + section). ?dry_run=1 checks without saving.
router.post('/posts', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const items = Array.isArray(req.body) ? req.body : Array.isArray(req.body?.posts) ? req.body.posts : [req.body || {}];
  if (items.length > 50) return res.status(400).json({ ok: false, error: 'Max 50 posts per request' });
  const dry = req.query.dry_run === '1' || req.body?.dry_run === true;
  const results = [];
  for (const b of items) {
    const r = buildFromBody(b || {}, today);
    if (r.errors) { results.push({ ok: false, title: b?.title || null, errors: r.errors }); continue; }
    const p = r.post;
    p.status = String(b.status || 'publish').toLowerCase().startsWith('draft') ? 'draft' : 'published';
    p.featured = b.featured === true;
    p.fingerprint = fingerprint(p.base, p.category);
    if (dry) { results.push({ ok: true, dry_run: true, title: p.title, section: p.category, slug_preview: require('../util').slugify(p.slug), data: p.data }); continue; }
    if (db.prepare('SELECT 1 FROM deleted_posts WHERE fingerprint=?').get(p.fingerprint) && !b.restore) { results.push({ ok: false, title: p.title, errors: ['this post was deleted in the admin — send restore: true to post it again'] }); continue; }
    if (b.restore) db.prepare('DELETE FROM deleted_posts WHERE fingerprint=?').run(p.fingerprint);
    const old = db.prepare('SELECT id, slug, featured FROM posts WHERE fingerprint=?').get(p.fingerprint);
    const saved = old ? savePost({ ...p, slug: old.slug, featured: p.featured || !!old.featured }, old.id) : savePost(p);
    if (saved.status === 'published') require('../scraper').pingIndexNow([saved.slug]).catch(() => {});
    log('info', `API: ${old ? 'updated' : 'created'} "${saved.title}" (${saved.status})`);
    results.push({ ok: true, action: old ? 'updated' : 'created', ...pub(saved) });
  }
  const single = !Array.isArray(req.body) && !Array.isArray(req.body?.posts);
  const anyOk = results.some(r => r.ok);
  res.status(anyOk ? (single && results[0].action === 'created' ? 201 : 200) : 400).json(single ? results[0] : { ok: anyOk, results });
});

router.get('/posts', (req, res) => {
  const where = ["category<>'news'"], args = [];
  if (req.query.section) { const c = sectionOf(req.query.section); if (c) { where.push('category=?'); args.push(c); } }
  if (req.query.status) { where.push('status=?'); args.push(/^draft|unpub/i.test(req.query.status) ? 'draft' : 'published'); }
  if (req.query.q) { where.push('(title LIKE ? OR organization LIKE ?)'); args.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const limit = Math.min(100, Math.max(1, +req.query.limit || 20)), offset = Math.max(0, +req.query.offset || 0);
  const rows = db.prepare(`SELECT * FROM posts WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM posts WHERE ${where.join(' AND ')}`).get(...args).c;
  res.json({ ok: true, total, limit, offset, posts: rows.map(pub) });
});
router.get('/posts/:id', (req, res) => {
  const p = find(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, ...pub(p), data: p.data });
});
// { "status": "publish" | "draft" }
router.patch('/posts/:id', (req, res) => {
  const p = find(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Not found' });
  const st = String(req.body?.status || '').toLowerCase();
  if (!/^(publish|published|draft|unpublish)$/.test(st)) return res.status(400).json({ ok: false, error: 'Send { "status": "publish" } or { "status": "draft" } — to change content, POST the post again' });
  const saved = savePost({ ...p, status: /^publish/.test(st) ? 'published' : 'draft' }, p.id);
  log('info', `API: ${saved.status === 'published' ? 'published' : 'unpublished'} "${saved.title}"`);
  res.json({ ok: true, ...pub(saved) });
});
router.delete('/posts/:id', (req, res) => {
  const p = find(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Not found' });
  db.prepare('INSERT OR REPLACE INTO deleted_posts(fingerprint,title) VALUES(?,?)').run(p.fingerprint, p.title);
  require('../news').deleteNewsFor(p.fingerprint);
  db.prepare('UPDATE seen_urls SET post_id=NULL WHERE post_id=?').run(p.id);
  db.prepare('DELETE FROM posts WHERE id=?').run(p.id);
  log('info', `API: deleted "${p.title}"`);
  res.json({ ok: true, deleted: p.id });
});
router.use((req, res) => res.status(404).json({ ok: false, error: 'Unknown endpoint — see Admin → API for the list' }));
router.use((err, req, res, next) => res.status(err.type === 'entity.parse.failed' ? 400 : 500).json({ ok: false, error: err.type === 'entity.parse.failed' ? 'Body is not valid JSON' : 'Server error' }));

router.newKey = newKey;
router.keyConfigured = () => keyHashes().length > 0;
module.exports = router;
