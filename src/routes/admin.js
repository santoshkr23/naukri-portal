const express = require('express');
const { db, CATEGORIES, getSettings, setSetting, log } = require('../db');
const { checkLogin, setSession, clearSession, requireAdmin } = require('../auth');
const { getById, savePost } = require('../posts');
const { parseRows, rowsToText, parseLines, parseDateLoose, truncate } = require('../util');
const scraper = require('../scraper');

const router = express.Router();
router.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('Cache-Control', 'no-store'); next(); });

router.get('/login', (req, res) => res.render('admin/login', { error: null }));
router.post('/login', (req, res) => {
  const err = checkLogin(req, req.body.user || '', req.body.pass || '');
  if (err) return res.status(401).render('admin/login', { error: err });
  setSession(res, req.secure);
  res.redirect('/admin');
});
router.post('/logout', (req, res) => { clearSession(res); res.redirect('/admin/login'); });

router.use(requireAdmin);

const flash = (res, msg) => res.redirect(`${res.req.baseUrl}${res.req.path === '/' ? '' : ''}?msg=${encodeURIComponent(msg)}`);

router.get('/', (req, res) => {
  const counts = db.prepare("SELECT status, COUNT(*) c FROM posts GROUP BY status").all();
  const byCat = db.prepare("SELECT category, COUNT(*) c FROM posts WHERE status='published' GROUP BY category").all();
  const today = db.prepare("SELECT COUNT(*) c FROM posts WHERE created_at >= datetime('now','-1 day')").get().c;
  const sources = db.prepare('SELECT * FROM sources ORDER BY id').all();
  const logs = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 15').all();
  res.render('admin/dashboard', { counts, byCat, today, sources, logs, running: scraper.isRunning(), msg: req.query.msg });
});

