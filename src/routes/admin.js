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
router.get('/posts', (req, res) => {
  const { status = '', category = '', q = '' } = req.query;
  const where = [], args = [];
  if (status) { where.push('status=?'); args.push(status); }
  if (category) { where.push('category=?'); args.push(category); }
  if (q) { where.push('title LIKE ?'); args.push(`%${q}%`); }
  const rows = db.prepare(`SELECT id,slug,title,category,status,source_url,created_at,published_at FROM posts
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`).all(...args);
  res.render('admin/posts', { rows, filters: { status, category, q }, msg: req.query.msg });
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
  if (post) savePost({ ...post, status: req.body.status === 'published' ? 'published' : 'draft' }, post.id);
  res.redirect(req.get('referer') || '/admin/posts');
});
router.post('/posts/:id/delete', (req, res) => {
  db.prepare('UPDATE seen_urls SET post_id=NULL WHERE post_id=?').run(+req.params.id);
  db.prepare('DELETE FROM posts WHERE id=?').run(+req.params.id);
  res.redirect('/admin/posts?msg=Deleted');
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
    res.redirect('/admin?msg=' + encodeURIComponent(r.duplicate ? 'Already exists (duplicate)' : `Skipped: ${r.skipped}`));
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
