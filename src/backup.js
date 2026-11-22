// Daily database backup: a consistent copy of site.db into /backups (a folder on the VPS), keeping the last 14.
//   docker exec naukri-portal node src/backup.js
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const dir = process.env.BACKUP_DIR || '/backups';
fs.mkdirSync(dir, { recursive: true });
const name = `site-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.db`;
db.backup(path.join(dir, name)).then(() => {
  const old = fs.readdirSync(dir).filter(f => /^site-.*\.db$/.test(f)).sort().slice(0, -14);
  old.forEach(f => fs.unlinkSync(path.join(dir, f)));
  console.log(`Backup saved: ${name}${old.length ? ` (${old.length} old removed)` : ''}`);
  process.exit(0);
}).catch(e => { console.error('Backup failed:', e.message); process.exit(1); });
