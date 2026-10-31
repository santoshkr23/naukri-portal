// Job alerts test: a local HTTPS stand-in for the browser's push service receives the encrypted notifications.
const path = require('path'); const fs = require('fs'); const os = require('os'); const https = require('https'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'np-push-'));
process.env.SCHEDULER_ENABLED = '0'; process.env.BASE_URL = 'https://example-site.test';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the stand-in uses a self-signed certificate
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', dir + '/k.pem', '-out', dir + '/c.pem', '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
const got = []; let status = 201;
const srv = https.createServer({ key: fs.readFileSync(dir + '/k.pem'), cert: fs.readFileSync(dir + '/c.pem') }, (req, res) => {
  const ch = []; req.on('data', c => ch.push(c)); req.on('end', () => { got.push({ path: req.url, h: req.headers, body: Buffer.concat(ch) }); res.statusCode = status; res.end(); });
}).listen(4814);

// a browser-like subscription: P-256 public key + 16-byte auth secret
const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
const sub = ep => ({ endpoint: `https://localhost:4814/${ep}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } });

(async () => {
  const app = require('../src/server'); const site = app.listen(4815); const B = 'http://localhost:4815';
  const { db, setSetting } = require('../src/db'); const { savePost } = require('../src/posts'); const push = require('../src/push');
  const j = async (m, p, body) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { s: r.status, j: await r.json() }; };

  const key = (await j('GET', '/push/key')).j.publicKey; assert.ok(key && key.length > 80, 'public key');
  assert.strictEqual((await j('POST', '/push/subscribe', { subscription: sub('a') })).s, 200);
  assert.strictEqual((await j('POST', '/push/subscribe', { subscription: sub('a') })).s, 200, 'same device twice');
  assert.strictEqual((await j('POST', '/push/subscribe', { subscription: sub('b') })).s, 200);
  assert.strictEqual((await j('POST', '/push/subscribe', { subscription: { endpoint: 'http://x' } })).s, 400, 'bad subscription refused');
  assert.strictEqual(push.count(), 2);

  // nothing new -> nothing sent
  setSetting('push_last_run', new Date(Date.now() - 1000).toISOString().replace('T', ' ').slice(0, 19));
  assert.strictEqual((await push.digest({ force: true })).posts, 0); assert.strictEqual(got.length, 0);

  // one new job -> each device gets one encrypted, signed notification
  const job = savePost({ title: 'SSC GD Constable Recruitment 2026: 39481 Posts', category: 'latest-jobs', status: 'published', total_posts: '39481', last_date: '2026-12-15', data: { intro: 'x', dates: [['Last date', '15 December 2026']], links: [['SSC', 'https://ssc.gov.in/']] } });
  db.prepare("UPDATE posts SET published_at=datetime('now','+1 second')").run();
  await new Promise(r => setTimeout(r, 1200));
  const r1 = await push.digest({ force: true });
  assert.strictEqual(r1.sent, 2, JSON.stringify(r1));
  assert.ok(got.every(g => g.h['content-encoding'] === 'aes128gcm' && /^vapid t=.+, k=/.test(g.h.authorization) && g.body.length > 100), 'encrypted + VAPID signed');
  assert.ok(got.every(g => g.h.ttl && g.h.topic === 'new-jobs'));

  // the open-page fallback lists the new post
  const latest = (await j('GET', '/push/latest?since=' + encodeURIComponent(new Date(Date.now() - 3600e3).toISOString()))).j;
  assert.ok(latest.posts.some(p => /SSC GD Constable/.test(p.title)), 'latest endpoint');

  // an expired device (410) is removed
  got.length = 0; status = 410;
  await push.sendAll(() => ({ title: 'x', body: 'y', url: '/' }));
  assert.strictEqual(push.count(), 0, 'expired subscriptions removed');

  // quiet hours: digest without force is skipped at night (IST)
  const h = Number(new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })) % 24;
  if (h >= 22 || h < 7) assert.strictEqual((await push.digest()).skipped, 'quiet hours');

  // service worker, manifest and icons are served
  const sw = await fetch(B + '/sw.js'); assert.strictEqual(sw.headers.get('service-worker-allowed'), '/');
  assert.strictEqual((await (await fetch(B + '/manifest.webmanifest')).json()).display, 'standalone');
  for (const i of ['icon-192', 'icon-512', 'badge-72', 'apple-touch-icon']) assert.strictEqual((await fetch(`${B}/${i}.png`)).headers.get('content-type'), 'image/png');
  const home = await (await fetch(B + '/')).text(); assert.ok(home.includes('id="alertBtn"') && home.includes('/static/js/alerts.js?v='), 'bell + script on pages');

  site.close(); srv.close(); console.log('PUSH TESTS PASSED'); process.exit(0);
})().catch(e => { console.error('PUSH TEST FAILED:', e.message); process.exit(1); });