// ---------- Posts ----------
const PAGE_SIZE = 100;
// Shared by the list and the bulk actions, so "select all matching" acts on exactly what the filters show
function postFilter(f) {
  const where = [], args = [];
  if (f.status === 'published' || f.status === 'draft') { where.push('status=?'); args.push(f.status); }
  if (f.category) { where.push('category=?'); args.push(f.category); }
  if (f.source === 'auto') where.push('source_url IS NOT NULL');
  if (f.source === 'sheet') where.push('source_url IS NULL');
  if (f.issue === 'empty') where.push(`data LIKE '%"dates":[]%' AND data LIKE '%"links":[]%'`);
  if (f.issue === 'nodates') where.push(`data LIKE '%"dates":[]%'`);
  if (f.issue === 'closed') where.push("category='latest-jobs' AND last_date IS NOT NULL AND last_date < date('now','localtime')");
  if (f.q) { where.push('(title LIKE ? OR organization LIKE ?)'); args.push(`%${f.q}%`, `%${f.q}%`); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}
const readFilters = src => ({ status: src.status || '', category: src.category || '', source: src.source || '', issue: src.issue || '', q: String(src.q || '').trim() });

router.get('/posts', (req, res) => {
  const filters = readFilters(req.query);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const w = postFilter(filters);
  const total = db.prepare(`SELECT COUNT(*) c FROM posts ${w.sql}`).get(...w.args).c;
  const rows = db.prepare(`SELECT id,slug,title,category,status,source_url,last_date,created_at,published_at,
      (data LIKE '%"dates":[]%' AND data LIKE '%"links":[]%') AS empty FROM posts ${w.sql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...w.args, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  // counts for the status tabs, with the other filters applied
  const tabCount = st => { const x = postFilter({ ...filters, status: st }); return db.prepare(`SELECT COUNT(*) c FROM posts ${x.sql}`).get(...x.args).c; };
  const counts = { all: tabCount(''), published: tabCount('published'), draft: tabCount('draft') };
  const qs = extra => new URLSearchParams(Object.entries({ ...filters, ...extra }).filter(([, v]) => v !== '' && v != null)).toString();
  res.render('admin/posts', { rows, filters, counts, total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)), qs, msg: req.query.msg,
    today: new Date().toISOString().slice(0, 10) });
});

function deletePosts(ids) {
  const get = db.prepare('SELECT title, fingerprint FROM posts WHERE id=?');
  const remember = db.prepare('INSERT OR REPLACE INTO deleted_posts(fingerprint,title) VALUES(?,?)');
  const unlink = db.prepare('UPDATE seen_urls SET post_id=NULL WHERE post_id=?');
  const del = db.prepare('DELETE FROM posts WHERE id=?');
  db.transaction(list => { for (const id of list) { const p = get.get(id); if (!p) continue; if (p.fingerprint) remember.run(p.fingerprint, p.title); unlink.run(id); del.run(id); } })(ids);
}

router.post('/posts/bulk', (req, res) => {
  const back = '/admin/posts' + (req.body.back ? '?' + String(req.body.back).replace(/(^|&)msg=[^&]*/g, '') : '');
  const go = msg => res.redirect(back + (back.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent(msg));
  let ids;
  if (req.body.all === '1') {
    const w = postFilter(readFilters(req.body));
    ids = db.prepare(`SELECT id FROM posts ${w.sql}`).all(...w.args).map(r => r.id);
  } else ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) return go('Tick at least one post first.');

  const action = req.body.action;
  if (action === 'delete') { deletePosts(ids); return go(`Deleted ${ids.length} post${ids.length > 1 ? 's' : ''}.`); }
  if (action === 'publish' || action === 'draft') {
    let done = 0, empty = 0; const live = [];
    for (const id of ids) {
      const p = getById(id); if (!p || p.status === action || (action === 'draft' && p.status !== 'published')) continue;
      if (action === 'publish' && !(p.data.dates || []).length && !(p.data.links || []).length) { empty++; continue; } // nothing to show yet
      const saved = savePost({ ...p, status: action === 'publish' ? 'published' : 'draft' }, id); done++;
      if (action === 'publish') live.push(saved.slug);
    }
    if (live.length) scraper.pingIndexNow(live).catch(() => {});
    return go(`${action === 'publish' ? 'Published' : 'Unpublished'} ${done} post${done === 1 ? '' : 's'}.` +
      (empty ? ` ${empty} not published because they have no dates or links yet — open them and fill them in first.` : ''));
  }
  go('Choose an action.');
});

router.get('/posts/:id/preview', (req, res, next) => {
  const post = getById(+req.params.id);
  if (!post) return next();
  require('./public').renderPost(res, post);
});

const blank = { id: null, title: '', slug: '', category: 'latest-jobs', organization: '', total_posts: '', meta_description: '', status: 'draft', featured: 0,
  data: { intro: '', advt: '', dates: [], fees: [], age: [], salary: [], vacancyHeader: ['Post Name', 'Total Posts'], vacancy: [], eligibility: [], selection: [], howTo: [], links: [], faqs: [], extra: [] } };

router.get('/posts/new', (req, res) => res.render('admin/post-form', { post: blank, rowsToText, msg: null }));
router.get('/posts/:id', (req, res) => {
  const post = getById(+req.params.id);
  if (!post) return res.redirect('/admin/posts');
  res.render('admin/post-form', { post, rowsToText, msg: req.query.msg });
});

function formToPost(b) {
  const dates = parseRows(b.dates);
  const lastRow = dates.find(([k]) => /last\s*date|closing/i.test(k));
  const extra = [];
  String(b.extra || '').split(/\n\s*\n/).forEach(block => {
    const lines = parseLines(block); if (lines.length < 2) return;
    extra.push({ heading: lines[0].replace(/^#+\s*/, ''), items: lines.slice(1) });
  });
  const data = {
    intro: String(b.intro || '').trim(), advt: String(b.advt || '').trim(),
    dates, fees: parseRows(b.fees), age: parseRows(b.age), salary: parseRows(b.salary),
    vacancyHeader: parseRows(b.vacancyHeader)[0] || ['Post Name', 'Total Posts'], vacancy: parseRows(b.vacancy),
    eligibility: parseRows(b.eligibility), selection: parseLines(b.selection), howTo: parseLines(b.howTo),
    links: parseRows(b.links), faqs: parseRows(b.faqs), extra
  };
  return {
    title: String(b.title || '').trim(), slug: String(b.slug || '').trim(), category: CATEGORIES[b.category] ? b.category : 'latest-jobs',
    organization: b.organization, total_posts: b.total_posts, status: b.status === 'published' ? 'published' : 'draft', featured: b.featured === '1',
    meta_description: truncate(b.meta_description || data.intro, 160), short_info: truncate(data.intro, 280),
    last_date: lastRow ? parseDateLoose(lastRow[1]) : null, data
  };
}

router.post('/posts/save', (req, res) => {
  const p = formToPost(req.body);
  if (!p.title) return res.render('admin/post-form', { post: { ...blank, ...p, id: req.body.id || null }, rowsToText, msg: 'Title is required.' });
  const saved = savePost(p, req.body.id ? +req.body.id : null);
  if (saved.status === 'published') scraper.pingIndexNow([saved.slug]).catch(() => {});
  res.redirect(`/admin/posts/${saved.id}?msg=Saved`);
});
router.post('/posts/:id/status', (req, res) => {
  const post = getById(+req.params.id);
  const to = (req.query.to || req.body.status) === 'published' ? 'published' : 'draft';
  if (post) savePost({ ...post, status: to }, post.id);
  res.redirect('/admin/posts' + (req.body.back ? '?' + req.body.back : ''));
});
router.post('/posts/:id/delete', (req, res) => {
  deletePosts([+req.params.id]);
  res.redirect('/admin/posts' + (req.body.back ? '?' + String(req.body.back).replace(/(^|&)msg=[^&]*/g, '') + '&' : '?') + 'msg=Deleted');
});

// ---------- Sources ----------
router.get('/sources', (req, res) => {
  res.render('admin/sources', { sources: db.prepare('SELECT * FROM sources ORDER BY id').all(), msg: req.query.msg, running: scraper.isRunning() });
});
router.post('/sources/save', (req, res) => {
  const { id, name, list_url, link_selector, content_selector } = req.body;
  try { new URL(list_url); } catch { return res.redirect('/admin/sources?msg=' + encodeURIComponent('Enter a valid URL')); }
  const enabled = req.body.enabled === '1' ? 1 : 0;
  if (id) db.prepare('UPDATE sources SET name=?,list_url=?,link_selector=?,content_selector=?,enabled=? WHERE id=?').run(name, list_url, link_selector || null, content_selector || null, enabled, +id);
  else db.prepare('INSERT INTO sources(name,list_url,link_selector,content_selector,enabled) VALUES(?,?,?,?,?)').run(name || new URL(list_url).hostname, list_url, link_selector || null, content_selector || null, enabled);
  res.redirect('/admin/sources?msg=Source saved');
});
router.post('/sources/:id/delete', (req, res) => { db.prepare('DELETE FROM sources WHERE id=?').run(+req.params.id); res.redirect('/admin/sources?msg=Source removed'); });
router.post('/sources/:id/run', (req, res) => {
  const src = db.prepare('SELECT * FROM sources WHERE id=?').get(+req.params.id);
  if (src) scraper.runSource(src).then(r => log('info', `Manual check of ${src.name}: ${r.found} new links found, ${r.imported} imported${r.errors ? `, ${r.errors} errors` : ''}`)).catch(e => log('error', e.message));
  res.redirect('/admin/sources?msg=' + encodeURIComponent('Check started — see Logs in a minute'));
});
router.post('/run-all', (req, res) => {
  scraper.runAll('manual').catch(e => log('error', e.message));
  res.redirect('/admin?msg=' + encodeURIComponent('Import started — refresh in a minute'));
});
router.post('/import-url', async (req, res) => {
  const url = String(req.body.url || '').trim();
  try {
    const r = await scraper.importUrl(url, { forceDraft: true });
    if (r.post) return res.redirect(`/admin/posts/${r.post.id}?msg=${encodeURIComponent('Imported as draft — review and publish')}`);
    res.redirect('/admin?msg=' + encodeURIComponent(r.duplicate ? 'Already exists (duplicate)' : r.listing ? `That is a section page listing ${r.listing.length} posts, not a post. Paste one post's URL, or add this page as a source.` : `Skipped: ${r.skipped}`));
  } catch (e) { res.redirect('/admin?msg=' + encodeURIComponent('Import failed: ' + e.message)); }
});

// ---------- Excel import ----------
const multer = require('multer');
const excel = require('../excel-import');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.get('/import', (req, res) => res.render('admin/import', { report: null, hasFile: excel.hasDefaultFile(), msg: req.query.msg }));
router.get('/import/template.xlsx', (req, res) => excel.hasDefaultFile() ? res.download(excel.DEFAULT_FILE, 'posts-template.xlsx') : res.redirect('/admin/import'));
router.post('/import', upload.single('file'), async (req, res) => {
  try {
    const src = req.file ? req.file.buffer : excel.hasDefaultFile() ? excel.DEFAULT_FILE : null;
    if (!src) return res.render('admin/import', { report: null, hasFile: false, msg: 'Choose an .xlsx file first.' });
    if (req.file && !/\.xlsx$/i.test(req.file.originalname)) return res.render('admin/import', { report: null, hasFile: excel.hasDefaultFile(), msg: 'Only .xlsx files can be imported.' });
    const report = await excel.importWorkbook(src);
    const fresh = db.prepare("SELECT slug FROM posts WHERE status='published' AND updated_at >= datetime('now','-2 minutes')").all().map(r => r.slug);
    if (fresh.length) scraper.pingIndexNow(fresh).catch(() => {});
    res.render('admin/import', { report, hasFile: excel.hasDefaultFile(), msg: null });
  } catch (e) { res.render('admin/import', { report: null, hasFile: excel.hasDefaultFile(), msg: 'Import failed: ' + e.message }); }
});

// ---------- Settings & logs ----------
router.get('/settings', (req, res) => res.render('admin/settings', { s: getSettings(), msg: req.query.msg }));
router.post('/settings', (req, res) => {
  const keys = ['site_name', 'site_tagline', 'home_intro', 'max_per_run', 'first_run_limit', 'telegram_url', 'whatsapp_url', 'contact_email', 'google_verification', 'ga_id', 'adsense_client'];
  for (const k of keys) setSetting(k, String(req.body[k] ?? '').trim());
  setSetting('auto_publish', req.body.auto_publish === '1' ? '1' : '0');
  res.redirect('/admin/settings?msg=Settings saved');
});
router.get('/logs', (req, res) => res.render('admin/logs', { logs: db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 300').all() }));

module.exports = router;
