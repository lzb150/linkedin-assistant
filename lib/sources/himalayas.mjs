// Himalayas job source via its free public JSON API
// (https://himalayas.app/docs/remote-jobs-api): remote-only roles from foreign
// employers, read with a plain fetch — no key, no login, no browser. The
// search endpoint filters by the candidate's country server-side (`country`,
// the first `candidateCountry` entry), so it returns jobs open to that country
// or to the whole world; jobs.mjs still re-checks the countries segment, like
// Djinni's. Each config search is a free-text query; results come newest-first
// (sort=recent), up to 20 per page, `pages` pages per search (default 2).
// Returns [{ source, title, company, url, location, text }]
//
// Measured 2026-10-17: 26 relevant QA roles open to Ukraine over ~7 weeks, 21
// of which DOU, Djinni and LinkedIn never surfaced.

import { stripHtml, oneLine, composeText, fetchText, pagedSearch, isoDate } from "./html.mjs";
import { knob } from "../filters.mjs";

// Test seam: HIMALAYAS_API points the source at a local server (the pipeline test).
const API = process.env.HIMALAYAS_API || "https://himalayas.app/jobs/api/search";
// Each search is a handful of small JSON pages; two at a time stays polite on
// the keyless rate limit.
const SEARCH_CONCURRENCY = 2;

export function searchUrl(query, country, page = 1) {
  const u = new URL(API);
  u.searchParams.set("q", query);
  if (country) u.searchParams.set("country", country);
  u.searchParams.set("sort", "recent");
  if (page > 1) u.searchParams.set("page", String(page));
  return u.toString();
}

// One API job → the shared record. The location reads "Remote · <countries>"
// so filterByLocation judges it with the same countries-segment rule as
// Djinni's; no restriction at all means open worldwide.
export function toJob(j) {
  const link = [j?.guid, j?.applicationLink].find((u) => typeof u === "string" && /^https:\/\//i.test(u));
  // oneLine on every field that reaches a log line (see html.mjs).
  const title = oneLine(j?.title);
  if (!link || !title) return null;   // no identity: would collapse into one "::title" key downstream
  const countries = (Array.isArray(j.locationRestrictions) ? j.locationRestrictions : [])
    .map((c) => oneLine(typeof c === "string" ? c : c?.name)).filter(Boolean);
  const posted = isoDate(j.pubDate);   // unix seconds
  const job = { source: "himalayas", title, company: oneLine(j.companyName), url: link, location: `Remote · ${countries.join(", ") || "Worldwide"}`, ...(posted ? { posted } : {}) };
  job.text = composeText(job, stripHtml(j.description || j.excerpt || ""));
  return job;
}

// null = not a jobs response at all (an HTML error page, a changed API), which
// the caller reports; [] = a real, empty page.
export function parseResponse(body) {
  let data;
  try { data = JSON.parse(body); } catch { return null; }
  return Array.isArray(data?.jobs) ? data.jobs.map(toJob).filter(Boolean) : null;
}

// Same options bag as every source (see jobs.mjs): `countries` is candidateCountry,
// of which the API takes the first (English) entry.
export async function fetchHimalayas(config, log = console.log, { countries = [], doFetch } = {}) {
  const country = countries[0];
  if (!config?.enabled) return [];
  const pages = knob("himalayas.pages", config.pages, 2, [1, Infinity], log);
  // The shared paged-search loop (html.mjs); every search failing (network
  // down, API gone) is an outage it throws.
  return pagedSearch(config.searches || [], {
    limit: SEARCH_CONCURRENCY, pages, label: "Himalayas search", plural: "Himalayas search(es)",
    page: async (query, p, say) => {
      const body = await fetchText(searchUrl(query, country, p), say, "Himalayas search", { doFetch });
      const items = body ? parseResponse(body) : null;
      if (!items) return { cut: body ? "not a jobs response" : "fetch failed" };
      // The API may return a short page before the end, so only an empty one ends the search.
      return items.length ? { items } : null;
    },
  }, log);
}
