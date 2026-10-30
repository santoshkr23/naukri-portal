// Turns extracted facts into an ORIGINAL post written in this site's own words and layout.
const { pick, parseDateLoose, fmtDate, truncate } = require('../util');

function detectCategory(title) {
  const t = title.toLowerCase();
  if (/answer\s*key|objection/.test(t)) return 'answer-key';
  if (/admit\s*card|hall\s*ticket|call\s*letter|exam\s*city|city\s*slip|city\s*details/.test(t)) return 'admit-card';
  if (/result|merit\s*list|score\s*card|cut\s*-?\s*off|marks/.test(t)) return 'result';
  if (/syllabus|exam\s*pattern/.test(t)) return 'syllabus';
  if (/exam\s*date|exam\s*schedule|time\s*table|date\s*sheet/.test(t)) return 'exam-date';
  if (/admission|entrance|counsell?ing|scholarship|\bcet\b|\bneet\b|\bjee\b|\bcuet\b/.test(t)) return 'admission';
  return 'latest-jobs';
}

function baseTitle(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*[|–—]\s*[^|–—]*$/, m => (/how to|apply|download|check|notification|out|link|official|sarkari|result\s*com/i.test(m) ? '' : m));
  t = t.replace(/\s*-\s*(how to.*|apply.*|download.*|check.*|notification out.*)$/i, '');
  t = t.replace(/\s*:\s*(how to.*|apply.*|download.*|check.*)$/i, '');
  t = t.replace(/\((\d[\d,]*)\s*posts?\)/i, '').replace(/\bfor\s+\d[\d,]*\s+posts?\b/i, '');
  t = t.replace(/\s*\|\s*.*$/, '').replace(/\s{2,}/g, ' ').trim();
  return t;
}

const TITLE_SUFFIX = {
  'latest-jobs': [': Apply Online, Eligibility & Last Date', ': Notification, Vacancy & Apply Link', ' – Eligibility, Fee & How to Apply'],
  'admit-card': [': Download Link & Exam Date', ' – Hall Ticket Download Steps', ': Exam Date & Admit Card Link'],
  'result': [': Direct Link to Check Result', ' – Check Result & Next Steps', ': Result Link & Selection Stages'],
  'answer-key': [': Download PDF & Raise Objection', ' – Answer Key Link & Objection Dates'],
  'admission': [': Online Form, Eligibility & Last Date', ' – Application Dates & Apply Link'],
  'syllabus': [': Exam Pattern & Syllabus PDF', ' – Topic-wise Syllabus & Pattern'],
  'exam-date': [': Exam Schedule & Official Notice', ' – Exam Date Notice & Admit Card Update']
};

const ACTION = {
  'latest-jobs': 'apply', 'admit-card': 'download the admit card', 'result': 'check the result',
  'answer-key': 'download the answer key', 'admission': 'apply', 'syllabus': 'download the syllabus', 'exam-date': 'check the exam schedule'
};

function findDate(rows, re) {
  const r = (rows || []).find(([k]) => re.test(k));
  return r ? r[1] : '';
}

