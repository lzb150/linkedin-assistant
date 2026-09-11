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
  // Anchored to a line start: a job TITLE of "## Cover note" sits in the H1 ("# ## Cover note — …") and must not match.
  const cover = (md.match(/^## Cover note[^\n]*\n([\s\S]*?)\n## Action/m) || [])[1] || "";
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
// vacancy (boards used to change a job's URL between runs when seen was URL-keyed).
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

// Score band → CSS class (colours live in the theme tokens, see <style>).
function scoreBand(s) {
  if (s >= 40) return "hi";    // green
  if (s >= 30) return "mid";   // amber
  return "lo";                  // gray
}

// Per-source badge colour. Unknown/future sources fall back to gray.
// All ≥ 4.5:1 against white text (WCAG AA for the 11px badge).
const SOURCE_COLORS = { linkedin: "#0a66c2", dou: "#c93c33", djinni: "#3d3bd4" };
function badge(source) {
  const c = (Object.hasOwn(SOURCE_COLORS, source) ? SOURCE_COLORS[source] : undefined) || "#6e7781";
  return `<span class="src" style="background:${c}">${esc(source)}</span>`;
}

// Source chips only for boards that actually have packages on disk: a disabled
// board's chip disappears by itself once its last package is archived.
const SOURCE_LABELS = { linkedin: "LinkedIn", dou: "DOU", djinni: "Djinni" };
const sourceChips = [...new Set(items.map((it) => it.fm.source || "dou"))].sort()
  .map((src) => `<button data-src="${esc(src)}" aria-pressed="false" onclick="setSource(this.dataset.src)">${esc(SOURCE_LABELS[src] || src)}</button>`)
  .join("\n      ");

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
<article class="card"${live ? ` data-url="${esc(f.url)}"` : ""} data-generated="${esc(f.generated || "")}" data-source="${esc(f.source || "dou")}" data-search="${esc(((f.title||"")+" "+(f.company||"")+" "+(f.matched_skills||"")).toLowerCase())}">
  <div class="head">
    <span class="score ${scoreBand(it.score)}" aria-label="keyword score ${it.score}">${it.score}</span>
    <div class="titles">
      <h2>${esc(f.title || "—")}</h2>
      <div class="sub">${badge(f.source || "dou")} <strong>${esc(f.company || "—")}</strong> · ${esc(f.location || "")} · <span class="lang">${esc(f.cover_language || "")}</span>${f.salary ? ` · <span class="salary">${esc(f.salary)}</span>` : ""}</div>
      ${it.llm != null ? `<div class="llm-row"><span class="llm"><span class="sr-only">LLM fit </span><span aria-hidden="true">🤖</span> ${it.llm}</span> <span class="llm-why">${esc(f.llm_why || "")}</span></div>` : ""}
    </div>
    <div class="actions">
      <a class="apply" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener" aria-label="Open ${esc(f.title || "—")} at ${esc(f.company || "—")}"${auto}>Open job ↗</a>
      ${live ? `<div class="status-seg" role="group" aria-label="Status">
        <button data-status="new" aria-pressed="false" onclick="setStatus(this.closest('.card'),'new')">New</button>
        <button data-status="viewed" aria-pressed="false" onclick="setStatus(this.closest('.card'),'viewed')">Viewed</button>
        <button data-status="rejected" aria-pressed="false" aria-label="Not for me" title="Not for me" onclick="setStatus(this.closest('.card'),'rejected')">✗</button>
      </div>` : ""}
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
<script>try { var t = localStorage.getItem("jobTheme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}</script>
<style>
  /* Palette = GitHub Primer: light values are the ones this page always used, the
     dark block is Primer's "dark default" (canvas #0d1117 / #161b22, border
     #30363d, fg #e6edf3 / #8b949e, *-emphasis fills for buttons). Every text /
     background pair was checked ≥ 4.5:1; white on each emphasis fill is 4.6+.
     Theme: system preference by default; the header toggle sets data-theme on
     <html> (persisted in localStorage) and wins in both directions. */
  :root {
    font-family: -apple-system, system-ui, sans-serif;
    color-scheme: light;
    --bg: #f6f8fa; --card: #fff; --card-muted: #f6f8fa; --border: #d0d7de;
    --text: #1f2328; --muted: #57606a;
    --header-bg: #24292f; --header-text: #fff; --header-muted: #cdd9e5; --header-border: #57606a; --header-hover: #32383f;
    --input-bg: #32383f; --placeholder: #9aa5b1;
    --btn-bg: #fff; --btn-text: #57606a; --btn-hover: #f3f4f6;
    --accent: #0969da; --accent-fill: #0969da; --focus: #0969da;
    --success-fill: #1f883d; --success-fill-hover: #1a7f37; --success-text: #1a7f37;
    --attention-fill: #9a6700; --attention-text: #9a6700;
    --danger-fill: #cf222e; --danger-text: #cf222e;
    --done-fill: #8250df; --neutral-fill: #6e7781; --closed-border: #8c959f;
    --chip-bg: #eaf2ff; --chip-text: #0a66c2;
    --score-hi: #1a7f37; --score-mid: #9a6700; --score-lo: #6e7781;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #0d1117; --card: #161b22; --card-muted: #0d1117; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e;
    --header-bg: #010409; --header-text: #e6edf3; --header-muted: #c9d1d9; --header-border: #30363d; --header-hover: #21262d;
    --input-bg: #0d1117; --placeholder: #6e7681;
    --btn-bg: #21262d; --btn-text: #c9d1d9; --btn-hover: #30363d;
    --accent: #58a6ff; --accent-fill: #1f6feb; --focus: #58a6ff;
    --success-fill: #238636; --success-fill-hover: #1a7f37; --success-text: #3fb950;
    --attention-fill: #9e6a03; --attention-text: #d29922;
    --danger-fill: #da3633; --danger-text: #f85149;
    --done-fill: #8957e5; --neutral-fill: #6e7681; --closed-border: #6e7681;
    --chip-bg: #0d2440; --chip-text: #79c0ff;
    --score-hi: #238636; --score-mid: #9e6a03; --score-lo: #6e7681;
  } }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #0d1117; --card: #161b22; --card-muted: #0d1117; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e;
    --header-bg: #010409; --header-text: #e6edf3; --header-muted: #c9d1d9; --header-border: #30363d; --header-hover: #21262d;
    --input-bg: #0d1117; --placeholder: #6e7681;
    --btn-bg: #21262d; --btn-text: #c9d1d9; --btn-hover: #30363d;
    --accent: #58a6ff; --accent-fill: #1f6feb; --focus: #58a6ff;
    --success-fill: #238636; --success-fill-hover: #1a7f37; --success-text: #3fb950;
    --attention-fill: #9e6a03; --attention-text: #d29922;
    --danger-fill: #da3633; --danger-text: #f85149;
    --done-fill: #8957e5; --neutral-fill: #6e7681; --closed-border: #6e7681;
    --chip-bg: #0d2440; --chip-text: #79c0ff;
    --score-hi: #238636; --score-mid: #9e6a03; --score-lo: #6e7681;
  }
  html { scroll-padding-top: 130px; }   /* sticky header: a card focused via Shift-Tab must not scroll under it */
  body { margin: 0; background: var(--bg); color: var(--text); }
  header { position: sticky; top: 0; background: var(--header-bg); color: var(--header-text); padding: 14px 20px; }
  header h1 { margin: 0; font-size: 18px; }
  header .meta { font-size: 13px; opacity: .8; margin-top: 2px; }
  main { max-width: 920px; margin: 18px auto; padding: 0 14px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
  .head { display: flex; align-items: flex-start; gap: 12px; }
  .score { color: #fff; font-weight: 700; font-size: 15px; min-width: 38px; height: 38px; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
  .score.hi { background: var(--score-hi); } .score.mid { background: var(--score-mid); } .score.lo { background: var(--score-lo); }
  .titles { flex: 1; }
  .titles h2 { margin: 0; font-size: 16px; }
  .sub { font-size: 13px; color: var(--muted); margin-top: 4px; }
  .llm-row { margin-top: 4px; font-size: 12px; }
  .llm { background: var(--done-fill); color: #fff; font-weight: 700; padding: 1px 6px; border-radius: 4px; }
  .llm-why { color: var(--muted); font-style: italic; }
  .src { color: #fff; font-size: 11px; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; }
  .lang { text-transform: uppercase; font-size: 11px; color: var(--muted); }
  .salary { color: var(--success-text); font-size: .8rem; white-space: nowrap; }
  .actions { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
  .apply { white-space: nowrap; text-align: center; background: var(--success-fill); color: #fff; text-decoration: none; padding: 7px 12px; border-radius: 7px; font-size: 13px; font-weight: 600; }
  .apply:hover { background: var(--success-fill-hover); }
  .status-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
  .status-seg button { flex: 1; background: var(--btn-bg); color: var(--btn-text); border: 0; border-left: 1px solid var(--border); padding: 6px 8px; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .status-seg button:first-child { border-left: 0; }
  .status-seg button:hover { background: var(--btn-hover); }
  .status-seg button.active[data-status="new"] { background: var(--neutral-fill); color: #fff; }
  .status-seg button.active[data-status="viewed"] { background: var(--attention-fill); color: #fff; }
  /* Muted background + heading (not whole-card opacity, which drops text
     contrast below WCAG 4.5:1). */
  .card.viewed { background: var(--card-muted); }
  .card.viewed .titles h2 { color: var(--muted); }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 8px; }
  .filter-seg, .src-seg { display: inline-flex; border: 1px solid var(--header-border); border-radius: 7px; overflow: hidden; }
  .filter-seg button, .src-seg button, .theme { background: transparent; color: var(--header-muted); border: 0; border-left: 1px solid var(--header-border); padding: 5px 10px; font-size: 12px; cursor: pointer; }
  .filter-seg button:first-child, .src-seg button:first-child { border-left: 0; }
  .filter-seg button:hover, .src-seg button:hover, .theme:hover { background: var(--header-hover); }
  .filter-seg button.active, .src-seg button.active { background: var(--accent-fill); color: #fff; }
  .filter-seg .cnt { font-size: 11px; font-weight: 400; }   /* no opacity: 70% white on the active blue was 3.34:1 */
  .theme { border: 1px solid var(--header-border); border-radius: 7px; margin-left: auto; }
  .skills { margin: 10px 0 4px; }
  .chip { display: inline-block; background: var(--chip-bg); color: var(--chip-text); font-size: 12px; padding: 2px 8px; border-radius: 12px; margin: 2px; }
  details { margin-top: 6px; }
  summary { cursor: pointer; font-size: 13px; color: var(--accent); }
  pre { white-space: pre-wrap; background: var(--card-muted); border: 1px solid var(--border); border-radius: 7px; padding: 10px; font-size: 13px; font-family: inherit; }
  .copy { background: var(--accent-fill); color: #fff; border: 0; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; }
  .resume { font-size: 12px; color: var(--muted); margin-left: 10px; }
  .alt-row { font-size: 12px; color: var(--muted); margin: 2px 0 4px; }
  .alt { color: var(--accent); text-decoration: none; margin-right: 8px; }
  .alt:hover { text-decoration: underline; }
  .empty { text-align: center; color: var(--muted); padding: 40px; }
  .status-seg button.active[data-status="rejected"] { background: var(--danger-fill); color: #fff; }
  .card.rejected { background: var(--card-muted); border-left: 4px solid var(--danger-fill); }
  .card.rejected .titles h2 { color: var(--muted); }
  .card.rejected .titles h2::after { content: " ✗"; color: var(--danger-text); }   /* non-colour cue next to the red border */
  /* Board reported the vacancy inactive (closed-check.mjs): muted like viewed, with a text cue. */
  .card.closed { background: var(--card-muted); border-left: 4px solid var(--closed-border); }
  .card.closed .titles h2 { color: var(--muted); }
  .card.closed .titles h2::after { content: " · closed"; color: var(--muted); font-weight: 400; font-size: 13px; }
  .status-seg button:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }   /* blue on white: 5.9:1 */
  /* White ring on the coloured .active fills (≥4.8:1) and on the dark header segs (~15:1);
     inset one extra px so it sits inside the fill rather than on the border. */
  .status-seg button.active:focus-visible, .filter-seg button:focus-visible, .src-seg button:focus-visible, .theme:focus-visible { outline: 2px solid #fff; outline-offset: -3px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .note-wrap summary { color: var(--muted); }
  .note { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; padding: 8px; border: 1px solid var(--border); border-radius: 7px; resize: vertical; background: var(--card); color: var(--text); }
  .note-has { color: var(--attention-text); }
  .offline, .flash { background: var(--attention-fill); color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
  .card.fresh { box-shadow: inset 3px 0 0 var(--accent-fill); }
  .ribbon { background: var(--accent-fill); color: #fff; font-size: 10px; padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
  #q { flex: 1; min-width: 160px; padding: 5px 10px; border-radius: 7px; border: 1px solid var(--header-border); background: var(--input-bg); color: var(--header-text); font-size: 13px; }
  #q::placeholder { color: var(--placeholder); }
  @media (max-width: 640px) { .head { flex-wrap: wrap; } .actions { width: 100%; } }
</style></head>
<body>
<header>
  <h1><span aria-hidden="true">🎯</span> Matching jobs: ${items.length}</h1>
  <div class="meta" aria-live="polite">Updated: ${new Date().toLocaleString("en-US")} · sorted by relevance · nothing is sent automatically</div>
  <div class="toolbar">
    <div class="filter-seg" role="group" aria-label="Filter by status">
      <button data-filter="new" class="active" aria-pressed="true" onclick="setFilter('new')">New <span class="cnt" id="cnt-new">0</span></button>
      <button data-filter="viewed" class="active" aria-pressed="true" onclick="setFilter('viewed')">Viewed <span class="cnt" id="cnt-viewed">0</span></button>
    </div>
    <input id="q" type="search" aria-label="Search title, company or skills" placeholder="Search title / company / skills…" oninput="setQuery(this.value)" />
    <div class="src-seg" role="group" aria-label="Source">
      <button data-src="all" class="active" aria-pressed="true" onclick="setSource(this.dataset.src)">All</button>
      ${sourceChips}
    </div>
    <button id="theme" class="theme" type="button" aria-pressed="false" onclick="toggleTheme()">🌙 Dark</button>
  </div>
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
