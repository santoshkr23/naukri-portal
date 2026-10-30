// Extracts FACTS (dates, fees, age limits, vacancy numbers, eligibility, official links) from a job page.
// It deliberately ignores paragraphs, FAQs, "how to" steps and images, so no one else's writing is copied.
const cheerio = require('cheerio');

const SECTION_RULES = [
  ['skip', /how\s*to\s*(apply|download|check|fill)|faq|frequently|important\s*question|related|comment|share|join\s*(us|whatsapp|telegram)|social|disclaimer|tools?$/i],
  ['links', /important\s*link|useful\s*link|direct\s*link|official\s*link/i],
  ['dates', /important\s*date|key\s*date|exam\s*date|schedule|time\s*table/i],
  ['fees', /fee/i],
  ['age', /age\s*limit|\bage\b/i],
  ['vacancy', /vacanc|post\s*detail|no\.?\s*of\s*post|total\s*post|post\s*wise/i],
  ['eligibility', /eligib|qualification/i],
  ['salary', /salary|pay\s*scale|pay\s*level|stipend|remuneration/i],
  ['selection', /selection/i]
];

const SOCIAL = /(facebook|twitter|x\.com|t\.me|telegram|whatsapp|instagram|youtube|linkedin|pinterest|tumblr|threads|play\.google|apps\.apple|tinyurl|bit\.ly|gravatar|dmca)/i;
const OFFICIAL_HINT = /(\.gov\.in|\.nic\.in|\.gov$|\.ac\.in|\.edu\.in|\.res\.in|\.aero|ibps\.in|\.org\.in|ssc\.|upsc\.|rrb|nta\.|nic\.in|\.gov\.|\.co\.in|bank|railway|police)/i;

function classify(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || t.length > 90) return null;
  for (const [key, re] of SECTION_RULES) if (re.test(t)) return key;
  return null;
}
const clean = s => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

function splitPair(text) {
  const m = text.match(/^(.{2,80}?)\s*[:：]\s*(.+)$/);
  if (m) return [clean(m[1]), clean(m[2])];
  return [clean(text), ''];
}

function pickRoot($) {
  const cands = ['article .entry-content', '.entry-content', 'article', '.post-content', '.td-post-content', 'main', '#content', 'body'];
  for (const c of cands) if ($(c).length && clean($(c).first().text()).length > 300) return $(c).first();
  return $('body');
}

