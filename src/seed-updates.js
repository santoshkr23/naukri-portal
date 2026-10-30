// Builds admit card / result / answer key / admission / syllabus / exam date posts from facts in updates-data.js,
// with all wording written by this site.
const { db } = require('./db');
const { savePost } = require('./posts');
const { fingerprint } = require('./util');
const UPDATES = require('./updates-data');

const host = u => { try { return new URL(u).hostname; } catch { return ''; } };
const get = (rows, re) => ((rows || []).find(([k]) => re.test(k)) || [])[1];

const TEMPLATES = {
  'admit-card': u => ({
    title: `${u.short} ${u.name}: Download Link & Exam Date`,
    intro: [`${u.org} has issued admit cards for ${u.name.replace(/ Admit Card.*$/i, '')}${u.total ? ` (${u.total} posts)` : ''}. ${get(u.dates, /^(?!.*(city|admit)).*(exam|test)/i) ? `The exam is on ${get(u.dates, /^(?!.*(city|admit)).*(exam|test)/i)}.` : ''}`,
      `To download it you will need your ${u.login.join(' and ').toLowerCase()}. Check your name, photo, exam centre and reporting time as soon as you download it, and contact the exam helpline straight away if anything is wrong.`],
    howTo: ['Open the admit card link from the Important Links table.', `Log in with your ${u.login.join(' and ').toLowerCase()}.`, 'Download the admit card and check every detail on it.', 'Print two copies and carry one with an original photo ID to the exam centre.'],
    faqs: [[`When was the ${u.short} admit card released?`, `On ${get(u.dates, /admit/i) || 'the date shown above'}.`], [`What do I need to download it?`, `Your ${u.login.join(' and ').toLowerCase()}.`], [`What should I carry to the exam centre?`, 'The printed admit card and an original photo ID such as Aadhaar, PAN, voter ID or passport.']]
  }),
  result: u => ({
    title: `${u.short} ${u.name}: Check Result & Next Steps`,
    intro: [`${u.org} has declared ${u.name}${u.total ? ` for ${u.total} posts` : ''}. ${get(u.dates, /result/i) ? `The result came out on ${get(u.dates, /result/i)}.` : ''}`,
      `The result is published as a list. Open it, search for your roll number (Ctrl + F on a computer), and note your status. ${u.nextStages?.length ? `Qualified candidates now move to: ${u.nextStages.join(', ')}.` : ''}`],
    howTo: ['Open the result link from the Important Links table.', 'Search the PDF for your roll number.', 'Save or print the page that shows your roll number.', 'Watch the official website for dates of the next stage.'],
    faqs: [[`Is the ${u.short} result out?`, `Yes — the result was declared${get(u.dates, /result/i) ? ` on ${get(u.dates, /result/i)}` : ''}.`], ['How do I find my name?', 'Open the result PDF and search for your roll number.'], ...(u.nextStages?.length ? [['What happens after the result?', `${u.nextStages.join(', ')}.`]] : [])]
  }),
  'answer-key': u => ({
    title: `${u.short} ${u.name}: Download & Raise Objection`,
    intro: [`${u.org} has released the provisional answer key for ${u.name.replace(/ Answer Key.*$/i, '')}${u.total ? ` (${u.total} posts)` : ''}. ${get(u.dates, /answer key/i) ? `It was published on ${get(u.dates, /answer key/i)}.` : ''}`,
      'Compare it with your response sheet to estimate your score. If you think an answer is wrong, raise an objection with proof before the window closes — a fee per question usually applies and is refunded if your objection is accepted.'],
    howTo: ['Open the answer key notice from the Important Links table.', `Log in with your ${u.login.join(' and ').toLowerCase()}.`, 'Download your response sheet and compare answers.', 'Raise objections, if any, with supporting proof before the deadline.'],
    faqs: [[`When was the answer key released?`, `On ${get(u.dates, /answer key/i) || 'the date shown above'}.`], ['Can I challenge an answer?', 'Yes, through the objection link during the objection window given in the official notice.'], ['Is this the final answer key?', 'No. This is provisional. The final key is published with or after the result.']]
  }),
  admission: u => ({
    title: `${u.short} ${u.name}: Last Date, Fee & Eligibility`,
    intro: [`Applications for ${u.short} ${u.name.replace(/ Online Form.*$/i, '')} are open. ${get(u.dates, /last date/i) ? `The last date to apply is ${get(u.dates, /last date/i)}` : ''}${get(u.dates, /exam/i) ? ` and the exam is on ${get(u.dates, /exam/i)}.` : '.'}`,
      'The fee, eligibility and apply link are listed below. Keep a scanned photo, signature and category certificate ready before you start the form.'],
    howTo: ['Open the apply link from the Important Links table.', 'Register with your mobile number and e-mail.', 'Fill in the form and upload your photo, signature and documents.', 'Pay the fee online and download the confirmation page.'],
    faqs: [[`What is the last date?`, `${get(u.dates, /last date/i) || 'See the dates table'}.`], ['What is the fee?', (u.fees || []).map(([k, v]) => `${k}: ${v}`).join('; ') + '.'], ...(get(u.dates, /exam/i) ? [['When is the exam?', `${get(u.dates, /exam/i)}.`]] : [])]
  }),
  syllabus: u => ({
    title: `${u.short} ${u.name} (Topic-wise)`,
    intro: [`This page sets out the ${u.short} ${u.name.replace('&', 'and')}: how many questions each subject carries, the marking scheme, and the main topics to prepare.`,
      'Use the pattern table to plan your time across subjects, then work through the topic list. Always cross-check with the latest official notice, since the commission can change the pattern.'],
    howTo: ['Note the marks per subject and give more time to high-weight sections.', 'Cover each topic in the list, then practise previous-year papers.', 'Take timed mock tests to get used to the exam length and negative marking.'],
    faqs: [['Is there negative marking?', (u.notes || []).find(n => /negative|deduct/i.test(n)) || 'Check the official notice.'], ...(u.pattern?.rows?.length ? [['How many questions are there?', u.pattern.rows.map(r => `${r[1]}: ${r[2]}`).join('; ') + '.']] : [])]
  }),
  'exam-date': u => ({
    title: `${u.short} ${u.name}: Full Schedule`,
    intro: [`${u.org} has announced the exam schedule for ${u.name.replace(/ Exam Date.*$/i, '')}${u.total ? ` (${u.total} posts)` : ''}. ${u.dates[0] ? `${u.dates[0][0]}: ${u.dates[0][1]}.` : ''}`,
      'Admit cards are usually released a few days before the exam on the official website. The full schedule and official notice are below.'],
    howTo: ['Open the exam date notice from the Important Links table.', 'Note your exam date and shift once your admit card is out.', 'Check the official website regularly for any change in dates.'],
    faqs: [[`When is the exam?`, u.dates.map(([k, v]) => `${k}: ${v}`).join('; ') + '.'], ['When will the admit card come?', get(u.dates, /admit/i) || 'Shortly before the exam.']]
  }),
  // Certificate, Outsourcing, Important and any other section
  generic: u => ({
    title: `${u.short} ${u.name}: Dates, Details & Official Link`,
    intro: [`${u.org ? `${u.org} has released` : 'Here is'} the latest update on ${u.short} ${u.name}${u.total ? ` (${u.total} posts)` : ''}.${get(u.dates, /last date/i) ? ` The last date is ${get(u.dates, /last date/i)}.` : ''}`,
      'All key dates, fees and the official links are listed below. Please confirm every detail on the official website before you act on it.'],
    howTo: ['Open the official link from the Important Links table.', ...(u.login?.length ? [`Log in with your ${u.login.join(' and ').toLowerCase()}.`] : []), 'Follow the steps on the official website and save a copy of any confirmation page.'],
    faqs: [...(get(u.dates, /last date/i) ? [['What is the last date?', `${get(u.dates, /last date/i)}.`]] : []), ...((u.fees || []).length ? [['Is there a fee?', u.fees.map(([k, v]) => `${k}: ${v}`).join('; ') + '.']] : [])]
  })
};

