// End-to-end test: serves a fictional source site locally, imports from it, then checks the public pages.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'np-test-'));
process.env.ADMIN_PASSWORD = 'test-pass';
process.env.SESSION_SECRET = 'x'.repeat(40);

const assert = require('assert');
const getStatus = id => require('../src/db').db.prepare('SELECT status FROM posts WHERE id=?').get(id).status;
const fixture = fs.readFileSync(path.join(__dirname, 'fixture-job.html'), 'utf8');

(async () => {
  const src = http.createServer((req, res) => {
    if (req.url === '/latest-jobs/') return res.end(`<html><body><ul><li><a href="/demo-water-board-junior-clerk-recruitment-2026/">Demo job</a></li><li><a href="/about/">About</a></li></ul></body></html>`);
    if (req.url.startsWith('/demo-water-board')) return res.end(fixture);
    // A site whose home page links to a section page (/syllabus/) that only lists posts
    if (req.url === '/home2/') return res.end(`<html><body><a href="/syllabus/">Syllabus</a> <a href="/latest-jobs/">Jobs</a></body></html>`);
    if (req.url === '/syllabus/') return res.end(`<html><body><h1>Syllabus – Latest Government Exam Syllabus 2026</h1><article><h2>All Latest Syllabus</h2><ul>${
      ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'].map(n => `<li><a href="/${n}-board-clerk-recruitment-2026/">${n} board clerk recruitment 2026</a></li>`).join('')}</ul><p>${'Filler text. '.repeat(40)}</p></article></body></html>`);
    const m = req.url.match(/^\/(alpha|beta|gamma|delta|epsilon|zeta|eta)-board/);
    if (m) return res.end(fixture.replace(/Demo Water Board/g, `${m[1][0].toUpperCase() + m[1].slice(1)} Water Board`));
    res.statusCode = 404; res.end('');
  }).listen(4801);

  const app = require('../src/server');
  const site = app.listen(4802);
  const { db } = require('../src/db');
  const { runAll } = require('../src/scraper');

  db.prepare('INSERT INTO sources(name,list_url) VALUES(?,?)').run('Fixture', 'http://localhost:4801/latest-jobs/');
  const r = await runAll('test');
  assert.strictEqual(r.imported, 1, 'one post imported');

  const post = db.prepare('SELECT * FROM posts').get();
  const data = JSON.parse(post.data);
  console.log('Title:', post.title, '| status:', post.status, '| slug:', post.slug);
  assert.strictEqual(post.category, 'latest-jobs');
  assert.strictEqual(post.total_posts, '120');
  assert.strictEqual(post.last_date, '2026-11-30');
  assert.ok(data.dates.some(([k, v]) => /last date/i.test(k) && /30 November 2026/.test(v)), 'dates extracted');
  assert.ok(data.fees.length >= 2, 'fees extracted');
  assert.strictEqual(data.vacancy.length, 2, 'vacancy rows');
  assert.ok(data.links.every(([, u]) => u.includes('demowater.gov.in')), 'only official links kept: ' + JSON.stringify(data.links));
  const all = JSON.stringify(data);
  assert.ok(!/must not be copied|Lorem ipsum|fictional test prose/i.test(all), 'source prose not copied');

  const base = 'http://localhost:4802';
  const get = async p => { const res = await fetch(base + p, { redirect: 'manual' }); return { status: res.status, text: await res.text(), headers: res.headers }; };
  const home = await get('/'); assert.strictEqual(home.status, 200); assert.ok(home.text.includes(post.slug));
  const page = await get(`/${post.slug}/`); assert.strictEqual(page.status, 200);
  assert.ok(page.text.includes('"@type":"JobPosting"') && page.text.includes('"@type":"FAQPage"'), 'schema present');
  assert.ok(page.text.includes('rel="canonical"'));
  assert.strictEqual((await get('/latest-jobs')).status, 301, 'trailing-slash redirect');
  assert.strictEqual((await get('/latest-jobs/')).status, 200);
  assert.ok((await get('/sitemap.xml')).text.includes(post.slug));
  assert.ok((await get('/robots.txt')).text.includes('Sitemap:'));
  assert.strictEqual((await get('/feed.xml')).status, 200);
  const og = await get(`/og/${post.slug}.png`); assert.strictEqual(og.status, 200);
  assert.strictEqual((await get('/admin')).status, 302, 'admin protected');

  // admin login + pages
  const login = await fetch(base + '/admin/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=admin&pass=test-pass' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const p of ['/admin', '/admin/posts', `/admin/posts/${post.id}`, '/admin/posts/new', '/admin/sources', '/admin/settings', '/admin/logs']) {
    const res = await fetch(base + p, { headers: { cookie } });
    assert.strictEqual(res.status, 200, p);
  }
  // second run must not duplicate
  const r2 = await runAll('test'); assert.strictEqual(r2.imported, 0, 'no duplicates on re-run');

  // Section pages are followed, never posted; an old section-page post is moved back to drafts
  const { savePost } = require('../src/posts');
  const old = savePost({ title: 'Syllabus – Latest Government Exam Syllabus 2026', category: 'syllabus', status: 'published', source_url: 'http://localhost:4801/syllabus/', data: {} });
  require('../src/db').setSetting('max_per_run', '3');
  db.prepare('INSERT INTO sources(name,list_url) VALUES(?,?)').run('Sections', 'http://localhost:4801/home2/');
  const r3 = await runAll('test');
  const posted = db.prepare("SELECT title, source_url FROM posts WHERE source_url LIKE '%-board-clerk-%'").all();
  console.log('From section page:', r3.imported, 'imported —', posted.map(p => p.title.split(':')[0]).join(' | '));
  assert.ok(r3.imported >= 1 && r3.imported <= 3, 'posts listed on the section page were imported, within max_per_run');
  assert.ok(!db.prepare("SELECT 1 FROM posts WHERE source_url='http://localhost:4801/syllabus/' AND status='published'").get(), 'section page is not a published post');
  assert.strictEqual(getStatus(old.id), 'draft', 'old section-page post moved to drafts');
  assert.ok(!db.prepare("SELECT 1 FROM seen_urls WHERE url LIKE '%/syllabus/'").get(), 'section page stays re-scannable');

  fs.writeFileSync(path.join(__dirname, 'out-home.html'), home.text);
  fs.writeFileSync(path.join(__dirname, 'out-post.html'), page.text);
  console.log('ALL TESTS PASSED');
  src.close(); site.close(); process.exit(0);
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
