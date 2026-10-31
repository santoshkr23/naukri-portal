// API test: key, create/update/list/publish/delete, validation, dry run
const path = require('path'); const fs = require('fs'); const os = require('os');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'np-api-'));
process.env.SCHEDULER_ENABLED = '0'; process.env.BASE_URL = 'https://example-site.test';
const assert = require('assert');
(async () => {
  const app = require('../src/server'); const srv = app.listen(4813); const B = 'http://localhost:4813/api/v1';
  const api = require('../src/routes/api');
  const call = async (method, p, body, key) => { const r = await fetch(B + p, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json() }; };

  assert.strictEqual((await call('GET', '/ping')).status, 401, 'no key -> 401');
  const key = api.newKey();
  assert.strictEqual((await call('GET', '/ping', null, 'wrong')).status, 401, 'wrong key -> 401');
  assert.strictEqual((await call('GET', '/ping', null, key)).j.ok, true);

  const job = { section: 'latest-jobs', title: 'SSC GD Constable Recruitment 2026', organisation: 'Staff Selection Commission (SSC)', total_posts: '39,481', last_date: '2099-12-15',
    dates: { 'Apply online starts': '16 November 2026' }, fees: { 'General / OBC': '₹100' }, min_age: '18 years', max_age: '23 years',
    vacancy: { BSF: 15654, CISF: 7145 }, eligibility: ['10th pass'], selection: ['CBT', 'PET'], links: { 'Apply online': 'https://ssc.gov.in/' },
    faqs: [{ q: 'Can 12th pass apply?', a: 'Yes.' }] };
  const dry = await call('POST', '/posts?dry_run=1', job, key);
  assert.ok(dry.j.ok && dry.j.dry_run, 'dry run ok');
  assert.strictEqual((await call('GET', '/posts', null, key)).j.total, 0, 'dry run saved nothing');

  const c = await call('POST', '/posts', job, key);
  assert.strictEqual(c.status, 201); assert.strictEqual(c.j.action, 'created'); assert.strictEqual(c.j.status, 'published');
  assert.ok(/^https:\/\/example-site\.test\/ssc-gd-constable-recruitment-2026/.test(c.j.url), c.j.url);
  assert.ok(c.j.news_url, 'news story made');
  const full = await call('GET', '/posts/' + c.j.id, null, key);
  assert.deepStrictEqual(full.j.data.vacancy, [['BSF', '15654'], ['CISF', '7145']]);
  assert.ok(full.j.data.dates.some(([k]) => /last date/i.test(k)), 'last date added to dates');
  assert.ok(full.j.data.faqs[0][0] === 'Can 12th pass apply?', 'own FAQ first');
  assert.strictEqual(full.j.total_posts, '39481');

  const u = await call('POST', '/posts', { ...job, total_posts: 40000 }, key);
  assert.strictEqual(u.j.action, 'updated'); assert.strictEqual(u.j.id, c.j.id, 'same post updated');

  const bad = await call('POST', '/posts', { section: 'latest-jobs', title: 'X' }, key);
  assert.strictEqual(bad.status, 400); assert.ok(bad.j.errors.some(e => /links/.test(e)));
  const closed = await call('POST', '/posts', { ...job, title: 'Old Job 2020', last_date: '2020-01-01' }, key);
  assert.ok(closed.j.errors.some(e => /passed/.test(e)), 'closed job refused');

  const ak = await call('POST', '/posts', { section: 'admit card', title: 'SSC CGL Tier-II Admit Card 2026', organisation: 'Staff Selection Commission (SSC)', dates: 'Admit card released: 1 December 2026\nExam date: 18 January 2027', links: 'SSC login: https://ssc.gov.in/login' }, key);
  assert.strictEqual(ak.j.section, 'admit-card', JSON.stringify(ak.j));

  const batch = await call('POST', '/posts', { posts: [job, { title: 'no section link' }] }, key);
  assert.strictEqual(batch.j.results.length, 2); assert.ok(batch.j.results[0].ok && !batch.j.results[1].ok);

  const d = await call('PATCH', '/posts/' + c.j.id, { status: 'draft' }, key); assert.strictEqual(d.j.status, 'draft');
  const l = await call('GET', '/posts?status=draft', null, key); assert.strictEqual(l.j.total, 1);
  const del = await call('DELETE', '/posts/' + c.j.id, null, key); assert.ok(del.j.ok);
  assert.strictEqual((await call('GET', '/posts/' + c.j.id, null, key)).status, 404);
  const again = await call('POST', '/posts', job, key); assert.ok(!again.j.ok && /deleted/.test(again.j.errors[0]), 'deleted post not recreated silently');
  assert.strictEqual((await call('POST', '/posts', { ...job, restore: true }, key)).j.action, 'created');
  const nojson = await fetch(B + '/posts', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: '{bad' });
  assert.strictEqual(nojson.status, 400);
  srv.close(); console.log('API TESTS PASSED'); process.exit(0);
})().catch(e => { console.error('API TEST FAILED:', e.message); process.exit(1); });
