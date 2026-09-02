// Glassdoor job source via the shared Playwright browser (Cloudflare 403s plain
// fetch; the site renders fine in the headful profile, no login needed).
// Each config search is a keyword string; the location is fixed to Ukraine via
// Glassdoor's numeric location id (IN244). Clicking a card loads the full
// description in the right-hand panel, like LinkedIn.
// Returns [{ source, title, company, url, location, text }]

import { siteUrl } from "./html.mjs";

const SEL = {
  card: "li[data-test='jobListing']",
  title: "a[data-test='job-title']",
  company: "[class*='EmployerProfile_compactEmployerName']",
  location: "[data-test='emp-location']",
  snippet: "[data-test='descSnippet']",
  desc: "[class*='JobDetails_jobDescription']",
};
const UKRAINE = "IN244";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// https://www.glassdoor.com/Job/ukraine-qa-automation-jobs-SRCH_IL.0,7_IN244_KO8,21.htm
// KO<start>,<end> are the keyword's char offsets inside the slug.
export function buildUrl(keywords, locId = UKRAINE) {
  const slug = keywords.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const start = "ukraine-".length;
  return `https://www.glassdoor.com/Job/ukraine-${slug}-jobs-SRCH_IL.0,7_${locId}_KO${start},${start + slug.length}.htm`;
}

// Absolute glassdoor.com listing URL, or null if the href would leave the site.
// Keeps ?jl=<jobId>: the bare /job-listing/… path is 403 on Glassdoor.
export function jobUrl(href) {
  const url = siteUrl(href, "https://www.glassdoor.com");
  return url && url.replace(/(\?jl=\d+).*$/, "$1");
}

export async function fetchGlassdoor(page, config, log = console.log) {
  const out = [];
  if (!config?.enabled) return out;
  const max = config.maxResults || 10;

  for (const keywords of config.searches || []) {
    log(`  Glassdoor search: ${keywords} / Ukraine`);
    try {
      await page.goto(buildUrl(keywords), { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForSelector(SEL.card, { timeout: 15000 });
      await sleep(1500);
      const cards = await page.$$(SEL.card);
      log(`    found ${cards.length} cards (capped at ${max})`);

      for (const card of cards.slice(0, max)) {
        const read = async (sel) => { try { const fEl = await card.$(sel); return fEl ? (await fEl.innerText()).trim() : ""; } catch { return ""; } };
        let title = "", href = "";
        try {
          const tEl = await card.$(SEL.title);
          if (tEl) { title = (await tEl.innerText()).trim(); href = (await tEl.getAttribute("href")) || ""; }
        } catch {}
        const url = jobUrl(href);
        if (!title || !url) continue;
        const company = (await read(SEL.company)).split("\n")[0];
        const location = (await read(SEL.location)) || "Ukraine";
        let desc = await read(SEL.snippet);
        try {
          await card.click();
          await sleep(1800); // polite delay; the panel renders client-side
          const dEl = await page.$(SEL.desc);
          const full = dEl ? (await dEl.innerText()).trim() : "";
          if (full) desc = full;
        } catch {}
        out.push({
          source: "glassdoor",
          title,
          company,
          url,
          location,
          text: `${title} at ${company}. ${location}. ${desc}`.replace(/\s+/g, " "),
        });
      }
      await sleep(2000); // pause between searches
    } catch (e) {
      log(`  Glassdoor search error: ${keywords} — ${e.message}`);
    }
  }

  const seen = new Set();
  return out.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));
}
