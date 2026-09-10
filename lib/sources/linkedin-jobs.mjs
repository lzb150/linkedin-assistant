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
// Even so, single searches took 368–1887 s in production: some await in the
// loop hangs past every per-action timeout. A wall-clock deadline per search
// keeps what was gathered and moves on; the next goto() destroys the hung
// call's execution context, and the `expired` check stops the stale loop.
const SEARCH_TIMEOUT = 180_000;

// Runs inside the page: pull everything we need from one card in one round trip.
function readCard(card, SEL) {
  const first = (sel) => card.querySelector(sel);
  const text = (el) => ((el && el.innerText) || "").trim().split("\n")[0];
  const tEl = first(SEL.title);
  let location = "";
  for (const lEl of card.querySelectorAll(SEL.location)) { location = text(lEl); if (location) break; }
  return { title: text(tEl), href: (tEl && tEl.getAttribute("href")) || "", company: text(first(SEL.company)), location };
}

export async function fetchLinkedInJobs(page, config, log = console.log, { sleep = defaultSleep, searchTimeoutMs = SEARCH_TIMEOUT } = {}) {
  const out = [];
  const max = config.maxResults || 8;

  for (const search of config.searches || []) {
    const url = buildUrl(search);
    const t0 = Date.now();
    log(`  LinkedIn search: ${search.keywords} / ${search.location}${search.remote ? " (remote)" : ""}`);
    // One flag set by the timer itself (not a Date.now() comparison: the timer
    // clock and Date.now() disagree by a millisecond, enough for a stale loop
    // to pass a "not expired yet" check after the deadline already fired).
    let timedOut = false, timer;
    const expired = () => timedOut;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`search deadline ${Math.round(searchTimeoutMs / 1000)}s exceeded — keeping what was gathered`));
      }, searchTimeoutMs);
    });
    const scan = async () => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(2500);
      // scroll a bit to load cards
      await page.mouse.wheel(0, 2000).catch(() => {});
      await sleep(1500);

      // LinkedIn virtualises the list: only cards near the viewport carry
      // content, so one pass rarely yields maxResults. Work in rounds — read
      // every card (one cheap evaluate each), click the new unique ones, then
      // scroll the last card into view to render the next batch. Stop at the
      // cap, or after two rounds that surfaced nothing new (end of the page).
      // SEL.card also matches both the <li> and its inner .job-card-container,
      // so the by-url set doubles as the duplicate filter — duplicates are
      // never clicked.
      const urls = new Set();
      let taken = 0, stagnant = 0, rounds = 0, cardCount = 0;
      while (taken < max && stagnant < 2 && !expired()) {
        const cards = await page.$$(SEL.card);
        cardCount = cards.length;
        let added = 0;
        for (const card of cards) {
          if (taken >= max || expired()) break;
          let fields;
          try { fields = await card.evaluate(readCard, SEL); } catch { continue; }
          // No href → jobUrl would collapse to bare "https://www.linkedin.com".
          if (!fields.title || !fields.href) continue;
          const jobUrl = fields.href.startsWith("http") ? fields.href.split("?")[0] : `https://www.linkedin.com${fields.href.split("?")[0]}`;
          if (urls.has(jobUrl)) continue;
          urls.add(jobUrl);
          added++; taken++;

          // Click to load the description panel. Re-check the deadline here:
          // the evaluate above may have crossed it, and a stale loop must not
          // click a card on the next search's page.
          if (expired()) break;
          let desc = "";
          try {
            await card.click({ timeout: ACTION_TIMEOUT });
            await sleep(1800); // polite delay
            desc = (await page.locator(SEL.desc).first().innerText({ timeout: ACTION_TIMEOUT })).trim();
          } catch {}

          // The card's own location (a search for "Ukraine" returns Kyiv, Lviv,
          // Remote…); the search location is only the fallback.
          const location = fields.location || search.location || "";
          out.push({
            source: "linkedin",
            title: fields.title,
            company: fields.company,
            url: jobUrl,
            location,
            // same shape as the other sources so location terms can score
            text: `${fields.title} at ${fields.company}. ${location}. ${desc}`,
          });
        }
        stagnant = added ? 0 : stagnant + 1;
        if (taken >= max || stagnant >= 2 || expired()) break;
        rounds++;
        // Scroll the list (not the window: the results pane is its own scroller).
        await cards.at(-1)?.evaluate((el) => el.scrollIntoView({ block: "end" })).catch(() => {});
        await sleep(1500);
      }
      log(`    found ${cardCount} cards, ${taken} unique after ${rounds} scroll(s) (capped at ${max})`);
      await sleep(2000); // pause between searches
    };
    try {
      await Promise.race([scan(), deadline]);
    } catch (e) {
      log(`    LinkedIn search error: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    log(`    search took ${Math.round((Date.now() - t0) / 1000)}s`);
  }

  // de-dup by url
  const seen = new Set();
  return out.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));
}
