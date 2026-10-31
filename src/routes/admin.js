const express = require('express');
const { db, CATEGORIES, getSettings, setSetting, log } = require('../db');
const { checkLogin, setSession, clearSession, requireAdmin, need, can, ROLES, hashPassword, passwordProblem } = require('../auth');
const audit = require('../audit');
const { getById, savePost } = require('../posts');
const { parseRows, rowsToText, parseLines, parseDateLoose, truncate } = require('../util');
const scraper = require('../scraper');

const router = express.Router();
router.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('Cache-Control', 'no-store'); next(); });

router.get('/login', (req, res) => res.render('admin/login', { error: null }));
router.post('/login', (req, res) => {
  const r = checkLogin(req, req.body.user || '', req.body.pass || '');
  if (r.error) { audit.record(String(req.body.user || '?').slice(0, 40), 'login failed', null, req.ip); return res.status(401).render('admin/login', { error: r.error }); }
  setSession(res, req.secure, r.user);
  audit.record({ user: r.user, ip: req.ip }, 'signed in');
  res.redirect('/admin');
});
router.post('/logout', (req, res) => { clearSession(res); res.redirect('/admin/login'); });

router.use(requireAdmin);

// ---------- who may open what (each role's list is in src/auth.js) ----------
const RULES = [
  [/^\/(launch)/, 'launch'], [/^\/(sources|run-all)/, 'sources'], [/^\/import-url/, 'import'], [/^\/import/, 'import'],
  [/^\/social\/(share|preview)/, 'social.share'], [/^\/social/, 'social.settings'],
  [/^\/notifications\/(send|run)/, 'notifications.send'], [/^\/notifications/, 'notifications.settings'],
  [/^\/api/, 'api'], [/^\/keep-settings/, 'keep'], [/^\/settings/, 'settings'], [/^\/logs/, 'logs'],
  [/^\/team/, 'users'], [/^\/activity/, 'activity'], [/^\/trash\/\d+\/purge/, 'trash.purge'], [/^\/trash/, 'trash'],
  [/^\/posts\/\d+\/delete/, 'posts.delete'], [/^\/posts\/\d+\/status/, 'posts.publish'], [/^\/posts/, 'posts.view']
];
router.use((req, res, next) => {
  if (req.path.startsWith('/account')) return next(); // everyone can change their own password
  const rule = RULES.find(([re]) => re.test(req.path));
  return rule ? need(rule[1])(req, res, next) : next();
});

const flash = (res, msg) => res.redirect(`${res.req.baseUrl}${res.req.path === '/' ? '' : ''}?msg=${encodeURIComponent(msg)}`);

