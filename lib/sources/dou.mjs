// DOU job source via official RSS feeds (legal, structured, no scraping).
// Returns [{ source, title, company, url, location, text }]

import { decodeEntities, stripHtml, fetchText, uniqueByUrl, oneLine, orderedPool, isoDate } from "./html.mjs";

function tag(block, name) {
  // handles <name>..</name> and CDATA. Two literal, case-insensitive searches
  // (no quantifiers) keep this linear — a lazy [\s\S]*? capture was O(n²) on a
  // feed full of unclosed openers.
  const open = block.search(new RegExp(`<${name}>`, "i"));
  if (open === -1) return "";
  const from = open + name.length + 2;
  const close = block.slice(from).search(new RegExp(`</${name}>`, "i"));
  if (close === -1) return "";
  // The wrapper is stripped with the surrounding whitespace tolerated: a feed
  // emitting "\n<![CDATA[ … ]]>\n" used to leave the literal markers in the text.
  return block.slice(from, from + close).replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "");
}

const LEGAL_FORM = /^(ТОВ|ООО|ПП|ФОП|LLC|Inc\.?|Ltd\.?|Limited|GmbH|Corp\.?|S\.?A\.?|B\.?V\.?)$/i;
// A salary part is a currency sign, or a free-standing run of 3+ digits.
// Plain `\d{3,}` also fired on a digit run glued to letters — "БЦ 101A",
// "офіс 1234Б" — and dropped the whole location part with it. Requiring the run
// not to touch a letter keeps those. It still cannot tell a bare postal code
// from a bare salary figure ("01001" vs "20000"); both are dropped, which costs
// a little location detail rather than leaking a salary into it.
const SALARY = /[$€₴]|(?:^|[^\p{L}\d])\d{3,}(?![\p{L}\d])/u;

// DOU title format: "Role в Company, salary, location" → { title, company, location }.
// Split role/company on the LAST " в " (the role itself may contain " в " or commas,
// e.g. "(Playwright, RestAssured)"), then parse only the remainder by commas.
// A title without the connector stays whole, with no company or location.
function splitTitle(rawTitle, unsplit) {
  const vIdx = rawTitle.lastIndexOf(" в ");
  if (vIdx === -1) {
    if (rawTitle) unsplit(rawTitle);
    return { title: rawTitle, company: "", location: "" };
  }
  const rest = rawTitle.slice(vIdx + 3); // "Company, salary, location"
  // Format: "Company[, legal form][, salary], location[, location…]" — DOU
  // lists several cities ("Ciklum, Київ, Львів"), so the company is the
  // FIRST part (plus a trailing legal-form token like "ТОВ"), salary-looking
  // parts are dropped, and everything left is the location list.
  const restParts = rest.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  const companyParts = [restParts[0]];
  if (LEGAL_FORM.test(restParts[1] || "")) companyParts.push(restParts[1]);
  return {
    title: rawTitle.slice(0, vIdx).trim(),
    company: companyParts.join(", "),
    location: restParts.slice(companyParts.length).filter((p) => !SALARY.test(p)).join(", "),
  };
}

// `unsplit(rawTitle)` hears of a title without the " в " connector (fetchDou
// reports them once per run): the company stays empty, and a DOU title-format
// change would otherwise pass in silence.
export function parseRss(xml, { unsplit = () => {} } = {}) {
  const items = [];
  // indexOf scan, not /<item>([\s\S]*?)<\/item>/g: the lazy capture rescans to
  // the end from every unclosed <item>, O(n²) on a hostile feed (64k openers → 4 s).
  for (let i = 0; ; ) {
    const open = xml.indexOf("<item>", i);
    if (open === -1) break;
    const close = xml.indexOf("</item>", open + 6);
    if (close === -1) break;
    const block = xml.slice(open + 6, close);
    i = close + 7;
    const rawTitle = oneLine(decodeEntities(tag(block, "title")));
    const link = decodeEntities(tag(block, "link")).split("?")[0];
    // No link = no identity: a blank company + blank url would collapse every
    // such item into one "::title" key downstream (dedup, seen-set).
    if (!link) continue;
    // The description is XML-escaped HTML (&lt;p&gt;…): decode the transport
    // layer first, then strip the HTML layer.
    const desc = stripHtml(decodeEntities(tag(block, "description")));
    const { title, company, location } = splitTitle(rawTitle, unsplit);
    const posted = isoDate(tag(block, "pubDate"));
    items.push({ source: "dou", title, company, url: link, location, text: `${rawTitle}. ${desc}`, ...(posted ? { posted } : {}) });
  }
  return items;
}

// DOU re-dates a vacancy it re-publishes and shows no other date, in the feed or on the page: 358291,
// months old, read 29 Oct (live, 2026-10-31). Its ids follow creation, so a vacancy dated later than one
// with a higher id existed before that one's date: its date is a re-publication, kept as `relisted`.
export function markRelisted(items) {
  const idOf = (j) => Number(/\/vacancies\/(\d+)/.exec(j.url)?.[1]) || null;
  let earliestAbove = Infinity;   // the earliest date among the higher ids seen so far
  for (const j of items.filter(idOf).sort((a, b) => idOf(b) - idOf(a))) {
    const t = Date.parse(j.posted || "");
    if (!Number.isFinite(t)) continue;
    if (t > earliestAbove) { j.relisted = j.posted; delete j.posted; }
    earliestAbove = Math.min(earliestAbove, t);
  }
  return items;
}

// The feeds are independent, so they go through the shared pool instead of one
// after another; orderedPool replays the items and log lines in config order.
// Capped like Djinni's searches: README invites adding a feed per profession,
// and the fan-out to jobs.dou.ua must not grow with the list.
const FEED_CONCURRENCY = 3;

// One feed's items; a feed that cannot be read counts in `tally.failed` and
// gives none. `tally.unsplit` collects its titles with no " в Company" part.
async function readFeed(feed, say, tally) {
  try {
    const xml = await fetchText(feed, say, "DOU feed");
    if (!xml) { tally.failed++; return []; }
    const parsed = parseRss(xml, { unsplit: (t) => tally.unsplit.push(t) });
    say(`  DOU feed ok (${parsed.length}): ${feed}`);
    return parsed;
  } catch (e) {
    say(`  DOU feed error: ${feed} — ${e.message}`);
    tally.failed++;
    return [];
  }
}

// The options bag is the shared source contract (skip, countries, doFetch);
// RSS items carry their full text, so DOU needs none of it.
export async function fetchDou(config, log = console.log, _opts = {}) {
  if (config?.enabled === false) return []; // DOU is on unless explicitly disabled (matches jobs.mjs)
  const feeds = config?.feeds || [];        // jobs.mjs passes config.dou, which may be absent
  const tally = { failed: 0, unsplit: [] };   // across all feeds
  const items = await orderedPool(feeds, FEED_CONCURRENCY, (feed, say) => readFeed(feed, say, tally), log);
  // Every feed failing (network down) is an outage, not a quiet run: throw so
  // jobs.mjs counts the source as failed and can exit non-zero.
  if (feeds.length && tally.failed === feeds.length) throw new Error(`all ${tally.failed} DOU feed(s) failed`);
  // Once per run, not per item: the company is read off the title, so a feed
  // that stops writing "Role в Company" leaves every card without one.
  if (tally.unsplit.length) log(`  DOU: ${tally.unsplit.length} title(s) without " в Company" — company left empty, e.g. ${tally.unsplit[0]}`);
  return markRelisted(uniqueByUrl(items));
}
