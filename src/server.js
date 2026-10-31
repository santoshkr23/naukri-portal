require('dotenv').config();
const path = require('path');
const express = require('express');
const compression = require('compression');
const { getSettings, CATEGORIES } = require('./db');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(compression());
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// Canonical URLs end with a slash: /latest-jobs  ->  /latest-jobs/
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.endsWith('/') && !req.path.includes('.') && !req.path.startsWith('/admin') && !req.path.startsWith('/api/')) {
    const q = req.originalUrl.slice(req.path.length);
    return res.redirect(301, req.path + '/' + q);
  }
  next();
});

// Remember the public address the site is reached at (used for links in social posts when BASE_URL isn't set)
let knownUrl = null;
app.use((req, res, next) => {
  if (!process.env.BASE_URL && !process.env.RENDER_EXTERNAL_URL && !/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(req.hostname)) {
    const u = `${req.protocol}://${req.get('host')}`;
    if (u !== knownUrl) { knownUrl = u; if (getSettings().site_url !== u) require('./db').setSetting('site_url', u); }
  }
  next();
});
// Version stamp for CSS/JS links: the address changes when the file changes, so browsers never keep a stale copy
const assetVer = {};
function asset(p) {
  const file = path.join(__dirname, '..', 'public', p);
  let v = assetVer[p];
  try { const m = require('fs').statSync(file).mtimeMs; if (!v || v.m !== m) v = assetVer[p] = { m, h: require('crypto').createHash('md5').update(require('fs').readFileSync(file)).digest('hex').slice(0, 8) }; } catch { return `/static/${p}`; }
  return `/static/${p}?v=${v.h}`;
}
app.use((req, res, next) => {
  res.locals.asset = asset;
  res.locals.settings = getSettings();
  res.locals.baseUrl = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  res.locals.CATEGORIES = CATEGORIES;
  res.locals.navCats = require('./db').db.prepare("SELECT DISTINCT category FROM posts WHERE status='published'").all().map(r => r.category);
  res.locals.currentPath = req.path;
  res.locals.meta = {};
  res.locals.schema = '';
  next();
});

app.use('/api/v1', require('./routes/api'));
app.use('/admin', require('./routes/admin'));
app.use('/', require('./routes/public'));

app.use((req, res) => res.status(404).render('404', { meta: { title: 'Page not found', robots: 'noindex' } }));
app.use((err, req, res, next) => { console.error(err); res.status(500).send('Something went wrong.'); });

const port = process.env.PORT || 3000;
if (require.main === module) {
  { const n = require('./db').restoreSources(); if (n) console.log(`Restored ${n} auto-import sources from IMPORT_SOURCES`); }
  // content/posts.xlsx (your Excel sheet) is the source of posts when present; otherwise the starter set in jobs-data.js is used
  const xl = require('./excel-import');
  if (xl.hasDefaultFile() && process.env.IMPORT_EXCEL !== '0') {
    xl.importWorkbook().then(r => console.log(`Excel: ${r.created.length} new, ${r.updated.length} updated, ${r.drafts.length} drafts`)).catch(e => console.error('Excel import failed:', e.message))
      .finally(() => { const n = require('./news').backfillNews(); if (n) console.log(`News: wrote ${n} stories`); });
  } else {
    if (process.env.SEED_JOBS !== '0') { const n = require('./seed-jobs').seedJobs(); if (n) console.log(`Added ${n} starter job posts`); }
    const n = require('./news').backfillNews(); if (n) console.log(`News: wrote ${n} stories`);
  }
  if (process.env.SEED_DEMO === '1') { const n = require('./seed').seed(); if (n) console.log(`Seeded ${n} sample posts`); }
  app.listen(port, () => console.log(`Site running on http://localhost:${port}  (admin: /admin)`));
  require('./scraper').startScheduler();
  require('./social').startWorker();
}
module.exports = app;
