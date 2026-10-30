// Colourful 1280x720 banner for every post, made automatically from the post's facts:
// outlined title, total posts, important dates, highlights, icon tiles, "Apply Online Now" and an original
// big calendar with the key date. Used as the post's main image and its share image.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { DATA_DIR, getSettings } = require('./db');

const FONTS = path.join(__dirname, '..', 'assets', 'fonts');
const F = {
  anton: { file: path.join(FONTS, 'Anton-Regular.ttf'), name: 'Anton' },
  baloo: { file: path.join(FONTS, 'Baloo2-ExtraBold.ttf'), name: 'Baloo 2 ExtraBold' },
  hind: { file: path.join(FONTS, 'Hind-Bold.ttf'), name: 'Hind Bold' }
};
const DIR = path.join(DATA_DIR, 'banner');
const W = 1280, H = 720;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function txt(str, { font = 'baloo', size, color = '#ffffff', width, align = 'left', spacing = 0 }) {
  const { data, info } = await sharp({ text: { text: `<span foreground="${color}">${esc(str)}</span>`, font: `${F[font].name} ${size}`, fontfile: F[font].file,
    rgba: true, align, spacing, ...(width ? { width } : {}) } }).png().toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}
// Largest size whose single line fits maxW x maxH
async function fitLine(str, opts, maxW, maxH, from, to = 18) {
  for (let size = from; size >= to; size -= 3) {
    const t = await txt(str, { ...opts, size });
    if (t.width <= maxW && t.height <= maxH) return t;
  }
  return txt(str, { ...opts, size: to, width: maxW });
}
// One size; long text is shortened with … until it fits
async function fitCut(str, opts, maxW) {
  let s = String(str), t = await txt(s, opts);
  while (t.width > maxW && s.length > 6) { s = s.slice(0, -2).replace(/[\s,:–-]+$/, ''); t = await txt(s + '…', opts); }
  return t;
}
// Thick outline behind a text (like a sticker)
async function outlined(t, color, r) {
  const shadow = await sharp(t.input).ensureAlpha().composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${t.width}" height="${t.height}"><rect width="100%" height="100%" fill="${color}"/></svg>`), blend: 'in' }]).png().toBuffer();
  const pts = []; for (let a = 0; a < 360; a += 30) pts.push([Math.round(r + r * Math.cos(a * Math.PI / 180)), Math.round(r + r * Math.sin(a * Math.PI / 180))]);
  const input = await sharp({ create: { width: t.width + r * 2, height: t.height + r * 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([...pts.map(([left, top]) => ({ input: shadow, left, top })), { input: shadow, left: r + 3, top: r + 5 }, { input: t.input, left: r, top: r }]).png().toBuffer();
  return { input, width: t.width + r * 2, height: t.height + r * 2 };
}
const svg = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`);
const box = (w, h, fill, { r = 16, stroke = '', sw = 0 } = {}) => ({ input: svg(w, h, `<rect x="${sw / 2}" y="${sw / 2}" width="${w - sw}" height="${h - sw}" rx="${r}" fill="${fill}" ${stroke ? `stroke="${stroke}" stroke-width="${sw}"` : ''}/>`), width: w, height: h });

const ICONS = {
  doc: '<path d="M14 6h16l8 8v28H14z" fill="none" stroke="#fff" stroke-width="3.5" stroke-linejoin="round"/><path d="M20 22h14M20 29h14M20 36h9" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>',
  people: '<circle cx="18" cy="17" r="6" fill="#fff"/><circle cx="32" cy="17" r="6" fill="#fff"/><path d="M7 40c0-8 5-13 11-13s11 5 11 13zM21 40c0-8 5-13 11-13s11 5 11 13z" fill="#fff"/>',
  search: '<circle cx="22" cy="22" r="11" fill="none" stroke="#fff" stroke-width="4"/><path d="M30 30l10 10" stroke="#fff" stroke-width="5" stroke-linecap="round"/>',
  rupee: '<path d="M15 10h22M15 18h22M15 10c14 0 14 16 0 16h-1l16 16" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
  apply: '<rect x="9" y="8" width="26" height="34" rx="3" fill="none" stroke="#fff" stroke-width="3.5"/><path d="M15 18h14M15 25h10" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/><path d="M27 40l14-14 4 4-14 14h-4z" fill="#fff"/>',
  cal: '<rect x="7" y="11" width="34" height="30" rx="4" fill="#fff"/><rect x="7" y="11" width="34" height="9" rx="4" fill="#fecaca"/><path d="M15 7v8M33 7v8" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M14 27h6M22 27h6M30 27h4M14 34h6M22 34h6" stroke="#dc2626" stroke-width="3.5" stroke-linecap="round"/>',
  case: '<rect x="6" y="16" width="36" height="24" rx="4" fill="#fff"/><path d="M18 16v-5h12v5" fill="none" stroke="#fff" stroke-width="4"/><rect x="6" y="24" width="36" height="4" fill="#1d4ed8"/>'
};
const icon = (name, size, bg) => ({ input: svg(size, size, `${bg ? `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${bg}"/>` : ''}<g transform="scale(${size / 48})">${ICONS[name]}</g>`), width: size, height: size });

// ---------- facts ----------
const get = (rows, re) => ((rows || []).find(([k]) => re.test(k)) || [])[1];
const MON = { jan: 'Jan', feb: 'Feb', mar: 'Mar', apr: 'Apr', may: 'May', jun: 'June', jul: 'July', aug: 'Aug', sep: 'Sep', oct: 'Oct', nov: 'Nov', dec: 'Dec' };
const shortDate = v => String(v || '').replace(/\(.*?\)/g, '').replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/g, m => {
  const full = { january: 'January', february: 'February', march: 'March', april: 'April', may: 'May', june: 'June', july: 'July', august: 'August', september: 'September', october: 'October', november: 'November', december: 'December' };
  return full[m.toLowerCase()] || MON[m.slice(0, 3).toLowerCase()] || m;
}).replace(/\s+/g, ' ').trim().slice(0, 22);
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/[\s,–-]+\S*$/, '') + '…' : s; };

function facts(post) {
  const d = post.data || {};
  const K = String(post.title).split(/:|–(?=[^–]*$)/)[0].replace(/\s*\((\d[\d,]*\s*Posts?|topic-wise)\)/ig, '').trim();
  const year = (K.match(/\b20\d{2}\b/) || [''])[0];
  const kind = (K.match(/syllabus\s*(?:&|and)\s*exam pattern|recruitment|online form|admit card|answer key|result|syllabus|exam date|admission|notification/i) || [''])[0];
  const abbr = (post.organization || '').match(/\(([^)]+)\)\s*$/)?.[1];
  let line1 = abbr && K.toUpperCase().startsWith(abbr.toUpperCase()) ? abbr : K.split(' ')[0];
  let rest = K.slice(line1.length).trim();
  rest = rest.replace(new RegExp(`\\b${kind}\\b`, 'i'), '').replace(year, '').replace(/\s{2,}/g, ' ').trim();
  if (!rest) { rest = line1; line1 = ''; }
  const line3 = `${(kind || { 'admit-card': 'Admit Card', result: 'Result', 'answer-key': 'Answer Key', syllabus: 'Syllabus', 'exam-date': 'Exam Date', admission: 'Admission' }[post.category] || 'Recruitment')}`.toUpperCase();

  const start = get(d.dates, /start|begin|released|notification/i);
  const last = get(d.dates, /last date(?!.*fee)|closing/i) || get(d.dates, /last/i);
  const exam = get(d.dates, /^(?!.*(city|admit card released)).*(exam|cbt|test)/i);
  const dates = post.category === 'latest-jobs' || post.category === 'admission'
    ? [['Application Start', start], ['Last Date to Apply', last]].filter(([, v]) => v)
    : (d.dates || []).slice(0, 2);
  if (dates.length < 2 && exam && !dates.some(([, v]) => v === exam)) dates.push(['Exam Date', exam]);
  if (!dates.length) {
    const site = (d.links || []).find(([l]) => /official/i.test(l)) || (d.links || [])[0];
    if (post.published_at) dates.push(['Published', new Date(post.published_at.replace(' ', 'T') + 'Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })]);
    if (site) { try { dates.push(['Official Site', new URL(site[1]).hostname.replace(/^www\./, '')]); } catch {} }
  }

  const pts = [];
  const elig = (d.eligibility || [])[0];
  if (elig) pts.push(`Qualification: ${String(elig[1] || elig[0]).split(' – ').pop()}`);
  const minA = get(d.age, /minimum/i), maxA = get(d.age, /maximum/i);
  if (minA || maxA) pts.push(`Age: ${[minA, maxA].filter(Boolean).map(a => String(a).match(/\d+(\.\d+)?/)?.[0]).filter(Boolean).join('–')} Years`);
  const fee = (d.fees || []).find(([k]) => !/mode/i.test(k));
  if (fee) pts.push(`Fee: ${cut(fee[1], 22)}`);
  const pay = (d.salary || [])[0];
  if (pay && !/see official/i.test(pay[1])) pts.push(`Pay: ${cut(pay[1], 24)}`);
  if (d.selection?.length && !/as per official/i.test(d.selection[0])) pts.push(`Selection: ${cut(d.selection.slice(0, 2).join(', '), 22)}`);
  const next = d.selection?.[0] && !/as per official/i.test(d.selection[0]) ? `Next: ${cut(d.selection[0], 22)}` : null;
  const FILL = {
    'latest-jobs': ['Apply Online', 'Official Notification', 'Sarkari Naukri'], admission: ['Apply Online', 'Official Notification', 'Check Eligibility'],
    'admit-card': ['Download Admit Card', 'Check Exam Centre', 'Carry Photo ID', next], result: ['Result Declared', 'Search Your Roll No.', next, 'Download Scorecard'],
    'answer-key': ['Provisional Answer Key', 'Match Your Answers', 'Raise Objection Online'], syllabus: ['Topic-wise Syllabus', 'Exam Pattern', 'Marking Scheme'],
    'exam-date': ['Exam Schedule Out', 'Admit Card Soon', 'Check Official Notice']
  }[post.category] || ['Official Notification', 'Check Details'];
  for (const x of FILL.filter(Boolean)) if (pts.length < 5) pts.push(x);

  // the date that matters most for this kind of post
  const keyRow = ({
    'latest-jobs': [['LAST DATE', last]], admission: [['LAST DATE', last]],
    'admit-card': [['EXAM DATE', exam], ['RELEASED', get(d.dates, /admit/i)]], result: [['RESULT DATE', get(d.dates, /result|declared/i)]],
    'answer-key': [['ANSWER KEY', get(d.dates, /answer key|released/i)]], 'exam-date': [['EXAM DATE', exam || (d.dates || [])[0]?.[1]]]
  }[post.category] || [['LAST DATE', last]]).find(([, v]) => v && /\d{1,2}\s*(?:[–-]\s*\d{1,2}\s*)?[A-Za-z]{3,}|\d{4}-\d{2}-\d{2}/.test(v));
  const total = /^\d+$/.test(String(post.total_posts || '')) ? Number(post.total_posts).toLocaleString('en-IN') : '';
  return { keyDate: keyRow ? { label: keyRow[0], text: keyRow[1] } : null, K, line1: line1.toUpperCase(), line2: rest.toUpperCase(), line3, year, org: post.organization || '', advt: d.advt || '', dates, pts: pts.slice(0, 5), total, category: post.category };
}

// ---------- drawing ----------
// Background styles; each post takes the next one (by its id)
const BG = [['#0284c7', '#7dd3fc', '#fef3c7'], ['#ea580c', '#fdba74', '#fef9c3'], ['#0f766e', '#5eead4', '#f0fdfa'], ['#6d28d9', '#c4b5fd', '#fdf4ff'], ['#be123c', '#fda4af', '#fff7ed']];
const bgIndex = post => (Number(post.id) || 0) % BG.length;

async function render(post) {
  const bgi = bgIndex(post);
  const f = facts(post);
  const s = getSettings();
  const L = []; const put = (o, left, top) => L.push({ input: o.input, left: Math.round(left), top: Math.round(top) });

  const bg = svg(W, H, `
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BG[bgi][0]}"/><stop offset="0.55" stop-color="${BG[bgi][1]}"/><stop offset="1" stop-color="${BG[bgi][2]}"/></linearGradient>
    <radialGradient id="sun" cx="0.62" cy="0.18" r="0.6"><stop offset="0" stop-color="#fff7d6" stop-opacity="0.95"/><stop offset="1" stop-color="#fff7d6" stop-opacity="0"/></radialGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#sky)"/><rect width="${W}" height="${H}" fill="url(#sun)"/>
    ${Array.from({ length: 14 }, (_, i) => `<path d="M790 120 L${-200 + i * 140} ${H} L${-130 + i * 140} ${H} Z" fill="#ffffff" opacity="0.07"/>`).join('')}
    <rect y="${H - 62}" width="${W}" height="62" fill="#1e3a8a"/>
    <rect y="${H - 66}" width="${W}" height="5" fill="#facc15"/>`);

  // left: organisation panel
  put(box(300, 292, '#ffffff', { r: 22, stroke: '#f97316', sw: 6 }), 18, 16);
  put(icon('case', 74, '#1d4ed8'), 131, 34);
  const orgMax = f.advt ? 132 : 168;
  let orgT; for (let size = 30; size >= 16; size -= 2) { orgT = await txt(cut(f.org || f.K, 80), { font: 'baloo', size, color: '#0f172a', width: 262, align: 'center', spacing: -2 }); if (orgT.height <= orgMax) break; }
  put(orgT, 18 + (300 - orgT.width) / 2, 120);
  if (f.advt) { const a = await fitLine(`Advt: ${cut(f.advt, 30)}`, { font: 'baloo', color: '#b91c1c' }, 260, 40, 24, 16); put(a, 18 + (300 - a.width) / 2, 300 - 16 - a.height); }

  // left: total posts
  put(box(300, 210, '#dc2626', { r: 22, stroke: '#ffffff', sw: 5 }), 18, 322);
  put(icon('people', 40), 40, 336);
  put(await txt(f.total ? 'TOTAL POSTS' : 'UPDATE', { font: 'anton', size: 34 }), 92, 334);
  put(box(264, 136, '#111827', { r: 14 }), 36, 384);
  const big = await outlined(await fitLine(f.total || ({ 'admit-card': 'ADMIT CARD', result: 'RESULT', 'answer-key': 'ANSWER KEY', syllabus: 'SYLLABUS', 'exam-date': 'EXAM DATE' }[f.category] || 'APPLY NOW'), { font: 'anton', color: '#facc15' }, 230, f.total ? 82 : 96, 92, 30), '#000000', 4);
  put(big, 36 + (264 - big.width) / 2, f.total ? 388 : 384 + (136 - big.height) / 2);
  if (f.total) { const p = await txt('POSTS', { font: 'anton', size: 30 }); put(p, 36 + (264 - p.width) / 2, 520 - p.height - 4); }

  // centre: title
  let y = 14;
  const titleW = 640, cx = 336;
  if (f.line1) {
    const l1 = await outlined(await fitLine(f.line1, { font: 'anton', color: '#fde047' }, titleW - 20, 96, 104, 40), '#991b1b', 7);
    put(l1, cx + (titleW - l1.width) / 2, y); y += l1.height - 6;
  }
  const l2t = await fitLine(f.line2, { font: 'anton', color: '#ffffff' }, titleW - 40, f.line1 ? 74 : 110, f.line1 ? 80 : 110, 26);
  put(box(titleW, l2t.height + 22, '#1e3a8a', { r: 14, stroke: '#ffffff', sw: 4 }), cx, y);
  const l2 = await outlined(l2t, '#0b1b4d', 4); put(l2, cx + (titleW - l2.width) / 2, y + 7); y += l2t.height + 30;
  const l3a = await fitLine(f.line3, { font: 'anton', color: '#111111' }, titleW - 190, 64, 64, 28);
  const l3b = f.year ? await outlined(await txt(f.year, { font: 'anton', size: l3a.height > 60 ? 64 : 54, color: '#dc2626' }), '#ffffff', 3) : null;
  const l3w = l3a.width + (l3b ? l3b.width + 16 : 0) + 44;
  put(box(Math.min(titleW, l3w), l3a.height + 16, '#facc15', { r: 14, stroke: '#ffffff', sw: 4 }), cx + (titleW - Math.min(titleW, l3w)) / 2, y);
  put(l3a, cx + (titleW - l3w) / 2 + 22, y + 8); if (l3b) put(l3b, cx + (titleW - l3w) / 2 + 22 + l3a.width + 16, y + 8 + (l3a.height - l3b.height) / 2);

  // centre: important dates
  const dy = 322;
  put(box(424, 210, '#ffffff', { r: 18, stroke: '#dc2626', sw: 5 }), 336, dy);
  put(box(414, 50, '#dc2626', { r: 14 }), 341, dy + 5);
  put(icon('cal', 38), 356, dy + 11);
  put(await txt('IMPORTANT DATES', { font: 'anton', size: 30, color: '#ffffff' }), 404, dy + 9);
  let ry = dy + 66;
  for (const [k, v] of f.dates.slice(0, 2)) {
    put(icon('cal', 40, '#dc2626'), 350, ry + 6);
    const lab = await fitLine(`${k}:`, { font: 'baloo', color: '#1d4ed8' }, 150, 56, 26, 16); put(lab, 398, ry + (54 - lab.height) / 2);
    put(box(190, 52, '#fde68a', { r: 10 }), 556, ry + 1);
    const val = await fitLine(shortDate(v), { font: 'baloo', color: '#b91c1c' }, 176, 48, 28, 14); put(val, 556 + (190 - val.width) / 2, ry + 1 + (52 - val.height) / 2);
    ry += 66;
  }

  // checklist
  put(box(262, 236, '#ffffff', { r: 18, stroke: '#16a34a', sw: 5 }), 772, 296);
  let cy = 312;
  for (const p of f.pts) {
    put({ input: svg(30, 30, '<rect width="30" height="30" rx="6" fill="#16a34a"/><path d="M8 15l5 5 10-11" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>'), width: 30, height: 30 }, 786, cy + 5);
    const t = await fitCut(p, { font: 'baloo', size: 21, color: '#0f172a' }, 200); put(t, 824, cy + (40 - t.height) / 2 + 1);
    cy += 43;
  }

  // right side: a big calendar with the date that matters most (no people)
  await calendar(f, put);

  // tiles
  const isJob = f.category === 'latest-jobs' || f.category === 'admission';
  const tiles = isJob
    ? [['Official Notification', 'doc', '#1d4ed8'], ['Eligibility Criteria', 'people', '#dc2626'], ['Selection Process', 'search', '#15803d'], ['Fee & Age Limit', 'rupee', '#ea580c'], ['How to Apply Online', 'apply', '#7c3aed']]
    : [['Official Notice', 'doc', '#1d4ed8'], ['Important Dates', 'cal', '#dc2626'], ['Login Details', 'people', '#15803d'], ['Next Steps', 'search', '#ea580c'], ['Direct Link', 'apply', '#7c3aed']];
  for (let i = 0; i < tiles.length; i++) {
    const [label, ic, col] = tiles[i]; const x = 18 + i * 152;
    put(box(144, 100, col, { r: 14, stroke: '#ffffff', sw: 3 }), x, 548);
    put(icon(ic, 38), x + 53, 554);
    const t = await txt(label, { font: 'baloo', size: 18, color: '#ffffff', width: 132, align: 'center', spacing: -9 }); put(t, x + (144 - t.width) / 2, 594 + (52 - t.height) / 2);
  }

  // apply button
  put({ input: svg(392, 86, `<rect x="4" y="8" width="384" height="74" rx="37" fill="#7f1d1d"/><rect x="4" y="2" width="384" height="74" rx="37" fill="#dc2626" stroke="#ffffff" stroke-width="5"/>`), width: 392, height: 86 }, 780, 548);
  put({ input: svg(54, 54, `<rect width="54" height="54" rx="12" fill="#ffffff"/><g transform="scale(1.125)"><rect x="9" y="8" width="26" height="34" rx="3" fill="none" stroke="#dc2626" stroke-width="3.5"/><path d="M15 18h14M15 25h10" stroke="#dc2626" stroke-width="3.5" stroke-linecap="round"/><path d="M27 40l14-14 4 4-14 14h-4z" fill="#1d4ed8"/></g>`), width: 54, height: 54 }, 800, 560);
  const [b1, b2] = { 'latest-jobs': ['APPLY', 'ONLINE NOW'], admission: ['APPLY', 'ONLINE NOW'], 'admit-card': ['DOWNLOAD', 'ADMIT CARD'], result: ['CHECK', 'RESULT NOW'],
    'answer-key': ['DOWNLOAD', 'ANSWER KEY'], syllabus: ['DOWNLOAD', 'SYLLABUS'], 'exam-date': ['CHECK', 'EXAM DATE'] }[f.category] || ['CHECK', 'DETAILS NOW'];
  let ap1, ap2;
  for (let size = 40; size >= 24; size -= 2) { ap1 = await txt(b1, { font: 'anton', size }); ap2 = await txt(b2, { font: 'anton', size, color: '#fde047' }); if (ap1.width + 12 + ap2.width <= 290) break; }
  put(ap1, 870, 560 + (54 - ap1.height) / 2); put(ap2, 870 + ap1.width + 12, 560 + (54 - ap2.height) / 2);

  // footer
  const foot = [s.site_name || 'NaukriSetu', 'सरकारी नौकरी • Latest Govt Jobs', 'Admit Card • Result • Answer Key'];
  const fw = W / foot.length;
  for (let i = 0; i < foot.length; i++) { const t = await fitLine(foot[i], { font: i === 0 ? 'anton' : 'hind', color: i === 0 ? '#fde047' : '#ffffff' }, fw - 30, 44, i === 0 ? 30 : 22, 14); put(t, i * fw + (fw - t.width) / 2, H - 62 + (62 - t.height) / 2); }

  return sharp(bg).composite(L.map(l => ({ ...l, left: Math.max(0, l.left), top: Math.max(0, l.top) }))).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
}

// ---------- calendar ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function splitDate(t) {
  let m = String(t).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { day: String(+m[3]), month: MONTHS[+m[2] - 1], year: m[1] };
  m = String(t).match(/(\d{1,2})(?:\s*[–-]\s*(\d{1,2}))?\s+([A-Za-z]{3,})\.?,?\s*(\d{4})?/);
  if (!m) return null;
  const mon = MONTHS.find(x => x.toLowerCase().startsWith(m[3].slice(0, 3).toLowerCase()));
  if (!mon) return null;
  return { day: m[2] ? `${+m[1]}–${+m[2]}` : String(+m[1]), month: mon, year: m[4] || '' };
}
async function calendar(f, put) {
  const x = 1046, y = 112, w = 218, h = 418;
  const d = f.keyDate && splitDate(f.keyDate.text);
  // rings + card
  put({ input: svg(w, h, `<rect x="4" y="10" width="${w - 8}" height="${h - 14}" rx="22" fill="#7f1d1d"/><rect x="0" y="4" width="${w - 8}" height="${h - 14}" rx="22" fill="#ffffff" stroke="#dc2626" stroke-width="5"/>
    <path d="M0 26 a22 22 0 0 1 22 -22 h${w - 52} a22 22 0 0 1 22 22 v84 h-${w - 8} z" fill="#dc2626"/>`), width: w, height: h }, x, y);
  for (const rx of [46, w - 54]) put({ input: svg(18, 40, '<rect x="3" y="0" width="12" height="40" rx="6" fill="#facc15" stroke="#7f1d1d" stroke-width="3"/>'), width: 18, height: 40 }, x + rx, y - 18);
  const label = await fitLine(f.keyDate ? f.keyDate.label : ({ syllabus: 'FREE PDF', result: 'RESULT OUT' }[f.category] || 'LATEST UPDATE'), { font: 'anton', color: '#ffffff' }, w - 30, 64, 46, 22);
  put(label, x + (w - 8 - label.width) / 2, y + 4 + (106 - label.height) / 2 + 6);
  if (d) {
    const day = await outlined(await fitLine(d.day, { font: 'anton', color: '#dc2626' }, w - 40, 140, 140, 50), '#fde68a', 4);
    const mon = await fitLine(d.month.toUpperCase(), { font: 'anton', color: '#1e3a8a' }, w - 34, 52, 40, 20);
    const yr = d.year ? await txt(d.year, { font: 'anton', size: 32, color: '#0f172a' }) : null;
    // stack day / month / year, centred in the white part of the card
    const gap = 6, stack = day.height + gap + mon.height + (yr ? gap + yr.height : 0);
    let sy = y + 112 + Math.max(4, (h - 112 - 14 - stack) / 2);
    put(day, x + (w - 8 - day.width) / 2, sy); sy += day.height + gap;
    put(mon, x + (w - 8 - mon.width) / 2, sy); sy += mon.height + gap;
    if (yr) put(yr, x + (w - 8 - yr.width) / 2, sy);
  } else {
    put(icon({ syllabus: 'doc', result: 'search' }[f.category] || 'case', 120, '#1d4ed8'), x + (w - 8 - 120) / 2, y + 150);
    const t = await fitLine('Check Details', { font: 'anton', color: '#1e3a8a' }, w - 30, 50, 38, 20); put(t, x + (w - 8 - t.width) / 2, y + 300);
  }
}

async function bannerFile(post) {
  fs.mkdirSync(DIR, { recursive: true });
  const f = facts(post);
  const v = crypto.createHash('md5').update(JSON.stringify([f, getSettings().site_name, bgIndex(post), 7])).digest('hex').slice(0, 10);
  const file = path.join(DIR, `${post.slug}-${v}.jpg`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, await render(post));
  return file;
}

module.exports = { bannerFile, facts };
