// Imports posts from an Excel workbook (the "Govt_Job_Posts" format).
// Each sheet is one section of the site; the sheet name picks the section:
//   "Latest Jobs"  -> job format (Post name, Last date, Application fee, Vacancy, Eligibility, Official links …)
//   "Admit Card", "Result", "Answer Key", "Admission", "Syllabus", "Exam Date", "Certificate", "Outsourcing", "Important"
//                  -> update format (Title, Key dates, Login needed, Fee, Exam pattern, Official links …)
//   "All Posts – To Write" -> title list; titles not yet on the site are added as DRAFTS to fill in later
// Other sheets (Summary, Vacancy & Eligibility) are ignored.
// Rows are matched to existing posts by title, so re-importing an edited sheet updates those posts instead of duplicating them.
// Columns are found by their header text, so you can reorder columns or add your own.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { db, CATEGORIES, log } = require('./db');
const { savePost } = require('./posts');
const { fingerprint, slugify, parseDateLoose } = require('./util');
const { buildPost } = require('./seed-jobs');
const { buildUpdate } = require('./seed-updates');

const DEFAULT_FILE = path.join(__dirname, '..', 'content', 'posts.xlsx');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------- cell helpers ----------
function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return longDate(v.toISOString().slice(0, 10));
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map(r => r.text).join('');
    if ('result' in v) return cellText(v.result);
    if (v.text != null) return cellText(v.text);
    if (v.hyperlink) return String(v.hyperlink);
    return '';
  }
  return String(v).trim();
}
function cellIso(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  if (v && typeof v === 'object' && 'result' in v) return cellIso(v.result);
  return parseDateLoose(cellText(v));
}
function longDate(iso) { const [y, m, d] = iso.split('-').map(Number); return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`; }
// "2026-10-31" -> "31 October 2026", "07 Oct 2026" -> "07 October 2026"
function tidyDates(s) {
  return String(s || '')
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => longDate(`${y}-${mo}-${d}`))
    .replace(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.? (\d{4})\b/g,
      (m, d, mo, y) => `${d.padStart(2, '0')} ${MONTHS.find(x => x.startsWith(mo.slice(0, 3)))} ${y}`);
}
const isExample = s => !s || /^example\b/i.test(s.trim());
const lines = s => String(s || '').split(/\r?\n/).map(l => l.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, '').trim()).filter(Boolean);
// "Label: value" (URLs keep their "https:" because a space must follow the colon)
const kv = s => lines(s).map(l => { const m = l.match(/^(.+?):\s+(.+)$/); return m ? [m[1].trim(), tidyDates(m[2].trim())] : [l, '']; });
// "Post – value": split on the first dash (eligibility) or the last one (vacancy counts)
function dashPairs(s, last) {
  return lines(s).map(l => {
    const parts = l.split(' – ');
    if (parts.length < 2) return [l, ''];
    return last ? [parts.slice(0, -1).join(' – '), parts[parts.length - 1]] : [parts[0], parts.slice(1).join(' – ')];
  });
}
// "1. Read …  2. Register …" or one step per line
const steps = s => isExample(s) ? [] : String(s).split(/\r?\n|\s{2,}(?=\d+[.)]\s)/).map(x => x.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
function faqs(s) {
  if (isExample(s)) return [];
  const out = []; const re = /Q:\s*([\s\S]+?)\s*A:\s*([\s\S]+?)(?=\s*Q:|$)/g; let m;
  while ((m = re.exec(s))) out.push([m[1].trim(), m[2].trim()]);
  return out;
}

// Header row -> getter by header pattern
function reader(ws) {
  const head = {};
  ws.getRow(1).eachCell((c, i) => { head[i] = cellText(c.value).toLowerCase(); });
  const col = re => { for (const [i, h] of Object.entries(head)) if (re.test(h)) return +i; return null; };
  return { head, col };
}

// Split "SSC CGL Tier-I Admit Card 2026" into short "SSC" + name, so wording like "SSC admit card" reads naturally.
function splitTitle(title, org) {
  const abbr = (org.match(/\(([^)]+)\)\s*$/) || [])[1];
  const orgName = org.replace(/\s*\([^)]*\)\s*$/, '');
  for (const s of [abbr, orgName]) if (s && title.toLowerCase().startsWith(s.toLowerCase() + ' ')) return [title.slice(0, s.length), title.slice(s.length + 1)];
  const i = title.indexOf(' ');
  return i > 0 ? [title.slice(0, i), title.slice(i + 1)] : [title, ''];
}

const categoryOf = sheetName => {
  const k = slugify(sheetName.replace(/\b(posts?|sheet)\b/gi, ''));
  return CATEGORIES[k] ? k : CATEGORIES[k + 's'] ? k + 's' : CATEGORIES[k.replace(/s$/, '')] ? k.replace(/s$/, '') : null;
};

// ---------- row -> post ----------
function jobFromRow(row, col, today) {
  const g = re => { const i = col(re); return i ? row.getCell(i).value : null; };
  const t = re => cellText(g(re));
  const title = t(/^post name|^title/);
  if (!title) return null;
  const org = t(/^organi[sz]ation/);
  const last = cellIso(g(/^last date/)) || parseDateLoose(t(/^all important dates/).match(/last date[^:]*:\s*(.+)/i)?.[1]);
  if (!last) return { skip: `${title}: no last date` };
  if (last < today) return { skip: `${title}: closed (last date ${longDate(last)})`, closed: true, title };

  let dates = kv(t(/^all important dates/)).filter(([k, v]) => v && !(/fee last date/i.test(k) && /no fee/i.test(v)));
  if (!dates.length) {
    dates = [['Notification released', t(/^post date/)], ['Apply online starts', t(/^application starts/)], ['Last date to apply', longDate(last)],
      ['Last date for fee payment', t(/^fee last date/)], ['Exam date', t(/^exam date/)]].filter(([, v]) => v).map(([k, v]) => [k, tidyDates(v)]);
  }
  const fees = kv(t(/^application fee/)).filter(([, v]) => v);
  if (t(/payment mode/)) fees.push(['Payment mode', t(/payment mode/)]);

  const age = [];
  const min = t(/^min age/), max = t(/^max age/), note = t(/^age note/);
  if (min && !/^no\b/i.test(min)) age.push(['Minimum age', min]);
  if (max) age.push(['Maximum age', max]);
  if (note) age.push(/^as on\b/i.test(note) ? ['Age as on', tidyDates(note.replace(/^as on\s*/i, ''))] : /^as per\b|relax/i.test(note) ? ['Age relaxation', note] : ['Note', tidyDates(note)]);

  const pay = t(/^pay|stipend/);
  const salary = !pay ? [] : /:\s/.test(pay) ? kv(pay) : [['Pay', pay]];
  const total = t(/^total posts/);
  let vacancy = dashPairs(t(/^vacancy/), true);
  if (!vacancy.length && total) vacancy = [['Total', total]];
  const eligibility = dashPairs(t(/^eligibility/)).map(([k, v]) => (v ? [k, v] : ['All posts', k]));
  const selection = lines(t(/^selection/));
  const catWise = lines(t(/^category-wise/));

  const j = {
    base: title, short: '', name: title, org, advt: t(/^advt/), total, last, dates, fees, age, salary,
    vacancy, eligibility: eligibility.length ? eligibility : [['All posts', 'See official notification']],
    selection: selection.length ? selection : ['As per official notification'],
    links: kv(t(/official links/)).filter(([, u]) => /^https?:\/\//.test(u)),
    extra: catWise.length ? [{ heading: 'Category-wise vacancy', items: catWise }] : []
  };
  return { category: 'latest-jobs', post: personalise(buildPost(j), t(/your short info/), t(/your how to apply/), t(/your faqs/)) };
}

function updateFromRow(row, col, category) {
  const t = re => { const i = col(re); return i ? cellText(row.getCell(i).value) : ''; };
  const title = t(/^title|^post name/);
  if (!title) return null;
  const org = t(/^organi[sz]ation/);
  const [short, name] = splitTitle(title, org);
  const dates = kv(t(/^key dates|important dates/));
  const pat = lines(t(/^exam pattern/)).map(l => l.split('|').map(x => x.trim()));
  const u = {
    category, base: title, short, name, org, advt: t(/^advt/), total: t(/^total posts/),
    dates, last: parseDateLoose((dates.find(([k]) => /last date/i.test(k)) || [])[1]),
    login: lines(t(/^login/)), nextStages: lines(t(/^next stages/)), fees: kv(t(/^fee/)).filter(([, v]) => v),
    eligibility: dashPairs(t(/^eligibility/)).map(([k, v]) => (v ? [k, v] : ['All candidates', k])),
    pattern: pat.length > 1 ? { header: pat[0], rows: pat.slice(1) } : null,
    notes: lines(t(/^marking|notes/)), topics: kv(t(/^main topics|topics/)).filter(([, v]) => v),
    links: kv(t(/official links/)).filter(([, u]) => /^https?:\/\//.test(u))
  };
  if (!u.links.length) return { skip: `${title}: no official link` };
  if (!u.login.length && /admit-card|answer-key/.test(category)) u.login = ['Registration number', 'Password or date of birth'];
  return { category, post: personalise(buildUpdate(u), t(/your short info/)) };
}

// Your own text from the "YOUR … (write)" columns replaces the generated text (cells starting with "EXAMPLE" are ignored).
function personalise(p, intro, howTo, faqText) {
  if (!isExample(intro)) { p.data.intro = intro.trim(); p.short_info = intro.trim().slice(0, 280); }
  const st = steps(howTo); if (st.length) p.data.howTo = st;
  const fq = faqs(faqText);
  if (fq.length) { const asked = new Set(fq.map(([q]) => q.toLowerCase())); p.data.faqs = [...fq, ...p.data.faqs.filter(([q]) => !asked.has(q.toLowerCase()))]; }
  return p;
}

// ---------- save ----------
// Loose title matching for the "To Write" list, so "Bihar BPSC School Teacher TRE 4 Online Form 2026"
// counts as already posted when "BPSC School Teacher TRE 4.0 Recruitment 2026" exists.
// Titles naming different stages (Prelims vs Mains, Revised, Final, Tier II…) never match, and neither do titles
// where one names an exam acronym the other doesn't (CHSL vs CGL, CSIR NET vs UGC NET).
const MATCH_STOP = new Set(('a an and the of for in on at to by with india online form forms apply recruitment bharti notification various post posts ' +
  'result results admit card answer key exam date dates syllabus pattern admission certificate download out released new latest 0 cen').split(' '));
const STAGE = new Set('main prelim pre final revised tier ii iii pet pst skill interview merit mark score city stage phase provisional additional counselling'.split(' '));
const norm = t => t.replace(/^(\d+)(st|nd|rd|th)$/, '$1').replace(/^([a-z]{4,}[^su])s$/, '$1');
function matchTokens(s) {
  return new Set(String(s).toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/).filter(t => t && !MATCH_STOP.has(t)).map(norm));
}
const acronyms = s => new Set((String(s).match(/\b[A-Z]{2,6}\b/g) || []).filter(t => !/^[IVX]+$/.test(t)).map(t => t.toLowerCase()).filter(t => !MATCH_STOP.has(t)));
function similar(a, b) {
  const A = matchTokens(a), B = matchTokens(b);
  for (const t of STAGE) if (A.has(t) !== B.has(t)) return false;
  const shared = [...A].filter(t => B.has(t));
  // An acronym only one title has is a different exam, unless the other title spells it out ("HFL" ~ "Housing Finance")
  // or it contains a shared acronym ("JNVST" ~ "NVS").
  for (const [X, Y, src] of [[A, B, a], [B, A, b]]) {
    const yOnly = [...Y].filter(t => !X.has(t));
    for (const ac of acronyms(src)) {
      if (Y.has(ac)) continue;
      const initials = yOnly.filter(t => /^[a-z]/.test(t)).map(t => t[0]).join('');
      const spelled = initials.length >= 2 && (ac.startsWith(initials) || initials.includes(ac));
      if (!spelled && !shared.some(t => t.length >= 3 && t !== ac && ac.includes(t))) return false;
    }
  }
  const [s] = A.size <= B.size ? [A, B] : [B, A];
  if (s.size < 3) return false;
  return shared.length / s.size >= 0.75;
}
const nearMatch = (title, category, extraTitles = []) =>
  db.prepare("SELECT title FROM posts WHERE category=? AND status='published'").all(category).some(r => similar(title, r.title.split(':')[0])) ||
  extraTitles.some(t => similar(title, t));

function upsert(p, report) {
  p.fingerprint = fingerprint(p.base, p.category);
  if (db.prepare('SELECT 1 FROM deleted_posts WHERE fingerprint=?').get(p.fingerprint)) { report.skipped.push(`${p.base}: deleted in admin`); return; }
  const old = db.prepare('SELECT * FROM posts WHERE fingerprint=?').get(p.fingerprint);
  if (!old) { savePost(p); report.created.push(p.title); return; }
  const same = old.title === p.title && old.data === JSON.stringify(p.data) && old.status === p.status && (old.last_date || null) === (p.last_date || null);
  if (same) { report.unchanged.push(p.title); return; }
  savePost({ ...p, slug: old.slug, featured: p.featured || !!old.featured }, old.id);
  report.updated.push(p.title);
}

// Bulk import: stories it creates are not auto-shared (use Admin → Posts → Share to social for those you want)
function importWorkbook(...args) {
  const firstImport = !db.prepare("SELECT 1 FROM posts WHERE category<>'news' LIMIT 1").get();
  const social = require('./social');
  // New rows are posted to social media like any new post — except when the database is empty
  // (a fresh deploy), where every row looks new and would flood the accounts.
  if (firstImport || !social.cfg().excel) return social.quietly(() => importWorkbookNow(...args));
  return importWorkbookNow(...args);
}

async function importWorkbookNow(file = DEFAULT_FILE, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(file)) await wb.xlsx.load(file); else await wb.xlsx.readFile(file);
  const report = { created: [], updated: [], unchanged: [], drafts: [], skipped: [], sheets: [], closedTitles: [], todoTitles: [], removedBlank: 0 };

  wb.eachSheet(ws => {
    const { col } = reader(ws);
    const isJobs = col(/^post name/) && col(/^last date/);
    const isUpdates = col(/^title/) && col(/official links/);
    const isTodo = col(/^section/) && col(/^post title/);
    const category = categoryOf(ws.name);
    if (!isJobs && !isUpdates && !isTodo) return;
    if (!isTodo && !category) { report.skipped.push(`Sheet "${ws.name}": no matching section on the site`); return; }
    report.sheets.push(ws.name);

    ws.eachRow((row, n) => {
      if (n === 1) return;
      try {
        if (isTodo) return todoRow(row, col, report);
        const r = isJobs ? jobFromRow(row, col, today) : updateFromRow(row, col, category);
        if (!r) return;
        if (r.skip) { report.skipped.push(r.skip); if (r.closed) report.closedTitles.push(r.title); return; }
        upsert(r.post, report);
      } catch (e) { report.skipped.push(`${ws.name} row ${n}: ${e.message}`); }
    });
  });
  if (require('./db').getSettings().todo_drafts !== '1') report.removedBlank = removeBlankTodoDrafts(report.todoTitles);
  log('info', `Excel import: ${report.removedBlank ? report.removedBlank + ' blank drafts deleted, ' : ''}${report.created.length} new, ${report.updated.length} updated, ${report.unchanged.length} unchanged, ${report.drafts.length} drafts, ${report.skipped.length} skipped`);
  return report;
}

// "All Posts – To Write": add titles that aren't on the site yet as drafts.
// "All Posts – To Write" is only your to-do list: its titles have no dates, fees or links, so no draft is
// created for them (set the setting todo_drafts=1 to create blank drafts again). Blank drafts made from it
// earlier are deleted on import.
function todoRow(row, col, report) {
  const t = re => { const i = col(re); return i ? cellText(row.getCell(i).value) : ''; };
  const title = t(/^post title/), category = categoryOf(t(/^section/));
  if (title) report.todoTitles.push(title);
  if (require('./db').getSettings().todo_drafts !== '1') return;
  if (!title || /done|skip|ignore|posted/i.test(t(/^status/))) return;
  if (!category) { report.skipped.push(`${title}: unknown section "${t(/^section/)}"`); return; }
  // Words in brackets matter here: "Combined JE (Electrical)" and "Combined JE (Mechanical)" are two different drafts
  const fp = fingerprint(title.replace(/[()]/g, ' '), category);
  if (db.prepare('SELECT 1 FROM posts WHERE fingerprint=? UNION SELECT 1 FROM deleted_posts WHERE fingerprint=?').get(fp, fp) ||
    db.prepare("SELECT 1 FROM posts WHERE fingerprint=? AND status='published'").get(fingerprint(title, category)) || nearMatch(title, category, category === 'latest-jobs' ? report.closedTitles : [])) return;
  const link = t(/official link/);
  savePost({
    title, base: title, slug: title, category, status: 'draft', fingerprint: fp,
    data: { intro: '', advt: '', dates: [], fees: [], age: [], salary: [], vacancyHeader: ['Post Name', 'Total Posts'], vacancy: [], eligibility: [], selection: [], howTo: [],
      links: /^https?:\/\//.test(link) ? [['Official website', link]] : [], faqs: [], extra: [] }
  });
  report.drafts.push(title);
}

// Unpublished posts that are still empty (no intro, dates, fees or links) and whose title is on the To Write list
function removeBlankTodoDrafts(titles) {
  const want = new Set(titles.map(x => x.trim().toLowerCase()));
  const rows = db.prepare("SELECT id, title, data, fingerprint FROM posts WHERE status='draft' AND category<>'news' AND source_url IS NULL").all();
  const del = db.prepare('DELETE FROM posts WHERE id=?');
  let n = 0;
  for (const r of rows) {
    let d = {}; try { d = JSON.parse(r.data || '{}'); } catch {}
    const blank = !String(d.intro || '').trim() && !(d.dates || []).length && !(d.fees || []).length && !(d.vacancy || []).length && (d.links || []).length <= 1;
    if (blank && want.has(r.title.trim().toLowerCase())) { del.run(r.id); n++; }
  }
  return n;
}

if (require.main === module) {
  require('dotenv').config();
  const file = process.argv[2] || DEFAULT_FILE;
  importWorkbook(path.resolve(file)).then(r => {
    console.log(`Sheets: ${r.sheets.join(', ')}`);
    console.log(`New: ${r.created.length}  Updated: ${r.updated.length}  Unchanged: ${r.unchanged.length}  Drafts added: ${r.drafts.length}  Skipped: ${r.skipped.length}`);
    r.skipped.forEach(s => console.log('  skipped –', s));
  }).catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { importWorkbook, DEFAULT_FILE, hasDefaultFile: () => fs.existsSync(DEFAULT_FILE), personalise, splitTitle, tidyDates, longDate };
