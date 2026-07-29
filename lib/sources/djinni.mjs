// Djinni job source via the public jobs board (https://djinni.co/jobs/).
// The board is server-rendered and readable with a plain fetch — no browser
// and no login needed, just like the DOU RSS source. Each config search is a
// full Djinni jobs-search URL (copy them straight from your browser's filters).
// Returns [{ source, title, company, url, location, text }]
//
// Listing cards only carry a truncated description snippet, which starves the
// relevance scorer. By default we follow each job link and pull the full
// description from the detail page (set `djinni.fullDescription = false` to skip
// the extra fetches and score on the snippet only).

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

import { stripHtml } from "./html.mjs";

// Split the listing HTML into per-job card blocks. Djinni wraps each result in
// <div id="job-item-NNN" ...>; a card runs until the next job-item id (or EOF).
export function splitCards(html) {
  const cards = [];
  const re = /id="job-item-(\d+)"/g;
  const starts = [];
  let m;
  while ((m = re.exec(html))) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    cards.push(html.slice(starts[i], starts[i + 1] ?? html.length));
  }
  return cards;
}

// Extract the inner HTML of the first <div> whose class contains `className`,
// counting nested <div>s so we capture the whole block (the description body
// holds nested <p>/<ul>/<div> markup that a non-greedy regex would cut short).
export function extractDivByClass(html, className) {
  const open = new RegExp(`<div[^>]*class="[^"]*${className}[^"]*"[^>]*>`, "i");
  const m = open.exec(html);
  if (!m) return "";
  let depth = 1;
  const tag = /<\/?div\b[^>]*>/gi;
  tag.lastIndex = m.index + m[0].length;
  let t;
  while ((t = tag.exec(html))) {
    depth += t[0][1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(m.index + m[0].length, t.index);
  }
  return html.slice(m.index + m[0].length);
}

// Build the text blob the relevance scorer sees: title + company + metadata,
// followed by the best description we have (full detail-page body if fetched,
// otherwise the listing snippet).
function composeText(job, description) {
  return `${job.title}${job.company ? ` at ${job.company}` : ""}. ${job.location}. ${description}`.trim();
}

export function parseCard(card) {
  const href = (card.match(/href="(\/jobs\/\d+[^"]*)"/) || [])[1];
  if (!href) return null;
  const url = `https://djinni.co${href.split("?")[0]}`;

  const title = stripHtml((card.match(/<h2[^>]*class="job-item__position[^"]*"[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || "");
  if (!title) return null;

  const company = stripHtml(
    (card.match(/<span class="small text-gray-800[^"]*">([\s\S]*?)<\/span>/i) || [])[1] || ""
  );

  // Metadata line: "Тільки віддалено · Країни Європи та Україна · N років досвіду · ...".
  const metaBlock = (card.match(/<div class="fw-medium d-flex flex-wrap[^"]*">([\s\S]*?)<\/div>/i) || [])[1] || "";
  const location = stripHtml(metaBlock).replace(/\s*·\s*/g, " · ");

  // Truncated listing snippet — used as-is unless we fetch the full description.
  const snippet = stripHtml((card.match(/<span class="js-truncated-text">([\s\S]*?)<\/span>/i) || [])[1] || "");

  const job = { source: "djinni", title, company, url, location, snippet };
  job.text = composeText(job, snippet);
  return job;
}

// Fetch a job's detail page and return its full description text (or "" on
// any failure — the caller keeps the snippet as a fallback).
async function fetchDescription(url, log) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) { log(`    Djinni detail ${res.status}: ${url}`); return ""; }
    const html = await res.text();
    return stripHtml(extractDivByClass(html, "job-post__description"));
  } catch (e) {
    log(`    Djinni detail error: ${url} — ${e.message}`);
    return "";
  }
}

// Run `worker` over `items` with at most `limit` in flight at once.
async function pool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

export async function fetchDjinni(config, log = console.log) {
  let out = [];
  if (!config?.enabled) return out;
  const max = config.maxResults || 15;

  for (const search of config.searches || []) {
    try {
      const res = await fetch(search, { headers: HEADERS });
      if (!res.ok) { log(`  Djinni search ${res.status}: ${search}`); continue; }
      const html = await res.text();
      const jobs = splitCards(html).slice(0, max).map(parseCard).filter(Boolean);
      log(`  Djinni search ok (${jobs.length}): ${search}`);
      out.push(...jobs);
    } catch (e) {
      log(`  Djinni search error: ${search} — ${e.message}`);
    }
  }

  // de-dup by url within this fetch
  const seen = new Set();
  out = out.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));

  // Enrich with full descriptions from each detail page (default on). Bounded
  // concurrency keeps it polite while staying much faster than one-at-a-time.
  if (config.fullDescription !== false && out.length) {
    log(`  Djinni: fetching ${out.length} full description(s)...`);
    let ok = 0;
    await pool(out, config.concurrency || 5, async (job) => {
      const full = await fetchDescription(job.url, log);
      if (full) { job.text = composeText(job, full); ok++; }
    });
    log(`  Djinni: enriched ${ok}/${out.length} with full text`);
  }

  // Drop the internal snippet field before returning.
  return out.map(({ snippet, ...job }) => job);
}
