// Public Telegram job channels via their web preview (https://t.me/s/<channel>):
// plain HTML, no login, no bot, no browser. Only channels have a preview —
// groups redirect to their join page, which is reported, not parsed.
//
// Posts follow a "Field: value" template, one field per line — the one
// @remote_qa_jobs uses:
//   Company name: Tether · Title: Automation QA Engineer (QVAC) · Grades: senior
//   Job description: … · Location: Worldwide · Anywhere: Yes · Remote: Yes
//   Forbidden locations: … · 👉 ( Job Description & Apply ) → link · Tags: #qa …
// A post without a Title field (ads, announcements) is not a job and is skipped.
//
// Where the candidate may live comes from the post, not the job page: the
// channel's Location / Anywhere fields were right on every post checked
// (2026-10-17), while the pages' JSON-LD country lists often name the
// employer's office instead (join.com: "Netherlands" for a worldwide role). The
// record's location reads "Remote · <Location>" ("Remote · Worldwide[, <Location>]"
// when Anywhere: Yes) so filterByLocation applies the Djinni countries rule; a
// Forbidden locations list naming the candidate's country drops the post here.
//
// The post's description is a 1–3 sentence summary, too thin for the LLM gate
// (Jooble's snippets never cleared it). With fullDescription (default true)
// the apply link is fetched for new jobs and its JSON-LD JobPosting description
// replaces the summary: 24 of 40 reachable job pages carried one. The link is
// third-party text, so only a public https host on the default port is
// fetched, and redirects stay on that host (fetchFollow).
//
// One page is ~20 posts, newest last on the page; jobs are returned newest
// first, since jobs.mjs spends its LLM budget in list order. `pages` (default
// 1) pages per channel.
// Returns [{ source, title, company, url, location, text }]

import { stripHtml, oneLine, composeText, decodeEntities, fetchText, pagedSearch, enrich, extractDivByClass } from "./html.mjs";
import { knob, candidateCountryList } from "../filters.mjs";

// Test seam: TGCHANNELS_BASE points the source at a local server (the pipeline test).
const BASE = process.env.TGCHANNELS_BASE || "https://t.me/s/";
const CHANNEL_CONCURRENCY = 2;
// Job pages sit on different hosts, so a few at a time is still polite.
const PAGE_CONCURRENCY = 3;

export const channelName = (c) => String(c ?? "").trim().replace(/^@/, "");

export function channelUrl(channel, before) {
  const u = new URL(encodeURIComponent(channelName(channel)), BASE);
  if (before) u.searchParams.set("before", String(before));
  return u.toString();
}

// The apply link is whatever the channel posted. A plain GET to it must not
// reach this Mac's own services (the state server listens on loopback) or
// the LAN: https only (the loopback services speak plain http), no explicit
// port, no credentials, and a dotted public-looking hostname rather than an
// IP literal or a local name. The URL parser has already normalised "127.1"
// and "0x7f.1" to dotted decimal, so the digits check covers those spellings.
export function isPublicHttps(link) {
  let u;
  try { u = new URL(link); } catch { return false; }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return false;
  // A trailing dot is the same host in DNS ("localhost." resolves to 127.0.0.1).
  const h = u.hostname.replace(/\.$/, "");
  return h.includes(".") && !/^[\d.]+$/.test(h) && !h.startsWith("[") && !/(^|\.)(localhost|local|internal|lan|home)$/i.test(h);
}

// "Field: value" lines of one post, keys lower-cased; the first of a repeated
// field wins.
export function postFields(textHtml) {
  const fields = {};
  for (const seg of String(textHtml).split(/<br\s*\/?>/i)) {
    const m = /^([A-Za-z][A-Za-z ]{0,30}):\s*(.*)$/.exec(stripHtml(seg));
    const key = m?.[1].trim().toLowerCase();
    if (key && !(key in fields)) fields[key] = m[2].trim();
  }
  return fields;
}

// The template's "( Job Description & Apply )" link, else the first real one;
// tag links are relative ("?q=%23qa"). Telegram auto-links any URL in the
// text, so a company named "Coderslab.io" comes first in its post (4 of 113
// posts checked, 2026-10-18). Only an explicit Apply link is the job's
// identity (`explicit`): the fallback is often a company domain that every
// post of that company shares, and as the url it made uniqueByUrl and the seen
// store hide all but the first of them for good — such a post keeps its
// permalink as url and the link only for the description fetch (toJob).
const applyLink = (textHtml) => {
  const links = [...String(textHtml).matchAll(/<a\s[^>]{0,512}?href="(https?:\/\/[^"]{1,2048})"[^>]{0,1024}>([\s\S]{0,2048}?)<\/a>/gi)];
  const explicit = links.find((l) => /\bapply\b/i.test(stripHtml(l[2])));
  const m = explicit || links[0];
  return { href: m ? decodeEntities(m[1]) : "", explicit: Boolean(explicit) };
};

