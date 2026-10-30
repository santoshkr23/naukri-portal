// News section: a short Hindi news story (Jagran-style: "English keyword: Hindi headline") is written automatically
// for every published update on the site — jobs, admit cards, results, answer keys and so on.
// It is written from the post's own facts in this site's words; nothing is copied from news sites.
// Admin edits to a news post are kept: once edited, a story is no longer regenerated.
const { db, getSettings, parsePost } = require('./db');

const HI_MONTHS = { january: 'जनवरी', february: 'फरवरी', march: 'मार्च', april: 'अप्रैल', may: 'मई', june: 'जून', july: 'जुलाई', august: 'अगस्त',
  september: 'सितंबर', october: 'अक्टूबर', november: 'नवंबर', december: 'दिसंबर' };
const EN_MONTHS = Object.keys(HI_MONTHS);
const SHORT = Object.fromEntries(EN_MONTHS.map(m => [m.slice(0, 3), m]));

// "06 November 2026" / "2026-11-06" / "To be announced" -> "6 नवंबर 2026" / "जल्द घोषित होगी"
function hiDate(s) {
  if (!s) return '';
  let t = String(s).trim();
  if (/to be announced|tba|will be (notified|announced)|as per .*schedule/i.test(t)) return 'जल्द घोषित होगी';
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => `${+d} ${EN_MONTHS[+mo - 1]} ${y}`);
  t = t.replace(/\b0(\d)\b(?=\s*([A-Za-z]{3}|[–-]))/g, '$1');
  t = t.replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b\.?/gi,
    m => HI_MONTHS[(SHORT[m.toLowerCase().slice(0, 3)] || m.toLowerCase())] || m);
  return t.replace(/\(tentative\)/i, '(संभावित)').replace(/\btentative\b/i, 'संभावित');
}
const LABELS = [
  [/notification|advertisement/i, 'अधिसूचना जारी'], [/apply.*start|application.*start|starts/i, 'ऑनलाइन आवेदन शुरू'],
  [/fee/i, 'शुल्क भुगतान की अंतिम तिथि'], [/correction/i, 'आवेदन में सुधार'], [/last date/i, 'आवेदन की अंतिम तिथि'],
  [/objection/i, 'आपत्ति दर्ज करने की अवधि'], [/admit/i, 'एडमिट कार्ड'], [/city/i, 'एग्जाम सिटी स्लिप'], [/answer key/i, 'आंसर-की'], [/result|merit/i, 'परिणाम'],
  [/interview|ssb/i, 'इंटरव्यू'], [/exam|cbt|test/i, 'परीक्षा तिथि'], [/selection list/i, 'चयन सूची']
];
const hiLabel = k => {
  if (/prelim/i.test(k)) return 'प्रारंभिक परीक्षा';
  if (/\bmains?\b/i.test(k) && /exam/i.test(k)) return 'मुख्य परीक्षा';
  if (/tier|paper|stage|phase|cbt[- ]?\d|session/i.test(k)) return k; // keep specific stage names as they are
  for (const [re, h] of LABELS) if (re.test(k)) return h;
  return k;
};

const get = (rows, re) => ((rows || []).find(([k]) => re.test(k)) || [])[1];
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const shortOrg = org => (String(org || '').match(/\(([^)]+)\)\s*$/) || [])[1] || String(org || '').trim();
const keyword = title => String(title).split(/:|–(?=[^–]*$)/)[0].replace(/\s*\((\d[\d,]*\s*Posts?|topic-wise)\)/ig, '').trim();
const dot = s => (s ? String(s).replace(/[.।\s]+$/, '') + '।' : '');

