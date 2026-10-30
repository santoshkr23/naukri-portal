const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'np_admin';
const attempts = new Map();

function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('hex'); }
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

function checkLogin(req, user, pass) {
  const ip = req.ip;
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 8) return 'Too many attempts. Try again in 15 minutes.';
  const ok = process.env.ADMIN_PASSWORD && safeEq(user, process.env.ADMIN_USER || 'admin') && safeEq(pass, process.env.ADMIN_PASSWORD);
  if (!ok) { a.n++; attempts.set(ip, a); return 'Wrong username or password.'; }
  attempts.delete(ip);
  return null;
}

function setSession(res, secure) {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const val = `${exp}.${sign(String(exp))}`;
  res.setHeader('Set-Cookie', `${COOKIE}=${val}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 3600}${secure ? '; Secure' : ''}`);
}
function clearSession(res) { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`); }

function isAuthed(req) {
  const v = readCookie(req, COOKIE); if (!v) return false;
  const [exp, sig] = v.split('.');
  return sig && safeEq(sig, sign(exp)) && +exp > Date.now();
}

function requireAdmin(req, res, next) {
  if (isAuthed(req)) {
    if (req.method === 'POST') { // basic CSRF guard: same-origin posts only
      const origin = req.get('origin') || req.get('referer') || '';
      if (origin && !origin.includes(req.get('host'))) return res.status(403).send('Bad origin');
    }
    return next();
  }
  res.redirect('/admin/login');
}

module.exports = { checkLogin, setSession, clearSession, requireAdmin, isAuthed };
