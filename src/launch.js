// Launch checklist: live checks of what the site needs before (and after) going public.
const { db, getSettings, siteUrl, DATA_DIR } = require('./db');

function checks(req) {
  const s = getSettings();
  const base = siteUrl();
  const env = process.env;
  const onRenderFree = !!(env.RENDER || env.RENDER_EXTERNAL_URL) && !/^\/(opt|var|data|mnt)\//.test(require('path').resolve(DATA_DIR)) && !env.PERSISTENT_DISK;
  const n = sql => db.prepare(sql).get().c;
  const published = n("SELECT COUNT(*) c FROM posts WHERE status='published' AND category<>'news'");
  const news = n("SELECT COUNT(*) c FROM posts WHERE status='published' AND category='news'");
  const closed = n("SELECT COUNT(*) c FROM posts WHERE status='published' AND category='latest-jobs' AND last_date IS NOT NULL AND last_date < date('now','localtime','-30 days')");
  const noLinks = n(`SELECT COUNT(*) c FROM posts WHERE status='published' AND category<>'news' AND data LIKE '%"links":[]%'`);
  const sources = n('SELECT COUNT(*) c FROM sources WHERE enabled=1');
  const social = require('./social'); const sc = social.cfg();
  const socialOn = Object.keys(social.PLATFORMS).filter(p => sc[p].ready).map(p => social.PLATFORMS[p].name);
  const pw = env.ADMIN_PASSWORD || '';
  const customDomain = base && !/onrender\.com|localhost|127\.0\.0\.1|\.vercel\.app|\.railway\.app|\.fly\.dev/.test(base);
  const C = (group, title, status, detail, link) => ({ group, title, status, detail, link });

  return [
    // ---- Must have before going public
    C('Before going public', 'Own domain name', customDomain ? 'ok' : 'bad', customDomain ? base : `The site runs on ${base || 'a temporary address'}. Google ranks and AdSense approves sites on their own domain — buy one and point it here, then set BASE_URL to it.`),
    C('Before going public', 'BASE_URL set to the https address', /^https:\/\//.test(env.BASE_URL || '') ? 'ok' : 'bad', env.BASE_URL ? env.BASE_URL : 'Not set. Canonical links, sitemap and social links need it. Render → Environment → BASE_URL = https://yourdomain.com'),
    C('Before going public', 'Data kept across restarts', onRenderFree ? 'bad' : 'ok', onRenderFree ? "Render's free plan wipes the database on every restart and sleeps after 15 minutes — posts added in the admin, deletions and social history are lost, and hourly imports don't run. Use a paid plan with a disk, or a VPS." : 'Storage looks persistent.'),
    C('Before going public', 'Strong admin password', pw.length >= 12 && !/change-this|password|admin|1234/i.test(pw) ? 'ok' : 'bad', pw.length >= 12 ? 'OK' : 'Use at least 12 characters with letters, numbers and a symbol (Render → Environment → ADMIN_PASSWORD).'),
    C('Before going public', 'Session secret set', (env.SESSION_SECRET || '').length >= 32 ? 'ok' : 'bad', (env.SESSION_SECRET || '').length >= 32 ? 'OK' : 'Set SESSION_SECRET to a long random text, or logins reset on every restart.'),
    C('Before going public', 'Site name and contact e-mail', s.contact_email ? 'ok' : 'bad', s.contact_email ? `${s.site_name} · ${s.contact_email}` : 'Add a contact e-mail in Settings — it appears on Contact Us, Privacy Policy and Disclaimer (AdSense and Google News check for it).', '/admin/settings'),
    C('Before going public', 'About, Contact, Disclaimer, Privacy pages', 'ok', 'Built in — open them once and read them.', '/about-us/'),
    C('Before going public', 'Enough real posts', published >= 40 ? 'ok' : 'warn', `${published} published posts and ${news} news stories. Aim for 40+ useful posts before applying for AdSense.`),
    C('Before going public', 'Closed jobs tidied', closed ? 'warn' : 'ok', closed ? `${closed} job posts closed more than 30 days ago are still published. Keep them (they get search traffic) but make sure the page says the date has passed, or unpublish them.` : 'OK', '/admin/posts?issue=closed'),
    C('Before going public', 'Every post has an official link', noLinks ? 'warn' : 'ok', noLinks ? `${noLinks} published posts have no official link.` : 'OK', '/admin/posts?issue=empty'),

    // ---- Google & SEO
    C('Google & SEO', 'Google Search Console verified', s.google_verification ? 'ok' : 'bad', s.google_verification ? 'Verification code added — now submit the sitemap there.' : 'Add your site at search.google.com/search-console, choose "HTML tag", paste the code in Settings.', '/admin/settings'),
    C('Google & SEO', 'Sitemap', 'info', `${base || ''}/sitemap.xml — submit it in Search Console and Bing Webmaster Tools.`, '/sitemap.xml'),
    C('Google & SEO', 'Google Analytics', s.ga_id ? 'ok' : 'warn', s.ga_id ? s.ga_id : 'Add a GA4 measurement ID (G-…) in Settings to see your traffic.', '/admin/settings'),
    C('Google & SEO', 'Bing / IndexNow', env.INDEXNOW_KEY ? 'ok' : 'warn', env.INDEXNOW_KEY ? 'New posts are sent to Bing and Yandex instantly.' : 'Set INDEXNOW_KEY (any 32-character text) so new posts reach Bing within minutes.'),

    // ---- Growth
    C('Growth', 'Telegram / WhatsApp join buttons', s.telegram_url || s.whatsapp_url ? 'ok' : 'warn', s.telegram_url || s.whatsapp_url ? [s.telegram_url, s.whatsapp_url].filter(Boolean).join(' · ') : 'Add your channel links in Settings — a Join button appears on every page.', '/admin/settings'),
    C('Growth', 'Social media auto-posting', socialOn.length ? 'ok' : 'warn', socialOn.length ? socialOn.join(', ') : 'No account connected yet.', '/admin/social'),
    C('Growth', 'Browser job alerts', s.push_enabled !== '0' ? 'ok' : 'warn', s.push_enabled !== '0' ? `${require('./push').count()} subscribers — hourly round-up${env.VAPID_PUBLIC_KEY ? '' : ' (save the VAPID keys with Keep settings so they survive restarts)'}` : 'Turned off.', '/admin/notifications'),
    C('Growth', 'Hindi news stories', s.auto_news !== '0' ? 'ok' : 'warn', s.auto_news !== '0' ? 'Written automatically for every update.' : 'Turned off in Settings.', '/admin/settings'),
    C('Growth', 'Fresh posts every day', sources || require('./routes/api').keyConfigured() ? 'ok' : 'warn', sources ? `${sources} auto-import source(s) on` : require('./routes/api').keyConfigured() ? 'API key set for automation' : 'Add auto-import sources or connect n8n through the API, so new jobs appear within hours.', '/admin/api'),

    // ---- Money
    C('Earning', 'Google AdSense', s.adsense_client ? 'ok' : 'info', s.adsense_client ? s.adsense_client : 'Apply after you have your own domain, 40+ posts and a few weeks of visitors. Paste the ca-pub-… ID in Settings.', '/admin/settings')
  ];
}

module.exports = { checks };
