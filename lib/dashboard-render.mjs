// Pure rendering for dashboard.mjs: package parsing, the identity collapse and
// the card markup. dashboard.mjs keeps only the IO (read packages, write
// index.html) and the page shell, so these rules are unit-testable without
// spawning the build.
import { identityKey } from "./dedup.mjs";
import { parseFrontmatter, COVER_START, COVER_END } from "./frontmatter.mjs";
import { MAX_URL_LENGTH } from "./job-state.mjs";
import { detectLang } from "./lang.mjs";

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const COVER_RE = new RegExp(`^${reEsc(COVER_START)}\n([\\s\\S]*?)\n${reEsc(COVER_END)}`, "m");

export function parse(md) {
  const fm = parseFrontmatter(md);
  if (!fm) return null;
  // Cover note. Prefer the explicit delimiters buildApplication writes: the
  // letter is model output, and one that contained its own "## Action" used to
  // truncate the card while the file kept the full text. The heading scan stays
  // as the fallback so packages written before the delimiters still render.
  // Anchored to a line start: a job TITLE of "## Cover note" sits in the H1 ("# ## Cover note — …") and must not match.
  const delimited = md.match(COVER_RE);
  const cover = delimited ? delimited[1] : ((md.match(/^## Cover note[^\n]*\n([\s\S]*?)\n## Action/m) || [])[1] || "");
  return { fm, cover: cover.trim() };
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

// A package's frontmatter → the fields the page sorts and renders by. The
// source default and the score parse live here once, not at every use site.
export function toItem({ fm, cover }) {
  const score = parseInt(fm.score, 10);
  return {
    fm, cover,
    source: fm.source || "dou",
    score: Number.isFinite(score) ? score : 0,
    llm: /^\d+$/.test(fm.llm_score || "") ? parseInt(fm.llm_score, 10) : null,
    generated: fm.generated || "",
  };
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

// Score band → CSS class (colours live in the theme tokens, see <style>).
export function scoreBand(s) {
  if (s >= 40) return "hi";    // green
  if (s >= 30) return "mid";   // amber
  return "lo";                  // gray
}

// Everything per-source the page needs, keyed once: badge colour and chip
// label used to be two object literals over the same three keys, so adding a
// board meant editing both. Unknown/future sources fall back to gray with their
// raw name. Colours are all ≥ 4.5:1 against white text (WCAG AA for the 11px badge).
const SOURCES = {
  linkedin: { color: "#0a66c2", label: "LinkedIn" },
  dou: { color: "#c93c33", label: "DOU" },
  djinni: { color: "#3d3bd4", label: "Djinni" },
};
// hasOwn: source is frontmatter text, "constructor" must not resolve.
const sourceMeta = (source) => (Object.hasOwn(SOURCES, source) ? SOURCES[source] : null);
export function badge(source) {
  return `<span class="src" style="background:${sourceMeta(source)?.color || "#6e7781"}">${esc(source)}</span>`;
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

export function renderCard(it, idx) {
  const f = it.fm;
  const skills = (f.matched_skills || "")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => `<span class="chip">${esc(s)}</span>`).join("");
  // Same vacancy on other boards (collected by dedupeJobs): "source|url, ...".
  // Split only before the next "source|" so commas inside URLs survive.
  const alt = (f.alt_links || "")
    .split(/,\s*(?=[a-z]+\|)/).map((s) => s.trim()).filter(Boolean)
    // A pair with no "|" is malformed (hand-edited frontmatter): indexOf
    // returns -1, which used to label the link with the pair minus its last
    // character and point it at the whole string. Drop it instead.
    .filter((pair) => pair.includes("|"))
    .map((pair) => {
      const sep = pair.indexOf("|");
      const src = pair.slice(0, sep), url = pair.slice(sep + 1);
      return `<a class="alt" href="${esc(safeUrl(url))}" target="_blank" rel="noopener">${esc(src)} ↗</a>`;
    }).join("");
  const altRow = alt ? `<div class="alt-row">also on: ${alt}</div>` : "";
  // The server keys state by http(s) url up to MAX_URL_LENGTH and 400s
  // anything else: a card with a bad or overlong url renders read-only (no
  // status buttons / note / auto-viewed) instead of failing on every click.
  const live = safeUrl(f.url) !== "#" && f.url.length <= MAX_URL_LENGTH;
  // auxclick too: a middle-click opens the job in a new tab without firing
  // click, and README promises that opening the link marks the card Viewed.
  const auto = live ? ` onclick="autoStatus(this.closest('.card'),'viewed')" onauxclick="if(event.button===1) autoStatus(this.closest('.card'),'viewed')"` : "";
  // Every per-card control used to carry the same accessible name on every
  // card — "New", "Viewed", "Copy letter", "Note", "Status", "Private note" —
  // so a screen-reader user tabbing through could not tell which vacancy they
  // were acting on (WCAG 2.4.6 / 4.1.2). `which` disambiguates them, and the
  // article takes its own name from its heading.
  const which = esc(`${f.title || "—"} at ${f.company || "—"}`);
  return `
<article class="card" aria-labelledby="t${idx}"${live ? ` data-url="${esc(f.url)}"` : ""} data-generated="${esc(f.generated || "")}" data-source="${esc(it.source)}" data-search="${esc(((f.title||"")+" "+(f.company||"")+" "+(f.matched_skills||"")).toLowerCase())}">
<div class="head">
  <span class="score ${scoreBand(it.score)}"><span class="sr-only">keyword score </span>${it.score}</span>
  <div class="titles">
    <h2 id="t${idx}"${langAttr(f.title)}>${esc(f.title || "—")}<span class="sr-only card-status"></span></h2>
    <div class="sub">${badge(it.source)} <strong>${esc(f.company || "—")}</strong> · <span${langAttr(f.location)}>${esc(f.location || "")}</span> · <span class="lang">${esc(f.cover_language || "")}</span>${f.salary ? ` · <span class="salary">${esc(f.salary)}</span>` : ""}</div>
    ${it.llm != null ? `<div class="llm-row"><span class="llm"><span class="sr-only">LLM fit </span><span aria-hidden="true">🤖</span> ${it.llm}</span>${f.llm_suspect ? ` <span class="suspect">⚠ ${esc(f.llm_suspect)} — ${SUSPECT_NOTE}</span>` : ""} <span class="llm-why">${esc(f.llm_why || "")}</span></div>` : f.llm_suspect ? `<div class="llm-row"><span class="suspect">⚠ ${esc(f.llm_suspect)} — ${SUSPECT_NOTE_NO_LLM}</span></div>` : ""}
  </div>
  <div class="actions">
    <a class="apply" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener" aria-label="Open job: ${esc(f.title || "—")} at ${esc(f.company || "—")}"${auto}>Open job ↗</a>
    ${live ? `<div class="status-seg" role="group" aria-label="Status — ${which}">
      <button data-status="new" aria-pressed="false" aria-label="Mark New — ${which}" onclick="setStatus(this.closest('.card'),'new')">New</button>
      <button data-status="viewed" aria-pressed="false" aria-label="Mark Viewed — ${which}" onclick="setStatus(this.closest('.card'),'viewed')">Viewed</button>
    </div>` : ""}
  </div>
</div>
<div class="skills">${skills}</div>
${altRow}
<details${live ? ` ontoggle="if(this.open) autoStatus(this.closest('.card'),'viewed')"` : ""}>
  <summary>Cover letter<span class="sr-only"> — ${which}</span></summary>
  <pre id="cover${idx}" lang="${esc(f.cover_language || "en")}">${esc(it.cover)}</pre>
  <button class="copy" onclick="copyCover(${idx}, this)">Copy letter<span class="sr-only"> — ${which}</span></button><span class="sr-only" role="status"></span>
  <span class="resume"><span aria-hidden="true">📎</span> resume: ${esc(f.resume || "")}</span>
</details>
${live ? `<details class="note-wrap">
  <summary><span aria-hidden="true">📝</span> Note<span class="sr-only"> — ${which}</span> <span class="note-has" hidden>●<span class="sr-only"> has note</span></span></summary>
  <textarea class="note" rows="3" maxlength="10000" aria-label="Private note — ${which}" placeholder="Private note (saved to disk)…" oninput="noteInput(this.closest('.card'), this)" onblur="saveNote(this.closest('.card'), this.value)"></textarea>
</details>` : ""}
</article>`;
}
