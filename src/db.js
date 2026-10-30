const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'site.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'latest-jobs',
  organization TEXT,
  short_info TEXT,
  total_posts TEXT,
  meta_description TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  source_url TEXT,
  source_id INTEGER,
  fingerprint TEXT,
  last_date TEXT,
  featured INTEGER DEFAULT 0,
  published_at TEXT,
  updated_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_list ON posts(status, category, published_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_fp ON posts(fingerprint);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  list_url TEXT NOT NULL,
  link_selector TEXT,
  content_selector TEXT,
  enabled INTEGER DEFAULT 1,
  last_checked TEXT,
  last_error TEXT,
  imported_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seen_urls (
  url TEXT PRIMARY KEY,
  source_id INTEGER,
  post_id INTEGER,
  seen_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT,
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

-- Posts deleted in the admin; the Excel import and starter seed skip these so they don't come back
CREATE TABLE IF NOT EXISTS deleted_posts (fingerprint TEXT PRIMARY KEY, title TEXT, deleted_at TEXT DEFAULT (datetime('now')));
`);

const DEFAULT_SETTINGS = {
  site_name: 'NaukriSetu',
  site_tagline: 'Latest Govt Jobs, Admit Card, Result & Answer Key',
  home_intro: 'Fresh government job notifications, admit cards, results and answer keys — checked against official sources and updated every hour.',
  auto_publish: '1',
  auto_news: '1',
  social_auto: '1',
  social_per_run: '3',
  social_excel: '1',
  max_per_run: '10',
  first_run_limit: '5',
  telegram_url: '',
  whatsapp_url: '',
  contact_email: '',
  google_verification: '',
  ga_id: '',
  adsense_client: ''
};

// Settings saved in the admin live in the database. Hosts that wipe the disk on restart (Render's free plan)
// lose them, so every setting can also come from an environment variable of the same name in capitals
// (e.g. TG_TOKEN, SITE_NAME). Order: default < environment variable < value saved in the admin.
const ENV_SETTING = /^[a-z][a-z0-9_]*$/;
function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || ENV_SKIP.has(k)) continue;
    const key = k.toLowerCase();
    if (key in DEFAULT_SETTINGS || SETTING_PREFIX.test(key)) s[key] = v;
  }
  for (const r of rows) if (ENV_SETTING.test(r.key)) s[r.key] = r.value;
  return s;
}
// environment variables that are configuration of the server, not settings
const ENV_SKIP = new Set(['PORT', 'BASE_URL', 'DATA_DIR', 'ADMIN_USER', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'NODE_ENV', 'CRON_SCHEDULE', 'SCHEDULER_ENABLED']);
const SETTING_PREFIX = /^(tg_|fb_|ig_|pin_|x_|social_|graph_version$|(telegram|facebook|instagram|pinterest|twitter)_enabled$)/;
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value ?? ''));
}
function log(level, message) {
  db.prepare('INSERT INTO logs(level,message) VALUES(?,?)').run(level, String(message).slice(0, 2000));
  db.prepare("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 2000)").run();
  if (level === 'error') console.error('[import]', message); else console.log('[import]', message);
}

const CATEGORIES = {
  'news': { name: 'News', short: 'News', color: 'rose' },
  'latest-jobs': { name: 'Latest Jobs', short: 'Jobs', color: 'teal' },
  'admit-card': { name: 'Admit Card', short: 'Admit Card', color: 'indigo' },
  'result': { name: 'Result', short: 'Result', color: 'green' },
  'answer-key': { name: 'Answer Key', short: 'Answer Key', color: 'amber' },
  'admission': { name: 'Admission', short: 'Admission', color: 'rose' },
  'syllabus': { name: 'Syllabus', short: 'Syllabus', color: 'slate' },
  'exam-date': { name: 'Exam Date', short: 'Exam Date', color: 'violet' },
  // Extra sections from the Excel sheet; their home-page box is hidden until they have a published post
  'certificate': { name: 'Certificate', short: 'Certificate', color: 'indigo', optional: true },
  'outsourcing': { name: 'Outsourcing', short: 'Outsourcing', color: 'teal', optional: true },
  'important': { name: 'Important', short: 'Important', color: 'rose', optional: true }
};

function parsePost(row) {
  if (!row) return row;
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
  return { ...row, data };
}

// Public address of the site: BASE_URL, else the one Render provides, else the address the site was last opened at
function siteUrl() {
  const u = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || getSettings().site_url || '';
  return u.replace(/\/$/, '');
}

module.exports = { siteUrl, db, DATA_DIR, getSettings, setSetting, log, CATEGORIES, parsePost };

// .env quoting: bare when safe, single quotes (taken literally) otherwise
function envQuote(v) {
  v = String(v).replace(/\r?\n/g, ' ');
  if (/^[A-Za-z0-9_\-.:\/@,+=%]*$/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  return JSON.stringify(v);
}
// Everything worth keeping across a disk wipe, as KEY=value lines for Render → Environment → "Add from .env"
function settingsAsEnv() {
  const lines = [];
  for (const r of db.prepare('SELECT key, value FROM settings ORDER BY key').all()) {
    if (!ENV_SETTING.test(r.key) || r.key === 'site_url' || r.value === '' || r.value === DEFAULT_SETTINGS[r.key] || (/_enabled$/.test(r.key) && r.value === '0')) continue;
    lines.push(`${r.key.toUpperCase()}=${envQuote(r.value)}`);
  }
  const sources = db.prepare('SELECT name, list_url, link_selector, content_selector, enabled FROM sources ORDER BY id').all();
  if (sources.length) lines.push(`IMPORT_SOURCES=${envQuote(JSON.stringify(sources))}`);
  return lines.join('\n');
}
// Auto-import sources listed in IMPORT_SOURCES come back after a disk wipe
function restoreSources() {
  if (!process.env.IMPORT_SOURCES || db.prepare('SELECT 1 FROM sources LIMIT 1').get()) return 0;
  let list; try { list = JSON.parse(process.env.IMPORT_SOURCES); } catch { console.error('IMPORT_SOURCES is not valid JSON'); return 0; }
  const ins = db.prepare('INSERT INTO sources(name,list_url,link_selector,content_selector,enabled) VALUES(?,?,?,?,?)');
  for (const s of list) if (s && s.list_url) ins.run(s.name || s.list_url, s.list_url, s.link_selector || null, s.content_selector || null, s.enabled === 0 ? 0 : 1);
  return list.length;
}
module.exports.settingsAsEnv = settingsAsEnv;
module.exports.restoreSources = restoreSources;
