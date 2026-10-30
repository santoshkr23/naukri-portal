const fs = require('fs');
const path = require('path');
const { db, parsePost, DATA_DIR } = require('./db');
const { uniqueSlug, nowSql, fingerprint } = require('./util');

const PUBLIC = "status='published'";

// A post's "year" is the year in its title (e.g. "... Admit Card 2026"); titles without a year use the publish year.
function yearClause(years) {
  const parts = years.map(() => "(title LIKE ? OR (title NOT GLOB '*20[0-9][0-9]*' AND substr(published_at,1,4)=?))");
  return { sql: `(${parts.join(' OR ')})`, args: years.flatMap(y => [`%${y}%`, String(y)]) };
}

function listPosts({ category, limit = 20, offset = 0, q, years } = {}) {
  const where = [PUBLIC]; const args = [];
  if (years && years.length) { const y = yearClause(years); where.push(y.sql); args.push(...y.args); }
  if (category) { where.push('category=?'); args.push(category); }
  if (q) { where.push('(title LIKE ? OR organization LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  const rows = db.prepare(`SELECT id,slug,title,category,organization,total_posts,last_date,published_at,updated_at,featured
    FROM posts WHERE ${where.join(' AND ')} ORDER BY published_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM posts WHERE ${where.join(' AND ')}`).get(...args).c;
  return { rows, total };
}

function getBySlug(slug) { return parsePost(db.prepare('SELECT * FROM posts WHERE slug=?').get(slug)); }
function getById(id) { return parsePost(db.prepare('SELECT * FROM posts WHERE id=?').get(id)); }

function related(post, n = 8) {
  return db.prepare(`SELECT slug,title,category FROM posts WHERE ${PUBLIC} AND id<>? AND (category=? OR organization=?)
    ORDER BY published_at DESC LIMIT ?`).all(post.id, post.category, post.organization || '', n);
}

function clearOg(slug) { try { fs.unlinkSync(path.join(DATA_DIR, 'og', `${slug}.png`)); } catch {} }

function savePost(p, id) {
  const now = nowSql();
  const row = {
    title: p.title, category: p.category, organization: p.organization || '', short_info: p.short_info || '',
    total_posts: p.total_posts || '', meta_description: p.meta_description || '', data: JSON.stringify(p.data || {}),
    status: p.status || 'draft', source_url: p.source_url || null, source_id: p.source_id || null,
    last_date: p.last_date || null, featured: p.featured ? 1 : 0
  };
  if (id) {
    const old = getById(id);
    const slug = p.slug && p.slug !== old.slug ? uniqueSlug(db, p.slug, id) : old.slug;
    const published_at = row.status === 'published' ? (old.published_at || now) : old.published_at;
    db.prepare(`UPDATE posts SET slug=@slug,title=@title,category=@category,organization=@organization,short_info=@short_info,
      total_posts=@total_posts,meta_description=@meta_description,data=@data,status=@status,last_date=@last_date,featured=@featured,
      published_at=@published_at,updated_at=@updated_at WHERE id=@id`).run({ ...row, slug, published_at, updated_at: now, id });
    clearOg(old.slug); clearOg(slug);
    return getById(id);
  }
  const slug = uniqueSlug(db, p.slug || p.title);
  const info = db.prepare(`INSERT INTO posts(slug,title,category,organization,short_info,total_posts,meta_description,data,status,
    source_url,source_id,fingerprint,last_date,featured,published_at,updated_at)
    VALUES(@slug,@title,@category,@organization,@short_info,@total_posts,@meta_description,@data,@status,@source_url,@source_id,
    @fingerprint,@last_date,@featured,@published_at,@updated_at)`).run({
    ...row, slug, fingerprint: p.fingerprint || fingerprint(p.base || p.title, p.category),
    published_at: row.status === 'published' ? now : null, updated_at: now
  });
  return getById(info.lastInsertRowid);
}

module.exports = { yearClause, listPosts, getBySlug, getById, related, savePost, clearOg };
