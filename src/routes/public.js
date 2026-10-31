const express = require('express');
const { db, CATEGORIES } = require('../db');
const { listPosts, getBySlug, related, yearClause } = require('../posts');
const { homeSchema, postSchema, categorySchema } = require('../seo');
const { ogImage } = require('../og');
const { fmtDate } = require('../util');
const PAGES = require('../pages');

const router = express.Router();
const PER_PAGE = 30;

// The colourful banner of a post (made on first request, then cached)
router.get('/banner/:slug.jpg', async (req, res, next) => {
  const post = getBySlug(req.params.slug);
  if (!post || post.category === 'news' || (post.status !== 'published' && !require('../auth').isAuthed(req))) return next();
  try { res.set('Cache-Control', 'public, max-age=86400').type('jpg').sendFile(await require('../banner').bannerFile(post)); }
  catch (e) { console.error('banner:', e.message); next(); }
});

// News stories: the green Hindi headline card (wide)
router.get('/card/:slug.jpg', async (req, res, next) => {
  const post = getBySlug(req.params.slug);
  if (!post || post.category !== 'news' || (post.status !== 'published' && !require('../auth').isAuthed(req))) return next();
  try { res.set('Cache-Control', 'public, max-age=86400').type('jpg').sendFile((await require('../social/card').cardFile(post, 'wide')).file); }
  catch (e) { console.error('card:', e.message); next(); }
});

router.get('/social/:file', (req, res, next) => {
  if (!/^[a-z0-9-]+-(square|tall)-[0-9a-f]{8}\.jpg$/.test(req.params.file)) return next();
  const f = require('path').join(require('../social/card').DIR, req.params.file);
  if (!require('fs').existsSync(f)) return next();
  res.set('Cache-Control', 'public, max-age=604800').type('jpg').sendFile(f);
});

// IndexNow key file (Bing/Yandex check it before accepting pings)
router.get('/:key.txt', (req, res, next) => {
  const k = process.env.INDEXNOW_KEY;
  if (!k || req.params.key !== k) return next();
  res.type('text/plain').send(k);
});

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin/\nDisallow: /search/\n\nSitemap: ${res.locals.baseUrl}/sitemap.xml\n`);
});

router.get('/sitemap.xml', (req, res) => {
  const b = res.locals.baseUrl;
  const posts = db.prepare("SELECT slug, updated_at FROM posts WHERE status='published' ORDER BY published_at DESC LIMIT 45000").all();
  const urls = [`<url><loc>${b}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`]
    .concat(Object.keys(CATEGORIES).filter(c => !CATEGORIES[c].optional || res.locals.navCats.includes(c)).map(c => `<url><loc>${b}/${c}/</loc><changefreq>hourly</changefreq><priority>0.9</priority></url>`))
    .concat(Object.keys(PAGES).map(p => `<url><loc>${b}/${p}/</loc><priority>0.3</priority></url>`))
    .concat(posts.map(p => `<url><loc>${b}/${p.slug}/</loc>${p.updated_at ? `<lastmod>${p.updated_at.replace(' ', 'T')}Z</lastmod>` : ''}<priority>0.8</priority></url>`));
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
});

router.get('/feed.xml', (req, res) => {
  const b = res.locals.baseUrl, s = res.locals.settings;
  const { rows } = listPosts({ limit: 50 });
  const x = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${x(s.site_name)}</title><link>${b}/</link><description>${x(s.site_tagline)}</description>${rows.map(p => `<item><title>${x(p.title)}</title><link>${b}/${p.slug}/</link><guid>${b}/${p.slug}/</guid><pubDate>${new Date(p.published_at.replace(' ', 'T') + 'Z').toUTCString()}</pubDate></item>`).join('')}</channel></rss>`);
});

router.get('/og/:slug.png', async (req, res, next) => {
  const post = getBySlug(req.params.slug);
  if (!post) return next();
  try { res.set('Cache-Control', 'public, max-age=86400').sendFile(await ogImage(post, res.locals.settings.site_name)); }
  catch (e) { next(e); }
});

router.get('/', (req, res) => {
  const boxes = {};
  // Home page shows only current-year updates (plus next year's, e.g. "NVS Admit Card 2027")
  const Y = new Date().getFullYear(), homeYears = [Y, Y + 1];
  for (const c of Object.keys(CATEGORIES)) boxes[c] = listPosts({ category: c, limit: 25, years: homeYears }).rows;
  const hy = yearClause(homeYears);
  const news = db.prepare(`SELECT slug,title,data,published_at FROM posts WHERE status='published' AND category='news' ORDER BY published_at DESC, id DESC LIMIT 7`).all()
    .map(n => { let d = {}; try { d = JSON.parse(n.data); } catch {} return { ...n, keyword: d.keyword || '', img: `/card/${n.slug}.jpg` }; });
  const highlights = db.prepare(`SELECT slug,title,category FROM posts WHERE status='published' AND category<>'news' AND ${hy.sql} ORDER BY featured DESC, published_at DESC LIMIT 12`).all(...hy.args);
  const s = res.locals.settings;
  res.render('home', {
    boxes, highlights, news, fmtDate, timeAgo,
    meta: { title: `${s.site_name} – ${s.site_tagline}`, description: s.home_intro, canonical: res.locals.baseUrl + '/' },
    schema: homeSchema(s, res.locals.baseUrl)
  });
});