// ---------- story templates per section ----------
function story(p) {
  const d = p.data || {};
  const K = keyword(p.title);
  const org = p.organization || shortOrg(K);
  const so = shortOrg(org);
  const official = (d.links || []).find(([l]) => /official|website/i.test(l)) || (d.links || [])[0];
  const site = official ? host(official[1]) : '';
  const lastH = hiDate(get(d.dates, /last date(?!.*fee)/i) || p.last_date);
  const startH = hiDate(get(d.dates, /start/i));
  const examRaw = get(d.dates, /^(?!.*(city|admit|answer|result)).*(exam|cbt|test)/i);
  const examH = hiDate(examRaw);
  const examKnown = examH && examH !== 'जल्द घोषित होगी';
  const total = p.total_posts && /^\d+$/.test(p.total_posts) ? Number(p.total_posts).toLocaleString('en-IN') : '';
  const onSite = site ? `आधिकारिक वेबसाइट ${site} पर` : 'आधिकारिक वेबसाइट पर';
  const kp = [], body = [];
  let headline, deck, stepsHeading = '', steps = [];

  switch (p.category) {
    case 'latest-jobs': {
      headline = total ? `${K}: ${so} में ${total} पदों पर भर्ती, ${lastH ? `${lastH} तक करें आवेदन` : 'ऐसे करें आवेदन'}`
        : `${K}: ${lastH ? `आवेदन की अंतिम तिथि ${lastH}` : 'आवेदन प्रक्रिया जारी'}, ऐसे करें अप्लाई`;
      deck = `${org} ने ${total ? `${total} पदों पर भर्ती के लिए अधिसूचना जारी की है` : `${K.replace(/\s*(online form|recruitment).*$/i, '')} के लिए आवेदन मांगे हैं`}। इच्छुक और योग्य उम्मीदवार ${startH ? `${startH} से ` : ''}${lastH ? `${lastH} तक ` : ''}${onSite} ऑनलाइन आवेदन कर सकते हैं।`;
      if (total) kp.push(`कुल पद: ${total}`);
      if (lastH) kp.push(`आवेदन की अंतिम तिथि: ${lastH}`);
      kp.push(examKnown ? `परीक्षा: ${examH}` : 'परीक्षा तिथि जल्द घोषित होगी');
      const minA = get(d.age, /minimum/i), maxA = get(d.age, /maximum/i);
      if (d.eligibility?.length) body.push(`योग्यता: ${d.eligibility.slice(0, 3).map(([k, v]) => (v ? `${k} — ${v}` : k)).join('; ')}${d.eligibility.length > 3 ? ' आदि' : ''}। पदवार योग्यता की पूरी जानकारी अधिसूचना में दी गई है।`);
      if (minA || maxA) body.push(`आयु सीमा: ${[minA && `न्यूनतम ${minA}`, maxA && `अधिकतम ${maxA}`].filter(Boolean).join(', ')}। आरक्षित वर्गों को नियमानुसार आयु में छूट मिलेगी।`);
      if (d.fees?.length) body.push(`आवेदन शुल्क: ${d.fees.filter(([k]) => !/mode/i.test(k)).map(([k, v]) => `${k} — ${v}`).join('; ')}।`);
      if (d.selection?.length && !/as per official/i.test(d.selection[0])) body.push(`चयन प्रक्रिया: ${d.selection.join(', ')}।`);
      stepsHeading = 'ऐसे करें आवेदन';
      steps = [`सबसे पहले ${site || 'आधिकारिक वेबसाइट'} पर जाएं और अधिसूचना ध्यान से पढ़ें।`, 'मोबाइल नंबर और ई-मेल से रजिस्ट्रेशन करें।',
        'आवेदन फॉर्म में मांगी गई जानकारी भरें और फोटो-हस्ताक्षर अपलोड करें।', 'आवेदन शुल्क जमा करें और फॉर्म सबमिट कर उसका प्रिंट सुरक्षित रखें।'];
      break;
    }
    case 'admit-card': {
      headline = `${K}: एडमिट कार्ड जारी, ${examKnown ? `परीक्षा ${examH} को, ` : ''}ऐसे करें डाउनलोड`;
      deck = `${org} ने ${K.replace(/admit card.*$/i, '').trim()} परीक्षा के एडमिट कार्ड जारी कर दिए हैं। उम्मीदवार ${onSite} लॉगिन कर अपना प्रवेश पत्र डाउनलोड कर सकते हैं।`;
      kp.push('एडमिट कार्ड जारी', examKnown ? `परीक्षा: ${examH}` : 'परीक्षा तिथि एडमिट कार्ड पर देखें', 'परीक्षा केंद्र पर फोटो पहचान पत्र साथ ले जाना जरूरी');
      body.push('एडमिट कार्ड पर अपना नाम, फोटो, परीक्षा केंद्र और रिपोर्टिंग समय जरूर जांच लें। कोई गलती हो तो तुरंत परीक्षा हेल्पलाइन से संपर्क करें।');
      if (d.selection?.length) body.push(`परीक्षा के बाद के चरण: ${d.selection.join(', ')}।`);
      stepsHeading = 'ऐसे करें डाउनलोड';
      steps = [`${site || 'आधिकारिक वेबसाइट'} पर जाएं।`, 'एडमिट कार्ड लिंक पर क्लिक करें।', 'रजिस्ट्रेशन नंबर और पासवर्ड/जन्मतिथि से लॉगिन करें।', 'एडमिट कार्ड डाउनलोड कर उसके दो प्रिंट निकाल लें।'];
      break;
    }
    case 'result': {
      headline = `${K}: परिणाम जारी, एक क्लिक में ऐसे चेक करें रिजल्ट`;
      deck = `${org} ने ${K.replace(/result.*$/i, '').trim()} का परिणाम जारी कर दिया है। उम्मीदवार ${onSite} अपना रिजल्ट देख सकते हैं।`;
      kp.push('परिणाम जारी', 'रोल नंबर से खोजें अपना नाम');
      if (d.selection?.length) { kp.push(`अगला चरण: ${d.selection[0]}`); body.push(`सफल उम्मीदवारों को अब इन चरणों से गुजरना होगा: ${d.selection.join(', ')}।`); }
      body.push('परिणाम पीडीएफ सूची के रूप में जारी हुआ है। फाइल खोलकर Ctrl + F से अपना रोल नंबर खोजें और उस पेज को सेव कर लें।');
      stepsHeading = 'ऐसे चेक करें रिजल्ट';
      steps = [`${site || 'आधिकारिक वेबसाइट'} पर जाएं।`, 'रिजल्ट लिंक पर क्लिक करें।', 'पीडीएफ में अपना रोल नंबर खोजें।', 'रिजल्ट डाउनलोड कर भविष्य के लिए सुरक्षित रखें।'];
      break;
    }
    case 'answer-key': {
      const keyDate = hiDate(get(d.dates, /answer key/i));
      headline = `${K}: आंसर-की जारी, एक क्लिक से करें डाउनलोड`;
      deck = `${org} ने ${K.replace(/answer key.*$/i, '').trim()} की प्रोविजनल आंसर-की ${keyDate ? `${keyDate} को ` : ''}जारी कर दी है। उम्मीदवार ${onSite} आंसर-की देखकर अपने अंकों का अनुमान लगा सकते हैं।`;
      kp.push('प्रोविजनल आंसर-की जारी', 'आपत्ति दर्ज कराने का मौका', 'फाइनल आंसर-की रिजल्ट के साथ आएगी');
      body.push('किसी उत्तर पर आपत्ति हो तो तय समय सीमा के भीतर प्रमाण के साथ ऑनलाइन आपत्ति दर्ज करें। आमतौर पर प्रति प्रश्न शुल्क लगता है, जो आपत्ति सही पाए जाने पर लौटा दिया जाता है।');
      stepsHeading = 'ऐसे करें डाउनलोड';
      steps = [`${site || 'आधिकारिक वेबसाइट'} पर जाएं।`, 'आंसर-की लिंक पर क्लिक करें।', 'लॉगिन कर अपनी रिस्पॉन्स शीट देखें।', 'उत्तरों का मिलान करें और जरूरत हो तो आपत्ति दर्ज करें।'];
      break;
    }
    case 'admission': {
      headline = `${K}: आवेदन शुरू, ${lastH ? `${lastH} तक करें अप्लाई` : 'ऐसे करें अप्लाई'}`;
      deck = `${K.replace(/online form.*$/i, '').trim()} के लिए आवेदन प्रक्रिया जारी है। ${lastH ? `आवेदन की अंतिम तिथि ${lastH} है` : 'अंतिम तिथि आधिकारिक वेबसाइट पर देखें'}${examKnown ? ` और परीक्षा ${examH} को होगी` : ''}।`;
      if (lastH) kp.push(`अंतिम तिथि: ${lastH}`);
      if (examKnown) kp.push(`परीक्षा: ${examH}`);
      if (d.fees?.length) { kp.push(`शुल्क: ${d.fees[0][1]} से`); body.push(`आवेदन शुल्क: ${d.fees.map(([k, v]) => `${k} — ${v}`).join('; ')}।`); }
      if (d.eligibility?.length) body.push(`योग्यता: ${d.eligibility.map(([k, v]) => (v ? `${k} — ${v}` : k)).join('; ')}।`);
      stepsHeading = 'ऐसे करें आवेदन';
      steps = [`${site || 'आधिकारिक वेबसाइट'} पर जाएं।`, 'रजिस्ट्रेशन कर लॉगिन करें।', 'फॉर्म भरें, दस्तावेज अपलोड करें और शुल्क जमा करें।', 'कन्फर्मेशन पेज डाउनलोड कर लें।'];
      break;
    }
    case 'syllabus': {
      headline = `${K}: यहां देखें विषयवार सिलेबस और परीक्षा पैटर्न`;
      deck = `${org} की परीक्षा की तैयारी कर रहे उम्मीदवारों के लिए सिलेबस और परीक्षा पैटर्न की पूरी जानकारी। जानें किस विषय से कितने प्रश्न आएंगे और नेगेटिव मार्किंग का नियम क्या है।`;
      const neg = (d.extra || []).flatMap(e => e.items).find(i => /negative|deduct/i.test(i));
      kp.push('विषयवार प्रश्न और अंक', neg ? `मार्किंग: ${neg}` : 'मार्किंग स्कीम पोस्ट में देखें', 'पिछले साल के पेपर से करें अभ्यास');
      body.push('ज्यादा अंक वाले विषयों को अधिक समय दें, हर टॉपिक पूरा करने के बाद पिछले वर्षों के प्रश्न-पत्र हल करें और समय-बद्ध मॉक टेस्ट दें।');
      break;
    }
    case 'exam-date': {
      const first = d.dates?.[0];
      headline = `${K}: परीक्षा कार्यक्रम घोषित, ${first ? `${hiDate(first[1])} को होगी परीक्षा` : 'यहां देखें शेड्यूल'}`;
      deck = `${org} ने ${K.replace(/exam date.*$/i, '').trim()} का परीक्षा कार्यक्रम जारी कर दिया है। एडमिट कार्ड परीक्षा से कुछ दिन पहले ${onSite} जारी होंगे।`;
      (d.dates || []).slice(0, 3).forEach(([k, v]) => kp.push(`${hiLabel(k)}: ${hiDate(v)}`));
      body.push('परीक्षा तिथि में बदलाव की सूचना आधिकारिक वेबसाइट पर ही दी जाती है, इसलिए वेबसाइट नियमित रूप से देखते रहें।');
      break;
    }
    default: {
      headline = `${K}: नई अपडेट जारी, यहां देखें पूरी जानकारी`;
      deck = `${org ? `${org} से जुड़ी` : 'एक'} नई अपडेट जारी हुई है। जरूरी तिथियां और आधिकारिक लिंक नीचे दिए गए हैं।`;
      if (lastH) kp.push(`अंतिम तिथि: ${lastH}`);
    }
  }
  body.push('भर्ती या परीक्षा से जुड़ा कोई भी कदम उठाने से पहले आधिकारिक अधिसूचना जरूर पढ़ें। तिथियों में बदलाव की स्थिति में आधिकारिक वेबसाइट की जानकारी ही मान्य होगी।');

  return {
    title: headline.replace(/\s+,/g, ',').replace(/\s+/g, ' ').trim(),
    keyword: K,
    data: {
      intro: [deck, ...body].map(dot).join('\n\n'),
      extra: kp.length ? [{ heading: 'मुख्य बातें', items: kp.filter(Boolean).slice(0, 4) }] : [],
      dates: (d.dates || []).map(([k, v]) => [hiLabel(k), hiDate(v)]),
      howTo: steps, howToHeading: stepsHeading,
      links: d.links || [], faqs: [], fees: [], age: [], salary: [], vacancy: [], eligibility: [], selection: [],
      keyword: K, lang: 'hi', relatedSlug: p.slug, relatedTitle: keyword(p.title), auto: true
    }
  };
}

