// Adds clearly-labelled SAMPLE posts (fictional organisations) so a fresh install has something to show.
// Run: npm run seed   — or set SEED_DEMO=1 to seed automatically when the database is empty.
const { db } = require('./db');
const { savePost } = require('./posts');

const SAMPLES = [
  { category: 'latest-jobs', org: 'Demo State Water Board', name: 'Junior Clerk & Store Keeper Recruitment 2026', total: '120', last: '30 November 2026', exam: 'January 2027' },
  { category: 'latest-jobs', org: 'Sample Rail Corporation', name: 'Station Assistant Recruitment 2026', total: '850', last: '12 December 2026', exam: 'February 2027' },
  { category: 'latest-jobs', org: 'Example Public Service Commission', name: 'Assistant Engineer Recruitment 2026', total: '64', last: '05 December 2026', exam: 'March 2027' },
  { category: 'latest-jobs', org: 'Demo District Health Society', name: 'Staff Nurse Recruitment 2026', total: '210', last: '20 November 2026', exam: 'December 2026' },
  { category: 'admit-card', org: 'Sample Police Board', name: 'Constable Admit Card 2026', exam: '15 November 2026' },
  { category: 'admit-card', org: 'Example Bank Selection Institute', name: 'Clerk Prelims Admit Card 2026', exam: '22 November 2026' },
  { category: 'result', org: 'Demo Staff Selection Board', name: 'Multi Tasking Staff Result 2026' },
  { category: 'result', org: 'Sample Teacher Eligibility Board', name: 'TET Result 2026' },
  { category: 'answer-key', org: 'Example Forest Department', name: 'Forest Guard Answer Key 2026' },
  { category: 'admission', org: 'Demo State University', name: 'B.Ed Admission Form 2026', last: '25 November 2026' },
  { category: 'syllabus', org: 'Sample Rail Corporation', name: 'Station Assistant Syllabus 2026' },
  { category: 'exam-date', org: 'Example Public Service Commission', name: 'Prelims Exam Date 2026', exam: '18 January 2027' }
];

function demoPost(s, i) {
  const base = `${s.org} ${s.name}`;
  const isJob = s.category === 'latest-jobs' || s.category === 'admission';
  const dates = [
    ['Notification released', '01 November 2026'],
    ...(isJob ? [['Online application starts', '05 November 2026'], ['Last date to apply', s.last], ['Last date for fee payment', s.last]] : []),
    ...(s.exam ? [['Exam date', s.exam]] : []),
    ...(s.category === 'admit-card' ? [['Admit card available', 'Now']] : []),
    ...(s.category === 'result' ? [['Result declared', '28 October 2026']] : [])
  ];
  const data = {
    intro: `SAMPLE POST — this is demo content for a fictional organisation, shown only to preview the layout. ${s.org} has announced ${base}.${s.total ? ` There are ${s.total} posts in total.` : ''} Below are the key dates, fee, eligibility and links in one place.`,
    advt: isJob ? `DEMO/${2026}/${String(i + 1).padStart(2, '0')}` : '',
    dates,
    fees: isJob ? [['General / OBC / EWS', '₹500'], ['SC / ST / PwD', '₹250'], ['Payment mode', 'UPI, debit card, net banking']] : [],
    age: isJob ? [['Minimum age', '18 years'], ['Maximum age', '35 years'], ['Age relaxation', 'As per government rules']] : [],
    salary: s.category === 'latest-jobs' ? [['Pay level', 'Level 4 (sample)'], ['Starting pay', '₹25,500 per month (sample)']] : [],
    vacancyHeader: ['Post Name', 'Total Posts'],
    vacancy: s.total ? [['Post A (sample)', String(Math.round(s.total * 0.7))], ['Post B (sample)', String(s.total - Math.round(s.total * 0.7))]] : [],
    eligibility: s.category === 'latest-jobs' ? [['Post A (sample)', '12th pass from a recognised board'], ['Post B (sample)', 'Graduate in any discipline']] : [],
    selection: s.category === 'latest-jobs' ? ['Written exam', 'Skill / typing test', 'Document verification', 'Medical examination'] : [],
    howTo: ['This is a sample post — on a real post, these steps explain how to apply or download.', 'Always use the official website link from the Important Links table.'],
    links: [['Official website (example)', 'https://example.com/']],
    faqs: [
      ['Is this a real notification?', 'No. This is a sample post with a fictional organisation, used only to preview the site design.'],
      ...(s.last ? [['What is the last date?', `In this sample, the last date is ${s.last}.`]] : [])
    ],
    extra: []
  };
  const last_date = s.last ? new Date(s.last + ' UTC').toISOString().slice(0, 10) : null;
  return {
    title: `${base} (Sample)`, slug: base, category: s.category, organization: s.org, total_posts: s.total || '',
    status: 'published', featured: i < 6, last_date, data,
    meta_description: `Sample post: ${base}. Demo of dates, fee, eligibility and links layout.`, short_info: data.intro.slice(0, 280)
  };
}

function seed() {
  const n = db.prepare('SELECT COUNT(*) c FROM posts').get().c;
  if (n > 0) return 0;
  SAMPLES.forEach((s, i) => savePost(demoPost(s, i)));
  return SAMPLES.length;
}

if (require.main === module) { require('dotenv').config(); console.log(`Seeded ${seed()} sample posts`); }
module.exports = { seed };
