// Builds a single self-contained HTML dashboard of all application packages
// in applications/, sorted by score. Run:  node dashboard.mjs [--open]
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { identityKey } from "./lib/dedup.mjs";
import { writeTextAtomic } from "./lib/json-file.mjs";
import { parseFrontmatter } from "./lib/frontmatter.mjs";
import { execFile } from "node:child_process";

const __dir = dirname(fileURLToPath(import.meta.url));
const APPS = join(__dir, "applications");
const OUT = join(APPS, "index.html");
// Fresh clone has no applications/ yet; build an empty dashboard instead of crashing.
mkdirSync(APPS, { recursive: true });

// The client script ships as two standalone files inlined at build time:
// the unit-tested pure core (.cjs so node:test can require it) and the DOM
// glue. Interpolated text is not re-parsed, so backticks in them are safe;
// a </script tag (any case/spacing) would terminate the tag mid-file — refuse to build.
const clientJs = ["dashboard-client-core.cjs", "dashboard-client-dom.js"]
  .map((f) => readFileSync(join(__dir, "lib", f), "utf8"))
  .join("\n");
if (/<\/script/i.test(clientJs)) throw new Error("dashboard client JS must not contain </script>");

function parse(md) {
  const fm = parseFrontmatter(md);
  if (!fm) return null;
  // cover note = text between "## Cover note" and "## Action"
  const cover = (md.match(/## Cover note[^\n]*\n([\s\S]*?)\n## Action/) || [])[1] || "";
  return { fm, cover: cover.trim() };
}

const esc = (s) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Frontmatter urls come from scraped job postings — only ever link http(s),
// so a hostile posting can't smuggle a javascript: url into an href.
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");

const files = readdirSync(APPS).filter((f) => f.endsWith(".md"));
const parsed = files
  .map((f) => parse(readFileSync(join(APPS, f), "utf8")))
  .filter(Boolean)
  .map((x) => ({
    ...x,
    score: Number.isFinite(parseInt(x.fm.score, 10)) ? parseInt(x.fm.score, 10) : 0,
    llm: /^\d+$/.test(x.fm.llm_score || "") && Number.isFinite(parseInt(x.fm.llm_score, 10)) ? parseInt(x.fm.llm_score, 10) : null,
    generated: x.fm.generated || "",
  }));

// Packages written before the extractSalary trailing-comma fix have values like
// "$2800–3500," baked into their frontmatter; clean them up at render time.
for (const it of parsed) if (it.fm.salary) it.fm.salary = it.fm.salary.replace(/[,\s]+$/, "");

// applications/ is append-only: historical runs left many packages for the same
// vacancy (e.g. a Jooble job whose URL changed every run when seen was URL-keyed).
// Collapse to one card per identity (company+title), keeping the most recently
// generated package so the dashboard reflects the latest data.
const byIdentity = new Map();
for (const it of parsed) {
  const key = identityKey({ company: it.fm.company, title: it.fm.title, url: it.fm.url }); // url scopes blank companies
  const prev = byIdentity.get(key);
  if (!prev || (it.fm.generated || "") > (prev.fm.generated || "")) byIdentity.set(key, it);
}
const items = [...byIdentity.values()].sort(
  (a, b) => (b.llm ?? -1) - (a.llm ?? -1) || b.score - a.score,
);

function scoreColor(s) {
  if (s >= 40) return "#1a7f37";   // green
  if (s >= 30) return "#9a6700";   // amber
  return "#6e7781";                 // gray
}

// Per-source badge colour. Unknown/future sources fall back to gray.
// All ≥ 4.5:1 against white text (WCAG AA for the 11px badge).
const SOURCE_COLORS = { linkedin: "#0a66c2", dou: "#c93c33", djinni: "#3d3bd4", jooble: "#0a7a5c", robota: "#c2263f", workua: "#1868b3", glassdoor: "#0caa41" };
function badge(source) {
  const c = (Object.hasOwn(SOURCE_COLORS, source) ? SOURCE_COLORS[source] : undefined) || "#6e7781";
  return `<span class="src" style="background:${c}">${esc(source)}</span>`;
}

const cards = items
  .map((it, idx) => {
    const f = it.fm;
    const skills = (f.matched_skills || "")
      .split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => `<span class="chip">${esc(s)}</span>`).join("");
    // Same vacancy on other boards (collected by dedupeJobs): "source|url, ...".
    // Split only before the next "source|" so commas inside URLs survive.
    const alt = (f.alt_links || "")
      .split(/,\s*(?=[a-z]+\|)/).map((s) => s.trim()).filter(Boolean)
      .map((pair) => {
        const sep = pair.indexOf("|");
        const src = pair.slice(0, sep), url = pair.slice(sep + 1);
        return `<a class="alt" href="${esc(safeUrl(url))}" target="_blank" rel="noopener">${esc(src)} ↗</a>`;
      }).join("");
    const altRow = alt ? `<div class="alt-row">also on: ${alt}</div>` : "";
    // The server keys state by http(s) url and 400s anything else: a card with
    // a bad url renders read-only (no status buttons / note / auto-viewed).
    const live = safeUrl(f.url) !== "#";
    const auto = live ? ` onclick="autoStatus(this.closest('.card'),'viewed')"` : "";
    return `
<article class="card"${live ? ` data-url="${esc(f.url)}"` : ""} data-generated="${esc(f.generated || "")}" data-source="${esc(f.source || "dou")}" data-score="${it.score}" data-search="${esc(((f.title||"")+" "+(f.company||"")+" "+(f.matched_skills||"")).toLowerCase())}">
  <div class="head">
    <span class="score" style="background:${scoreColor(it.score)}">${it.score}</span>
    <div class="titles">
      <h2>${esc(f.title || "—")}</h2>
      <div class="sub">${badge(f.source || "dou")} <strong>${esc(f.company || "—")}</strong> · ${esc(f.location || "")} · <span class="lang">${esc(f.cover_language || "")}</span>${f.salary ? ` · <span class="salary">${esc(f.salary)}</span>` : ""}</div>
      ${it.llm != null ? `<div class="llm-row"><span class="llm">🤖 ${it.llm}</span> <span class="llm-why">${esc(f.llm_why || "")}</span></div>` : ""}
    </div>
    <div class="actions">
      <a class="apply" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener" aria-label="Open ${esc(f.title || "—")} at ${esc(f.company || "—")}"${auto}>Open job ↗</a>
      ${live ? `<div class="status-seg" role="group" aria-label="Status">
        <button data-status="new" aria-pressed="false" onclick="setStatus(this.closest('.card'),'new')">New</button>
        <button data-status="viewed" aria-pressed="false" onclick="setStatus(this.closest('.card'),'viewed')">Viewed</button>
        <button data-status="applied" aria-pressed="false" onclick="setStatus(this.closest('.card'),'applied')">Applied</button>
        <button data-status="answered" aria-pressed="false" onclick="setStatus(this.closest('.card'),'answered')">Answered</button>
        <button data-status="interview" aria-pressed="false" onclick="setStatus(this.closest('.card'),'interview')">Interview</button>
        <button data-status="rejected" aria-pressed="false" aria-label="Rejected" onclick="setStatus(this.closest('.card'),'rejected')">✗</button>
      </div>
      <span class="applied-ago" hidden></span>` : ""}
    </div>
  </div>
  <div class="skills">${skills}</div>
  ${altRow}
  <details${live ? ` ontoggle="if(this.open) autoStatus(this.closest('.card'),'viewed')"` : ""}>
    <summary>Cover letter</summary>
    <pre id="cover${idx}" lang="${esc(f.cover_language || "en")}">${esc(it.cover)}</pre>
    <button class="copy" onclick="copyCover(${idx}, this)">Copy letter</button><span class="sr-only" role="status"></span>
    <span class="resume">📎 resume: ${esc(f.resume || "")}</span>
  </details>
  ${live ? `<details class="note-wrap">
    <summary>📝 Note <span class="note-has" hidden>●</span></summary>
    <textarea class="note" rows="3" maxlength="10000" aria-label="Private note" placeholder="Private note (saved to disk)…" onblur="saveNote(this.closest('.card'), this.value)"></textarea>
  </details>` : ""}
</article>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jobs — ${items.length}</title>
<style>
  :root { font-family: -apple-system, system-ui, sans-serif; }
  body { margin: 0; background: #f6f8fa; color: #1f2328; }
  header { position: sticky; top: 0; background: #24292f; color: #fff; padding: 14px 20px; }
  header h1 { margin: 0; font-size: 18px; }
  header .meta { font-size: 13px; opacity: .8; margin-top: 2px; }
  main { max-width: 920px; margin: 18px auto; padding: 0 14px; }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
  .head { display: flex; align-items: flex-start; gap: 12px; }
  .score { color: #fff; font-weight: 700; font-size: 15px; min-width: 38px; height: 38px; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
  .titles { flex: 1; }
  .titles h2 { margin: 0; font-size: 16px; }
  .sub { font-size: 13px; color: #57606a; margin-top: 4px; }
  .llm-row { margin-top: 4px; font-size: 12px; }
  .llm { background: #8250df; color: #fff; font-weight: 700; padding: 1px 6px; border-radius: 4px; }
  .llm-why { color: #57606a; font-style: italic; }
  .src { color: #fff; font-size: 11px; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; }
  .lang { text-transform: uppercase; font-size: 11px; color: #57606a; }
  .salary { color: #1a7f37; font-size: .8rem; white-space: nowrap; }
  .actions { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
  .apply { white-space: nowrap; text-align: center; background: #1f883d; color: #fff; text-decoration: none; padding: 7px 12px; border-radius: 7px; font-size: 13px; font-weight: 600; }
  .apply:hover { background: #1a7f37; }
  .status-seg { display: inline-flex; border: 1px solid #d0d7de; border-radius: 7px; overflow: hidden; }
  .status-seg button { flex: 1; background: #fff; color: #57606a; border: 0; border-left: 1px solid #d0d7de; padding: 6px 8px; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .status-seg button:first-child { border-left: 0; }
  .status-seg button:hover { background: #f3f4f6; }
  .status-seg button.active[data-status="new"] { background: #6e7781; color: #fff; }
  .status-seg button.active[data-status="viewed"] { background: #9a6700; color: #fff; }
  /* Muted background + heading (not whole-card opacity, which drops text
     contrast below WCAG 4.5:1). */
  .card.viewed { background: #f6f8fa; }
  .card.viewed .titles h2 { color: #57606a; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 8px; }
  .filter-seg { display: inline-flex; border: 1px solid #57606a; border-radius: 7px; overflow: hidden; }
  .filter-seg button { background: transparent; color: #cdd9e5; border: 0; border-left: 1px solid #57606a; padding: 5px 10px; font-size: 12px; cursor: pointer; }
  .filter-seg button:first-child { border-left: 0; }
  .filter-seg button:hover { background: #32383f; }
  .filter-seg button.active { background: #0969da; color: #fff; }
  .filter-seg .cnt { opacity: .7; font-size: 11px; }
  .skills { margin: 10px 0 4px; }
  .chip { display: inline-block; background: #eaf2ff; color: #0a66c2; font-size: 12px; padding: 2px 8px; border-radius: 12px; margin: 2px; }
  details { margin-top: 6px; }
  summary { cursor: pointer; font-size: 13px; color: #0969da; }
  pre { white-space: pre-wrap; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 7px; padding: 10px; font-size: 13px; font-family: inherit; }
  .copy { background: #0969da; color: #fff; border: 0; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; }
  .resume { font-size: 12px; color: #57606a; margin-left: 10px; }
  .alt-row { font-size: 12px; color: #57606a; margin: 2px 0 4px; }
  .alt { color: #0969da; text-decoration: none; margin-right: 8px; }
  .alt:hover { text-decoration: underline; }
  .empty { text-align: center; color: #57606a; padding: 40px; }
  .status-seg button.active[data-status="applied"] { background: #1a7f37; color: #fff; }
  .status-seg button.active[data-status="answered"] { background: #0969da; color: #fff; }
  .status-seg button.active[data-status="interview"] { background: #8250df; color: #fff; }
  .status-seg button.active[data-status="rejected"] { background: #cf222e; color: #fff; }
  .card.applied { border-left: 4px solid #1a7f37; }
  .card.rejected { background: #f6f8fa; border-left: 4px solid #cf222e; }
  .card.rejected .titles h2 { color: #57606a; }
  .card.rejected .titles h2::after { content: " ✗"; color: #cf222e; }   /* non-colour cue next to the red border */
  .status-seg button:focus-visible { outline: 2px solid #0969da; outline-offset: -2px; }   /* blue on white: 5.9:1 */
  /* White ring on the coloured .active fills (≥4.8:1) and on the dark header segs (~15:1);
     inset one extra px so it sits inside the fill rather than on the border. */
  .status-seg button.active:focus-visible, .filter-seg button:focus-visible, .src-seg button:focus-visible, .min-seg button:focus-visible { outline: 2px solid #fff; outline-offset: -3px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .applied-ago { font-size: 11px; color: #1a7f37; text-align: center; }
  .funnel { font-size: 12px; color: #cdd9e5; margin-top: 6px; }
  .note-wrap summary { color: #57606a; }
  .note { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; padding: 8px; border: 1px solid #d0d7de; border-radius: 7px; resize: vertical; }
  .note-has { color: #9a6700; }
  .offline, .flash { background: #9a6700; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
  .card.fresh { box-shadow: inset 3px 0 0 #0969da; }
  .ribbon { background: #0969da; color: #fff; font-size: 10px; padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
  #q { flex: 1; min-width: 160px; padding: 5px 10px; border-radius: 7px; border: 1px solid #57606a; background: #32383f; color: #fff; font-size: 13px; }
  #q::placeholder { color: #9aa5b1; }
  .src-seg, .min-seg { display: inline-flex; border: 1px solid #57606a; border-radius: 7px; overflow: hidden; }
  .src-seg button, .min-seg button { background: transparent; color: #cdd9e5; border: 0; border-left: 1px solid #57606a; padding: 5px 10px; font-size: 12px; cursor: pointer; }
  .src-seg button:first-child, .min-seg button:first-child { border-left: 0; }
  .src-seg button.active, .min-seg button.active { background: #0969da; color: #fff; }
  @media (max-width: 640px) { .head { flex-wrap: wrap; } .actions { width: 100%; } }
</style></head>
<body>
<header>
  <h1>🎯 Matching jobs: ${items.length}</h1>
  <div class="meta" aria-live="polite">Updated: ${new Date().toLocaleString("en-US")} · sorted by relevance · nothing is sent automatically</div>
  <div class="toolbar">
    <div class="filter-seg" role="group" aria-label="Filter by status">
      <button data-filter="all" aria-pressed="false" onclick="setFilter('all')">All <span class="cnt" id="cnt-all">0</span></button>
      <button data-filter="new" class="active" aria-pressed="true" onclick="setFilter('new')">New <span class="cnt" id="cnt-new">0</span></button>
      <button data-filter="viewed" aria-pressed="false" onclick="setFilter('viewed')">Viewed <span class="cnt" id="cnt-viewed">0</span></button>
      <button data-filter="applied" aria-pressed="false" onclick="setFilter('applied')">Applied <span class="cnt" id="cnt-applied">0</span></button>
      <button data-filter="answered" aria-pressed="false" onclick="setFilter('answered')">Answered <span class="cnt" id="cnt-answered">0</span></button>
      <button data-filter="interview" aria-pressed="false" onclick="setFilter('interview')">Interview <span class="cnt" id="cnt-interview">0</span></button>
    </div>
    <input id="q" type="search" aria-label="Search title, company or skills" placeholder="Search title / company / skills…" oninput="setQuery(this.value)" />
    <div class="src-seg" role="group" aria-label="Source">
      <button data-src="all" class="active" aria-pressed="true" onclick="setSource('all')">All</button>
      <button data-src="linkedin" aria-pressed="false" onclick="setSource('linkedin')">LinkedIn</button>
      <button data-src="dou" aria-pressed="false" onclick="setSource('dou')">DOU</button>
      <button data-src="djinni" aria-pressed="false" onclick="setSource('djinni')">Djinni</button>
      <button data-src="jooble" aria-pressed="false" onclick="setSource('jooble')">Jooble</button>
      <button data-src="robota" aria-pressed="false" onclick="setSource('robota')">Robota</button>
      <button data-src="glassdoor" aria-pressed="false" onclick="setSource('glassdoor')">Glassdoor</button>
      <button data-src="workua" aria-pressed="false" onclick="setSource('workua')">Work.ua</button>
    </div>
    <div class="min-seg" role="group" aria-label="Minimum score">
      <button data-min="0" class="active" aria-pressed="true" onclick="setMin(this,0)">All</button>
      <button data-min="30" aria-pressed="false" onclick="setMin(this,30)">≥30</button>
      <button data-min="40" aria-pressed="false" onclick="setMin(this,40)">≥40</button>
    </div>
  </div>
  <div class="funnel" id="funnel"></div>
</header>
<main>
${items.length ? cards : '<div class="empty">No matching jobs yet. Run <code>node jobs.mjs</code>.</div>'}
</main>
<script>
${clientJs}
</script>
</body></html>`;

// Atomic: the state server serves this file, a half-written page must never be visible.
writeTextAtomic(OUT, html);
console.log(`Dashboard: ${OUT} (${items.length} jobs)`);

// Best-effort: opening a browser is a convenience, not a requirement.
if (process.argv.includes("--open")) {
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [OUT], () => {});
}