function extract(html, pageUrl, contentSelector) {
  const $ = cheerio.load(html);
  const pageHost = new URL(pageUrl).hostname.replace(/^www\./, '');
  $('script,style,noscript,iframe,svg,nav,header,footer,aside,form,.sharedaddy,.related-posts,#comments,.comments-area,.yarpp,.wp-block-buttons').remove();

  const root = contentSelector && $(contentSelector).length ? $(contentSelector).first() : pickRoot($);
  let title = clean($('h1').first().text()) || clean($('title').text());

  const sections = {};
  const extra = [];
  let current = null; // {key, heading}
  const bucket = key => (sections[key] ||= { items: [], rows: [], links: [] });

  const official = new Map(); // url -> label
  const addLink = (href, label) => {
    if (!href) return;
    let u;
    try { u = new URL(href, pageUrl); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    const host = u.hostname.replace(/^www\./, '');
    if (host === pageHost || host.endsWith('.' + pageHost) || SOCIAL.test(host)) return;
    const key = u.toString();
    if (!official.has(key)) official.set(key, { label: clean(label).slice(0, 80), host });
  };

  root.find('h1,h2,h3,h4,h5,h6,p,li,tr').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const $el = $(el);

    if (/^h[1-6]$/.test(tag)) {
      const text = clean($el.text());
      const key = classify(text);
      current = key ? { key, heading: text } : { key: 'extra', heading: text };
      if (current.key === 'extra') extra.push({ heading: text, items: [] });
      return;
    }

    if (tag === 'p') {
      const text = clean($el.text());
      const bold = clean($el.find('strong,b').first().text());
      if (text && bold && bold === text && text.length < 70) { // bold paragraph acting as a heading
        const key = classify(text);
        if (key) { current = { key, heading: text }; return; }
      }
      if (current && ['dates', 'fees', 'age', 'salary'].includes(current.key) && /[:：]/.test(text) && text.length < 160) {
        bucket(current.key).items.push(text);
      }
      return;
    }

    if (tag === 'li') {
      if ($el.find('ul,ol').length) return;
      const text = clean($el.text());
      if (!text || text.length > 220) return;
      if (current?.key === 'links') { const a = $el.find('a[href]').first(); if (a.length) addLink(a.attr('href'), splitPair(text)[0] || a.text()); return; }
      if (!current || current.key === 'skip') return;
      if (current.key === 'extra') { if (text.length < 140) extra[extra.length - 1]?.items.push(text); return; }
      bucket(current.key).items.push(text);
      return;
    }

    if (tag === 'tr') {
      const cells = $el.children('td,th');
      if (cells.toArray().some(c => $(c).find('ul,ol,h2,h3,h4,table').length)) return; // layout table
      const texts = cells.toArray().map(c => clean($(c).text())).filter(Boolean);
      if (!texts.length) return;
      if (texts.length === 1) {
        const key = classify(texts[0]);
        if (key) { current = { key, heading: texts[0] }; return; }
      }
      const a = $el.find('a[href]').first();
      if (current?.key === 'links' || (a.length && texts.length <= 2 && /click|download|apply|official|notification|link/i.test(texts.join(' ')))) {
        if (a.length) addLink(a.attr('href'), texts[0]);
        return;
      }
      if (!current || current.key === 'skip' || current.key === 'extra') return;
      bucket(current.key).rows.push(texts.slice(0, 4).map(t => t.slice(0, 240)));
    }
  });

  // Fallback: collect any official-looking external links in the content
  root.find('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    try { if (OFFICIAL_HINT.test(new URL(href, pageUrl).hostname)) addLink(href, $(a).text()); } catch {}
  });

  // Organisation: first official link text that looks like a body name, else from title
  let organization = '';
  root.find('a[href]').each((_, a) => {
    if (organization) return;
    const t = clean($(a).text());
    try {
      const h = new URL($(a).attr('href'), pageUrl).hostname;
      if (OFFICIAL_HINT.test(h) && t.length > 3 && t.length < 90 && !/click|here|download|apply|login|http/i.test(t)) organization = t;
    } catch {}
  });

  const pairs = key => {
    const s = sections[key]; if (!s) return [];
    const out = s.items.map(splitPair);
    for (const r of s.rows) if (r.length >= 2) out.push([r[0], r.slice(1).join(' – ')]);
    return dedupeRows(out).slice(0, 15);
  };

  const vacancyRows = (sections.vacancy?.rows || []).filter(r => r.length >= 2);
  let vacancyHeader = null, vacancy = vacancyRows;
  if (vacancyRows.length && /post|name|category|total/i.test(vacancyRows[0].join(' ')) && !/\d{2,}/.test(vacancyRows[0][0])) {
    vacancyHeader = vacancyRows[0]; vacancy = vacancyRows.slice(1);
  }

  const allText = clean(root.text());
  const totalMatch = (title.match(/(\d[\d,]*)\s*(?:posts?|vacanc)/i) || allText.match(/total\s*(?:no\.?\s*of\s*)?posts?\s*[:\-]?\s*(\d[\d,]*)/i) || allText.match(/(\d[\d,]*)\s*posts?\b/i));
  const total_posts = totalMatch ? totalMatch[1].replace(/,/g, '') : '';

  const advt = (allText.match(/advt\.?\s*no\.?\s*[:\-]?\s*([A-Z0-9\/\-.‐]{3,40})|advertisement\s*no\.?\s*[:\-]?\s*([A-Z0-9\/\-.‐]{3,40})/i) || []).slice(1).find(Boolean) || '';

  const links = [...official.entries()].slice(0, 12).map(([url, v]) => [v.label || v.host, url]);

  return {
    title,
    organization,
    total_posts,
    advt,
    dates: pairs('dates'),
    fees: pairs('fees'),
    age: pairs('age'),
    salary: pairs('salary'),
    vacancyHeader,
    vacancy: vacancy.slice(0, 60),
    eligibility: (sections.eligibility?.rows || []).filter(r => r.length >= 2).map(r => [r[0], r[r.length - 1]]).slice(0, 40)
      .concat((sections.eligibility?.items || []).map(t => [t, ''])).slice(0, 40),
    selection: (sections.selection?.items || []).filter(t => t.length < 100).slice(0, 10),
    extra: extra.filter(e => e.items.length && e.items.length <= 20 && !/notification|short\s*detail|^.{0,3}$/i.test(e.heading)).slice(0, 4),
    links
  };
}

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter(r => { const k = r.join('|').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Listing page / RSS -> candidate post URLs on the same site
const POST_HINT = /(recruit|online-form|vacanc|bharti|admit|result|answer|syllabus|admission|exam|notification|merit|cut-off|cutoff|city|apply|form|jobs?-\d|\d{4})/i;
const NOT_POST = /(\/category\/|\/tag\/|\/page\/\d|\/author\/|wp-|\/feed|#|\?replytocom|privacy|contact|about|disclaimer|terms)/i;

function discoverLinks(body, listUrl, selector) {
  const base = new URL(listUrl);
  const host = base.hostname.replace(/^www\./, '');
  const out = [];
  const push = href => {
    try {
      const u = new URL(href, listUrl); u.hash = '';
      if (u.hostname.replace(/^www\./, '') !== host) return;
      if (u.pathname === '/' || NOT_POST.test(u.href)) return;
      if (!selector && !POST_HINT.test(u.pathname)) return;
      const s = u.toString();
      if (!out.includes(s) && s !== base.toString()) out.push(s);
    } catch {}
  };
  if (/^\s*<\?xml|<rss[\s>]|<feed[\s>]/i.test(body.slice(0, 500))) {
    const $ = cheerio.load(body, { xmlMode: true });
    $('item > link').each((_, l) => push($(l).text().trim()));
    $('entry > link[href]').each((_, l) => push($(l).attr('href')));
    return out.slice(0, 50);
  }
  const $ = cheerio.load(body);
  const anchors = selector ? $(selector).find('a[href]').add($(selector).filter('a[href]')) : $('a[href]');
  anchors.each((_, a) => push($(a).attr('href')));
  return out.slice(0, 50);
}

module.exports = { extract, discoverLinks, classify };
