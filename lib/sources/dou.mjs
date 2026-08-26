// DOU job source via official RSS feeds (legal, structured, no scraping).
// Returns [{ source, title, company, url, location, text }]

import { decodeEntities, stripHtml, FETCH_TIMEOUT } from "./html.mjs";

function tag(block, name) {
  // handles <name>..</name> and CDATA
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i");
  const m = block.match(re);
  if (!m) return "";
  return m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

export function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const rawTitle = decodeEntities(tag(block, "title"));
    const link = decodeEntities(tag(block, "link")).split("?")[0];
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
      // Location is always the LAST part; the company itself may contain commas
      // ("Маніфай, ТОВ"), so it is everything before the last one.
      const restParts = rest.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
      company = (restParts.length > 1 ? restParts.slice(0, -1) : restParts).join(", ");
      location = restParts.length > 1 ? restParts[restParts.length - 1] : "";
    }
    items.push({ source: "dou", title, company, url: link, location, text: `${rawTitle}. ${desc}` });
  }
  return items;
}

export async function fetchDou(config, log = console.log) {
  const out = [];
  if (!config?.enabled) return out;
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
