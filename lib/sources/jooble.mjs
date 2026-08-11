// Jooble job source via the official Jooble API (https://jooble.org/api/about).
// Jooble's site is behind Cloudflare, so plain scraping is blocked — the API is
// the supported, structured path. It needs a free API key, read from the
// JOOBLE_API_KEY env var so the secret never lands in the tracked config.
//
// POST https://{host}/api/{KEY}  body: { keywords, location, ResultOnPage, page }
// Response: { totalCount, jobs: [{ title, company, location, snippet, salary,
//             source, type, link, updated, id }] }
// Returns [{ source, title, company, url, location, text }]

import { stripHtml } from "./html.mjs";

// The Ukrainian Jooble market also carries relocation vacancies physically
// located abroad ("Краків, Польща", "за кордоном"). config.excludeLocation
// lists case-insensitive substrings that drop such jobs before scoring.
export function filterByLocation(jobs, excludeLocation) {
  if (!excludeLocation?.length) return jobs;
  const patterns = excludeLocation.map((s) => String(s).toLowerCase());
  return jobs.filter((j) => {
    const loc = (j.location || "").toLowerCase();
    return !patterns.some((p) => loc.includes(p));
  });
}

// Pure mapper from a Jooble API response to our normalized job records.
// Slice to `max` first, then map, then drop anything without a title or url.
export function mapJoobleJobs(data, max) {
  return (data.jobs || []).slice(0, max).map((j) => {
    const title = stripHtml(j.title || "");
    const company = stripHtml(j.company || "");
    const location = stripHtml(j.location || "");
    const snippet = stripHtml(j.snippet || "");
    return {
      source: "jooble",
      title,
      company,
      url: (j.link || "").split("?")[0],
      location,
      text: `${title}${company ? ` at ${company}` : ""}. ${location}. ${snippet}`.trim(),
    };
  }).filter((j) => j.title && j.url);
}

export async function fetchJooble(config, log = console.log) {
  const out = [];
  if (!config?.enabled) return out;

  const key = process.env.JOOBLE_API_KEY;
  if (!key) {
    log("  Jooble enabled but JOOBLE_API_KEY is not set — skipping. Get a free key at jooble.org/api/about");
    return out;
  }

  const host = config.apiHost || "jooble.org";
  const endpoint = `https://${host}/api/${key}`;
  const max = config.maxResults || 15;

  for (const search of config.searches || []) {
    const label = `${search.keywords || ""}${search.location ? ` / ${search.location}` : ""}`;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
        },
        body: JSON.stringify({
          keywords: search.keywords || "",
          location: search.location || "",
          ResultOnPage: max,
          page: "1",
        }),
      });
      if (!res.ok) { log(`  Jooble search ${res.status}: ${label}`); continue; }

      let data;
      try { data = await res.json(); }
      catch { log(`  Jooble search: non-JSON response (likely a Cloudflare/HTML block): ${label}`); continue; }

      const mapped = mapJoobleJobs(data, max);
      const jobs = filterByLocation(mapped, config.excludeLocation);
      const dropped = mapped.length - jobs.length;

      log(`  Jooble search ok (${jobs.length}${dropped ? `, ${dropped} foreign-location dropped` : ""}): ${label}`);
      out.push(...jobs);
    } catch (e) {
      log(`  Jooble search error: ${label} — ${e.message}`);
    }
  }

  // de-dup by url within this fetch
  const seen = new Set();
  return out.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));
}
