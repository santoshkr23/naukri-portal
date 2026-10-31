// Browser notifications (Web Push). Visitors tap the bell and allow notifications; once an hour the site sends
// each of them one round-up of the updates published since the last one. Works even when the browser is closed on
// Android/desktop Chrome, Edge and Firefox; on iPhone only after "Add to Home Screen" (iOS 16.4+).
// Nothing is sent at night (22:00–07:00 IST) — those updates go out in the 7 am round-up.
const webpush = require('web-push');
const cron = require('node-cron');
const { db, getSettings, setSetting, log, siteUrl } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, sections TEXT DEFAULT '',
  ua TEXT, fails INTEGER DEFAULT 0, last_ok TEXT, created_at TEXT DEFAULT (datetime('now')), seen_at TEXT DEFAULT (datetime('now')))`);

// ---------- keys ----------
function keys() {
  const s = getSettings();
  let pub = s.vapid_public_key, priv = s.vapid_private_key;
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey; priv = k.privateKey;
    setSetting('vapid_public_key', pub); setSetting('vapid_private_key', priv);
    log('info', 'Notifications: made new VAPID keys — copy them with Admin → Keep settings so subscribers survive restarts');
  }
  const mail = s.contact_email ? `mailto:${s.contact_email}` : (siteUrl() || 'mailto:admin@example.com');
  webpush.setVapidDetails(/^https:|^mailto:/.test(mail) ? mail : 'mailto:admin@example.com', pub, priv);
  return { publicKey: pub };
}

// ---------- subscribers ----------
function subscribe(sub, sections, ua) {
  if (!sub || !/^https:\/\//.test(sub.endpoint || '') || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('bad subscription');
  db.prepare(`INSERT INTO push_subs(endpoint,p256dh,auth,sections,ua) VALUES(@e,@p,@a,@s,@u)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh=@p, auth=@a, sections=@s, ua=@u, fails=0, seen_at=datetime('now')`)
    .run({ e: sub.endpoint, p: sub.keys.p256dh, a: sub.keys.auth, s: (sections || []).join(','), u: String(ua || '').slice(0, 200) });
}
const unsubscribe = endpoint => db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(String(endpoint || '')).changes;
const count = () => db.prepare('SELECT COUNT(*) c FROM push_subs').get().c;

// ---------- sending ----------
async function sendAll(payloadFor, { only } = {}) {
  keys();
  const subs = only ? db.prepare('SELECT * FROM push_subs WHERE endpoint=?').all(only) : db.prepare('SELECT * FROM push_subs').all();
  let sent = 0, gone = 0, failed = 0;
  const ok = db.prepare("UPDATE push_subs SET fails=0, last_ok=datetime('now') WHERE endpoint=?");
  const bad = db.prepare('UPDATE push_subs SET fails=fails+1 WHERE endpoint=?');
  for (let i = 0; i < subs.length; i += 20) { // 20 at a time
    await Promise.all(subs.slice(i, i + 20).map(async s => {
      const payload = payloadFor(s);
      if (!payload) return;
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: 'normal', topic: 'new-jobs' });
        ok.run(s.endpoint); sent++;
      } catch (e) {
        if ([404, 410].includes(e.statusCode) || e.statusCode === 403) { unsubscribe(s.endpoint); gone++; } // expired or wrong keys
        else { bad.run(s.endpoint); failed++; }
      }
    }));
  }
  db.prepare('DELETE FROM push_subs WHERE fails >= 10').run();
  return { sent, gone, failed, total: subs.length };
}

const SHORT = t => String(t).split(/:|–(?=[^–]*$)/)[0].replace(/\s*\((\d[\d,]*\s*Posts?)\)/i, '').trim();
const istHour = () => Number(new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })) % 24;

// The hourly round-up
async function digest({ force = false } = {}) {
  const s = getSettings();
  if (s.push_enabled === '0' && !force) return { skipped: 'off' };
  if (s.push_quiet !== '0' && !force) { const h = istHour(); if (h >= 22 || h < 7) return { skipped: 'quiet hours' }; }
  const since = s.push_last_run || new Date(Date.now() - 3600e3).toISOString().replace('T', ' ').slice(0, 19);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const posts = db.prepare(`SELECT id, slug, title, category, last_date, total_posts FROM posts WHERE status='published' AND category<>'news'
    AND published_at > ? AND published_at <= ? ORDER BY published_at DESC`).all(since, now);
  setSetting('push_last_run', now);
  if (!posts.length || !count()) { setSetting('push_last_result', `${now} UTC — ${posts.length} new, ${count()} subscribers, nothing sent`); return { posts: 0 }; }
  const base = siteUrl();
  const r = await sendAll(sub => {
    const want = sub.sections ? sub.sections.split(',') : null;
    const mine = want ? posts.filter(p => want.includes(p.category)) : posts;
    if (!mine.length) return null;
    if (mine.length === 1) {
      const p = mine[0];
      return { title: `🔔 ${SHORT(p.title)}`, body: [p.total_posts && /^\d+$/.test(p.total_posts) ? `${Number(p.total_posts).toLocaleString('en-IN')} पद` : '', p.last_date ? `अंतिम तिथि: ${p.last_date.split('-').reverse().join('-')}` : '', 'पूरी जानकारी के लिए टैप करें'].filter(Boolean).join(' · '),
        url: `${base}/${p.slug}/`, image: `${base}/banner/${p.slug}.jpg` };
    }
    return { title: `🔔 ${mine.length} नई सरकारी नौकरी अपडेट`, body: mine.slice(0, 3).map(p => '• ' + SHORT(p.title)).join('\n') + (mine.length > 3 ? `\n+${mine.length - 3} और` : ''),
      url: `${base}/`, image: `${base}/banner/${mine[0].slug}.jpg` };
  });
  setSetting('push_last_result', `${now} UTC — ${posts.length} new updates → sent to ${r.sent} of ${r.total} subscribers${r.gone ? `, ${r.gone} expired removed` : ''}${r.failed ? `, ${r.failed} failed` : ''}`);
  log('info', `Notifications: ${posts.length} new updates sent to ${r.sent}/${r.total} subscribers`);
  return { posts: posts.length, ...r };
}

// New posts for a page that is open (also used when push isn't available)
function latestSince(sinceIso) {
  const since = /^\d{4}-\d{2}-\d{2}/.test(sinceIso || '') ? sinceIso.replace('T', ' ').slice(0, 19) : new Date(Date.now() - 3600e3).toISOString().replace('T', ' ').slice(0, 19);
  return db.prepare(`SELECT slug, title, category FROM posts WHERE status='published' AND category<>'news' AND published_at > ? ORDER BY published_at DESC LIMIT 5`).all(since)
    .map(p => ({ title: SHORT(p.title), url: `/${p.slug}/`, banner: `/banner/${p.slug}.jpg` }));
}

function start() {
  if (process.env.SCHEDULER_ENABLED === '0') return;
  keys();
  if (!getSettings().push_last_run) setSetting('push_last_run', new Date().toISOString().replace('T', ' ').slice(0, 19));
  cron.schedule('10 * * * *', () => digest().catch(e => log('error', 'Notifications: ' + e.message)), { timezone: 'Asia/Kolkata' });
}

module.exports = { keys, subscribe, unsubscribe, count, sendAll, digest, latestSince, start };
