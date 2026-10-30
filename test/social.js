// Social posting test: a local stand-in for Telegram, Facebook, Instagram, Pinterest and X records each request.
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'np-social-'));
process.env.SOCIAL_TEST_ORIGIN = 'http://localhost:4811';
process.env.BASE_URL = 'https://example-site.test';
process.env.SCHEDULER_ENABLED = '0';
const assert = require('assert');

const seen = [];
const mock = http.createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    const body = Buffer.concat(chunks); const [, host, ...rest] = req.url.split('/'); const p = '/' + rest.join('/');
    seen.push({ host, path: p.split('?')[0], method: req.method, auth: req.headers.authorization || '', type: req.headers['content-type'] || '', body });
    const j = o => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (host === 'api.telegram.org') return j({ ok: true, result: { message_id: 7, chat: { username: 'testchannel' } } });
    if (p.endsWith('/photos')) return j({ id: '11', post_id: '22_33' });
    if (p.endsWith('/media')) return j({ id: 'container1' });
    if (p.endsWith('/media_publish')) return j({ id: 'ig99' });
    if (p.startsWith('/v26.0/ig99')) return j({ permalink: 'https://instagram.com/p/xyz' });
    if (host === 'api.pinterest.com') return j({ id: '555' });
    if (p.includes('media/upload')) return j({ media_id_string: '777' });
    if (p === '/2/tweets') return j({ data: { id: '888' } });
    res.statusCode = 404; j({ error: { message: 'not mocked ' + p } });
  });
}).listen(4811);

(async () => {
  const { db, setSetting } = require('../src/db');
  const { savePost } = require('../src/posts');
  const social = require('../src/social');
  const set = o => Object.entries(o).forEach(([k, v]) => setSetting(k, v));
  set({ telegram_enabled: '1', tg_token: '1:abc', tg_chats: '@testchannel', facebook_enabled: '1', fb_page_id: '22', fb_token: 'fbt',
    instagram_enabled: '1', ig_user_id: '1784', ig_token: 'igt', pinterest_enabled: '1', pin_token: 'pina', pin_board: '123',
    twitter_enabled: '1', x_api_key: 'k', x_api_secret: 's', x_access_token: 't', x_access_secret: 'ts', social_auto: '1' });

  // A post published by hand -> its news story is queued
  const job = savePost({ title: 'RRB Technician Answer Key 2026: Download & Raise Objection', category: 'answer-key', status: 'published', organization: 'Railway Recruitment Board (RRB)',
    data: { intro: 'x', dates: [['Answer key released', '15 October 2026']], links: [['RRB official website', 'https://rrb.indianrailways.gov.in/']] } });
  const news = db.prepare("SELECT * FROM posts WHERE fingerprint=?").get('news:' + job.fingerprint);
  assert.ok(news, 'news story written');
  assert.ok(db.prepare('SELECT 1 FROM social_queue WHERE post_id=?').get(news.id), 'story queued for social');

  // Bulk jobs don't queue
  await social.quietly(async () => savePost({ title: 'SSC MTS Result 2026: Check Result', category: 'result', status: 'published', data: { intro: 'x', dates: [['Result', '1 November 2026']], links: [['SSC', 'https://ssc.gov.in/']] } }));
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM social_queue').get().c, 1, 'bulk import does not queue');

  const r = await social.processQueue();
  assert.strictEqual(r.shared, 1);
  const logs = db.prepare('SELECT platform, status, url, error FROM social_log').all();
  console.log(logs.map(l => `${l.platform}: ${l.status} ${l.url || l.error}`).join('\n'));
  assert.ok(logs.every(l => l.status === 'ok'), 'all platforms posted');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM social_queue').get().c, 0, 'queue emptied');

  const tg = seen.find(s => s.path.endsWith('/sendPhoto'));
  assert.ok(tg.type.startsWith('multipart/form-data') && tg.body.includes(Buffer.from([0xff, 0xd8, 0xff])), 'telegram got a JPEG');
  assert.ok(tg.body.toString().includes('https://example-site.test/rrb-technician-answer-key-2026-news/'), 'telegram caption has the link');
  const ig = seen.find(s => s.path.endsWith('/media'));
  const igBody = JSON.parse(ig.body); assert.ok(/^https:\/\/example-site\.test\/social\/.+-square-[0-9a-f]{8}\.jpg$/.test(igBody.image_url), 'instagram image url is public: ' + igBody.image_url);
  const pin = JSON.parse(seen.find(s => s.host === 'api.pinterest.com').body);
  assert.strictEqual(pin.board_id, '123'); assert.strictEqual(pin.media_source.source_type, 'image_base64'); assert.ok(pin.title.length <= 100);
  const tw = seen.find(s => s.path === '/2/tweets');
  assert.ok(/^OAuth oauth_consumer_key="k".*oauth_signature="/.test(tw.auth), 'x request is OAuth 1.0a signed');
  const tweet = JSON.parse(tw.body); assert.deepStrictEqual(tweet.media.media_ids, ['777']);
  const len = tweet.text.replace(/https?:\/\/\S+/g, 'x'.repeat(23)).length; assert.ok(len <= 280, 'tweet fits 280: ' + len);
  console.log('Tweet:', tweet.text.replace(/\n/g, ' | '));

  // already posted -> sharing again does nothing; the image file is served publicly
  const again = await social.sharePost(news.id); assert.strictEqual(again.results.length, 0, 'no double posting');
  const app = require('../src/server'); const srv = app.listen(4812);
  const img = await fetch('http://localhost:4812/social/' + igBody.image_url.split('/social/')[1]);
  assert.strictEqual(img.status, 200); assert.strictEqual(img.headers.get('content-type'), 'image/jpeg');
  fs.writeFileSync(path.join(__dirname, 'out-social.jpg'), Buffer.from(await img.arrayBuffer()));
  srv.close(); mock.close();
  console.log('SOCIAL TESTS PASSED'); process.exit(0);
})().catch(e => { console.error('SOCIAL TEST FAILED:', e.message); process.exit(1); });
