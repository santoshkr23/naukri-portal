// Activity log (who did what) and recycle bin (deleted posts kept 30 days, restorable).
const { db, log } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT (datetime('now')), who TEXT, role TEXT,
  action TEXT, post_id INTEGER, title TEXT, detail TEXT, ip TEXT);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
CREATE TABLE IF NOT EXISTS trash (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, title TEXT, category TEXT, status TEXT,
  row TEXT NOT NULL, deleted_by TEXT, deleted_at TEXT DEFAULT (datetime('now')));
`);

const who = actor => (typeof actor === 'string' ? { name: actor, role: actor === 'API' ? 'api' : 'system' } : actor?.user ? { name: actor.user.username, role: actor.user.role, ip: actor.ip } : actor ? { name: actor.username, role: actor.role } : { name: 'system', role: 'system' });

function record(actor, action, post, detail) {
  const w = who(actor);
  db.prepare('INSERT INTO audit(who,role,action,post_id,title,detail,ip) VALUES(?,?,?,?,?,?,?)')
    .run(w.name, w.role, action, post?.id || null, post?.title ? String(post.title).slice(0, 200) : null, detail ? String(detail).slice(0, 500) : null, w.ip || null);
  db.prepare("DELETE FROM audit WHERE at < datetime('now','-180 days')").run();
}

// Delete = move to the recycle bin. The post (and its news story) leave the site; nothing is lost for 30 days.
function trashPosts(ids, actor) {
  const get = db.prepare('SELECT * FROM posts WHERE id=?');
  const toBin = db.prepare('INSERT INTO trash(post_id,title,category,status,row,deleted_by) VALUES(?,?,?,?,?,?)');
  const remember = db.prepare('INSERT OR REPLACE INTO deleted_posts(fingerprint,title) VALUES(?,?)');
  const unlink = db.prepare('UPDATE seen_urls SET post_id=NULL WHERE post_id=?');
  const del = db.prepare('DELETE FROM posts WHERE id=?');
  const w = who(actor);
  const done = [];
  db.transaction(list => {
    for (const id of list) {
      const p = get.get(id); if (!p) continue;
      toBin.run(p.id, p.title, p.category, p.status, JSON.stringify(p), w.name);
      if (p.fingerprint) { remember.run(p.fingerprint, p.title); require('./news').deleteNewsFor(p.fingerprint); }
      unlink.run(id); del.run(id); done.push(p);
    }
  })(ids);
  for (const p of done) record(actor, 'deleted', p, 'moved to recycle bin');
  return done.length;
}

function restore(trashId, actor) {
  const t = db.prepare('SELECT * FROM trash WHERE id=?').get(trashId);
  if (!t) throw new Error('Not in the recycle bin any more.');
  const p = JSON.parse(t.row);
  if (p.fingerprint && db.prepare('SELECT 1 FROM posts WHERE fingerprint=?').get(p.fingerprint)) throw new Error('A post with the same title already exists — delete or rename it first.');
  const { uniqueSlug } = require('./util');
  const id = db.prepare('SELECT 1 FROM posts WHERE id=?').get(p.id) ? null : p.id;
  const slug = db.prepare('SELECT 1 FROM posts WHERE slug=?').get(p.slug) ? uniqueSlug(db, p.slug) : p.slug;
  const cols = ['title', 'category', 'organization', 'short_info', 'total_posts', 'meta_description', 'data', 'status', 'source_url', 'source_id', 'fingerprint', 'last_date', 'featured', 'published_at', 'updated_at', 'created_at'];
  const info = db.prepare(`INSERT INTO posts(${id ? 'id,' : ''}slug,${cols.join(',')}) VALUES(${id ? '?,' : ''}?,${cols.map(() => '?').join(',')})`)
    .run(...(id ? [id] : []), slug, ...cols.map(c => p[c] ?? null));
  const newId = id || info.lastInsertRowid;
  if (p.fingerprint) db.prepare('DELETE FROM deleted_posts WHERE fingerprint=?').run(p.fingerprint);
  db.prepare('DELETE FROM trash WHERE id=?').run(trashId);
  const { getById } = require('./posts');
  const post = getById(newId);
  if (post.status === 'published') { try { require('./news').ensureNewsFor(post); } catch {} }
  record(actor, 'restored', post, 'from recycle bin');
  return post;
}

function purge(trashId, actor) {
  const t = db.prepare('SELECT id, post_id, title FROM trash WHERE id=?').get(trashId);
  if (!t) return 0;
  db.prepare('DELETE FROM trash WHERE id=?').run(trashId);
  record(actor, 'deleted forever', { id: t.post_id, title: t.title });
  return 1;
}
function autoPurge() {
  const n = db.prepare("DELETE FROM trash WHERE deleted_at < datetime('now','-30 days')").run().changes;
  if (n) log('info', `Recycle bin: ${n} posts older than 30 days removed for good`);
  return n;
}

module.exports = { record, trashPosts, restore, purge, autoPurge };
