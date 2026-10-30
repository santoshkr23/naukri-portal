// Turns the facts in jobs-data.js into posts written in this site's own words.
// Runs automatically on an empty database (SEED_JOBS=1), or: npm run seed:jobs
const { db } = require('./db');
const { savePost } = require('./posts');
const { fingerprint } = require('./util');
const JOBS = require('./jobs-data');

const fmt = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

function buildPost(j) {
  const base = j.base || `${j.short} ${j.name}`;
  const lastTxt = fmt(j.last);
  const start = (j.dates.find(([k]) => /starts/i.test(k)) || [])[1];
  const exam = (j.dates.find(([k]) => /exam|cbt/i.test(k)) || [])[1];
  const maxAge = (j.age.find(([k]) => /maximum/i.test(k)) || [])[1];
  const minAge = (j.age.find(([k]) => /minimum/i.test(k)) || [])[1];
  const firstFee = j.fees[0];
  const officialHost = (() => { try { return new URL((j.links.find(([l]) => /official website/i.test(l)) || j.links[0])[1]).hostname; } catch { return ''; } })();

  const intro = [
    `${j.org} has opened ${j.total ? `recruitment for ${j.total} posts` : `applications for ${j.name.replace(/ Online Form.*$/i, '')}`}${j.advt ? ` under advertisement ${j.advt}` : ''}. ${start ? `Online applications open on ${start} and` : 'Applications'} close on ${lastTxt}.`,
    [
      minAge && /^\d/.test(maxAge || '') ? `Age limit: ${minAge} to ${maxAge}.` : /^\d/.test(maxAge || '') ? `Upper age limit: ${maxAge}.` : minAge ? `Minimum age: ${minAge} (upper limit varies by post).` : '',
      `Key qualification (${j.eligibility[0][0]}): ${String(j.eligibility[0][1]).replace(/\.$/, '')}.`,
      exam && !/announced/i.test(exam) ? `Exam: ${exam}.` : 'The exam date will be announced on the official website.'
    ].filter(Boolean).join(' '),
    `The tables below list every date, fee, vacancy and eligibility rule, followed by direct links to the official website. Please confirm the details in the official notification before you apply.`
  ].join('\n\n');

  const howTo = [
    'Download the official notification from the Important Links table and read the eligibility rules for your post.',
    `Open the official application portal${officialHost ? ` (${officialHost})` : ''} and register with your mobile number and e-mail.`,
    'Fill in your personal, educational and category details exactly as in your certificates.',
    'Upload your photo, signature and any documents in the size and format the portal asks for.',
    firstFee && /no fee|none/i.test(firstFee[1]) ? 'Submit the form — check whether any fee applies to your category.' : 'Pay the application fee online and submit the form.',
    'Save the confirmation page and payment receipt as PDF for later.'
  ];

  const faqs = [
    [`What is the last date to apply for ${base}?`, `Applications close on ${lastTxt}.`],
    ...(j.total ? [[`How many vacancies are there?`, `There are ${j.total} posts in total. See the vacancy table for the break-up.`]] : []),
    ...(maxAge ? [[`What is the age limit?`, `${minAge ? `Minimum ${minAge}, maximum ${maxAge}` : `Maximum ${maxAge}`}, with relaxation for reserved categories as per rules.`]] : []),
    ...(firstFee ? [[`How much is the application fee?`, j.fees.map(([k, v]) => `${k}: ${v}`).join('; ') + '.']] : []),
    [`What is the selection process?`, `${j.selection.join(', ')}.`],
    ...(officialHost ? [[`Where do I apply?`, `Only on the official website — ${officialHost}. Use the links in the Important Links table.`]] : [])
  ];

  return {
    title: j.total ? `${base}: ${j.total} Posts, Apply Online by ${lastTxt.replace(/ \d{4}$/, '')}` : `${base}: Apply Online by ${lastTxt.replace(/ \d{4}$/, '')}`,
    slug: base,
    base,
    category: 'latest-jobs',
    organization: j.org,
    total_posts: j.total,
    last_date: j.last,
    status: 'published',
    featured: true,
    meta_description: `${base}: ${j.total ? `${j.total} posts, ` : ''}last date ${lastTxt}${maxAge ? `, max age ${maxAge}` : ''}. Check dates, fee, eligibility, vacancy and official apply link.`.slice(0, 158),
    short_info: intro.slice(0, 280),
    data: { intro, advt: j.advt, dates: j.dates, fees: j.fees, age: j.age, salary: j.salary, vacancyHeader: ['Post / Category', 'Vacancies'], vacancy: j.vacancy, eligibility: j.eligibility, selection: j.selection, howTo, links: j.links, faqs, extra: j.extra || [] }
  };
}

function seedJobs() {
  const has = db.prepare('SELECT 1 FROM posts WHERE fingerprint=?1 UNION SELECT 1 FROM deleted_posts WHERE fingerprint=?1');
  let n = 0;
  for (const j of JOBS) {
    const p = buildPost(j);
    p.fingerprint = fingerprint(p.base, p.category);
    if (has.get(p.fingerprint)) continue;
    savePost(p);
    n++;
  }
  return n + require('./seed-updates').seedUpdates();
}

if (require.main === module) { require('dotenv').config(); console.log(`Added ${seedJobs()} job posts`); }
module.exports = { seedJobs, buildPost };