// ---------- create / update / remove ----------
const newsFp = fp => `news:${fp}`;

function ensureNewsFor(p) {
  if (!p || p.category === 'news' || !p.fingerprint) return null;
  if (getSettings().auto_news === '0') return null;
  const { savePost } = require('./posts');
  const old = parsePost(db.prepare('SELECT * FROM posts WHERE fingerprint=?').get(newsFp(p.fingerprint)));
  if (db.prepare('SELECT 1 FROM deleted_posts WHERE fingerprint=?').get(newsFp(p.fingerprint))) return null;
  if (old && !old.data.auto) return old; // edited by hand: leave it alone
  const s = story(p);
  const post = {
    title: s.title, category: 'news', organization: p.organization, total_posts: p.total_posts, last_date: p.last_date,
    status: p.status === 'published' ? 'published' : 'draft', featured: false, fingerprint: newsFp(p.fingerprint),
    meta_description: s.data.intro.split('\n')[0].slice(0, 158), short_info: s.data.intro.slice(0, 280), data: s.data
  };
  if (old) {
    if (old.title === post.title && JSON.stringify(old.data) === JSON.stringify(post.data) && old.status === post.status) return old;
    return savePost({ ...post, slug: old.slug }, old.id);
  }
  if (post.status !== 'published') return null; // only make news for live posts
  const made = savePost({ ...post, slug: `${s.keyword} news` });
  try { require('./social').onNewsCreated(made); } catch (e) { console.error('social:', e.message); }
  return made;
}

