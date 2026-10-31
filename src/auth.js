// Admin sign-in with roles.
// The OWNER signs in with ADMIN_USER / ADMIN_PASSWORD from the environment and can do everything.
// The owner adds team members (Admin, Editor, Writer) in Admin → Team; their passwords are stored hashed.
const crypto = require('crypto');
const { db } = require('./db');

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'np_admin';
const attempts = new Map();

db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE COLLATE NOCASE NOT NULL, name TEXT, role TEXT NOT NULL,
  pass_hash TEXT NOT NULL, active INTEGER DEFAULT 1, ver INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), last_login TEXT)`);

// ---------- roles ----------
const ROLES = {
  owner: { name: 'Owner', about: 'Everything, including team members, API keys and Keep settings.' },
  admin: { name: 'Admin', about: 'Posts (publish, delete to the recycle bin, restore), settings, social media, job alerts, sources. Not team members, API keys or Keep settings.' },
  editor: { name: 'Editor', about: 'Write, edit, publish and unpublish posts, import Excel, share to social media. Cannot delete posts or change settings.' },
  writer: { name: 'Writer', about: 'Write and edit drafts. Cannot publish, delete, or edit posts that are already live.' }
};
const PERMS = {
  'posts.view': ['owner', 'admin', 'editor', 'writer'], 'posts.edit': ['owner', 'admin', 'editor', 'writer'],
  'posts.publish': ['owner', 'admin', 'editor'], 'posts.delete': ['owner', 'admin'],
  import: ['owner', 'admin', 'editor'], 'social.share': ['owner', 'admin', 'editor'], 'social.settings': ['owner', 'admin'],
  'notifications.send': ['owner', 'admin'], 'notifications.settings': ['owner', 'admin'], sources: ['owner', 'admin'],
  settings: ['owner', 'admin'], launch: ['owner', 'admin'], logs: ['owner', 'admin'], activity: ['owner', 'admin'],
  trash: ['owner', 'admin'], 'trash.purge': ['owner'], api: ['owner'], keep: ['owner'], users: ['owner']
};
const can = (user, perm) => !!user && (PERMS[perm] || []).includes(user.role);

// ---------- passwords ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${crypto.scryptSync(String(pw), salt, 32).toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const a = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), 32), b = Buffer.from(hash, 'base64');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function passwordProblem(pw, username) {
  pw = String(pw || '');
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'Password must not contain the username.';
  if (/^(.)\1+$|^(password|1234567890|qwertyuiop)/i.test(pw)) return 'That password is too easy to guess.';
  return null;
}

// ---------- sessions ----------
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('hex'); }
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
// Changing the owner password (or a member's password/role) signs that person out everywhere
const ownerVer = () => sign('owner:' + (process.env.ADMIN_PASSWORD || '')).slice(0, 12);
const OWNER = () => ({ id: 'owner', username: process.env.ADMIN_USER || 'admin', name: 'Owner', role: 'owner' });

function checkLogin(req, username, pass) {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 8) return { error: 'Too many attempts. Try again in 15 minutes.' };
  let user = null;
  if (process.env.ADMIN_PASSWORD && safeEq(String(username).toLowerCase(), String(process.env.ADMIN_USER || 'admin').toLowerCase()) && safeEq(pass, process.env.ADMIN_PASSWORD)) user = OWNER();
  else {
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username).trim());
    if (u && u.active && verifyPassword(pass, u.pass_hash)) { user = u; db.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").run(u.id); }
    else if (u && !u.active && verifyPassword(pass, u.pass_hash)) return { error: 'This account has been switched off by the owner.' };
  }
  if (!user) { a.n++; attempts.set(ip, a); return { error: 'Wrong username or password.' }; }
  attempts.delete(ip);
  return { user };
}

function setSession(res, secure, user) {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const uid = user.id === 'owner' ? 'owner' : String(user.id);
  const ver = user.id === 'owner' ? ownerVer() : String(user.ver || 1);
  const payload = `${uid}.${ver}.${exp}`;
  res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 3600}${secure ? '; Secure' : ''}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', [`${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`, `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`]);
}

function currentUser(req) {
  if (req._user !== undefined) return req._user;
  req._user = null;
  const v = readCookie(req, COOKIE); if (!v) return null;
  const parts = v.split('.'); if (parts.length !== 4) return null;
  const [uid, ver, exp, sig] = parts;
  if (!safeEq(sig, sign(`${uid}.${ver}.${exp}`)) || +exp < Date.now()) return null;
  if (uid === 'owner') { if (process.env.ADMIN_PASSWORD && safeEq(ver, ownerVer())) req._user = OWNER(); return req._user; }
  const u = db.prepare('SELECT id, username, name, role, active, ver FROM users WHERE id=?').get(+uid);
  if (u && u.active && String(u.ver) === ver && ROLES[u.role]) req._user = u;
  return req._user;
}
const isAuthed = req => !!currentUser(req);

function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (user) {
    if (req.method === 'POST') { // basic CSRF guard: same-origin posts only
      const origin = req.get('origin') || req.get('referer') || '';
      if (origin && !origin.includes(req.get('host'))) return res.status(403).send('Bad origin');
    }
    req.user = user;
    res.locals.user = user;
    res.locals.can = perm => can(user, perm);
    res.locals.ROLES = ROLES;
    return next();
  }
  res.redirect('/admin/login');
}

// Route guard: need('posts.delete')
const need = perm => (req, res, next) => {
  if (can(req.user, perm)) return next();
  const msg = `Your role (${ROLES[req.user?.role]?.name || 'unknown'}) can't do that — ask the owner.`;
  if (req.method === 'GET') return res.status(403).render('admin/denied', { msg });
  const back = (req.get('referer') || '/admin').replace(/([?&])msg=[^&]*/g, '$1').replace(/[?&]$/, '');
  res.redirect(back + (back.includes('?') ? '&' : '?') + 'msg=' + encodeURIComponent('✗ ' + msg));
};

// ---------- team members kept across restarts (Keep settings exports them as ADMIN_USERS) ----------
function exportUsers() {
  return db.prepare('SELECT username, name, role, pass_hash, active FROM users ORDER BY id').all();
}
function restoreUsers() {
  if (!process.env.ADMIN_USERS || db.prepare('SELECT 1 FROM users LIMIT 1').get()) return 0;
  let list; try { list = JSON.parse(process.env.ADMIN_USERS); } catch { console.error('ADMIN_USERS is not valid JSON'); return 0; }
  const ins = db.prepare('INSERT OR IGNORE INTO users(username,name,role,pass_hash,active) VALUES(?,?,?,?,?)');
  let n = 0;
  for (const u of list) if (u && u.username && ROLES[u.role] && u.role !== 'owner' && /^scrypt\$/.test(u.pass_hash || '')) n += ins.run(u.username, u.name || '', u.role, u.pass_hash, u.active === 0 ? 0 : 1).changes;
  return n;
}

module.exports = { checkLogin, setSession, clearSession, requireAdmin, isAuthed, currentUser, need, can, ROLES, PERMS, hashPassword, verifyPassword, passwordProblem, exportUsers, restoreUsers };
