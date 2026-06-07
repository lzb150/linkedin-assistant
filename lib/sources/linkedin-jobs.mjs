// LinkedIn Jobs source via the logged-in browser session.
// ⚠️ Scraping LinkedIn search violates their ToS and is detectable. Kept modest:
// few results, polite delays, read-only. Takes an existing Playwright `page`.
// Returns [{ source, title, company, url, location, text }]

const SEL = {
  // result list cards (LinkedIn obfuscates these; centralized for easy fixing)
  card: "li.jobs-search-results__list-item, .job-card-container, .scaffold-layout__list-item",
  title: ".job-card-list__title, .job-card-container__link, a.job-card-list__title--link, [class*='job-card-list__title']",
  company: ".job-card-container__primary-description, .artdeco-entity-lockup__subtitle, [class*='primary-description']",
  // right-hand description panel after clicking a card
  desc: "#job-details, .jobs-description__content, .jobs-box__html-content, .jobs-description-content__text",
};

function buildUrl({ keywords, location, remote }) {
  const p = new URLSearchParams();
  if (keywords) p.set("keywords", keywords);
  if (location) p.set("location", location);
  if (remote) p.set("f_WT", "2"); // remote filter
  p.set("sortBy", "DD");          // newest first
  return `https://www.linkedin.com/jobs/search/?${p.toString()}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchLinkedInJobs(page, config, log = console.log) {
  const out = [];
  if (!config?.enabled) return out;
  const max = config.maxResults || 8;

  for (const search of config.searches || []) {
    const url = buildUrl(search);
    log(`  LinkedIn search: ${search.keywords} / ${search.location}${search.remote ? " (remote)" : ""}`);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(2500);
      // scroll a bit to load cards
      await page.mouse.wheel(0, 2000).catch(() => {});
      await sleep(1500);

      const cards = await page.$$(SEL.card);
      log(`    found ${cards.length} cards (capped at ${max})`);

      for (const card of cards.slice(0, max)) {
        let title = "", company = "", href = "";
        try {
          const tEl = await card.$(SEL.title);
          if (tEl) {
            title = (await tEl.innerText()).trim().split("\n")[0];
            href = (await tEl.getAttribute("href")) || "";
          }
        } catch {}
        try {
          const cEl = await card.$(SEL.company);
          if (cEl) company = (await cEl.innerText()).trim().split("\n")[0];
        } catch {}
        if (!title) continue;

        const jobUrl = href.startsWith("http") ? href.split("?")[0] : `https://www.linkedin.com${href.split("?")[0]}`;

        // Click to load the description panel.
        let desc = "";
        try {
          await card.click();
          await sleep(1800); // polite delay
          const dEl = await page.$(SEL.desc);
          if (dEl) desc = (await dEl.innerText()).trim();
        } catch {}

        out.push({
          source: "linkedin",
          title,
          company,
          url: jobUrl,
          location: search.location || "",
          text: `${title} at ${company}. ${desc}`,
        });
      }
      await sleep(2000); // pause between searches
    } catch (e) {
      log(`    LinkedIn search error: ${e.message}`);
    }
  }

  // de-dup by url
  const seen = new Set();
  return out.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));
}