router.get('/', (req, res) => {
  const counts = db.prepare("SELECT status, COUNT(*) c FROM posts GROUP BY status").all();
  const byCat = db.prepare("SELECT category, COUNT(*) c FROM posts WHERE status='published' GROUP BY category").all();
  const today = db.prepare("SELECT COUNT(*) c FROM posts WHERE created_at >= datetime('now','-1 day')").get().c;
  const sources = db.prepare('SELECT * FROM sources ORDER BY id').all();
  const logs = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 15').all();
  const lcBad = can(req.user, 'launch') ? require('../launch').checks(req).filter(x => x.status === 'bad').length : 0;
  res.render('admin/dashboard', { counts, byCat, today, sources, logs, running: scraper.isRunning(), msg: req.query.msg, lcBad });
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

// Deleting moves posts to the recycle bin (restorable for 30 days)
const deletePosts = (ids, req) => audit.trashPosts(ids, req);

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
  const perm = { delete: 'posts.delete', publish: 'posts.publish', draft: 'posts.publish', share: 'social.share' }[action];
  if (perm && !can(req.user, perm)) return go(`✗ Your role (${ROLES[req.user.role].name}) can't ${action === 'draft' ? 'unpublish' : action} posts — ask the owner.`);
  if (action === 'delete') {
    if (ids.length > 25 && req.user.role !== 'owner') return go('✗ Only the owner can delete more than 25 posts at once.');
    const n = deletePosts(ids, req);
    return go(`Moved ${n} post${n === 1 ? '' : 's'} to the recycle bin — restore them from Recycle bin within 30 days.`);
  }
  if (action === 'publish' || action === 'draft') {
    let done = 0, empty = 0; const live = [];
    for (const id of ids) {
      const p = getById(id); if (!p || p.status === action || (action === 'draft' && p.status !== 'published')) continue;
      if (action === 'publish' && !(p.data.dates || []).length && !(p.data.links || []).length) { empty++; continue; } // nothing to show yet
      const saved = savePost({ ...p, status: action === 'publish' ? 'published' : 'draft' }, id); done++;
      audit.record(req, action === 'publish' ? 'published' : 'unpublished', saved);
      if (action === 'publish') live.push(saved.slug);
    }
    if (live.length) scraper.pingIndexNow(live).catch(() => {});
    return go(`${action === 'publish' ? 'Published' : 'Unpublished'} ${done} post${done === 1 ? '' : 's'}.` +
      (empty ? ` ${empty} not published because they have no dates or links yet — open them and fill them in first.` : ''));
  }
  if (action === 'share') {
    const news = social.newsIdsFor(ids);
    const n = social.enqueue(news);
    audit.record(req, 'shared to social', null, `${n} stories queued`);
    const ready = Object.keys(social.PLATFORMS).filter(p => social.cfg()[p].ready).length;
    return go(ready ? `Queued ${n} news stor${n === 1 ? 'y' : 'ies'} for social media (${news.length - n} already queued). A few are posted every 5 minutes — see Social media.`
      : 'No social account is set up yet — go to Social media first.');
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

router.post('/posts/save', need('posts.edit'), (req, res) => {
  const p = formToPost(req.body);
  if (!p.title) return res.render('admin/post-form', { post: { ...blank, ...p, id: req.body.id || null }, rowsToText, msg: 'Title is required.' });
  const old = req.body.id ? getById(+req.body.id) : null;
  if (old) { const keep = { ...old.data }; delete keep.auto; p.data = { ...keep, ...p.data }; }
  if (!can(req.user, 'posts.publish')) {
    if (old && old.status === 'published') return res.render('admin/post-form', { post: { ...old, ...p, id: old.id }, rowsToText, msg: '✗ This post is live — only an Editor, Admin or the Owner can change it. Ask one of them.' });
    p.status = 'draft'; p.featured = false;
  }
  const saved = savePost(p, old ? old.id : null);
  audit.record(req, old ? (old.status !== saved.status ? (saved.status === 'published' ? 'published' : 'unpublished') : 'edited') : 'created', saved, saved.status);
  if (saved.status === 'published') scraper.pingIndexNow([saved.slug]).catch(() => {});
  res.redirect(`/admin/posts/${saved.id}?msg=Saved`);
});
router.post('/posts/:id/status', (req, res) => {
  const post = getById(+req.params.id);
  const to = (req.query.to || req.body.status) === 'published' ? 'published' : 'draft';
  if (post) { const saved = savePost({ ...post, status: to }, post.id); audit.record(req, to === 'published' ? 'published' : 'unpublished', saved); }
  res.redirect('/admin/posts' + (req.body.back ? '?' + req.body.back : ''));
});
router.post('/posts/:id/delete', (req, res) => {
  deletePosts([+req.params.id], req);
  res.redirect('/admin/posts' + (req.body.back ? '?' + String(req.body.back).replace(/(^|&)msg=[^&]*/g, '') + '&' : '?') + 'msg=' + encodeURIComponent('Moved to the recycle bin'));
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
router.post('/sources/:id/delete', (req, res, next) => { audit.record(req, 'removed an auto-import source', null, String(req.params.id)); next(); });
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
    audit.record(req, 'imported Excel', null, `${report.created.length} new, ${report.updated.length} updated${req.file ? ' — ' + req.file.originalname : ''}`);
    const fresh = db.prepare("SELECT slug FROM posts WHERE status='published' AND updated_at >= datetime('now','-2 minutes')").all().map(r => r.slug);
    if (fresh.length) scraper.pingIndexNow(fresh).catch(() => {});
    res.render('admin/import', { report, hasFile: excel.hasDefaultFile(), msg: null });
  } catch (e) { res.render('admin/import', { report: null, hasFile: excel.hasDefaultFile(), msg: 'Import failed: ' + e.message }); }
});

// ---------- Social media ----------
const social = require('../social');
router.get('/social', (req, res) => {
  const s = getSettings(), c = social.cfg();
  const latest = db.prepare("SELECT id, slug, title FROM posts WHERE category='news' AND status='published' ORDER BY published_at DESC, id DESC LIMIT 1").get();
  const logRows = db.prepare(`SELECT l.*, p.title, p.slug FROM social_log l LEFT JOIN posts p ON p.id=l.post_id ORDER BY l.id DESC LIMIT 60`).all();
  const queued = db.prepare('SELECT COUNT(*) c FROM social_queue').get().c;
  const inDb = new Set(db.prepare('SELECT key FROM settings').all().map(r => r.key));
  const fromEnv = Object.fromEntries(Object.values(social.PLATFORMS).flatMap(p => p.keys).map(k => [k, !inDb.has(k) && !!process.env[k.toUpperCase()]]));
  res.render('admin/social', { s, c, PLATFORMS: social.PLATFORMS, SECRET: social.SECRET_KEYS, latest, logRows, queued, fromEnv, msg: req.query.msg,
    baseUrl: require('../db').siteUrl(), baseFrom: process.env.BASE_URL ? 'BASE_URL' : process.env.RENDER_EXTERNAL_URL ? 'Render' : s.site_url ? 'detected' : '',
    lastOk: db.prepare("SELECT created_at FROM social_log WHERE status='ok' ORDER BY id DESC LIMIT 1").get()?.created_at,
    lastErr: db.prepare("SELECT created_at, platform, error FROM social_log WHERE status='error' ORDER BY id DESC LIMIT 1").get(),
    upSince: new Date(Date.now() - process.uptime() * 1000).toISOString().replace('T', ' ').slice(0, 16) });
});
// What each field must look like — catches a browser auto-filling the admin login into these boxes
const SOCIAL_FORMAT = {
  tg_token: [/^\d{5,}:[A-Za-z0-9_-]{30,}$/, 'Telegram bot token looks like 123456789:AAH… (copy it again from @BotFather)'],
  tg_chats: [/^(@[A-Za-z][A-Za-z0-9_]{3,}|-?\d{5,})([\s,]+(@[A-Za-z][A-Za-z0-9_]{3,}|-?\d{5,}))*$/, 'Telegram channel must be @username or a number like -1001234567890'],
  fb_page_id: [/^\d{5,}$/, 'Facebook Page ID is a number'],
  ig_user_id: [/^\d{5,}$/, 'Instagram account ID is a number (e.g. 1784…)'],
  pin_board: [/^\d{5,}$/, 'Pinterest Board ID is a number'],
  fb_token: [/^EA[A-Za-z0-9]{40,}$/, 'Facebook token starts with EA…'],
  ig_token: [/^(EA|IG)[A-Za-z0-9]{40,}$/, 'Instagram token starts with EA… or IG…'],
  pin_token: [/^[A-Za-z0-9_.\-]{20,}$/, 'Pinterest token looks wrong'],
  x_api_key: [/^[A-Za-z0-9]{15,}$/, 'X API key looks wrong'], x_api_secret: [/^[A-Za-z0-9]{30,}$/, 'X API key secret looks wrong'],
  x_access_token: [/^\d+-[A-Za-z0-9]{20,}$/, 'X access token looks like 12345-AbC…'], x_access_secret: [/^[A-Za-z0-9]{30,}$/, 'X access token secret looks wrong']
};
function saveSocial(req) {
  const problems = [];
  const login = [process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASSWORD].filter(Boolean);
  for (const p of Object.keys(social.PLATFORMS)) {
    setSetting(`${p}_enabled`, req.body[`${p}_enabled`] === '1' ? '1' : '0');
    for (const k of social.PLATFORMS[p].keys) {
      const v = String(req.body[k] ?? '').trim();
      if (social.SECRET_KEYS.includes(k) && !v) continue; // blank secret field = keep the saved one
      if (v && (login.includes(v) || (SOCIAL_FORMAT[k] && !SOCIAL_FORMAT[k][0].test(v)))) {
        problems.push(login.includes(v) ? `${social.PLATFORMS[p].name}: your browser filled in your admin login — enter the real value` : SOCIAL_FORMAT[k][1]);
        continue; // keep the previous value
      }
      setSetting(k, v);
    }
  }
  setSetting('social_auto', req.body.social_auto === '1' ? '1' : '0');
  setSetting('social_excel', req.body.social_excel === '1' ? '1' : '0');
  setSetting('social_per_run', String(Math.min(20, Math.max(1, +req.body.social_per_run || 3))));
  setSetting('social_hashtags', String(req.body.social_hashtags || '').trim());
  setSetting('graph_version', String(req.body.graph_version || '').trim());
  return problems;
}
router.post('/social', (req, res, next) => { audit.record(req, 'changed social media settings'); next(); });
router.post('/social', (req, res) => {
  const problems = saveSocial(req);
  res.redirect('/admin/social?msg=' + encodeURIComponent(problems.length ? `✗ Not saved: ${problems.join(' · ')}. Everything else was saved.` : 'Saved'));
});
router.post('/social/forget/:key', (req, res) => {
  if (social.SECRET_KEYS.includes(req.params.key)) setSetting(req.params.key, '');
  res.redirect('/admin/social?msg=' + encodeURIComponent('Removed'));
});
router.post('/social/check/:platform', async (req, res) => {
  const p = req.params.platform;
  if (!social.PLATFORMS[p]) return res.redirect('/admin/social');
  if (req.body.tg_chats !== undefined) { const problems = saveSocial(req); if (problems.length) return res.redirect('/admin/social?msg=' + encodeURIComponent(`✗ Not saved: ${problems.join(' · ')}`)); }
  try { res.redirect('/admin/social?msg=' + encodeURIComponent(`✓ ${social.PLATFORMS[p].name} connected: ${await social.checkPlatform(p)}`)); }
  catch (e) { res.redirect('/admin/social?msg=' + encodeURIComponent(`✗ ${social.PLATFORMS[p].name}: ${e.message}`)); }
});
router.post('/social/share/:id', async (req, res) => {
  const [id] = social.newsIdsFor([+req.params.id]);
  if (!id) return res.redirect('/admin/social?msg=' + encodeURIComponent('No published news story for that post.'));
  const r = await social.sharePost(id, req.body.platform || undefined);
  const txt = (r.results || []).map(x => `${social.PLATFORMS[x.platform].name}: ${x.ok ? 'posted' : x.error}`).join(' · ') || 'Already shared everywhere that is turned on.';
  res.redirect('/admin/social?msg=' + encodeURIComponent(txt));
});
router.post('/social/run', async (req, res) => {
  const r = await social.processQueue();
  res.redirect('/admin/social?msg=' + encodeURIComponent(`Shared ${r.shared} stor${r.shared === 1 ? 'y' : 'ies'} from the queue.`));
});
router.get('/social/preview/:id/:kind.jpg', async (req, res, next) => {
  const p = getById(+req.params.id);
  if (!p || p.category !== 'news' || !['square', 'tall'].includes(req.params.kind)) return next();
  const img = await social.postImage(p);
  res.type('jpg').sendFile(img[req.params.kind].file);
});

// ---------- Job alerts (browser notifications) ----------
router.get('/notifications', (req, res) => {
  const push = require('../push'); push.keys();
  const s = getSettings();
  const byDevice = db.prepare(`SELECT CASE WHEN ua LIKE '%Android%' THEN 'Android' WHEN ua LIKE '%iPhone%' OR ua LIKE '%iPad%' THEN 'iPhone / iPad'
    WHEN ua LIKE '%Windows%' THEN 'Windows' WHEN ua LIKE '%Mac OS%' THEN 'Mac' ELSE 'Other' END d, COUNT(*) c FROM push_subs GROUP BY d ORDER BY c DESC`).all();
  const week = db.prepare("SELECT COUNT(*) c FROM push_subs WHERE created_at >= datetime('now','-7 days')").get().c;
  const keysFromEnv = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  res.render('admin/notifications', { s, total: push.count(), byDevice, week, keysFromEnv, msg: req.query.msg });
});
router.post('/notifications/settings', (req, res) => {
  setSetting('push_enabled', req.body.push_enabled === '1' ? '1' : '0');
  setSetting('push_quiet', req.body.push_quiet === '1' ? '1' : '0');
  res.redirect('/admin/notifications?msg=Saved');
});
router.post('/notifications/send', (req, res, next) => { audit.record(req, 'sent a notification to everyone', null, String(req.body.title || '').slice(0, 80)); next(); });
router.post('/notifications/send', async (req, res) => {
  const push = require('../push');
  const title = String(req.body.title || '').trim().slice(0, 80), body = String(req.body.body || '').trim().slice(0, 240);
  let url = String(req.body.url || '/').trim();
  if (!title) return res.redirect('/admin/notifications?msg=' + encodeURIComponent('Write a title first.'));
  if (!/^\/|^https?:\/\//.test(url)) url = '/';
  const r = await push.sendAll(() => ({ title, body, url }));
  log('info', `Notifications: custom message "${title}" sent to ${r.sent}/${r.total}`);
  res.redirect('/admin/notifications?msg=' + encodeURIComponent(`Sent to ${r.sent} of ${r.total} subscribers${r.gone ? ` (${r.gone} expired removed)` : ''}.`));
});
router.post('/notifications/run', async (req, res) => {
  const r = await require('../push').digest({ force: true });
  res.redirect('/admin/notifications?msg=' + encodeURIComponent(r.posts ? `Round-up sent: ${r.posts} new updates to ${r.sent} of ${r.total} subscribers.` : 'No new updates since the last round-up — nothing sent.'));
});

// ---------- Team (owner only) ----------
const teamView = (req, res, extra = {}) => res.render('admin/team', { users: db.prepare('SELECT id, username, name, role, active, created_at, last_login FROM users ORDER BY id').all(),
  owner: process.env.ADMIN_USER || 'admin', msg: req.query.msg, ...extra });
router.get('/team', (req, res) => teamView(req, res));
router.post('/team/add', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase(), name = String(req.body.name || '').trim().slice(0, 60), role = req.body.role;
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return teamView(req, res, { msg: '✗ Username: 3–30 letters, numbers, dot, dash or underscore.' });
  if (!['admin', 'editor', 'writer'].includes(role)) return teamView(req, res, { msg: '✗ Choose a role.' });
  if (username === String(process.env.ADMIN_USER || 'admin').toLowerCase() || db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return teamView(req, res, { msg: '✗ That username is taken.' });
  const bad = passwordProblem(req.body.password, username); if (bad) return teamView(req, res, { msg: '✗ ' + bad });
  db.prepare('INSERT INTO users(username,name,role,pass_hash) VALUES(?,?,?,?)').run(username, name, role, hashPassword(req.body.password));
  audit.record(req, 'added team member', null, `${username} as ${ROLES[role].name}`);
  res.redirect('/admin/team?msg=' + encodeURIComponent(`Added ${username} as ${ROLES[role].name}. Send them the address /admin and their password.`));
});
router.post('/team/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(+req.params.id);
  if (!u) return res.redirect('/admin/team');
  const act = req.body.act;
  if (act === 'role' && ['admin', 'editor', 'writer'].includes(req.body.role)) {
    db.prepare('UPDATE users SET role=?, ver=ver+1 WHERE id=?').run(req.body.role, u.id);
    audit.record(req, 'changed role', null, `${u.username}: ${ROLES[u.role].name} → ${ROLES[req.body.role].name}`);
    return res.redirect('/admin/team?msg=' + encodeURIComponent(`${u.username} is now ${ROLES[req.body.role].name} (signed out so the change applies).`));
  }
  if (act === 'password') {
    const bad = passwordProblem(req.body.password, u.username); if (bad) return teamView(req, res, { msg: '✗ ' + bad });
    db.prepare('UPDATE users SET pass_hash=?, ver=ver+1 WHERE id=?').run(hashPassword(req.body.password), u.id);
    audit.record(req, 'reset password', null, u.username);
    return res.redirect('/admin/team?msg=' + encodeURIComponent(`New password set for ${u.username} — they were signed out.`));
  }
  if (act === 'toggle') {
    db.prepare('UPDATE users SET active=?, ver=ver+1 WHERE id=?').run(u.active ? 0 : 1, u.id);
    audit.record(req, u.active ? 'switched off account' : 'switched on account', null, u.username);
    return res.redirect('/admin/team?msg=' + encodeURIComponent(`${u.username} ${u.active ? 'can no longer sign in (signed out now)' : 'can sign in again'}.`));
  }
  if (act === 'remove') {
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
    audit.record(req, 'removed team member', null, u.username);
    return res.redirect('/admin/team?msg=' + encodeURIComponent(`Removed ${u.username}.`));
  }
  res.redirect('/admin/team');
});

// ---------- My account (everyone) ----------
router.get('/account', (req, res) => res.render('admin/account', { msg: req.query.msg }));
router.post('/account', (req, res) => {
  if (req.user.role === 'owner') return res.redirect('/admin/account?msg=' + encodeURIComponent('The owner password is ADMIN_PASSWORD in Render → Environment — change it there.'));
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!require('../auth').verifyPassword(req.body.current || '', u.pass_hash)) return res.redirect('/admin/account?msg=' + encodeURIComponent('✗ Current password is wrong.'));
  const bad = passwordProblem(req.body.password, u.username); if (bad) return res.redirect('/admin/account?msg=' + encodeURIComponent('✗ ' + bad));
  db.prepare('UPDATE users SET pass_hash=?, ver=ver+1 WHERE id=?').run(hashPassword(req.body.password), u.id);
  audit.record(req, 'changed own password');
  setSession(res, req.secure, db.prepare('SELECT * FROM users WHERE id=?').get(u.id));
  res.redirect('/admin/account?msg=' + encodeURIComponent('Password changed.'));
});

// ---------- Recycle bin ----------
router.get('/trash', (req, res) => {
  audit.autoPurge();
  res.render('admin/trash', { rows: db.prepare("SELECT id, post_id, title, category, status, deleted_by, deleted_at, CAST(julianday(deleted_at,'+30 days') - julianday('now') AS INTEGER) days_left FROM trash ORDER BY id DESC").all(), msg: req.query.msg });
});
router.post('/trash/restore', (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  let ok = 0; const errs = [];
  for (const id of ids) { try { audit.restore(id, req); ok++; } catch (e) { errs.push(e.message); } }
  res.redirect('/admin/trash?msg=' + encodeURIComponent(`Restored ${ok} post${ok === 1 ? '' : 's'}${ok ? ' — back on the site with the same address' : ''}.${errs.length ? ' ✗ ' + [...new Set(errs)].join(' ') : ''}`));
});
router.post('/trash/:id/restore', (req, res) => {
  try { const p = audit.restore(+req.params.id, req); res.redirect('/admin/trash?msg=' + encodeURIComponent(`Restored “${p.title.slice(0, 60)}”.`)); }
  catch (e) { res.redirect('/admin/trash?msg=' + encodeURIComponent('✗ ' + e.message)); }
});
router.post('/trash/:id/purge', (req, res) => { audit.purge(+req.params.id, req); res.redirect('/admin/trash?msg=' + encodeURIComponent('Deleted for good.')); });

// ---------- Activity ----------
router.get('/activity', (req, res) => {
  const who = String(req.query.who || ''), action = String(req.query.action || '');
  const where = [], args = [];
  if (who) { where.push('who=?'); args.push(who); }
  if (action) { where.push('action=?'); args.push(action); }
  res.render('admin/activity', { rows: db.prepare(`SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 400`).all(...args),
    people: db.prepare('SELECT DISTINCT who FROM audit ORDER BY who').all().map(r => r.who), actions: db.prepare('SELECT DISTINCT action FROM audit ORDER BY action').all().map(r => r.action), who, action });
});

// ---------- Launch checklist ----------
router.get('/launch', (req, res) => res.render('admin/launch', { items: require('../launch').checks(req) }));

// ---------- API ----------
router.get('/api', (req, res) => {
  const api = require('./api');
  res.render('admin/api', { configured: api.keyConfigured(), hint: getSettings().api_key_hint, fromEnv: !!process.env.API_KEY, newKey: null,
    base: require('../db').siteUrl() || `${req.protocol}://${req.get('host')}`, msg: req.query.msg,
    recent: db.prepare("SELECT created_at, message FROM logs WHERE message LIKE 'API:%' ORDER BY id DESC LIMIT 15").all() });
});
router.post('/api/key', (req, res) => {
  const api = require('./api');
  const key = api.newKey();
  audit.record(req, 'made a new API key');
  res.render('admin/api', { configured: true, hint: getSettings().api_key_hint, fromEnv: !!process.env.API_KEY, newKey: key,
    base: require('../db').siteUrl() || `${req.protocol}://${req.get('host')}`, msg: null,
    recent: db.prepare("SELECT created_at, message FROM logs WHERE message LIKE 'API:%' ORDER BY id DESC LIMIT 15").all() });
});
router.post('/api/key/delete', (req, res) => { setSetting('api_key_hash', ''); setSetting('api_key_hint', ''); res.redirect('/admin/api?msg=' + encodeURIComponent('Key removed — the API is off unless API_KEY is set in the environment')); });

// ---------- Keep settings across restarts ----------
router.get('/keep-settings', (req, res, next) => { audit.record(req, 'opened Keep settings (shows tokens)'); next(); });
router.get('/keep-settings', (req, res) => {
  const { settingsAsEnv } = require('../db');
  res.render('admin/keep-settings', { envText: settingsAsEnv(), onRender: !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL), msg: req.query.msg });
});

// ---------- Settings & logs ----------
router.get('/settings', (req, res) => res.render('admin/settings', { s: getSettings(), msg: req.query.msg }));


router.post('/settings', (req, res) => {
  setSetting('auto_news', req.body.auto_news === '1' ? '1' : '0');
  if (req.body.auto_news === '1') require('../news').backfillNews();
  const keys = ['site_name', 'site_tagline', 'home_intro', 'max_per_run', 'first_run_limit', 'telegram_url', 'whatsapp_url', 'contact_email', 'google_verification', 'ga_id', 'adsense_client'];
  for (const k of keys) setSetting(k, String(req.body[k] ?? '').trim());
  setSetting('auto_publish', req.body.auto_publish === '1' ? '1' : '0');
  audit.record(req, 'changed settings');
  res.redirect('/admin/settings?msg=Settings saved');
});
router.get('/logs', (req, res) => res.render('admin/logs', { logs: db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 300').all() }));

module.exports = router;