// When the post it's about is unpublished, its auto news goes too
function syncNewsStatus(p) {
  if (!p || p.category === 'news' || !p.fingerprint) return;
  const n = parsePost(db.prepare('SELECT * FROM posts WHERE fingerprint=?').get(newsFp(p.fingerprint)));
  if (n && n.data.auto && n.status === 'published' && p.status !== 'published') {
    db.prepare("UPDATE posts SET status='draft' WHERE id=?").run(n.id);
  }
}

function deleteNewsFor(fp) {
  const n = parsePost(db.prepare('SELECT id, data FROM posts WHERE fingerprint=?').get(newsFp(fp)));
  if (n && n.data.auto) db.prepare('DELETE FROM posts WHERE id=?').run(n.id);
}

// Writes news for every published post that doesn't have a story yet (on startup / after an import)
function backfillNews() {
  if (getSettings().auto_news === '0') return 0;
  const rows = db.prepare(`SELECT p.* FROM posts p WHERE p.status='published' AND p.category<>'news' AND p.fingerprint IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM posts n WHERE n.fingerprint = 'news:' || p.fingerprint)
    AND NOT EXISTS (SELECT 1 FROM deleted_posts x WHERE x.fingerprint = 'news:' || p.fingerprint) ORDER BY p.published_at, p.id`).all();
  let n = 0;
  require('./social').quietlySync(() => {
    for (const r of rows) {
      const made = ensureNewsFor(parsePost(r));
      if (made) { db.prepare('UPDATE posts SET published_at=? WHERE id=?').run(r.published_at, made.id); n++; }
    }
  });
  return n;
}

module.exports = { ensureNewsFor, syncNewsStatus, deleteNewsFor, backfillNews, story, hiDate };
