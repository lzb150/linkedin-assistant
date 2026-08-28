// DOU job source via official RSS feeds (legal, structured, no scraping).
// Returns [{ source, title, company, url, location, text }]

import { decodeEntities, stripHtml, FETCH_TIMEOUT } from "./html.mjs";

function tag(block, name) {
  // handles <name>..</name> and CDATA. Two literal, case-insensitive searches
  // (no quantifiers) keep this linear — a lazy [\s\S]*? capture was O(n²) on a
  // feed full of unclosed openers.
  const open = block.search(new RegExp(`<${name}>`, "i"));
  if (open === -1) return "";
  const from = open + name.length + 2;
  const close = block.slice(from).search(new RegExp(`</${name}>`, "i"));
  if (close === -1) return "";
  const m = [null, block.slice(from, from + close)];
  return m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

const LEGAL_FORM = /^(ТОВ|ООО|ПП|ФОП|LLC|Inc\.?|Ltd\.?|Limited|GmbH|Corp\.?|S\.?A\.?|B\.?V\.?)$/i;
const SALARY = /[$€₴]|\d{3,}/;

export function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const rawTitle = decodeEntities(tag(block, "title"));
    const link = decodeEntities(tag(block, "link")).split("?")[0];
    // No link = no identity: a blank company + blank url would collapse every
    // such item into one "::title" key downstream (dedup, seen-set).
    if (!link) continue;
    // The description is XML-escaped HTML (&lt;p&gt;…): decode the transport
    // layer first, then strip the HTML layer.
    const desc = stripHtml(decodeEntities(tag(block, "description")));
    // DOU title format: "Role в Company, salary, location".
    // Split role/company on the LAST " в " (the role itself may contain " в " or commas,
    // e.g. "(Playwright, RestAssured)"), then parse only the remainder by commas.
    let title = rawTitle, company = "", location = "";
    const vIdx = rawTitle.lastIndexOf(" в ");
    if (vIdx !== -1) {
      title = rawTitle.slice(0, vIdx).trim();
      const rest = rawTitle.slice(vIdx + 3); // "Company, salary, location"
      // Format: "Company[, legal form][, salary], location[, location…]" — DOU
      // lists several cities ("Ciklum, Київ, Львів"), so the company is the
      // FIRST part (plus a trailing legal-form token like "ТОВ"), salary-looking
      // parts are dropped, and everything left is the location list.
      const restParts = rest.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
      const companyParts = [restParts[0]];
      if (LEGAL_FORM.test(restParts[1] || "")) companyParts.push(restParts[1]);
      company = companyParts.join(", ");
      location = restParts.slice(companyParts.length).filter((p) => !SALARY.test(p)).join(", ");
    }
    items.push({ source: "dou", title, company, url: link, location, text: `${rawTitle}. ${desc}` });
  }
  return items;
}

export async function fetchDou(config, log = console.log) {
  const out = [];
  if (config?.enabled === false) return out; // DOU is on unless explicitly disabled (matches jobs.mjs)
  for (const feed of config.feeds || []) {
    try {
      const res = await fetch(feed, {
        headers: { "User-Agent": "Mozilla/5.0 (job-assistant)" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (!res.ok) { log(`  DOU feed ${res.status}: ${feed}`); continue; }
      const xml = await res.text();
      const items = parseRss(xml);
      log(`  DOU feed ok (${items.length}): ${feed}`);
      out.push(...items);
    } catch (e) {
      log(`  DOU feed error: ${feed} — ${e.message}`);
    }
  }
  // de-dup by url within this fetch
  const seen = new Set();
  return out.filter((j) => (seen.has(j.url) ? false : (seen.add(j.url), true)));
}
