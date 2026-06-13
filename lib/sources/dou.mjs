// DOU job source via official RSS feeds (legal, structured, no scraping).
// Returns [{ source, title, company, url, location, text }]

function decodeEntities(s) {
  let out = s || "";
  // Two passes handle double-encoded entities (DOU emits e.g. "&amp;nbsp;", "&amp;amp;").
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }
  return out;
}

function stripHtml(s) {
  return decodeEntities(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
    const desc = stripHtml(tag(block, "description"));
    // DOU title format: "Role в Company, salary, location".
    // Split role/company on the LAST " в " (the role itself may contain " в " or commas,
    // e.g. "(Playwright, RestAssured)"), then parse only the remainder by commas.
    let title = rawTitle, company = "", location = "";
    const vIdx = rawTitle.lastIndexOf(" в ");
    if (vIdx !== -1) {
      title = rawTitle.slice(0, vIdx).trim();
      const rest = rawTitle.slice(vIdx + 3); // "Company, salary, location"
      const restParts = rest.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
      company = restParts[0] || "";
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
      const res = await fetch(feed, { headers: { "User-Agent": "Mozilla/5.0 (job-assistant)" } });
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
