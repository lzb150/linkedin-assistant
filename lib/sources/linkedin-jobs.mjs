// LinkedIn Jobs source via the logged-in browser session.
// ⚠️ Scraping LinkedIn search violates their ToS and is detectable. Kept modest:
// few results, polite delays, read-only. Takes an existing Playwright `page`.
// Returns [{ source, title, company, url, location, text }]

const SEL = {
  // result list cards (LinkedIn obfuscates these; centralized for easy fixing)
  card: "li.jobs-search-results__list-item, .job-card-container, .scaffold-layout__list-item",
  title: ".job-card-list__title, .job-card-container__link, a.job-card-list__title--link, [class*='job-card-list__title']",
  company: ".job-card-container__primary-description, .artdeco-entity-lockup__subtitle, [class*='primary-description']",
  location: ".job-card-container__metadata-item, .artdeco-entity-lockup__caption, .job-card-container__metadata-wrapper li, [class*='metadata-item']",
  // right-hand description panel after clicking a card
  desc: "#job-details, .jobs-description__content, .jobs-box__html-content, .jobs-description-content__text",
};

export function buildUrl({ keywords, location, remote }) {
  const p = new URLSearchParams();
  if (keywords) p.set("keywords", keywords);
  if (location) p.set("location", location);
  if (remote) p.set("f_WT", "2"); // remote filter
  p.set("sortBy", "DD");          // newest first
  return `https://www.linkedin.com/jobs/search/?${p.toString()}`;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Clicking a card re-renders LinkedIn's virtualised list and detaches the other
// handles; every per-action call on a detached handle then burns Playwright's
// 30s default timeout inside a silent catch (15 cards ≈ 35 min per search).
// So: read a card in ONE evaluate() before clicking, and cap the click/desc wait.
const ACTION_TIMEOUT = 5000;

// Runs inside the page: pull everything we need from one card in one round trip.
function readCard(card, SEL) {
  const first = (sel) => card.querySelector(sel);
  const text = (el) => ((el && el.innerText) || "").trim().split("\n")[0];
  const tEl = first(SEL.title);
  let location = "";
  for (const lEl of card.querySelectorAll(SEL.location)) { location = text(lEl); if (location) break; }
  return { title: text(tEl), href: (tEl && tEl.getAttribute("href")) || "", company: text(first(SEL.company)), location };
}

export async function fetchLinkedInJobs(page, config, log = console.log, { sleep = defaultSleep } = {}) {
  const out = [];
  const max = config.maxResults || 8;

  for (const search of config.searches || []) {
    const url = buildUrl(search);
    const t0 = Date.now();
    log(`  LinkedIn search: ${search.keywords} / ${search.location}${search.remote ? " (remote)" : ""}`);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(2500);
      // scroll a bit to load cards
      await page.mouse.wheel(0, 2000).catch(() => {});
      await sleep(1500);

      const cards = await page.$$(SEL.card);
      // SEL.card matches both the <li> and its inner .job-card-container, so
      // every job shows up twice. Read all cards first (one cheap evaluate each),
      // de-dup by url, THEN cap and click — otherwise half the clicks are wasted
      // on duplicates and maxResults yields half as many jobs as configured.
      const uniq = [];
      const urls = new Set();
      for (const card of cards) {
        let fields;
        try { fields = await card.evaluate(readCard, SEL); } catch { continue; }
        // No href → jobUrl would collapse to bare "https://www.linkedin.com".
        if (!fields.title || !fields.href) continue;
        const url = fields.href.startsWith("http") ? fields.href.split("?")[0] : `https://www.linkedin.com${fields.href.split("?")[0]}`;
        if (urls.has(url)) continue;
        urls.add(url);
        uniq.push({ card, url, ...fields });
      }
      log(`    found ${cards.length} cards, ${uniq.length} unique (capped at ${max})`);

      for (const { card, url: jobUrl, title, company, location: cardLocation } of uniq.slice(0, max)) {
        // Click to load the description panel.
        let desc = "";
        try {
          await card.click({ timeout: ACTION_TIMEOUT });
          await sleep(1800); // polite delay
          desc = (await page.locator(SEL.desc).first().innerText({ timeout: ACTION_TIMEOUT })).trim();
        } catch {}

        // The card's own location (a search for "Ukraine" returns Kyiv, Lviv,
        // Remote…); the search location is only the fallback.
        const location = cardLocation || search.location || "";
        out.push({
          source: "linkedin",
          title,
          company,
          url: jobUrl,
          location,
          // same shape as the other sources so location terms can score
          text: `${title} at ${company}. ${location}. ${desc}`,
        });
      }
      await sleep(2000); // pause between searches
    } catch (e) {
      log(`    LinkedIn search error: ${e.message}`);
    }
    log(`    search took ${Math.round((Date.now() - t0) / 1000)}s`);
  }

  // de-dup by url
  const seen = new Set();
  return out.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));
}
