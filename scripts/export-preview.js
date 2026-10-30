// Renders a static, read-only preview of the site (sample posts) into ./preview — no admin, no import.
const path = require('path');
const fs = require('fs');
const os = require('os');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'np-preview-'));
process.env.SCHEDULER_ENABLED = '0';
process.env.BASE_URL = process.env.BASE_URL || 'https://preview.local';

const OUT = path.join(__dirname, '..', 'preview');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  require('../src/seed-jobs').seedJobs();
  const app = require('../src/server');
  const server = app.listen(0);
  const port = server.address().port;
  const { db, CATEGORIES } = require('../src/db');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  const fav = 'data:image/svg+xml,' + encodeURIComponent(fs.readFileSync(path.join(__dirname, '..', 'public', 'favicon.svg'), 'utf8'));

  const pages = { '/': 'index.html' };
  Object.keys(CATEGORIES).forEach(c => (pages[`/${c}/`] = `${c}.html`));
  db.prepare("SELECT slug FROM posts WHERE status='published'").all().forEach(p => (pages[`/${p.slug}/`] = `${p.slug}.html`));
  ['about-us', 'contact-us', 'disclaimer', 'privacy-policy'].forEach(p => (pages[`/${p}/`] = `${p}.html`));

  for (const [url, file] of Object.entries(pages)) {
    let html = await (await fetch(`http://localhost:${port}${url}`)).text();
    html = html
      .replace('<link rel="stylesheet" href="/static/css/style.css">', `<style>${css}</style>`)
      .replace('href="/static/favicon.svg"', `href="${fav}"`)
      .replace(/<link rel="alternate"[^>]*>/, '').replace('<a href="/feed.xml">RSS Feed</a>', '')
      .replace(/href="(\/[a-z0-9-]*\/?)"/g, (m, href) => (pages[href] ? `href="${pages[href]}"` : pages[href + '/'] ? `href="${pages[href + '/']}"` : m))
      .replace('<form class="search" action="/search/"', '<form class="search" onsubmit="return false"')
      .replace('<body>', '<body><div style="background:#f2a516;color:#0b3d3a;text-align:center;padding:6px 10px;font:600 14px system-ui">Preview — job facts as of 30 Oct 2026; always confirm on the official website. Admin panel and auto-import run on the real server</div>');
    fs.writeFileSync(path.join(OUT, file), html);
  }
  server.close();
  console.log(`Exported ${Object.keys(pages).length} pages to ${OUT}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
