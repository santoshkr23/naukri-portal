const { CATEGORIES } = require('./db');

const esc = s => String(s ?? '').replace(/</g, '\\u003c');
const ld = obj => `<script type="application/ld+json">${esc(JSON.stringify(obj))}</script>`;
const toIso = s => (s ? new Date(s.replace(' ', 'T') + (s.length > 10 ? 'Z' : 'T00:00:00+05:30')).toISOString() : undefined);

function orgLd(settings, baseUrl) {
  return { '@type': 'Organization', name: settings.site_name, url: baseUrl + '/', logo: baseUrl + '/static/logo.png' };
}

function homeSchema(settings, baseUrl) {
  return ld({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: settings.site_name, url: baseUrl + '/',
        potentialAction: { '@type': 'SearchAction', target: `${baseUrl}/search/?q={search_term_string}`, 'query-input': 'required name=search_term_string' } },
      orgLd(settings, baseUrl),
      { '@type': 'FAQPage', mainEntity: [
        [`Is ${settings.site_name} a government website?`, 'No. It is an independent information portal. Always apply and pay fees only on the official website linked in each post.'],
        ['How often are updates added?', 'New notifications are checked every hour, and each post shows when it was published and last updated.'],
        ['Which details should I verify before applying?', 'The last date, fee, age limit and qualification. These can change through a corrigendum, so open the official notification from the Important Links table.']
      ].map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }
    ]
  });
}

function breadcrumbs(items) {
  return { '@type': 'BreadcrumbList', itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.url })) };
}

function postSchema(post, settings, baseUrl) {
  const url = `${baseUrl}/${post.slug}/`;
  const cat = CATEGORIES[post.category] || { name: post.category };
  const graph = [
    breadcrumbs([{ name: 'Home', url: baseUrl + '/' }, { name: cat.name, url: `${baseUrl}/${post.category}/` }, { name: post.title, url }]),
    {
      '@type': post.category === 'news' ? 'NewsArticle' : 'Article', ...(post.data?.lang ? { inLanguage: post.data.lang } : {}), headline: post.title.slice(0, 110), description: post.meta_description,
      image: post.category === 'news' ? `${baseUrl}/card/${post.slug}.jpg` : `${baseUrl}/banner/${post.slug}.jpg`, datePublished: toIso(post.published_at), dateModified: toIso(post.updated_at || post.published_at),
      mainEntityOfPage: url, author: orgLd(settings, baseUrl), publisher: orgLd(settings, baseUrl)
    }
  ];
  const d = post.data || {};
  if (post.category === 'latest-jobs') {
    const descHtml = [`<p>${d.intro || ''}</p>`,
      d.dates?.length ? `<h3>Important Dates</h3><ul>${d.dates.map(([k, v]) => `<li>${k}: ${v}</li>`).join('')}</ul>` : '',
      d.eligibility?.length ? `<h3>Eligibility</h3><ul>${d.eligibility.map(([k, v]) => `<li>${k}${v ? ': ' + v : ''}</li>`).join('')}</ul>` : ''].join('');
    const job = {
      '@type': 'JobPosting', title: post.title.split(/[:–]/)[0].trim(), description: descHtml,
      datePosted: toIso(post.published_at), hiringOrganization: { '@type': 'Organization', name: post.organization || settings.site_name },
      employmentType: 'FULL_TIME', jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'IN' } },
      directApply: false
    };
    if (post.last_date) job.validThrough = `${post.last_date}T23:59:00+05:30`;
    if (post.total_posts) job.totalJobOpenings = +post.total_posts;
    graph.push(job);
  }
  if (d.faqs?.length) {
    graph.push({ '@type': 'FAQPage', mainEntity: d.faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });
  }
  return ld({ '@context': 'https://schema.org', '@graph': graph });
}

function categorySchema(catKey, settings, baseUrl) {
  const cat = CATEGORIES[catKey];
  return ld({ '@context': 'https://schema.org', '@graph': [breadcrumbs([{ name: 'Home', url: baseUrl + '/' }, { name: cat.name, url: `${baseUrl}/${catKey}/` }])] });
}

module.exports = { homeSchema, postSchema, categorySchema };