// The Location value as a countries segment for filterByLocation. Format words
// go: the record's first segment already says Remote/Office, and a segment
// carrying one is skipped as "no countries", so "Ukraine (Remote)" named no
// country at all.
// A format word goes with the connector after it ("Remote or Ukraine",
// "Remote — Ukraine", "Remote-first, Ukraine"); one at the end leaves its
// connector behind, which the trim takes.
export function placeOf(location) {
  return oneLine(location)
    .replace(/\s·\s/g, ", ")   // " · " separates the segments; a value carrying one must not open its own
    .replace(/(?:100\s*%\s*)?\b(?:fully\s+|in-)?(?:remote|office|hybrid|full-time|part-time)\b(?:-(?:first|friendly|only))?(?:\s*(?:\bor\b|\band\b|[-–—/,;+]))?\s*/gi, "")
    .replace(/\(\s*(?:[,;/]|or|and)?\s*\)/gi, "")
    .replace(/\(\s*[,;/]\s*/g, "(")
    .replace(/\s*[,;/]\s*\)/g, ")")
    .replace(/^[\s,;/+\-–—]+|[\s,;/+\-–—]+$/g, "")
    .replace(/\s+(?:or|and)$/i, "")
    .replace(/\s{2,}/g, " ");
}

// Forbidden locations that name the candidate's country. The channel writes
// the field as an allow-list ("Outside Europe and Ukraine" on every post
// checked, 2026-10-18), and an "except" reads the same way: only a plain list
// of countries is a ban.
export function forbidsCountry(forbidden, countries) {
  const f = String(forbidden || "").toLowerCase();
  if (!f || /\b(?:outside|except|but|other than)\b/.test(f)) return false;
  return candidateCountryList(countries).some((c) => f.includes(c.toLowerCase()));
}

// One post → the shared record, or null when it is not a job post.
export function toJob(channel, id, textHtml) {
  const f = postFields(textHtml);
  // oneLine on every field that reaches a log line (see html.mjs).
  const title = oneLine(f.title);
  if (!title) return null;
  const permalink = `https://t.me/${channelName(channel)}/${id}`;
  const link = applyLink(textHtml);
  // The parsed href, not the decoded text: an "&#10;" in the post's link is a
  // real newline after decodeEntities, which the URL parser drops but a log
  // line would print — forging a digest line (see oneLine in html.mjs).
  const apply = isPublicHttps(link.href) ? new URL(link.href).href : "";
  const where = placeOf(f.location);
  const format = /^no\b/i.test(f.remote || "") ? "Office" : "Remote";
  // Anywhere: Yes reads "Worldwide", followed by any place the post names
  // ("Ukraine, Poland"): a worldwide: false source keeps only jobs that name the
  // candidate's country, and the dashboard marks them.
  const named = where && !/worldwide|anywhere/i.test(where) ? where : "";
  const place = /^yes\b/i.test(f.anywhere || "") ? (named ? `Worldwide, ${named}` : "Worldwide") : where;
  const location = place ? `${format} · ${place}` : format;
  // Tags as words ("#test_automation" → "test automation") for the keyword
  // gate; only after the Tags label, so a "#1 in fintech" in the text is not one.
  const tagLine = stripHtml(textHtml).split(/\bTags\s*:/i).slice(1).join(" ");
  const tags = (tagLine.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.slice(1).replace(/_/g, " "));
  const summary = [
    f.grades && `Grades: ${f.grades}.`,
    f["job description"],
    f["forbidden locations"] && `Forbidden locations: ${f["forbidden locations"]}.`,
    tags.length && `Tags: ${tags.join(", ")}.`,
  ].filter(Boolean).map(oneLine).join(" ");
  const job = { source: "tgchannels", title, company: oneLine(f["company name"]), url: link.explicit && apply ? apply : permalink, location };
  job.text = composeText(job, summary);
  return { ...job, summary, apply, forbidden: oneLine(f["forbidden locations"]) };
}

