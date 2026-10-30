// Auto-posts news stories to Telegram, Facebook, Instagram, Pinterest and X, each with a branded image and the link.
// Stories go into a queue; a worker posts a few every 5 minutes so the accounts never send a burst.
// Credentials come from Admin → Social media, or from environment variables of the same name in capitals
// (e.g. TG_TOKEN), which survive redeploys on hosts that wipe the database.
const fs = require('fs');
const crypto = require('crypto');
const cron = require('node-cron');
const { db, getSettings, parsePost, log } = require('../db');
const { cardFile } = require('./card');

db.exec(`
CREATE TABLE IF NOT EXISTS social_queue (post_id INTEGER PRIMARY KEY, attempts INTEGER DEFAULT 0, next_at TEXT DEFAULT (datetime('now')), created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS social_log (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, platform TEXT, status TEXT, url TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_social_log_post ON social_log(post_id, platform, status);
`);

const PLATFORMS = {
  telegram: { name: 'Telegram', keys: ['tg_token', 'tg_chats'] },
  facebook: { name: 'Facebook Page', keys: ['fb_page_id', 'fb_token'] },
  instagram: { name: 'Instagram', keys: ['ig_user_id', 'ig_token'] },
  pinterest: { name: 'Pinterest', keys: ['pin_token', 'pin_board'] },
  twitter: { name: 'X (Twitter)', keys: ['x_api_key', 'x_api_secret', 'x_access_token', 'x_access_secret'] }
};
const SECRET_KEYS = ['tg_token', 'fb_token', 'ig_token', 'pin_token', 'x_api_key', 'x_api_secret', 'x_access_token', 'x_access_secret'];

function cfg() {
  const s = getSettings();
  const v = k => (s[k] || process.env[k.toUpperCase()] || '').trim();
  const c = { auto: s.social_auto === '1', perRun: Math.max(1, +s.social_per_run || 3), hashtags: s.social_hashtags ?? '#SarkariNaukri #GovtJobs #Naukri',
    graph: v('graph_version') || 'v26.0', base: (process.env.BASE_URL || '').replace(/\/$/, '') };
  for (const [p, def] of Object.entries(PLATFORMS)) {
    c[p] = { enabled: s[`${p}_enabled`] === '1' || process.env[`${p.toUpperCase()}_ENABLED`] === '1' };
    for (const k of def.keys) c[p][k] = v(k);
    c[p].ready = c[p].enabled && def.keys.every(k => c[p][k]);
  }
  return c;
}

// ---------- queue ----------
let quiet = 0; // bulk jobs (Excel import, back-fill) don't auto-share
async function quietly(fn) { quiet++; try { return await fn(); } finally { quiet--; } }
function quietlySync(fn) { quiet++; try { return fn(); } finally { quiet--; } }

function onNewsCreated(news) {
  if (quiet || !news || news.status !== 'published') return;
  const c = cfg();
  if (!c.auto || !Object.keys(PLATFORMS).some(p => c[p].ready)) return;
  enqueue([news.id]);
}
function enqueue(ids) {
  const ins = db.prepare('INSERT OR IGNORE INTO social_queue(post_id) VALUES(?)');
  let n = 0; for (const id of ids) n += ins.run(id).changes;
  return n;
}
// Accepts any posts: a job/result post is shared through its news story
function newsIdsFor(ids) {
  const out = new Set();
  for (const id of ids) {
    const p = db.prepare('SELECT id, category, fingerprint, status FROM posts WHERE id=?').get(id);
    if (!p) continue;
    if (p.category === 'news') { if (p.status === 'published') out.add(p.id); continue; }
    const n = db.prepare("SELECT id FROM posts WHERE fingerprint=? AND status='published'").get(`news:${p.fingerprint}`);
    if (n) out.add(n.id);
  }
  return [...out];
}

