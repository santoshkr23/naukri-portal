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
  max_per_run: '10',
  first_run_limit: '5',
  telegram_url: '',
  whatsapp_url: '',
  contact_email: '',
  google_verification: '',
  ga_id: '',
  adsense_client: ''
};

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s;
}
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

module.exports = { db, DATA_DIR, getSettings, setSetting, log, CATEGORIES, parsePost };
