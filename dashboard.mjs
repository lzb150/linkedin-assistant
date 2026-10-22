// Builds a single self-contained HTML dashboard of all application packages
// in applications/, sorted by score. Run:  node dashboard.mjs [--open]
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeTextAtomic } from "./lib/json-file.mjs";
import { readPackages } from "./lib/packages.mjs";
import { parse, toItem, collapseItems, renderCard, sourceChips } from "./lib/dashboard-render.mjs";
import { readJobsConfig } from "./lib/jobs-config.mjs";
import { candidateCountryList } from "./lib/filters.mjs";
import { execFile } from "node:child_process";

const __dir = dirname(fileURLToPath(import.meta.url));
const APPS = join(__dir, "applications");
const OUT = join(APPS, "index.html");
// Fresh clone has no applications/ yet; build an empty dashboard instead of crashing.
mkdirSync(APPS, { recursive: true, mode: 0o700 });   // see jobs.mjs: owner-only at creation

// The client script ships as two standalone files inlined at build time:
// the unit-tested pure core (.cjs so node:test can require it) and the DOM
// glue. Interpolated text is not re-parsed, so backticks in them are safe;
// a </script tag (any case/spacing) would terminate the tag mid-file — refuse to build.
const clientJs = ["dashboard-client-core.cjs", "dashboard-client-dom.js"]
  .map((f) => readFileSync(join(__dir, "lib", f), "utf8"))
  .join("\n");
if (/<\/script/i.test(clientJs)) throw new Error("dashboard client JS must not contain </script>");
// The skin lives next to the client script, inlined the same way (and refused
// on a </style tag for the same reason). A plain .css file: editors highlight
// it, and a palette change diffs on its own instead of inside this builder.
const css = readFileSync(join(__dir, "lib", "dashboard.css"), "utf8");
if (/<\/style/i.test(css)) throw new Error("dashboard CSS must not contain </style>");

// The shared reader skips what cannot be read (a directory named x.md, a
// permission error) with a warning instead of aborting the build. `raw` asks it
// for the body too — the cover note is not frontmatter — so each package is
// read once instead of twice, and a package archived between the two reads can
// no longer disappear underneath us.
const warn = (f, e) => console.warn(`unreadable package skipped: ${f} (${e.message})`);
const items = collapseItems(readPackages(APPS, { warn, raw: true })
  .map(({ _raw }) => parse(_raw))
  .filter(Boolean)
  .map(toItem));
// Only candidateCountry is read, for the "<country> listed" mark on remote-board
// cards. A missing or broken config is jobs.mjs's to report; here it just means
// the default country.
let candidateCountry;
try { candidateCountry = readJobsConfig(join(__dir, "jobs.config.json")).candidateCountry; } catch {}
const countries = candidateCountryList(candidateCountry);
const llmInUse = items.some((it) => it.llm != null);
const cards = items.map((it, i) => renderCard(it, i, { countries, llmInUse })).join("\n");

// no-referrer: "Open job ↗" and the alt links would tell every board the
// visit came from 127.0.0.1:7777 (http → https is not a downgrade).
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Jobs — ${items.length}</title>
<script>try { var t = localStorage.getItem("jobTheme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}</script>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" referrerpolicy="no-referrer" href="https://fonts.googleapis.com/css2?family=Exo+2:wght@400;600;700&family=JetBrains+Mono:wght@400;600&family=Tektur:wght@500;700&display=swap">
<style>
${css}</style></head>
<body>
<header>
  <h1><span class="glitch" data-text="Matching jobs">Matching jobs</span> <span class="count"><span aria-hidden="true">// </span>${items.length}</span></h1>
  <div class="meta" aria-live="polite">Updated: ${new Date().toLocaleString("en-US")} · sorted by relevance · nothing is sent automatically</div>
  <div class="toolbar">
    <div class="filter-seg" role="group" aria-label="Filter by status">
      <button data-filter="new" class="active" aria-pressed="true" onclick="setFilter('new')">New <span class="cnt" id="cnt-new">0</span></button>
      <button data-filter="viewed" class="active" aria-pressed="true" onclick="setFilter('viewed')">Viewed <span class="cnt" id="cnt-viewed">0</span></button>
    </div>
    <input id="q" type="search" aria-label="Search title, company or skills" placeholder="Search title / company / skills…" oninput="setQuery(this.value)" />
    <div class="src-seg" role="group" aria-label="Source">
      <button data-src="all" class="active" aria-pressed="true" onclick="setSource(this.dataset.src)">All</button>
      ${sourceChips(items)}
    </div>
    <span id="shown" class="sr-only" role="status"></span>
    <button id="theme" class="theme" type="button" aria-pressed="false" aria-label="Dark theme" onclick="toggleTheme()">Dark</button>
  </div>
</header>
<main>
${items.length ? cards : '<div class="empty">No matching jobs yet. Run <code>node jobs.mjs</code>.</div>'}
<div class="empty" id="no-match" hidden>No jobs match these filters.</div>
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
