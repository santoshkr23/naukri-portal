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
  if (req.method === 'GET' && !req.path.endsWith('/') && !req.path.includes('.') && !req.path.startsWith('/admin')) {
    const q = req.originalUrl.slice(req.path.length);
    return res.redirect(301, req.path + '/' + q);
  }
  next();
});

app.use((req, res, next) => {
  res.locals.settings = getSettings();
  res.locals.baseUrl = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  res.locals.CATEGORIES = CATEGORIES;
  res.locals.currentPath = req.path;
  res.locals.meta = {};
  res.locals.schema = '';
  next();
});

app.use('/admin', require('./routes/admin'));
app.use('/', require('./routes/public'));

app.use((req, res) => res.status(404).render('404', { meta: { title: 'Page not found', robots: 'noindex' } }));
app.use((err, req, res, next) => { console.error(err); res.status(500).send('Something went wrong.'); });

const port = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(port, () => console.log(`Site running on http://localhost:${port}  (admin: /admin)`));
  require('./scraper').startScheduler();
}
module.exports = app;
