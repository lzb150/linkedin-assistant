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

import { stripHtml, oneLine, extractDivByClass, composeText, fetchText, pagedSearch, enrich, isoDate } from "./html.mjs";
import { knob } from "../filters.mjs";

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

// Inner HTML of the first <tag> whose OWN tag carries `cls`.
// The single regex this replaces walked up to 2048 chars looking for `class=`
// at every "<h2", so a card whose class never matches cost ~1.3 s per MB —
// 6.4 s of blocked event loop on a body at the 5 MB cap. Same shape as
// extractDivByClass: bound the scan to the tag itself, then jump past it, which
// makes the work proportional to the number of tags rather than to their
// distance from a match.
function innerByTagClass(html, tag, cls) {
  const open = new RegExp(`<${tag}\\b`, "gi");
  let m;
  while ((m = open.exec(html))) {
    const gt = html.indexOf(">", m.index);
    if (gt === -1) break;                                  // unterminated tag: nothing usable follows
    if (html.slice(m.index, gt).includes(cls)) {
      const close = html.indexOf(`</${tag}`, gt);
      return close === -1 ? "" : html.slice(gt + 1, close);
    }
    open.lastIndex = gt + 1;                               // never rescan inside a tag we rejected
  }
  return "";
}

// Card field captures are bounded: an unclosed tag in a 1 MB card must not
// make the lazy quantifier scan quadratically.
const companyOf = (card) => oneLine(stripHtml(
  (card.match(/<span class=["']small text-gray-800[^"']{0,512}["']>([\s\S]{0,4096}?)<\/span>/i) || [])[1] || ""
));