router.get('/search/', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const { rows } = q ? listPosts({ q, limit: 50 }) : { rows: [] };
  res.render('list', { heading: q ? `Search: ${q}` : 'Search', rows, q, fmtDate, page: 1, pages: 1, catKey: null,
    meta: { title: `Search ${q} | ${res.locals.settings.site_name}`, description: 'Search government job updates', robots: 'noindex,follow' } });
});

router.get('/:slug/', (req, res, next) => {
  const slug = req.params.slug;
  const b = res.locals.baseUrl, s = res.locals.settings;

  if (CATEGORIES[slug]) {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const year = /^20\d{2}$/.test(req.query.year || '') ? +req.query.year : null;
    const { rows, total } = listPosts({ category: slug, limit: PER_PAGE, offset: (page - 1) * PER_PAGE, years: year ? [year] : null });
    const Y = new Date().getFullYear();
    const yearTabs = [Y + 1, Y, Y - 1].filter(y => listPosts({ category: slug, limit: 1, years: [y] }).total > 0);
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    const name = CATEGORIES[slug].name;
    return res.render('list', { heading: `${name}${year ? ' ' + year : ''}`, rows, q: '', fmtDate, page, pages, catKey: slug, year, yearTabs,
      meta: { title: `${name} ${new Date().getFullYear()} – Latest Updates${page > 1 ? ` (Page ${page})` : ''} | ${s.site_name}`,
        description: `All the latest ${name.toLowerCase()} updates for central and state government exams, with dates and direct official links.`,
        canonical: `${b}/${slug}/${year ? `?year=${year}` : page > 1 ? `?page=${page}` : ''}`,
        prev: !year && page > 1 ? `${b}/${slug}/${page > 2 ? `?page=${page - 1}` : ''}` : null,
        next: !year && page < pages ? `${b}/${slug}/?page=${page + 1}` : null },
      schema: categorySchema(slug, s, b) });
  }

  if (PAGES[slug]) {
    return res.render('page', { page: PAGES[slug](s), meta: { title: `${PAGES[slug](s).title} | ${s.site_name}`, description: `${PAGES[slug](s).title} – ${s.site_name}`, canonical: `${b}/${slug}/` } });
  }

  const post = getBySlug(slug);
  if (!post || post.status !== 'published') return next();
  renderPost(res, post);
});

function renderPost(res, post) {
  const s = res.locals.settings, b = res.locals.baseUrl;
  if (post.category === 'news') return renderNews(res, post);
  const near = (op, dir) => db.prepare(`SELECT slug,title FROM posts WHERE status='published' AND category=? AND id<>?
    AND published_at ${op} ? ORDER BY published_at ${dir}, id ${dir} LIMIT 1`).get(post.category, post.id, post.published_at || '');
  const sections = Object.keys(CATEGORIES).map(k => ({ key: k, rows: db.prepare(`SELECT slug,title FROM posts WHERE status='published'
    AND category=? AND id<>? ORDER BY published_at DESC LIMIT 6`).all(k, post.id) })).filter(s => s.rows.length);
  res.render('post', {
    post, related: related(post), fmtDate, prev: near('<', 'DESC'), next: near('>', 'ASC'), sections,
    meta: { title: post.title, description: post.meta_description, canonical: `${b}/${post.slug}/`, image: `${b}/banner/${post.slug}.jpg`,
      type: 'article', published: post.published_at, modified: post.updated_at, robots: post.status === 'published' ? null : 'noindex' },
    schema: postSchema(post, s, b)
  });
}

function renderNews(res, post) {
  const s = res.locals.settings, b = res.locals.baseUrl;
  const more = db.prepare(`SELECT slug,title,published_at FROM posts WHERE status='published' AND category='news' AND id<>? ORDER BY published_at DESC, id DESC LIMIT 8`).all(post.id);
  const related = post.data.relatedSlug ? db.prepare("SELECT slug,title,category FROM posts WHERE slug=? AND status='published'").get(post.data.relatedSlug) : null;
  res.render('news', {
    post, more, related, fmtDate, timeAgo, fmtTime,
    meta: { title: post.title, description: post.meta_description, canonical: `${b}/${post.slug}/`, image: `${b}/card/${post.slug}.jpg`, lang: post.data.lang || 'hi',
      type: 'article', published: post.published_at, modified: post.updated_at, robots: post.status === 'published' ? null : 'noindex' },
    schema: postSchema(post, s, b)
  });
}

// "5 मिनट पहले" style times for news
function timeAgo(sql) {
  if (!sql) return '';
  const t = new Date(sql.replace(' ', 'T') + 'Z'), m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'अभी'; if (m < 60) return `${m} मिनट पहले`;
  const h = Math.round(m / 60); if (h < 24) return `${h} घंटे पहले`;
  const d = Math.round(h / 24); if (d < 7) return `${d} दिन पहले`;
  return fmtDate(sql);
}
function fmtTime(sql) {
  if (!sql) return '';
  const t = new Date(sql.replace(' ', 'T') + 'Z');
  return t.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) + ' IST';
}

router.renderPost = renderPost;
module.exports = router;
