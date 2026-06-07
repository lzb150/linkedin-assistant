// Builds a single self-contained HTML dashboard of all application packages
// in applications/, sorted by score. Run:  node dashboard.mjs [--open]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const APPS = join(__dir, "applications");
const OUT = join(APPS, "index.html");

function parse(md) {
  const fm = {};
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  // cover note = text between "## Cover note" and "## Action"
  const cover = (m[2].match(/## Cover note[^\n]*\n([\s\S]*?)\n## Action/) || [])[1] || "";
  return { fm, cover: cover.trim() };
}

const esc = (s) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const files = readdirSync(APPS).filter((f) => f.endsWith(".md"));
const items = files
  .map((f) => parse(readFileSync(join(APPS, f), "utf8")))
  .filter(Boolean)
  .map((x) => ({ ...x, score: parseInt(x.fm.score || "0", 10) }))
  .sort((a, b) => b.score - a.score);

function scoreColor(s) {
  if (s >= 40) return "#1a7f37";   // green
  if (s >= 30) return "#9a6700";   // amber
  return "#6e7781";                 // gray
}

function badge(source) {
  const c = source === "linkedin" ? "#0a66c2" : "#e8453c";
  return `<span class="src" style="background:${c}">${esc(source)}</span>`;
}

const cards = items
  .map((it, idx) => {
    const f = it.fm;
    const skills = (f.matched_skills || "")
      .split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => `<span class="chip">${esc(s)}</span>`).join("");
    return `
<article class="card" data-url="${esc(f.url)}">
  <div class="head">
    <span class="score" style="background:${scoreColor(it.score)}">${it.score}</span>
    <div class="titles">
      <h2>${esc(f.title || "—")}</h2>
      <div class="sub">${badge(f.source || "dou")} <strong>${esc(f.company || "—")}</strong> · ${esc(f.location || "")} · <span class="lang">${esc(f.cover_language || "")}</span></div>
    </div>
    <div class="actions">
      <a class="apply" href="${esc(f.url)}" target="_blank" rel="noopener">Open job ↗</a>
      <div class="status-seg" role="group" aria-label="Status">
        <button data-status="new" onclick="setStatus(this,'new')">New</button>
        <button data-status="viewed" onclick="setStatus(this,'viewed')">Viewed</button>
        <button data-status="applied" onclick="setStatus(this,'applied')">Applied</button>
      </div>
    </div>
  </div>
  <div class="skills">${skills}</div>
  <details>
    <summary>Cover letter</summary>
    <pre id="cover${idx}">${esc(it.cover)}</pre>
    <button class="copy" onclick="copyCover(${idx})">Copy letter</button>
    <span class="resume">📎 resume: ${esc(f.resume || "")}</span>
  </details>
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
  .src { color: #fff; font-size: 11px; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; }
  .lang { text-transform: uppercase; font-size: 11px; color: #57606a; }
  .actions { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
  .apply { white-space: nowrap; text-align: center; background: #1f883d; color: #fff; text-decoration: none; padding: 7px 12px; border-radius: 7px; font-size: 13px; font-weight: 600; }
  .apply:hover { background: #1a7f37; }
  .status-seg { display: inline-flex; border: 1px solid #d0d7de; border-radius: 7px; overflow: hidden; }
  .status-seg button { flex: 1; background: #fff; color: #57606a; border: 0; border-left: 1px solid #d0d7de; padding: 6px 8px; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .status-seg button:first-child { border-left: 0; }
  .status-seg button:hover { background: #f3f4f6; }
  .status-seg button.active[data-status="new"] { background: #6e7781; color: #fff; }
  .status-seg button.active[data-status="viewed"] { background: #9a6700; color: #fff; }
  .status-seg button.active[data-status="applied"] { background: #1f883d; color: #fff; }
  .card.viewed { opacity: .55; }
  .card.applied { border-left: 4px solid #1f883d; }
  .card.applied .titles h2::after { content: " ✓"; color: #1f883d; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 8px; }
  .filter-seg { display: inline-flex; border: 1px solid #57606a; border-radius: 7px; overflow: hidden; }
  .filter-seg button { background: transparent; color: #cdd9e5; border: 0; border-left: 1px solid #57606a; padding: 5px 10px; font-size: 12px; cursor: pointer; }
  .filter-seg button:first-child { border-left: 0; }
  .filter-seg button:hover { background: #32383f; }
  .filter-seg button.active { background: #0969da; color: #fff; }
  .filter-seg .cnt { opacity: .7; font-size: 11px; }
  .io { display: inline-flex; gap: 6px; }
  .io button { background: #32383f; color: #cdd9e5; border: 1px solid #57606a; padding: 5px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .io button:hover { background: #3c434b; }
  .skills { margin: 10px 0 4px; }
  .chip { display: inline-block; background: #eaf2ff; color: #0a66c2; font-size: 12px; padding: 2px 8px; border-radius: 12px; margin: 2px; }
  details { margin-top: 6px; }
  summary { cursor: pointer; font-size: 13px; color: #0969da; }
  pre { white-space: pre-wrap; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 7px; padding: 10px; font-size: 13px; font-family: inherit; }
  .copy { background: #0969da; color: #fff; border: 0; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; }
  .resume { font-size: 12px; color: #57606a; margin-left: 10px; }
  .empty { text-align: center; color: #57606a; padding: 40px; }
</style></head>
<body>
<header>
  <h1>🎯 Matching jobs: ${items.length}</h1>
  <div class="meta">Updated: ${new Date().toLocaleString("en-US")} · sorted by relevance · nothing is sent automatically</div>
  <div class="toolbar">
    <div class="filter-seg" role="group" aria-label="Filter by status">
      <button data-filter="all" class="active" onclick="setFilter(this,'all')">All <span class="cnt" id="cnt-all">0</span></button>
      <button data-filter="new" onclick="setFilter(this,'new')">New <span class="cnt" id="cnt-new">0</span></button>
      <button data-filter="viewed" onclick="setFilter(this,'viewed')">Viewed <span class="cnt" id="cnt-viewed">0</span></button>
      <button data-filter="applied" onclick="setFilter(this,'applied')">Applied <span class="cnt" id="cnt-applied">0</span></button>
    </div>
    <div class="io">
      <button onclick="exportStatus()">Export</button>
      <button onclick="document.getElementById('importFile').click()">Import</button>
      <input type="file" id="importFile" accept="application/json,.json" hidden onchange="importStatus(this.files[0]); this.value='';">
    </div>
  </div>
</header>
<main>
${items.length ? cards : '<div class="empty">No matching jobs yet. Run <code>node jobs.mjs</code>.</div>'}
</main>
<script>
function copyCover(i){
  const t = document.getElementById('cover'+i).innerText;
  navigator.clipboard.writeText(t).then(()=>{
    event.target.textContent='✓ Copied';
    setTimeout(()=>event.target.textContent='Copy letter',1500);
  });
}

// Job status persists in localStorage keyed by job URL, so it survives dashboard
// regeneration (jobs.mjs rewrites this file on every run). Map shape:
// { "<url>": "viewed" | "applied" }. A missing entry means status "new".
const STATUS_KEY = 'jobStatus';
const LEGACY_SEEN_KEY = 'dashboardSeenJobs';

function loadStatus(){
  let map = {};
  try { map = JSON.parse(localStorage.getItem(STATUS_KEY) || '{}'); } catch {}
  if (typeof map !== 'object' || map === null || Array.isArray(map)) map = {};
  // One-time migration from the old binary "seen" Set: each becomes "viewed".
  const legacy = localStorage.getItem(LEGACY_SEEN_KEY);
  if (legacy !== null) {
    try { for (const url of JSON.parse(legacy)) { if (!map[url]) map[url] = 'viewed'; } } catch {}
    localStorage.removeItem(LEGACY_SEEN_KEY);
    localStorage.setItem(STATUS_KEY, JSON.stringify(map));
  }
  return map;
}
function saveStatus(){ localStorage.setItem(STATUS_KEY, JSON.stringify(statusMap)); }

let statusMap = loadStatus();
let activeFilter = 'all';

const statusOf = (url) => statusMap[url] || 'new';

function renderCard(card){
  const st = statusOf(card.dataset.url);
  card.classList.toggle('viewed', st === 'viewed');
  card.classList.toggle('applied', st === 'applied');
  card.querySelectorAll('.status-seg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.status === st);
  });
}

function setStatus(btn, status){
  const card = btn.closest('.card');
  const url = card.dataset.url;
  if (status === 'new') delete statusMap[url]; else statusMap[url] = status;
  saveStatus();
  renderCard(card);
  applyFilter();
}

function applyFilter(){
  const counts = { all: 0, new: 0, viewed: 0, applied: 0 };
  document.querySelectorAll('.card').forEach((card) => {
    const st = statusOf(card.dataset.url);
    counts.all++; counts[st]++;
    card.style.display = (activeFilter === 'all' || activeFilter === st) ? '' : 'none';
  });
  for (const k of ['all', 'new', 'viewed', 'applied']) {
    const el = document.getElementById('cnt-' + k);
    if (el) el.textContent = counts[k];
  }
}

function setFilter(btn, filter){
  activeFilter = filter;
  document.querySelectorAll('.filter-seg button').forEach((b) => b.classList.toggle('active', b === btn));
  applyFilter();
}

function exportStatus(){
  const blob = new Blob([JSON.stringify(statusMap, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'job-status.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importStatus(file){
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let incoming;
    try { incoming = JSON.parse(reader.result); } catch { return; }
    if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) return;
    for (const [url, st] of Object.entries(incoming)) {
      if (st === 'viewed' || st === 'applied') statusMap[url] = st;
    }
    saveStatus();
    document.querySelectorAll('.card').forEach(renderCard);
    applyFilter();
  };
  reader.readAsText(file);
}

// Restore saved state on load.
document.querySelectorAll('.card').forEach(renderCard);
applyFilter();
</script>
</body></html>`;

writeFileSync(OUT, html);
console.log(`Dashboard: ${OUT} (${items.length} jobs)`);

if (process.argv.includes("--open")) {
  execFile("open", [OUT], () => {});
}