// ---------- captions ----------
const strip = s => String(s || '').replace(/\s+/g, ' ').trim();
function parts(news, c) {
  const d = news.data || {};
  const link = `${c.base}/${news.slug}/`;
  const deck = strip(String(d.intro || '').split(/\n\s*\n/)[0]);
  const points = ((d.extra || [])[0]?.items || []).slice(0, 3);
  const k = String(d.keyword || '');
  const auto = [];
  const abbr = (news.organization || '').match(/\(([A-Z][A-Za-z]{1,9})\)/) || k.match(/^([A-Z]{2,8})\b/);
  if (abbr) auto.push('#' + abbr[1]);
  for (const [re, t] of [[/answer key/i, '#AnswerKey'], [/admit card/i, '#AdmitCard'], [/result/i, '#Result'], [/syllabus/i, '#Syllabus'], [/recruit|vacanc/i, '#Recruitment'], [/exam date/i, '#ExamDate']]) if (re.test(k)) { auto.push(t); break; }
  const tags = [...new Set([...auto, ...String(c.hashtags || '').split(/\s+/).filter(t => t.startsWith('#'))])].join(' ');
  return { link, deck, points, tags, title: news.title, keyword: k };
}
const htmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- HTTP ----------
async function call(url, opts = {}) {
  // tests only: send every platform request to a local stand-in server
  if (process.env.SOCIAL_TEST_ORIGIN) { const u = new URL(url); url = process.env.SOCIAL_TEST_ORIGIN + '/' + u.hostname + u.pathname + u.search; }
  let res;
  try { res = await fetch(url, { ...opts, signal: AbortSignal.timeout(60000) }); }
  catch (e) { throw new Error(`could not reach ${new URL(url).hostname} (${e.cause?.code || e.name === 'TimeoutError' && 'timed out' || e.message})`); }
  const txt = await res.text();
  let body; try { body = JSON.parse(txt); } catch { body = { raw: txt.slice(0, 300) }; }
  if (!res.ok || body.ok === false || body.error || body.errors) {
    const e = body.description || body.error?.message || body.error_description || body.message || body.detail || body.title ||
      (Array.isArray(body.errors) ? body.errors.map(x => x.message || x.detail).join('; ') : '') || body.raw || `HTTP ${res.status}`;
    throw new Error(String(typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 300));
  }
  return body;
}
const fileBlob = (file, type = 'image/jpeg') => new Blob([fs.readFileSync(file)], { type });

// ---------- X (Twitter): OAuth 1.0a user context ----------
const pct = s => encodeURIComponent(s).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
function oauthHeader(method, url, x, extra = {}) {
  const o = { oauth_consumer_key: x.x_api_key, oauth_nonce: crypto.randomBytes(16).toString('hex'), oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: x.x_access_token, oauth_version: '1.0' };
  const u = new URL(url);
  const all = { ...o, ...extra }; u.searchParams.forEach((v, k) => (all[k] = v));
  const paramStr = Object.keys(all).sort().map(k => `${pct(k)}=${pct(all[k])}`).join('&');
  const baseStr = [method.toUpperCase(), pct(u.origin + u.pathname), pct(paramStr)].join('&');
  o.oauth_signature = crypto.createHmac('sha1', `${pct(x.x_api_secret)}&${pct(x.x_access_secret)}`).update(baseStr).digest('base64');
  return 'OAuth ' + Object.keys(o).sort().map(k => `${pct(k)}="${pct(o[k])}"`).join(', ');
}

