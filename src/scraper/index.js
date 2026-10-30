const cron = require('node-cron');
const robotsParser = require('robots-parser');
const { db, getSettings, log } = require('../db');
const { extract, discoverLinks } = require('./extract');
const { compose, aiIntro } = require('./compose');
const { savePost } = require('../posts');
const { fingerprint, nowSql } = require('../util');

const UA = 'Mozilla/5.0 (compatible; NaukriPortalBot/1.0; +job-alert-aggregator)';
const robotsCache = new Map();
let running = false;

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function allowedByRobots(url) {
  const origin = new URL(url).origin;
  if (!robotsCache.has(origin)) {
    let txt = '';
    try { txt = await fetchText(origin + '/robots.txt'); } catch {}
    robotsCache.set(origin, robotsParser(origin + '/robots.txt', txt));
  }
  return robotsCache.get(origin).isAllowed(url, UA) !== false;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Import one page URL -> post (used by sources and by the admin "import single URL" box)
async function importUrl(url, { source = null, forceDraft = false } = {}) {
  if (!(await allowedByRobots(url))) { log('warn', `Skipped (robots.txt disallows): ${url}`); return { skipped: 'robots' }; }
  const html = await fetchText(url);
  const facts = extract(html, url, source?.content_selector);
  if (!facts.title) return { skipped: 'no title' };
  const c = compose(facts);
  const fp = fingerprint(c.base, c.category);
  const dup = db.prepare('SELECT id, slug FROM posts WHERE fingerprint=?').get(fp);
  if (dup) { log('info', `Duplicate of existing post "${dup.slug}" — skipped ${url}`); return { duplicate: dup.id }; }

  const ai = await aiIntro(c);
  if (ai) c.data.intro = ai;

  const settings = getSettings();
  const lowQuality = c.quality < 2; // needs at least two of: dates, links, fee/age/vacancy
  const status = !forceDraft && settings.auto_publish === '1' && !lowQuality ? 'published' : 'draft';
  const post = savePost({ ...c, slug: c.base, status, fingerprint: fp, source_url: url, source_id: source?.id || null });
  log('info', `Imported "${post.title}" as ${status}${lowQuality ? ' (low detail — review)' : ''} from ${url}`);
  if (status === 'published') pingIndexNow([post.slug]).catch(() => {});
  return { post };
}

async function runSource(src) {
  const settings = getSettings();
  const maxPerRun = +settings.max_per_run || 10;
  const result = { found: 0, imported: 0, errors: 0 };
  try {
    if (!(await allowedByRobots(src.list_url))) throw new Error('robots.txt disallows the listing URL');
    const body = await fetchText(src.list_url);
    const links = discoverLinks(body, src.list_url, src.link_selector);
    const isSeen = db.prepare('SELECT 1 FROM seen_urls WHERE url=?');
    const markSeen = db.prepare('INSERT OR IGNORE INTO seen_urls(url,source_id,post_id) VALUES(?,?,?)');
    let fresh = links.filter(u => !isSeen.get(u));
    result.found = fresh.length;

    if (!src.last_checked) { // first run: don't flood the site with old posts
      const keep = +settings.first_run_limit || 5;
      fresh.slice(keep).forEach(u => markSeen.run(u, src.id, null));
      fresh = fresh.slice(0, keep);
    }

    for (const url of fresh.slice(0, maxPerRun)) {
      try {
        const r = await importUrl(url, { source: src });
        markSeen.run(url, src.id, r.post?.id || r.duplicate || null);
        if (r.post) result.imported++;
      } catch (e) {
        result.errors++;
        log('error', `${src.name || src.list_url}: ${e.message}`);
        if (/HTTP 404|HTTP 410/.test(e.message)) markSeen.run(url, src.id, null);
      }
      await sleep(2500); // be polite to the source server
    }
    db.prepare('UPDATE sources SET last_checked=?, last_error=NULL, imported_count=imported_count+? WHERE id=?').run(nowSql(), result.imported, src.id);
  } catch (e) {
    db.prepare('UPDATE sources SET last_checked=?, last_error=? WHERE id=?').run(nowSql(), e.message, src.id);
    log('error', `${src.name || src.list_url}: ${e.message}`);
  }
  return result;
}

async function runAll(trigger = 'schedule') {
  if (running) { log('warn', 'Import already running — skipped'); return null; }
  running = true;
  const t0 = Date.now();
  try {
    const sources = db.prepare('SELECT * FROM sources WHERE enabled=1 ORDER BY id').all();
    let imported = 0, found = 0, errors = 0;
    for (const s of sources) { const r = await runSource(s); imported += r.imported; found += r.found; errors += r.errors; }
    log('info', `Run (${trigger}) finished: ${sources.length} sources, ${found} new links, ${imported} posts imported, ${errors} errors, ${Math.round((Date.now() - t0) / 1000)}s`);
    return { imported, found, errors };
  } finally { running = false; }
}

async function pingIndexNow(slugs) {
  const key = process.env.INDEXNOW_KEY, base = process.env.BASE_URL;
  if (!key || !base) return;
  const host = new URL(base).hostname;
  await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host, key, urlList: slugs.map(s => `${base.replace(/\/$/, '')}/${s}/`) }),
    signal: AbortSignal.timeout(10000)
  });
}

function startScheduler() {
  if (process.env.SCHEDULER_ENABLED === '0') return;
  const expr = process.env.CRON_SCHEDULE || '5 * * * *';
  cron.schedule(expr, () => runAll('schedule').catch(e => log('error', e.message)), { timezone: 'Asia/Kolkata' });
  console.log(`Auto-import scheduled: "${expr}" (Asia/Kolkata)`);
}

module.exports = { runAll, runSource, importUrl, startScheduler, isRunning: () => running, pingIndexNow };