function buildUpdate(u) {
  const t = (TEMPLATES[u.category] || TEMPLATES.generic)(u);
  const base = u.base || `${u.short} ${u.name}`;
  const official = (u.links.find(([l]) => /official website/i.test(l)) || u.links[u.links.length - 1])[1];
  t.faqs.push(['What is the official website?', host(official)]);
  const data = {
    intro: t.intro.filter(Boolean).join('\n\n'), advt: u.advt || '',
    dates: u.dates || [], fees: u.fees || [], age: [], salary: [],
    vacancyHeader: u.pattern?.header || ['Post Name', 'Total Posts'], vacancy: u.pattern?.rows || [],
    eligibility: u.eligibility || [], selection: u.nextStages || [],
    extra: [...(u.notes?.length ? [{ heading: 'Marking scheme', items: u.notes }] : []), ...(u.topics?.length ? [{ heading: 'Main topics', items: u.topics.map(([s, l]) => `${s}: ${l}`) }] : [])],
    howTo: t.howTo, links: u.links, faqs: t.faqs
  };
  return {
    title: t.title, slug: base, base, category: u.category, organization: u.org, total_posts: u.total || '',
    last_date: u.last || null, status: 'published', featured: false,
    meta_description: `${base}: ${data.intro.split('\n')[0]}`.slice(0, 158),
    short_info: data.intro.slice(0, 280), data, published: u.published
  };
}

function seedUpdates() {
  const has = db.prepare('SELECT 1 FROM posts WHERE fingerprint=?1 UNION SELECT 1 FROM deleted_posts WHERE fingerprint=?1');
  let n = 0;
  for (const u of UPDATES) {
    const p = buildUpdate(u);
    p.fingerprint = fingerprint(p.base, p.category);
    if (has.get(p.fingerprint)) continue;
    const saved = savePost(p);
    if (u.published) db.prepare('UPDATE posts SET published_at=? WHERE id=?').run(`${u.published} 06:00:00`, saved.id);
    n++;
  }
  return n;
}

module.exports = { seedUpdates, buildUpdate };
