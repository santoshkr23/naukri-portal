# NaukriSetu – Govt Job Portal with Auto-Import

A fast, SEO-ready government job alert site (Latest Jobs, Admit Card, Result, Answer Key, Admission, Syllabus, Exam Date) with an admin panel and an hourly auto-import engine.

## What it does

- **Public site** — home page with highlight tiles and a box per section, category pages with pagination, search, and post pages in a consistent layout. Each post shows: summary strip → intro → Important Dates / Fee / Age / Salary → Vacancy table → Eligibility → Selection → How to apply → Important Links → FAQs → share buttons → related posts.
- **Admin panel** (`/admin`) — dashboard, create/edit/publish/delete posts, import a single URL as a draft, manage auto-import sources, settings, and logs.
- **Auto-import** — every hour, each source's listing page (or RSS feed) is checked for new posts. For each new page it:
  1. respects the site's `robots.txt`
  2. extracts **facts only**: dates, fees, age limits, vacancy numbers, eligibility, selection stages, and **official** links. Paragraphs, FAQs, how-to text, social links and images from the source are ignored.
  3. writes a fresh post in your own template and wording, with its own intro, FAQs, how-to steps and meta description
  4. skips duplicates (the same job found on two sites is imported once)
  5. publishes it, or keeps it as a draft if the page had too little detail to trust
- **SEO built in** — server-rendered pages, clean URLs with trailing slashes, title and meta description, canonical, Open Graph/Twitter tags, a generated share image per post, JSON-LD (`JobPosting`, `Article`, `FAQPage`, `BreadcrumbList`, `WebSite` + search box), `sitemap.xml`, `robots.txt`, an RSS feed, prev/next pagination tags, and optional IndexNow pings.
- **Monetisation hooks** — AdSense client ID, Google Analytics ID, and the Search Console verification code are all set from Settings. About / Contact / Disclaimer / Privacy pages are included (AdSense requires them).

## Run locally

```bash
cp .env.example .env      # set ADMIN_PASSWORD and SESSION_SECRET
npm install
npm start                 # http://localhost:3000   admin: http://localhost:3000/admin
npm test                  # end-to-end test with a fictional source site
```

## Deploy (needs an always-on server)

The hourly import needs a process that never sleeps, plus a persistent disk for the SQLite database. GitHub Pages and the free Render tier won't work for this.

- **VPS** (Hostinger/DigitalOcean/AWS Lightsail, ~₹400–800/month): install Node 20+, `npm install`, run with `pm2 start src/server.js --name naukri`, and put Nginx + a free Let's Encrypt certificate in front of it.
- **Railway / Render paid / Fly.io**: attach a volume and set `DATA_DIR` to the volume path.

Set `BASE_URL` to your real domain so the canonical links and the sitemap are correct.

## After launch – getting traffic

1. Add the site to **Google Search Console** and submit `https://yourdomain/sitemap.xml`. Do the same in **Bing Webmaster Tools** and set `INDEXNOW_KEY` (also host `/<key>.txt`).
2. Keep auto-publish on only for sources whose output you've reviewed. For the first week, check the drafts every day.
3. Add value Google can't find on every other site: correct dates, fast updates, and short notes in your own words (in the intro field).
4. Grow Telegram and WhatsApp channels; set the links in Settings so they appear on every page.

## Choosing sources

The best sources are **official ones**: the "What's New" or recruitment pages of SSC, UPSC, RRB, IBPS, state PSCs and the like. These are the original, authoritative source, and Google rewards being early and accurate. Aggregator sites work technically, but use them only as a "something new happened" signal. Always check that the facts and links point to the official site.

If a source's pages aren't parsed well, set its **content selector** (e.g. `article .entry-content`) and **link selector** (the area that lists posts) on the Sources page.

## Important

- The importer keeps facts and official links only. Don't change it to copy other sites' write-ups or images: that infringes copyright, and Google demotes duplicate content.
- Never use another site's brand name or logo. "Sarkari Result", for example, is a registered trademark. Pick your own name in Settings.
- This is an information site. Keep the disclaimer and tell users to verify on the official website.
