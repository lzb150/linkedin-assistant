// Robota.ua job source via the shared Playwright browser (the site sits behind
// Cloudflare, so plain fetch gets 403 — and headless Chrome is hard-blocked
// too, so this source only yields results on HEADFUL=1 runs). No login needed.
// Takes an existing Playwright `page`, like the LinkedIn source.
// Each config search is a full search URL
// (e.g. https://robota.ua/zapros/qa-automation/ukraine — copy from the browser).
// Returns [{ source, title, company, url, location, text }]

const SEL = {
  // Angular SPA; result cards are <a class="card ..."> (centralized for easy fixing)
  card: "a.card",
  title: "h2",
  company: "span.santa-mr-20",
  // vacancy detail page container; recommendations are stripped before reading
  detail: "alliance-jobseeker-vacancy-page",
  detailNoise: "alliance-recommended-vacancy-list",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Squash SPA innerText (icons, buttons, blank lines) into one scoring blob.
export function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

export async function fetchRobota(page, config, log = console.log) {
  const out = [];
  if (!config?.enabled) return out;
  const max = config.maxResults || 10;

  for (const search of config.searches || []) {
    log(`  Robota.ua search: ${search}`);
    try {
      await page.goto(search, { waitUntil: "domcontentloaded", timeout: 30000 });
      // Cloudflare hard-blocks headless Chrome outright — fail fast with a hint
      // instead of waiting out the card selector timeout on every search.
      if (/cloudflare|attention required/i.test(await page.title())) {
        log("  ⚠️  Robota.ua blocked by Cloudflare (headless is rejected) — run with HEADFUL=1 to include this source.");
        return out;
      }
      await page.waitForSelector(SEL.card, { timeout: 15000 });
      await sleep(1000); // let the list settle

      const cards = await page.$$eval(SEL.card, (els, sel) =>
        els.map((el) => {
          const row = el.querySelector("div.santa-flex.santa-items-center " + sel.company)?.closest("div");
          const spans = row ? [...row.querySelectorAll("span")].map((s) => s.innerText.trim()).filter(Boolean) : [];
          return {
            href: el.getAttribute("href") || "",
            title: el.querySelector(sel.title)?.innerText.trim() || "",
            company: spans[0] || "",
            location: spans[1] || "",
            snippet: el.innerText || "",
          };
        }), SEL);

      let n = 0;
      for (const c of cards) {
        if (!c.title || !c.href || n >= max) continue;
        n++;
        out.push({
          source: "robota",
          title: c.title,
          company: c.company,
          url: `https://robota.ua${c.href.split("?")[0]}`,
          location: c.location,
          text: cleanText(`${c.title} at ${c.company}. ${c.location}. ${c.snippet}`),
        });
      }
      log(`    found ${cards.length} cards (kept ${n}, capped at ${max})`);
      await sleep(1500); // polite pause between searches
    } catch (e) {
      log(`  Robota.ua search error: ${search} — ${e.message}`);
    }
  }

  // de-dup by url within this fetch
  const seen = new Set();
  const jobs = out.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));

  // Enrich with the full vacancy page text (default on). Card snippets are
  // short and starve the relevance scorer, same trade-off as Djinni/Work.ua.
  if (config.fullDescription !== false && jobs.length) {
    log(`  Robota.ua: fetching ${jobs.length} full description(s)...`);
    let ok = 0;
    for (const job of jobs) {
      try {
        await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForSelector(SEL.detail, { timeout: 15000 });
        await sleep(800);
        const full = await page.$eval(SEL.detail, (el, noiseSel) => {
          const clone = el.cloneNode(true);
          clone.querySelectorAll(noiseSel).forEach((n) => n.remove());
          return clone.innerText || "";
        }, SEL.detailNoise);
        if (full) { job.text = cleanText(`${job.title} at ${job.company}. ${job.location}. ${full}`); ok++; }
        await sleep(1000); // polite delay between vacancy pages
      } catch (e) {
        log(`    Robota.ua detail error: ${job.url} — ${e.message}`);
      }
    }
    log(`  Robota.ua: enriched ${ok}/${jobs.length} with full text`);
  }

  return jobs;
}
