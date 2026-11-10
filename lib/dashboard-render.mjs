// Pure rendering for dashboard.mjs: package parsing, the identity collapse and
// the card markup. dashboard.mjs keeps only the IO (read packages, write
// index.html) and the page shell, so these rules are unit-testable without
// spawning the build.
import { createRequire } from "node:module";
import { identityKey } from "./dedup.mjs";
import { reEsc } from "./regex.mjs";
import { sourceInfo } from "./sources/registry.mjs";
import { shownDate } from "./job-dates.mjs";
import { parseFrontmatter, COVER_START, COVER_END } from "./frontmatter.mjs";
import { MAX_URL_LENGTH, NOTE_MAX } from "./job-state.mjs";
import { detectLang } from "./lang.mjs";
import { namesCountry, DEFAULT_CANDIDATE_COUNTRY, WORLDWIDE } from "./filters.mjs";

const COVER_RE = new RegExp(`^${reEsc(COVER_START)}\n([\\s\\S]*?)\n${reEsc(COVER_END)}`, "m");

export function parse(md) {
  const fm = parseFrontmatter(md);
  return fm ? { fm, cover: coverOf(md) } : null;
}

// Cover note. Prefer the explicit delimiters buildApplication writes: the
// letter is model output, and one that contained its own "## Action" used to
// truncate the card while the file kept the full text. The heading scan stays
// as the fallback so packages written before the delimiters still render.
// Anchored to a line start: a job TITLE of "## Cover note" sits in the H1 ("# ## Cover note — …") and must not match.
function coverOf(text) {
  const md = text.replace(/\r\n/g, "\n");   // a hand-edited CRLF package, as parseFrontmatter reads it
  const delimited = md.match(COVER_RE);
  const cover = delimited ? delimited[1] : ((md.match(/^## Cover note[^\n]*\n([\s\S]*?)\n## Action/m) || [])[1] || "");
  return cover.trim();
}

// A package from readPackages(dir, { raw: true }) → its item: the frontmatter
// it already parsed (readers must not parse each file twice) plus the cover
// note read from the text.
export function packageItem({ _raw, ...fm }) {
  return toItem({ fm, cover: coverOf(_raw) });
}

// Also escapes the apostrophe. Every interpolation site happens to use double
// quotes today, so leaving ' alone was safe — but that is an invariant nothing
// checks and one single-quoted attribute would break silently.
export const esc = (s) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Frontmatter urls come from scraped job postings — only ever link http(s),
// so a hostile posting can't smuggle a javascript: url into an href.
// Cyrillic text (titles / locations come from Ukrainian boards) gets its lang so screen readers switch voice;
// the shared detector tells uk from ru, a blanket lang="uk" would misvoice a Russian title.
export const langAttr = (s) => { const l = detectLang(s); return l === "en" ? "" : ` lang="${l}"`; };

export const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");

// auxclick too: a middle-click opens the job in a new tab without firing
// click, and README promises that opening the link marks the card Viewed.
const AUTO_VIEWED = ` onclick="autoStatus(this.closest('.card'),'viewed')" onauxclick="if(event.button===1) autoStatus(this.closest('.card'),'viewed')"`;

// A package's frontmatter → the fields the page sorts and renders by. The
// source default and the score parse live here once, not at every use site.
export function toItem({ fm, cover }) {
  const score = parseInt(fm.score, 10);
  return {
    fm, cover,
    source: fm.source || "dou",
    score: Number.isFinite(score) ? score : 0,
    llm: wholeNumber(fm.llm_score, null),
    generated: fm.generated || "",
    posted: isoStamp(fm.posted),
    relisted: isoStamp(fm.relisted),
    updated: isoStamp(fm.updated),
    reposts: wholeNumber(fm.reposts, 0),
    // "borderline": the verdict fell short of llm.minScore (or the LLM failed
    // twice); shown under its own tab, never among the matches.
    tier: fm.tier === "borderline" ? "borderline" : "match",
  };
}

// A frontmatter value of digits only → that number, anything else → `fallback`.
function wholeNumber(v, fallback) {
  return /^\d+$/.test(v || "") ? parseInt(v, 10) : fallback;
}

// A parseable frontmatter date → canonical ISO, anything else → "". A date
// without a time is a calendar date, not the UTC instant Date.parse reads it
// as: it becomes that day's local midnight (ageLabel counts local days).
// An impossible calendar date is no date: `new Date(2026, 1, 30)` rolls over to
// 2 March instead of failing, and the card then showed a made-up age. Anything
// else must at least start with a four-digit year — Date.parse reads "5" as 2001.
function isoStamp(v) {
  const s = String(v || "").trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(s);
  if (!day) return "";
  const d = new Date(+day[1], +day[2] - 1, +day[3]);
  if (d.getMonth() !== +day[2] - 1 || d.getDate() !== +day[3]) return "";   // a full stamp rolls over too
  if (!day[4]) return d.toISOString();
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

// applications/ is append-only: historical runs left many packages for the same
// vacancy (boards used to change a job's URL between runs when seen was URL-keyed).
// Collapse to one card per identity (company+title), keeping the most recently
// generated package, then sort: LLM-scored first (desc), then keyword score.
export function collapseItems(items) {
  const byIdentity = new Map();
  for (const it of items) {
    const key = identityKey({ company: it.fm.company, title: it.fm.title, url: it.fm.url }); // url scopes blank companies
    const prev = byIdentity.get(key);
    if (!prev || it.generated > prev.generated) byIdentity.set(key, it);
  }
  return [...byIdentity.values()].sort((a, b) => (b.llm ?? -1) - (a.llm ?? -1) || b.score - a.score);
}

// "posted today" / "relisted 3 d ago" / "updated 6 w ago" — rendered when the
// dashboard is built, which every run does, so it is at most an hour stale.
// Calendar days (the machine's local ones, Kyiv), not elapsed 24 h blocks: a
// vacancy posted at 23:50 is "1 d ago" at 00:30, not "today".
// The page recomputes it on load (dashboard-client-dom.js), with this same function.
export const ageLabel = createRequire(import.meta.url)("./dashboard-client-core.cjs").ageLabel;

// The card's one date (lib/job-dates.mjs); a date that is not the first
// posting says so in its tooltip.
const AGE_TITLE = {
  relisted: "The board re-listed this vacancy; it shows no first posting date",
  updated: "The board gives only its last update, not the first posting date",
};

function ageMark(it, now) {
  const date = shownDate(it);
  if (!date) return "";
  const title = AGE_TITLE[date.kind];
  // The tooltip's text again for a screen reader, which a title does not reach reliably.
  return ` · <span class="posted"${title ? ` title="${title}"` : ""}><time datetime="${esc(date.at)}" data-kind="${esc(date.kind)}">${esc(ageLabel(date.kind, date.at, now))}</time>${title ? `<span class="sr-only"> (${title})</span>` : ""}</span>`;
}

// Score band → CSS class (colours live in the theme tokens, see <style>).
export function scoreBand(s) {
  if (s >= 40) return "hi";    // green
  if (s >= 30) return "mid";   // amber
  return "lo";                  // gray
}

// Badge colour and chip label come from the source's registry row. The badge
// prints the label too, since a source key need not read as a name
// ("tgchannels"). Unknown/future sources fall back to gray with their raw name.
const sourceMeta = sourceInfo;
export function badge(source) {
  return `<span class="src" style="--src:${sourceMeta(source)?.color || "#6e7781"}">${esc(sourceMeta(source)?.label || source)}</span>`;
}

// Source chips only for boards that actually have packages on disk: a disabled
// board's chip disappears by itself once its last package is archived.
export const sourceChips = (items) => [...new Set(items.map((it) => it.source))].sort()
  .map((src) => `<button data-src="${esc(src)}" aria-pressed="false" onclick="setSource(this.dataset.src)">${esc(sourceMeta(src)?.label || src)}</button>`)
  .join("\n      ");

// Printed with the badge, not in a hover-only title attribute, which never
// reaches keyboard, touch or screen-reader users.
const SUSPECT_NOTE = "the posting addresses the screener, so this score may have been asked for";
// Flagged posting with no verdict: the model gave no usable answer, which may
// itself be what the posting asked for.
const SUSPECT_NOTE_NO_LLM = "the posting addresses the screener, and the LLM gave no usable verdict";
// Keyword-only package while the LLM is in use: written after two failed
// verdicts (or before the retry existed), so the fit gate never ran and the
// cover note is the generic template. Derived, not stored: a card without a
// verdict among cards that have one is unverified by definition, which also
// covers the packages written before this badge existed. With the LLM never
// used, no card has a verdict and nothing is marked.
const UNVERIFIED_NOTE = "no LLM verdict — the fit gate did not run and the cover note is the keyword template; read the posting yourself";

// Remote boards whose location lists the countries a candidate may live in (registry `countryList`).
const listsCountries = (source) => Boolean(sourceInfo(source)?.countryList);

// `countries`: candidateCountry from jobs.config.json, first entry for the label.
// A map(renderCard) caller passes the array as the third argument; that is not
// an options object, so it falls back to the default.
// `llmInUse`: some card on the page carries a verdict, so one without is marked.
export function renderCard(it, idx, opts) {
  const f = it.fm;
  // The server keys state by http(s) url up to MAX_URL_LENGTH and 400s
  // anything else: a card with a bad or overlong url renders read-only (no
  // status buttons / note / auto-viewed) instead of failing on every click.
  const href = safeUrl(f.url);
  const live = href !== "#" && f.url.length <= MAX_URL_LENGTH;
  // The status cue and the NEW ribbon are English inside a heading that may
  // carry lang="uk": lang="en" keeps them out of the Ukrainian voice.
  // Every per-card control used to carry the same accessible name on every
  // card — "New", "Viewed", "Copy letter", "Note", "Status", "Private note" —
  // so a screen-reader user tabbing through could not tell which vacancy they
  // were acting on (WCAG 2.4.6 / 4.1.2). `which` disambiguates them, and the
  // article takes its own name from its heading.
  const which = esc(`${f.title || "—"} at ${f.company || "—"}`);
  const borderline = it.tier === "borderline";
  return `
${articleOpen(it, idx, { live, borderline })}
<div class="head">
  <span class="score ${scoreBand(it.score)}"><span class="sr-only">keyword score </span>${it.score}</span>
  <div class="titles">
    <h2 id="t${idx}"${langAttr(f.title)}>${esc(f.title || "—")}<span class="sr-only card-status" lang="en"></span></h2>
    ${subLine(it, opts)}
    ${llmRow(it, opts, borderline)}
  </div>
  <div class="actions">
    ${openLink(f, href, live)}
    ${live ? statusButtons(which) : ""}
  </div>
</div>
<div class="skills">${skillChips(f)}</div>
${altRow(f)}
${coverLetter(it, idx, which, live)}
${live ? noteBox(which) : ""}
</article>`;
}

function articleOpen(it, idx, { live, borderline }) {
  const f = it.fm;
  return `<article class="card" aria-labelledby="t${idx}"${live ? ` data-url="${esc(f.url)}"` : ""}${borderline ? ' data-tier="borderline"' : ""} data-generated="${esc(f.generated || "")}" data-source="${esc(it.source)}" data-search="${esc(((f.title||"")+" "+(f.company||"")+" "+(f.matched_skills||"")).toLowerCase())}">`;
}

function subLine(it, opts) {
  const f = it.fm;
  return `<div class="sub">${badge(it.source)} <strong${langAttr(f.company)}>${esc(f.company || "—")}</strong> · ${locationHtml(it)}${listedMark(it, opts)} · <span class="lang">${esc(f.cover_language || "")}</span>${f.salary ? ` · <span class="salary">${esc(f.salary)}</span>` : ""}${ageMark(it, opts?.now)}${it.reposts ? ` · <span class="repost" title="The board closed the earlier listing; this is the same vacancy re-listed">reposted ×${it.reposts}<span class="sr-only"> (the board closed the earlier listing and listed the vacancy again)</span></span>` : ""}</div>`;
}

// Himalayas spells out every eligible country: forty names fill the card and
// hide whether the candidate's own is among them, which the "✓ <country>
// listed" mark already answers. On a Remote card a segment longer than
// LONG_LIST collapses to its size, a disclosure keyboard and touch can open
// (a hover title reaches neither). A "Worldwide, …" segment stays whole: open
// to everyone is the fact that matters, and its names are not the whole list.
// Approximate (~): names such as "Virgin Islands, British" carry a comma.
const LONG_LIST = 6;
const collapses = (seg) => seg.split(",").length > LONG_LIST && !WORLDWIDE.test(seg);
function locationHtml(it) {
  const loc = it.fm.location || "";
  const parts = loc.split(" · ");
  if (!listsCountries(it.source) || parts[0] !== "Remote" || !parts.some(collapses)) return `<span${langAttr(loc)}>${esc(loc)}</span>`;
  const short = parts.map((p) => (collapses(p) ? `~${p.split(",").length} countries` : p)).join(" · ");
  return `<details class="places"><summary>${esc(short)}</summary> ${esc(loc)}</details>`;
}

function listedMark(it, opts) {
  const countries = Array.isArray(opts?.countries) && opts.countries.length ? opts.countries : DEFAULT_CANDIDATE_COUNTRY;
  return listsCountries(it.source) && namesCountry(it.fm.location, countries)
    ? ` · <span class="listed"><span aria-hidden="true">✓ </span>${esc(countries[0])} listed</span>` : "";
}

function llmRow(it, opts, borderline) {
  const tierTag = borderline ? `<span class="tier"><span class="sr-only">tier </span>borderline</span> ` : "";
  if (it.llm != null) return verdictRow(it, tierTag);
  return noVerdictRow(it.fm, tierTag, { unverified: opts?.llmInUse === true, borderline });
}

function verdictRow(it, tierTag) {
  const f = it.fm;
  return `<div class="llm-row">${tierTag}<span class="llm"><span class="sr-only">LLM fit </span><span aria-hidden="true">AI</span> ${it.llm}</span>${f.llm_suspect ? ` <span class="suspect">⚠ ${esc(f.llm_suspect)} — ${SUSPECT_NOTE}</span>` : ""} <span class="llm-why"${langAttr(f.llm_why)}>${esc(f.llm_why || "")}</span></div>`;
}

function noVerdictRow(f, tierTag, { unverified, borderline }) {
  if (!(unverified || f.llm_suspect || borderline)) return "";
  return `<div class="llm-row">${tierTag}${unverified ? `<span class="llm unverified"><span class="sr-only">LLM fit </span><span aria-hidden="true">AI</span> ?</span>` : ""}${f.llm_suspect ? ` <span class="suspect">⚠ ${esc(f.llm_suspect)} — ${SUSPECT_NOTE_NO_LLM}</span>` : ""}${unverified ? ` <span class="llm-why">${UNVERIFIED_NOTE}</span>` : ""}</div>`;
}

// No http(s) url: say so instead of an `<a href="#" target="_blank">` named
// "Open job" that opened a second copy of the dashboard (WCAG 2.4.4).
function openLink(f, href, live) {
  return href === "#"
    ? `<span class="apply" aria-disabled="true">No usable link</span>`
    : `<a class="apply" href="${esc(href)}" target="_blank" rel="noopener" aria-label="Open job: ${esc(f.title || "—")} at ${esc(f.company || "—")}"${live ? AUTO_VIEWED : ""}>Open job ↗</a>`;
}

function statusButtons(which) {
  return `<div class="status-seg" role="group" aria-label="Status — ${which}">
      <button data-status="new" aria-pressed="false" aria-label="Mark New — ${which}" onclick="setStatus(this.closest('.card'),'new')">New</button>
      <button data-status="viewed" aria-pressed="false" aria-label="Mark Viewed — ${which}" onclick="setStatus(this.closest('.card'),'viewed')">Viewed</button>
    </div>`;
}

function skillChips(f) {
  return (f.matched_skills || "")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => `<span class="chip">${esc(s)}</span>`).join("");
}

// Same vacancy on other boards (collected by dedupeJobs): "source|url, ...".
// Split only before the next "source|" so commas inside URLs survive.
function altRow(f) {
  const alt = (f.alt_links || "")
    .split(/,\s*(?=[a-z]+\|)/).map((s) => s.trim()).filter(Boolean)
    // A pair with no "|" is malformed (hand-edited frontmatter): indexOf
    // returns -1, which used to label the link with the pair minus its last
    // character and point it at the whole string. Drop it instead.
    .filter((pair) => pair.includes("|"))
    .map((pair) => {
      const sep = pair.indexOf("|");
      return { src: pair.slice(0, sep), href: safeUrl(pair.slice(sep + 1)) };
    })
    // A non-http(s) alt url used to render as href="#": a working-looking link
    // that reopened the dashboard in a second tab. Drop it instead.
    .filter(({ href }) => href !== "#")
    .map(({ src, href }) => `<a class="alt" href="${esc(href)}" target="_blank" rel="noopener">${esc(src)} ↗</a>`)
    .join("");
  return alt ? `<div class="alt-row">also on: ${alt}</div>` : "";
}

// The cover letter marks the card Viewed from a click on its summary (Enter
// and Space click it too), not from `toggle`: Chromium's find-in-page opens a
// closed <details> whose text matches and fires toggle, and Cmd-F "regards"
// used to mark a card nobody opened.
function coverLetter(it, idx, which, live) {
  const f = it.fm;
  return `<details>
  <summary${live ? ` onclick="if(!this.parentElement.open) autoStatus(this.closest('.card'),'viewed')"` : ""}>Cover letter<span class="sr-only"> — ${which}</span></summary>
  <pre id="cover${idx}" lang="${esc(f.cover_language || "en")}">${esc(it.cover)}</pre>
  <button class="copy" onclick="copyCover(${idx}, this)">Copy letter<span class="sr-only"> — ${which}</span></button><span class="sr-only" role="status"></span>
  <span class="resume">resume: ${esc(f.resume || "")}</span>
</details>`;
}

function noteBox(which) {
  return `<details class="note-wrap">
  <summary>Note<span class="sr-only"> — ${which}</span> <span class="note-has" hidden>●<span class="sr-only"> has note</span></span></summary>
  <textarea class="note" rows="3" maxlength="${NOTE_MAX}" aria-label="Private note — ${which}" placeholder="Private note (saved to disk)…" oninput="noteInput(this.closest('.card'), this)" onblur="saveNote(this.closest('.card'), this.value)"></textarea>
</details>`;
}
