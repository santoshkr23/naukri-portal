// Roles test: each role signs in and tries actions it should and shouldn't be able to do.
const path = require('path'); const fs = require('fs'); const os = require('os');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'np-roles-'));
process.env.SCHEDULER_ENABLED = '0'; process.env.ADMIN_USER = 'owner1'; process.env.ADMIN_PASSWORD = 'Owner-pass-123'; process.env.SESSION_SECRET = 'r'.repeat(40);
const assert = require('assert');
(async () => {
  const app = require('../src/server'); const srv = app.listen(4816); const B = 'http://localhost:4816';
  const { db } = require('../src/db'); const { savePost } = require('../src/posts');
  const form = o => new URLSearchParams(o).toString();
  async function login(u, p) {
    const r = await fetch(B + '/admin/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ user: u, pass: p }) });
    const c = r.headers.get('set-cookie'); return r.status === 302 && c ? c.split(';')[0] : null;
  }
  const as = cookie => ({
    get: async p => { const r = await fetch(B + p, { redirect: 'manual', headers: { cookie } }); return { s: r.status, t: await r.text(), loc: r.headers.get('location') || '' }; },
    post: async (p, o) => { const r = await fetch(B + p, { method: 'POST', redirect: 'manual', headers: { cookie, origin: B, 'content-type': 'application/x-www-form-urlencoded' }, body: form(o || {}) }); return { s: r.status, loc: decodeURIComponent(r.headers.get('location') || ''), t: await r.text() }; }
  });
  const mk = (title, status = 'published') => savePost({ title, category: 'latest-jobs', status, data: { intro: 'x', dates: [['Last date', '1 Dec 2099']], links: [['Official', 'https://example.gov.in/']] } });
  const exists = id => !!db.prepare('SELECT 1 FROM posts WHERE id=?').get(id);

  const owner = as(await login('owner1', 'Owner-pass-123')); assert.ok(owner, 'owner signs in');
  assert.strictEqual((await login('owner1', 'wrong')), null, 'wrong password refused');
  for (const [u, r] of [['wendy', 'writer'], ['eddie', 'editor'], ['adam', 'admin']]) {
    const x = await owner.post('/admin/team/add', { username: u, role: r, password: 'Strong-pass-42' });
    assert.ok(/Added/.test(x.loc), `${r} added: ${x.loc}${x.t.slice(0, 0)}`);
  }
  assert.ok(/at least 10/.test((await owner.post('/admin/team/add', { username: 'weak', role: 'writer', password: 'short' })).t), 'weak password refused');

  const writer = as(await login('wendy', 'Strong-pass-42')), editor = as(await login('eddie', 'Strong-pass-42')), admin = as(await login('adam', 'Strong-pass-42'));
  const live = mk('Live Job 2026'), live2 = mk('Second Job 2026');

  // ---- writer
  assert.strictEqual((await writer.get('/admin/settings')).s, 403, 'writer: no settings');
  assert.strictEqual((await writer.get('/admin/team')).s, 403);
  await writer.post(`/admin/posts/${live.id}/delete`); assert.ok(exists(live.id), 'writer cannot delete');
  await writer.post('/admin/posts/bulk', { action: 'delete', ids: live.id }); assert.ok(exists(live.id), 'writer cannot bulk delete');
  await writer.post(`/admin/posts/${live.id}/status?to=draft`); assert.strictEqual(db.prepare('SELECT status FROM posts WHERE id=?').get(live.id).status, 'published', 'writer cannot unpublish');
  const ed = await writer.post('/admin/posts/save', { id: live.id, title: 'Hacked title', category: 'latest-jobs', status: 'published', dates: 'Last date | 1 Dec 2099', links: 'Official | https://example.gov.in/' });
  assert.ok(/only an Editor/.test(ed.t) && db.prepare('SELECT title FROM posts WHERE id=?').get(live.id).title === 'Live Job 2026', 'writer cannot edit a live post');
  await writer.post('/admin/posts/save', { title: 'Writer Draft 2026', category: 'latest-jobs', status: 'published', dates: 'Last date | 1 Dec 2099', links: 'Official | https://example.gov.in/' });
  assert.strictEqual(db.prepare("SELECT status FROM posts WHERE title='Writer Draft 2026'").get().status, 'draft', 'writer posts stay drafts');
  assert.ok(!(await writer.get('/admin/posts')).t.includes('value="delete"'), 'writer sees no delete button');

  // ---- editor
  await editor.post(`/admin/posts/${live.id}/delete`); assert.ok(exists(live.id), 'editor cannot delete');
  assert.strictEqual((await editor.get('/admin/social')).s, 403, 'editor: no social settings');
  const draft = db.prepare("SELECT id FROM posts WHERE title='Writer Draft 2026'").get().id;
  await editor.post('/admin/posts/bulk', { action: 'publish', ids: draft });
  assert.strictEqual(db.prepare('SELECT status FROM posts WHERE id=?').get(draft).status, 'published', 'editor can publish');

  // ---- admin: delete goes to the bin, can restore, cannot empty the bin or manage the team
  assert.strictEqual((await admin.get('/admin/team')).s, 403); assert.strictEqual((await admin.get('/admin/keep-settings')).s, 403); assert.strictEqual((await admin.get('/admin/api')).s, 403);
  await admin.post(`/admin/posts/${live.id}/delete`); assert.ok(!exists(live.id), 'admin can delete');
  const bin = db.prepare('SELECT * FROM trash WHERE post_id=?').get(live.id); assert.ok(bin && bin.deleted_by === 'adam', 'in recycle bin, by adam');
  await admin.post(`/admin/trash/${bin.id}/purge`); assert.ok(db.prepare('SELECT 1 FROM trash WHERE id=?').get(bin.id), 'admin cannot empty the bin');
  const re = await admin.post(`/admin/trash/${bin.id}/restore`); assert.ok(/Restored/.test(re.loc), re.loc);
  const back = db.prepare('SELECT id, slug, status FROM posts WHERE id=?').get(live.id); assert.ok(back && back.slug === 'live-job-2026' && back.status === 'published', 'restored with same id and address');
  assert.ok(db.prepare("SELECT 1 FROM posts WHERE fingerprint=?").get('news:' + db.prepare('SELECT fingerprint FROM posts WHERE id=?').get(live.id).fingerprint), 'news story back');

  // ---- owner can empty the bin
  await admin.post(`/admin/posts/${live2.id}/delete`);
  const b2 = db.prepare('SELECT id FROM trash WHERE post_id=?').get(live2.id);
  await owner.post(`/admin/trash/${b2.id}/purge`); assert.ok(!db.prepare('SELECT 1 FROM trash WHERE id=?').get(b2.id), 'owner empties the bin');

  // ---- activity names the person
  const acts = db.prepare('SELECT who, action, title FROM audit').all();
  assert.ok(acts.some(a => a.who === 'adam' && a.action === 'deleted' && a.title === 'Live Job 2026'));
  assert.ok(acts.some(a => a.who === 'adam' && a.action === 'restored'));
  assert.ok(acts.some(a => a.who === 'eddie' && a.action === 'published'));
  assert.ok((await owner.get('/admin/activity')).t.includes('adam'));

  // ---- role change / switch off signs people out at once
  const eddieId = db.prepare("SELECT id FROM users WHERE username='eddie'").get().id;
  await owner.post(`/admin/team/${eddieId}`, { act: 'role', role: 'writer' });
  assert.strictEqual((await editor.get('/admin/posts')).s, 302, 'old session ended after role change');
  const adamId = db.prepare("SELECT id FROM users WHERE username='adam'").get().id;
  await owner.post(`/admin/team/${adamId}`, { act: 'toggle' });
  assert.strictEqual(await login('adam', 'Strong-pass-42'), null, 'switched-off account cannot sign in');

  // ---- team survives a wiped disk through ADMIN_USERS
  const env = require('../src/db').settingsAsEnv(); const line = env.split('\n').find(l => l.startsWith('ADMIN_USERS='));
  assert.ok(line && !line.includes('Strong-pass-42') && line.includes('scrypt$'), 'exported as hashes only');
  db.prepare('DELETE FROM users').run();
  process.env.ADMIN_USERS = line.slice('ADMIN_USERS='.length).replace(/^'|'$/g, '');
  assert.strictEqual(require('../src/auth').restoreUsers(), 3);
  assert.ok(await login('wendy', 'Strong-pass-42'), 'restored member signs in');

  srv.close(); console.log('ROLE TESTS PASSED'); process.exit(0);
})().catch(e => { console.error('ROLE TEST FAILED:', e.message); process.exit(1); });