// ---------- platforms ----------
const POSTERS = {
  async telegram(news, c, img) {
    const p = parts(news, c);
    const caption = [`<b>${htmlEsc(p.title)}</b>`, htmlEsc(p.deck), p.points.map(x => `• ${htmlEsc(x)}`).join('\n'),
      `👉 पूरी खबर: ${htmlEsc(p.link)}`, htmlEsc(p.tags)].filter(Boolean).join('\n\n');
    const urls = [];
    for (const chat of c.telegram.tg_chats.split(/[\s,]+/).filter(Boolean)) {
      const fd = new FormData();
      fd.append('chat_id', chat); fd.append('photo', fileBlob(img.square.file), img.square.name);
      fd.append('caption', caption.length > 1024 ? caption.slice(0, 1000) + '…' : caption); fd.append('parse_mode', 'HTML');
      const r = await call(`https://api.telegram.org/bot${c.telegram.tg_token}/sendPhoto`, { method: 'POST', body: fd });
      const ch = r.result?.chat;
      urls.push(ch?.username ? `https://t.me/${ch.username}/${r.result.message_id}` : `${chat} #${r.result?.message_id}`);
    }
    return urls.join(' ');
  },
  async facebook(news, c, img) {
    const p = parts(news, c);
    const fd = new FormData();
    fd.append('source', fileBlob(img.square.file), img.square.name);
    fd.append('message', [p.title, p.deck, p.points.map(x => `• ${x}`).join('\n'), `👉 पूरी खबर: ${p.link}`, p.tags].filter(Boolean).join('\n\n'));
    fd.append('access_token', c.facebook.fb_token);
    const r = await call(`https://graph.facebook.com/${c.graph}/${c.facebook.fb_page_id}/photos`, { method: 'POST', body: fd });
    return r.post_id ? `https://www.facebook.com/${r.post_id}` : `https://www.facebook.com/${r.id}`;
  },
  async instagram(news, c, img) {
    if (!/^https:\/\//.test(c.base) || /localhost|127\.0\.0\.1/.test(c.base)) throw new Error('Instagram needs BASE_URL set to your public https:// site address, so it can fetch the image.');
    const p = parts(news, c);
    const caption = [p.title, p.deck, p.points.map(x => `• ${x}`).join('\n'), `👉 पूरी खबर: ${p.link}`, '(लिंक प्रोफ़ाइल के बायो में भी)', p.tags].filter(Boolean).join('\n\n').slice(0, 2200);
    const g = `https://graph.facebook.com/${c.graph}/${c.instagram.ig_user_id}`;
    const made = await call(`${g}/media`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_url: `${c.base}/social/${img.square.name}`, caption, access_token: c.instagram.ig_token }) });
    let r;
    for (let i = 0; i < 6; i++) { // the container can need a moment before it can be published
      try { r = await call(`${g}/media_publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ creation_id: made.id, access_token: c.instagram.ig_token }) }); break; }
      catch (e) { if (i === 5 || !/not ready|not finished|try again|9007/i.test(e.message)) throw e; await new Promise(res => setTimeout(res, 5000)); }
    }
    try { const m = await call(`https://graph.facebook.com/${c.graph}/${r.id}?fields=permalink&access_token=${encodeURIComponent(c.instagram.ig_token)}`); return m.permalink || r.id; } catch { return r.id; }
  },
  async pinterest(news, c, img) {
    const p = parts(news, c);
    const body = { board_id: c.pinterest.pin_board, title: (p.keyword || p.title).slice(0, 100), link: p.link,
      description: [p.title, p.deck, p.tags].filter(Boolean).join(' — ').slice(0, 500), alt_text: p.title.slice(0, 500),
      media_source: { source_type: 'image_base64', content_type: 'image/jpeg', data: fs.readFileSync(img.tall.file).toString('base64') } };
    const r = await call('https://api.pinterest.com/v5/pins', { method: 'POST', headers: { authorization: `Bearer ${c.pinterest.pin_token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return `https://www.pinterest.com/pin/${r.id}/`;
  },
  async twitter(news, c, img) {
    const x = c.twitter, p = parts(news, c);
    // upload the image (v1.1 simple upload, falling back to the v2 endpoint)
    let mediaId;
    try {
      const url = 'https://upload.x.com/1.1/media/upload.json', fd = new FormData();
      fd.append('media', fileBlob(img.square.file), img.square.name);
      mediaId = (await call(url, { method: 'POST', headers: { authorization: oauthHeader('POST', url, x) }, body: fd })).media_id_string;
    } catch (e1) {
      const url = 'https://api.x.com/2/media/upload', fd = new FormData();
      fd.append('media', fileBlob(img.square.file), img.square.name); fd.append('media_category', 'tweet_image');
      try { mediaId = (await call(url, { method: 'POST', headers: { authorization: oauthHeader('POST', url, x) }, body: fd })).data?.id; }
      catch (e2) { throw new Error(`image upload failed: ${e2.message}`); }
    }
    // 280 characters; a link always counts as 23
    const tail = `\n\n👉 ${p.link}\n${p.tags}`;
    const room = 280 - 23 - p.tags.length - 6;
    const text = (p.title.length > room ? p.title.slice(0, room - 1) + '…' : p.title) + tail;
    const url = 'https://api.x.com/2/tweets';
    const r = await call(url, { method: 'POST', headers: { authorization: oauthHeader('POST', url, x), 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...(mediaId ? { media: { media_ids: [String(mediaId)] } } : {}) }) });
    return `https://x.com/i/web/status/${r.data.id}`;
  }
};

// Connection checks: read-only calls, nothing is posted
const CHECKS = {
  async telegram(c) {
    const me = await call(`https://api.telegram.org/bot${c.telegram.tg_token}/getMe`);
    const out = [`bot @${me.result.username}`];
    for (const chat of c.telegram.tg_chats.split(/[\s,]+/).filter(Boolean)) {
      const ch = (await call(`https://api.telegram.org/bot${c.telegram.tg_token}/getChat?chat_id=${encodeURIComponent(chat)}`)).result;
      const m = (await call(`https://api.telegram.org/bot${c.telegram.tg_token}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${me.result.id}`)).result;
      if (!['administrator', 'creator'].includes(m.status) && ch.type === 'channel') throw new Error(`bot is not an admin of ${ch.title} — add it as an admin with "Post messages"`);
      out.push(`${ch.type} “${ch.title}”`);
    }
    return out.join(', ');
  },
  async facebook(c) { const r = await call(`https://graph.facebook.com/${c.graph}/${c.facebook.fb_page_id}?fields=name&access_token=${encodeURIComponent(c.facebook.fb_token)}`); return `Page “${r.name}”`; },
  async instagram(c) { const r = await call(`https://graph.facebook.com/${c.graph}/${c.instagram.ig_user_id}?fields=username&access_token=${encodeURIComponent(c.instagram.ig_token)}`); return `@${r.username}${/^https:\/\//.test(c.base) ? '' : ' — but set BASE_URL to your https site address before posting'}`; },
  async pinterest(c) {
    const h = { headers: { authorization: `Bearer ${c.pinterest.pin_token}` } };
    if (!c.pinterest.pin_board) {
      const r = await call('https://api.pinterest.com/v5/boards?page_size=50', h);
      if (!r.items?.length) throw new Error('token works, but this account has no boards — create one on Pinterest first');
      throw new Error('token works — now paste a Board ID: ' + r.items.map(b => `${b.name} = ${b.id}`).join(', '));
    }
    const r = await call(`https://api.pinterest.com/v5/boards/${c.pinterest.pin_board}`, h); return `board “${r.name}”`;
  },
  async twitter(c) { const url = 'https://api.x.com/2/users/me'; const r = await call(url, { headers: { authorization: oauthHeader('GET', url, c.twitter) } }); return `@${r.data.username}`; }
};

async function checkPlatform(p) {
  const c = cfg();
  if (!PLATFORMS[p].keys.every(k => c[p][k] || (p === 'pinterest' && k === 'pin_board'))) throw new Error('fill in all fields first');
  return CHECKS[p](c);
}

// Post one story to every enabled platform it hasn't reached yet
async function sharePost(postId, only) {
  const c = cfg();
  const news = parsePost(db.prepare('SELECT * FROM posts WHERE id=?').get(postId));
  if (!news || news.status !== 'published') return { skipped: 'not published' };
  const done = new Set(db.prepare("SELECT platform FROM social_log WHERE post_id=? AND status='ok'").all(postId).map(r => r.platform));
  const targets = Object.keys(PLATFORMS).filter(p => c[p].ready && !done.has(p) && (!only || only === p));
  if (!targets.length) return { results: [] };
  if (!c.base && targets.some(p => p !== 'telegram')) log('warn', 'Social: BASE_URL is not set — links in posts will be relative');
  const img = { square: await cardFile(news, 'square'), tall: await cardFile(news, 'tall') };
  const results = [];
  for (const p of targets) {
    try {
      const url = await POSTERS[p](news, c, img);
      db.prepare('INSERT INTO social_log(post_id,platform,status,url) VALUES(?,?,?,?)').run(postId, p, 'ok', url);
      results.push({ platform: p, ok: true, url });
    } catch (e) {
      db.prepare('INSERT INTO social_log(post_id,platform,status,error) VALUES(?,?,?,?)').run(postId, p, 'error', e.message);
      log('error', `Social ${PLATFORMS[p].name}: ${e.message} — "${news.title.slice(0, 60)}"`);
      results.push({ platform: p, ok: false, error: e.message });
    }
  }
  return { results };
}

let busy = false;
async function processQueue(limit) {
  if (busy) return { shared: 0 };
  busy = true;
  let shared = 0;
  try {
    const c = cfg();
    const rows = db.prepare("SELECT * FROM social_queue WHERE next_at <= datetime('now') ORDER BY created_at, post_id LIMIT ?").all(limit || c.perRun);
    for (const q of rows) {
      const r = await sharePost(q.post_id);
      const failed = (r.results || []).filter(x => !x.ok).length;
      if (!failed || q.attempts >= 2) db.prepare('DELETE FROM social_queue WHERE post_id=?').run(q.post_id);
      else db.prepare("UPDATE social_queue SET attempts=attempts+1, next_at=datetime('now', ?) WHERE post_id=?").run(`+${(q.attempts + 1) * 30} minutes`, q.post_id);
      if ((r.results || []).length) shared++;
    }
  } finally { busy = false; }
  return { shared };
}

function startWorker() {
  if (process.env.SCHEDULER_ENABLED === '0') return;
  cron.schedule('*/5 * * * *', () => processQueue().catch(e => log('error', 'Social queue: ' + e.message)), { timezone: 'Asia/Kolkata' });
}

module.exports = { PLATFORMS, SECRET_KEYS, cfg, quietly, quietlySync, onNewsCreated, enqueue, newsIdsFor, sharePost, processQueue, checkPlatform, startWorker };