function compose(facts, { category } = {}) {
  const base = baseTitle(facts.title);
  category = category || detectCategory(base);
  const year = (base.match(/20\d{2}/) || [new Date().getFullYear()])[0];
  const org = facts.organization || base.replace(/\b(recruitment|online form|admit card|result|answer key|syllabus|admission|exam date|notification|20\d{2}).*$/i, '').trim() || base;
  const total = facts.total_posts && +facts.total_posts > 0 ? facts.total_posts : '';
  const title = `${base}${total && category === 'latest-jobs' && !/post/i.test(base) ? ` (${total} Posts)` : ''}${pick(TITLE_SUFFIX[category])}`;

  const lastDateRaw = findDate(facts.dates, /last\s*date|closing|end\s*date/i);
  const startRaw = findDate(facts.dates, /start|begin|opening/i);
  const examRaw = findDate(facts.dates, /exam/i);
  const admitRaw = findDate(facts.dates, /admit|hall/i);
  const resultRaw = findDate(facts.dates, /result/i);
  const last_date = parseDateLoose(lastDateRaw);
  const genFee = findDate(facts.fees, /gen|ur|obc|ews/i);
  const maxAge = findDate(facts.age, /max/i);
  const minAge = findDate(facts.age, /min/i);
  const officialSite = (facts.links.find(([l]) => /official\s*website/i.test(l)) || facts.links.find(([, u]) => /\.gov|\.nic|\.aero|\.ac\.in/i.test(u)) || facts.links[0] || [])[1] || '';

  const intro = [];
  if (category === 'latest-jobs') {
    intro.push(pick([
      `${org} has released a recruitment notification${total ? ` for ${total} posts` : ''} under ${base}.`,
      `A new vacancy notice is out: ${base}${total ? `, covering ${total} posts` : ''}, issued by ${org}.`,
      `${org} is inviting applications for ${base}${total ? ` — ${total} vacancies in total` : ''}.`
    ]));
    intro.push(startRaw && lastDateRaw ? `The application window runs from ${startRaw} to ${lastDateRaw}.` : lastDateRaw ? `The last date to apply is ${lastDateRaw}.` : `Application dates are listed in the table below.`);
  } else if (category === 'admit-card') {
    intro.push(pick([`${org} has issued the admit card update for ${base.replace(/admit card/i, '').trim() || base}.`, `Hall tickets for ${base.replace(/admit card/i, 'the exam').trim()} are now part of the official update from ${org}.`]));
    if (examRaw) intro.push(`The exam is scheduled for ${examRaw}.`);
  } else if (category === 'result') {
    intro.push(pick([`${org} has declared ${base}.`, `The result for ${base.replace(/result/i, '').trim() || base} is now available from ${org}.`]));
    if (resultRaw) intro.push(`Result date: ${resultRaw}.`);
  } else if (category === 'answer-key') {
    intro.push(`${org} has published ${base}. Candidates can compare their responses and file objections within the allowed window.`);
  } else if (category === 'admission') {
    intro.push(`${org} has opened applications for ${base}.${lastDateRaw ? ` Forms are accepted until ${lastDateRaw}.` : ''}`);
  } else {
    intro.push(`${org} has shared an update on ${base}.`);
  }
  intro.push(pick([
    'Below you will find the key dates, fee, age limit, vacancy break-up and the official links, arranged so you can check everything in one place.',
    'This page sums up the important dates, application fee, eligibility and direct official links. Always cross-check with the official notification before you act.',
    'Scroll down for a quick summary table, eligibility details and links that go straight to the official website.'
  ]));

  const howTo = {
    'latest-jobs': [
      'Read the official notification PDF and confirm you meet the age and qualification rules.',
      'Open the official recruitment website from the Important Links table below.',
      'Register with a working mobile number and e-mail ID, then log in.',
      'Fill in personal, education and category details carefully.',
      'Upload your photo, signature and any documents in the required size and format.',
      'Pay the application fee (if applicable) and submit the form.',
      'Download and keep a printout of the confirmation page.'
    ],
    'admit-card': [
      'Open the admit card link from the Important Links table below.',
      'Enter your registration / roll number and date of birth or password.',
      'Check name, photo, exam centre, date and reporting time on the hall ticket.',
      'Download and print it — carry it with a valid photo ID to the exam centre.'
    ],
    'result': [
      'Open the result link from the Important Links table below.',
      'Enter your roll number / registration number and date of birth if asked.',
      'Check your status, marks or merit list position.',
      'Save a copy and note the dates for the next stage of selection.'
    ],
    'answer-key': [
      'Open the answer key link below and log in if required.',
      'Compare the official answers with your response sheet.',
      'If you find an error, submit an objection with proof before the deadline.'
    ],
    'admission': [
      'Check eligibility in the official information bulletin.',
      'Register on the official portal from the links below.',
      'Fill in the form, upload documents and pay the fee.',
      'Submit and save the confirmation page.'
    ],
    'syllabus': ['Open the syllabus link below.', 'Download the PDF and note the subject-wise topics and marks.', 'Plan your preparation around the exam pattern.'],
    'exam-date': ['Open the exam notice link below.', 'Check your exam date, shift and reporting time.', 'Watch for the admit card release on the official website.']
  }[category];

  const faqs = [];
  if (lastDateRaw && ['latest-jobs', 'admission'].includes(category)) faqs.push([`What is the last date for ${base}?`, `The last date mentioned in the notice is ${lastDateRaw}.`]);
  if (total) faqs.push([`How many vacancies are there in ${base}?`, `There are ${total} posts in total. See the vacancy table above for the post-wise break-up.`]);
  if (genFee) faqs.push([`What is the application fee?`, `For General/OBC/EWS candidates the fee is ${genFee}. Fees for other categories are listed in the fee table.`]);
  if (maxAge) faqs.push([`What is the age limit?`, `${minAge ? `Minimum age is ${minAge} and m` : 'M'}aximum age is ${maxAge}, with relaxation as per government rules.`]);
  if (examRaw) faqs.push([`When is the exam?`, `The exam date given in the official schedule is ${examRaw}.`]);
  if (admitRaw && category === 'admit-card') faqs.push([`When was the admit card released?`, `The admit card date in the official schedule is ${admitRaw}.`]);
  if (facts.selection.length) faqs.push([`What is the selection process?`, `Selection is based on: ${facts.selection.join(', ')}.`]);
  if (officialSite) { try { faqs.push([`What is the official website?`, `The official website is ${new URL(officialSite).hostname}.`]); } catch {} }

  const meta_description = truncate(
    `${base}: ${[total && `${total} posts`, lastDateRaw && `last date ${lastDateRaw}`, examRaw && `exam ${examRaw}`, genFee && `fee ${genFee}`].filter(Boolean).join(', ') || 'latest update'}. Check dates, eligibility and official ${ACTION[category]} link.`,
    158
  );

  const data = {
    intro: intro.join(' '),
    advt: facts.advt || '',
    dates: facts.dates, fees: facts.fees, age: facts.age, salary: facts.salary,
    vacancyHeader: facts.vacancyHeader || ['Post Name', 'Total Posts'],
    vacancy: facts.vacancy, eligibility: facts.eligibility, selection: facts.selection,
    extra: facts.extra, howTo, links: facts.links, faqs
  };

  return {
    title, base, category, organization: org, total_posts: total, last_date,
    short_info: truncate(data.intro, 280), meta_description, data,
    quality: (facts.dates.length ? 1 : 0) + (facts.links.length ? 1 : 0) + (facts.vacancy.length || facts.fees.length || facts.age.length ? 1 : 0)
  };
}

// Optional: let an AI rewrite the intro from the FACTS ONLY (never sees the source page text)
async function aiIntro(composed) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const facts = { title: composed.base, organization: composed.organization, total_posts: composed.total_posts, dates: composed.data.dates, fees: composed.data.fees, age: composed.data.age, category: composed.category };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'claude-haiku-5-5', max_tokens: 400,
        messages: [{ role: 'user', content: `Write a clear, factual 2-paragraph introduction (90-140 words, simple English for Indian job seekers) for a job-alert page using ONLY these facts. Do not invent anything. No headings, no markdown.\n\n${JSON.stringify(facts)}` }]
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.content?.[0]?.text?.trim() || null;
  } catch { return null; }
}

module.exports = { compose, detectCategory, baseTitle, aiIntro, fmtDate };