// null = not a channel preview at all (a group's or a missing channel's page,
// an error page), which the caller reports; { jobs: [] } = a real, empty page.
export function parseChannel(html, channel) {
  if (!/class="tgme_channel_history\b/.test(html)) return null;
  const jobs = [];
  for (const chunk of html.split(/(?=<div class="tgme_widget_message_wrap\b)/).slice(1)) {
    const id = /data-post="[^"/]{1,64}\/(\d{1,12})"/.exec(chunk)?.[1];
    const text = id && extractDivByClass(chunk, "tgme_widget_message_text");
    const job = text && toJob(channel, id, text);
    if (job) jobs.push(job);
  }
  return { jobs: jobs.reverse(), before: /class="tme_messages_more[^"]*"[^>]{0,256}data-before="(\d{1,12})"/.exec(html)?.[1] || "" };
}

// The JSON-LD JobPosting description of a job page as plain text, or "".
// Script blocks are found by a forward scan (no backtracking on a junk page
// full of unterminated "<script", see html.mjs).
export function jobPostingText(html) {
  const open = /<script\b/gi, close = /<\/script/gi;
  let m;
  while ((m = open.exec(html))) {
    const gt = html.indexOf(">", m.index);
    if (gt < 0) break;
    close.lastIndex = gt;
    const end = close.exec(html);
    if (!end) break;
    open.lastIndex = end.index;
    if (!/application\/ld\+json/i.test(html.slice(m.index, gt))) continue;
    let data;
    try { data = JSON.parse(html.slice(gt + 1, end.index)); } catch { continue; }
    const nodes = Array.isArray(data) ? data : [data, ...(Array.isArray(data?.["@graph"]) ? data["@graph"] : [])];
    const posting = nodes.find((n) => n && typeof n === "object" && [].concat(n["@type"]).includes("JobPosting"));
    if (typeof posting?.description !== "string") continue;
    // Some boards put entity-escaped HTML in the JSON ("&lt;p&gt;…"): decode it
    // into markup first, or stripHtml would decode it into visible tags.
    const d = /&lt;\/?[a-z]/i.test(posting.description) ? decodeEntities(posting.description) : posting.description;
    const text = stripHtml(d);
    if (text) return text;
  }
  return "";
}

// `countries`: candidateCountry; a post whose Forbidden locations names one of
// them is dropped here, since filterByLocation only reads the Location field.
export async function fetchTgChannels(config, log = console.log, { skip = () => false, doFetch, countries } = {}) {
  if (!config?.enabled) return [];
  const pages = knob("tgchannels.pages", config.pages, 1, [1, Infinity], log);
  // The shared paged-search loop (html.mjs); every channel failing (network
  // down, t.me unreachable) is an outage it throws. A channel pages by the
  // `before` cursor of the page just read, handed back as `prev`.
  const found = await pagedSearch(config.channels || [], {
    limit: CHANNEL_CONCURRENCY, pages, label: "Telegram channel", plural: "Telegram channel(s)", unit: "job",
    name: (channel) => `@${channelName(channel)}`,
    page: async (channel, p, say, prev) => {
      const html = await fetchText(channelUrl(channel, prev?.before), say, "Telegram channel", { doFetch });
      const page = html ? parseChannel(html, channel) : null;
      if (!page) return { cut: html ? "not a public channel preview (groups have none)" : "fetch failed" };
      return { items: page.jobs, more: Boolean(page.before), before: page.before };   // no `before`: the channel's first post is on this page
    },
  }, log);
  const out = found.filter((job) => {
    if (!forbidsCountry(job.forbidden, countries)) return true;
    log(`  Telegram: dropped, forbidden locations name the candidate's country [${job.forbidden}]: ${job.title}`);
    return false;
  });

  // Full descriptions only for jobs the caller does not already know (see djinni.mjs).
  if (config.fullDescription !== false) {
    await enrich(out, {
      label: "Telegram job page", skip, doFetch, limit: PAGE_CONCURRENCY,
      fetching: (n) => `  Telegram: fetching ${n} job page(s)...`,
      enriched: (ok, n) => `  Telegram: enriched ${ok}/${n} with the full description`,
      url: (job) => job.apply,
      extract: jobPostingText,
      text: (job, full) => composeText(job, `${job.summary} ${full}`),
    }, log);
  }
  return out.map(({ summary, apply, forbidden, ...job }) => job);
}
