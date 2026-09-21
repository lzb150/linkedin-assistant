// Djinni job source via the public jobs board (https://djinni.co/jobs/).
// The board is server-rendered and readable with a plain fetch — no browser
// and no login needed, just like the DOU RSS source. Each config search is a
// full Djinni jobs-search URL (copy them straight from your browser's filters).
// Returns [{ source, title, company, url, location, text }]
//
// Listing cards only carry a truncated description snippet, which starves the
// relevance scorer. By default we follow each job link and pull the full
// description from the detail page (set `djinni.fullDescription = false` to skip
// the extra fetches and score on the snippet only). `skip(job)` (jobs.mjs: seen
// store / excluded title) exempts known jobs from that fetch.
//
// Djinni does not list newest-first (bumped and months-old postings share page
// 1, sort params are ignored), so a fresh vacancy can sit on page 2 for its
// whole life: 847039 @ DevPulse, posted 2026-09-07, was never on page 1 during
// any hourly run. Each search therefore reads `pages` pages (default 3).

import { stripHtml, extractDivByClass, composeText, fetchText, pool, uniqueByUrl } from "./html.mjs";
import { numberIn, knob } from "../filters.mjs";

// Split the listing HTML into per-job card blocks. Djinni wraps each result in
// <div id="job-item-NNN" ...>; a card runs until the next job-item id (or EOF).
export function splitCards(html) {
  const cards = [];
  const re = /id=["']job-item-(\d+)["']/g;
  const starts = [];
  let m;
  while ((m = re.exec(html))) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    cards.push(html.slice(starts[i], starts[i + 1] ?? html.length));
  }
  return cards;
}

export function parseCard(card) {
  const href = (card.match(/href=["'](\/jobs\/\d+[^"']*)["']/) || [])[1];
  if (!href) return null;
  const url = `https://djinni.co${href.split("?")[0]}`;

  const title = stripHtml((card.match(/<h2[^>]{0,2048}class=["']job-item__position[^"']{0,512}["'][^>]{0,2048}>([\s\S]{0,4096}?)<\/h2>/i) || [])[1] || "");
  if (!title) return null;

  // Captures are bounded (like the title regex above): an unclosed tag in a
  // 1 MB card must not make the lazy quantifier scan quadratically.
  const company = stripHtml(
    (card.match(/<span class=["']small text-gray-800[^"']{0,512}["']>([\s\S]{0,4096}?)<\/span>/i) || [])[1] || ""
  );

  // Metadata line: "Тільки віддалено · Країни Європи та Україна · N років досвіду · ...".
  // The block nests <span>/<div> children, so use the depth-aware extractor.
  const metaBlock = extractDivByClass(card, "fw-medium d-flex flex-wrap");
  const location = stripHtml(metaBlock).replace(/\s*·\s*/g, " · ");

  // Truncated listing snippet — used as-is unless we fetch the full description.
  const snippet = stripHtml((card.match(/<span class=["']js-truncated-text["']>([\s\S]{0,4096}?)<\/span>/i) || [])[1] || "");

  const job = { source: "djinni", title, company, url, location, snippet };
  job.text = composeText(job, snippet);
  return job;
}

// Fetch a job's detail page and return its full description text (or "" on
// any failure — the caller keeps the snippet as a fallback).
async function fetchDescription(url, log) {
  try {
    const html = await fetchText(url, log, "  Djinni detail");
    return stripHtml(extractDivByClass(html, "job-post__description"));
  } catch (e) {
    log(`    Djinni detail error: ${url} — ${e.message}`);
    return "";
  }
}

// Searches run concurrently; kept low because each one still walks up to
// `pages` pages of its own, and the detail-page enrichment below adds more.
const SEARCH_CONCURRENCY = 3;
const pageUrl = (search, p) => (p === 1 ? search : `${search}${search.includes("?") ? "&" : "?"}page=${p}`);

export async function fetchDjinni(config, log = console.log, { skip = () => false } = {}) {
  let out = [];
  if (!config?.enabled) return out;
  const max = numberIn(config.maxResults, 15, [1, Infinity]);   // per page (Djinni's page size is 15)
  const pages = knob("djinni.pages", config.pages, 3, [1, Infinity], log);

  // The searches are independent of each other, so they run through the shared
  // pool; the pages WITHIN one search stay sequential, because page p+1 is only
  // worth fetching when page p came back non-empty. Each search collects its own
  // jobs and log lines, replayed in config order once the pool drains, so the
  // returned list and the log read exactly as they did when this was a plain
  // loop — jobs.mjs spends its LLM budget (llm.maxPerRun) in list order.
  const searches = config.searches || [];
  const found = searches.map(() => []);
  const lines = searches.map(() => []);
  await pool(searches.map((_, i) => i), SEARCH_CONCURRENCY, async (i) => {
    const search = searches[i];
    const say = (line) => lines[i].push(line);
    try {
      let n = 0, read = 0, cut = "";   // `read` counts pages that actually yielded jobs, not the one we broke on
      for (let p = 1; p <= pages; p++) {
        const html = await fetchText(pageUrl(search, p), say, "Djinni search");
        // "" is a failed fetch (429, 503, timeout), not the end of the results.
        // Both used to break the same way and still log "ok", so a rate-limited
        // search reported a clean short read and the drop went unnoticed.
        if (!html) { cut = ` — stopped at page ${p}: fetch failed`; break; }
        const jobs = splitCards(html).slice(0, max).map(parseCard).filter(Boolean);
        if (!jobs.length) break;   // past the last page
        found[i].push(...jobs); n += jobs.length; read++;
      }
      say(`  Djinni search ${cut ? "partial" : "ok"} (${n} over ${read} page${read === 1 ? "" : "s"}): ${search}${cut}`);
    } catch (e) {
      say(`  Djinni search error: ${search} — ${e.message}`);
    }
  });
  for (const line of lines.flat()) log(line);
  out = uniqueByUrl(found.flat());

  // Enrich with full descriptions from each detail page (default on) — only for
  // jobs the caller does not already know; the known ones are returned with
  // their snippet so the seen store still re-stamps them. Bounded concurrency
  // keeps it polite while staying much faster than one-at-a-time.
  const toEnrich = out.filter((job) => !skip(job));
  if (config.fullDescription !== false && toEnrich.length) {
    log(`  Djinni: fetching ${toEnrich.length} full description(s)${out.length > toEnrich.length ? ` (${out.length - toEnrich.length} already known — skipped)` : ""}...`);
    let ok = 0;
    await pool(toEnrich, knob("djinni.concurrency", config.concurrency, 5, [1, Infinity], log), async (job) => {
      const full = await fetchDescription(job.url, log);
      if (full) { job.text = composeText(job, full); ok++; }
    });
    log(`  Djinni: enriched ${ok}/${toEnrich.length} with full text`);
  }

  // Drop the internal snippet field before returning.
  return out.map(({ snippet, ...job }) => job);
}