// Truncated listing snippet — used as-is unless we fetch the full description.
const snippetOf = (card) => stripHtml((card.match(/<span class=["']js-truncated-text["']>([\s\S]{0,4096}?)<\/span>/i) || [])[1] || "");

// The listing's only stamp, the tooltip "18:51 27.10.2026" beside "оновлено 4 год. тому", is the
// last UPDATE: a bump re-stamps it, so a vacancy posted weeks ago read as posted today. The detail
// page states both dates: "Опубліковано 1 жовтня · Оновлено 30 жовтня" (live, 2026-10-30, whatever
// Accept-Language says) or "Published 9 March · Updated 12 June" (an older capture). The first one is
// the posting date, at Kyiv midnight; it names no year unless the posting is from an earlier one, so
// a bare date takes the latest year that does not put it in the future.
const MONTHS = {
  січня: 1, лютого: 2, березня: 3, квітня: 4, травня: 5, червня: 6, липня: 7, серпня: 8, вересня: 9, жовтня: 10, листопада: 11, грудня: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export function publishedOf(html, now = Date.now()) {
  const at = html.indexOf("job-publication-info");
  if (at < 0) return undefined;
  const m = /(?:Опубліковано|Published)\s+(\d{1,2})\s+(\p{L}+)(?:\s+(\d{4}))?/iu.exec(html.slice(at, at + 1000));
  const month = m && MONTHS[m[2].toLowerCase()];
  if (!month) return undefined;
  const on = (year) => isoDate(`00:00 ${m[1].padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`, now);
  if (m[3]) return on(m[3]);
  // Kyiv's year, not UTC's: in the first two hours of 1 January a bare "1 січня" is this year's.
  // New Year always falls in winter time (UTC+2), and the year changes at no other moment.
  const year = new Date(now + 2 * 3_600_000).getUTCFullYear();
  return on(year) ?? on(year - 1);
}

export function parseCard(card) {
  const href = (card.match(/href=["'](\/jobs\/\d+[^"']*)["']/) || [])[1];
  if (!href) return null;
  const url = `https://djinni.co${href.split("?")[0]}`;

  // oneLine on every field that reaches a log line: stripHtml's \s+ collapse
  // keeps C0 controls and bidi overrides (see html.mjs).
  const title = oneLine(stripHtml(innerByTagClass(card, "h2", "job-item__position")));
  if (!title) return null;
  const company = companyOf(card);

  // Metadata line: "Тільки віддалено · Країни Європи та Україна · N років досвіду · ...".
  // The block nests <span>/<div> children, so use the depth-aware extractor.
  const metaBlock = extractDivByClass(card, "fw-medium d-flex flex-wrap");
  const location = oneLine(stripHtml(metaBlock)).replace(/\s*·\s*/g, " · ");

  const snippet = snippetOf(card);
  const job = { source: "djinni", title, company, url, location, snippet };
  job.text = composeText(job, snippet);
  return job;
}

// Searches run concurrently; kept low because each one still walks up to
// `pages` pages of its own, and the detail-page enrichment below adds more.
const SEARCH_CONCURRENCY = 3;
const pageUrl = (search, p) => (p === 1 ? search : `${search}${search.includes("?") ? "&" : "?"}page=${p}`);
// Past a search's last page Djinni does not serve an empty page: it 302s to
// /jobs/, the unfiltered all-jobs listing, which used to be read as this
// search's page N — up to 15 off-search vacancies (recruiters, marketers) per
// search per run. A redirect that drops our page number is the end.
const leftPage = (p) => (url) => new URL(url).searchParams.get("page") !== String(p);

// Page `p` of one search, answered the way pagedSearch (html.mjs) reads it:
// its first `max` cards, a cut, or null past the last page.
async function readPage(search, p, say, { max, doFetch }) {
  const html = await fetchText(pageUrl(search, p), say, "Djinni search", { doFetch, ...(p > 1 ? { stopAt: leftPage(p) } : {}) });
  if (html === null) return null;   // redirected off this page number: past the last page
  // "" is a failed fetch (429, 503, timeout), not the end of the results.
  // Both used to break the same way and still log "ok", so a rate-limited
  // search reported a clean short read and the drop went unnoticed.
  if (!html) return { cut: "fetch failed" };
  const cards = splitCards(html);
  const items = cards.slice(0, max).map(parseCard).filter(Boolean);
  // Cards that split but none that parsed is the title or href markup renamed,
  // not the end of the results: read as "past the last page" it logged a clean
  // "ok (0 over 0 pages)" for every search, and the outage throw (pagedSearch)
  // could never fire — only the source-health median noticed, a run later.
  if (cards.length && !items.length) return { cut: "no parsable cards (Djinni markup changed?)" };
  return items.length ? { items } : null;   // an empty page is past the last page, and is not counted as read
}

// Same options bag as every source (see jobs.mjs).
export async function fetchDjinni(config, log = console.log, { skip = () => false, doFetch } = {}) {
  if (!config?.enabled) return [];
  const max = knob("djinni.maxResults", config.maxResults, 15, [1, Infinity], log);   // per page (Djinni's page size is 15)
  const pages = knob("djinni.pages", config.pages, 3, [1, Infinity], log);

  // The shared paged-search loop (html.mjs): searches in parallel, the pages
  // within one sequential, jobs and log lines in config order.
  const out = await pagedSearch(config.searches || [], {
    limit: SEARCH_CONCURRENCY, pages, label: "Djinni search", plural: "Djinni search(es)",
    page: (search, p, say) => readPage(search, p, say, { max, doFetch }),
  }, log);

  // Enrich with full descriptions from each detail page (default on) — only for
  // jobs the caller does not already know; the known ones are returned with
  // their snippet so the seen store still re-stamps them.
  if (config.fullDescription !== false) {
    await enrich(out, {
      label: "Djinni detail", skip, doFetch,
      limit: knob("djinni.concurrency", config.concurrency, 5, [1, Infinity], log),
      fetching: (n, known) => `  Djinni: fetching ${n} full description(s)${known ? ` (${known} already known — skipped)` : ""}...`,
      enriched: (ok, n) => `  Djinni: enriched ${ok}/${n} with full text`,
      url: (job) => job.url,
      extract: (html) => stripHtml(extractDivByClass(html, "job-post__description")),
      fields: (html) => { const posted = publishedOf(html); return posted ? { posted } : {}; },
      text: (job, full) => composeText(job, full),
    }, log);
  }

  // Drop the internal snippet field before returning.
  return out.map(({ snippet, ...job }) => job);
}
