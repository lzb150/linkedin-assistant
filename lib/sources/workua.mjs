// Work.ua job source via the public jobs board (https://www.work.ua/).
// Server-rendered and readable with a plain fetch — no browser, no login,
// same shape as the Djinni source. Each config search is a full jobs-search
// URL (e.g. https://www.work.ua/jobs-qa+automation/ — copy from the browser).
// Returns [{ source, title, company, url, location, text }]
//
// Listing cards carry a 3-line snippet; by default we follow each job link and
// pull the full description from the detail page (`workua.fullDescription =
// false` skips the extra fetches and scores on the snippet only).

import { stripHtml, extractDiv, composeText, fetchText, pool, HEADERS } from "./html.mjs";

// Work.ua serves Ukrainian by default; ask for it explicitly so titles stay stable.
const WORKUA_HEADERS = { ...HEADERS, "Accept-Language": "uk-UA,uk;q=0.9,en;q=0.8" };

// Split the listing HTML into per-job card blocks. Work.ua wraps each result
// in <div ... class="card card-hover ... job-link ..."> preceded by
// <a name="ID">; a card runs until the next card (or EOF).
export function splitCards(html) {
  const cards = [];
  const re = /class="card card-hover[^"]*job-link[^"]*"/g;
  const starts = [];
  let m;
  while ((m = re.exec(html))) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    cards.push(html.slice(starts[i], starts[i + 1] ?? html.length));
  }
  return cards;
}

export function parseCard(card) {
  const href = (card.match(/href="(\/jobs\/\d+\/)"/) || [])[1];
  if (!href) return null;
  const url = `https://www.work.ua${href}`;

  const title = stripHtml((card.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || "");
  if (!title) return null;

  // Company row: <div class="text-indent"> with the company icon, then the
  // company name in <span class="strong-600"> and the location as the last
  // class-less <span> (sometimes with a leading ", ").
  const row = (card.match(/<div class="text-indent"><span[^>]*glyphicon-company[\s\S]*?<\/div>/i) || [])[0] || "";
  const company = stripHtml((row.match(/<span class="strong-600">([\s\S]*?)<\/span>/i) || [])[1] || "");
  const locSpans = [...row.matchAll(/<span class="">([\s\S]*?)<\/span>/gi)]
    .map((m) => stripHtml(m[1])).filter(Boolean);
  const location = (locSpans[locSpans.length - 1] || "").replace(/^,\s*/, "");

  // Truncated 3-line listing snippet.
  const snippet = stripHtml((card.match(/<p class="ellipsis[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "");

  const job = { source: "workua", title, company, url, location, snippet };
  job.text = composeText(job, snippet);
  return job;
}

// Fetch a job's detail page and return its full description text (or "" on
// any failure — the caller keeps the snippet as a fallback).
async function fetchDescription(url, log) {
  try {
    const html = await fetchText(url, log, "  Work.ua detail", WORKUA_HEADERS);
    return stripHtml(extractDiv(html, /<div[^>]*id="job-description"[^>]*>/i));
  } catch (e) {
    log(`    Work.ua detail error: ${url} — ${e.message}`);
    return "";
  }
}

export async function fetchWorkua(config, log = console.log) {
  let out = [];
  if (!config?.enabled) return out;
  const max = config.maxResults || 15;

  for (const search of config.searches || []) {
    try {
      const html = await fetchText(search, log, "Work.ua search", WORKUA_HEADERS);
      if (!html) continue;
      const jobs = splitCards(html).slice(0, max).map(parseCard).filter(Boolean);
      log(`  Work.ua search ok (${jobs.length}): ${search}`);
      out.push(...jobs);
    } catch (e) {
      log(`  Work.ua search error: ${search} — ${e.message}`);
    }
  }

  // de-dup by url within this fetch
  const seen = new Set();
  out = out.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));

  // Enrich with full descriptions from each detail page (default on).
  if (config.fullDescription !== false && out.length) {
    log(`  Work.ua: fetching ${out.length} full description(s)...`);
    let ok = 0;
    await pool(out, config.concurrency || 5, async (job) => {
      const full = await fetchDescription(job.url, log);
      if (full) { job.text = composeText(job, full); ok++; }
    });
    log(`  Work.ua: enriched ${ok}/${out.length} with full text`);
  }

  return out.map(({ snippet, ...job }) => job);
}
