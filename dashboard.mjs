// Builds a single self-contained HTML dashboard of all application packages
// in applications/, sorted by score. Run:  node dashboard.mjs [--open]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { identityKey } from "./lib/dedup.mjs";
import { parseFrontmatter } from "./lib/frontmatter.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const APPS = join(__dir, "applications");
const OUT = join(APPS, "index.html");

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
    score: parseInt(x.fm.score || "0", 10),
    llm: /^\d+$/.test(x.fm.llm_score || "") ? parseInt(x.fm.llm_score, 10) : null,
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
  const key = identityKey({ company: it.fm.company, title: it.fm.title });
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
const SOURCE_COLORS = { linkedin: "#0a66c2", dou: "#e8453c", djinni: "#3d3bd4", jooble: "#0a8f6c" };
function badge(source) {
  const c = SOURCE_COLORS[source] || "#6e7781";
  return `<span class="src" style="background:${c}">${esc(source)}</span>`;
}

const cards = items
  .map((it, idx) => {
    const f = it.fm;
    const skills = (f.matched_skills || "")
      .split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => `<span class="chip">${esc(s)}</span>`).join("");
    // Same vacancy on other boards (collected by dedupeJobs): "source|url, ...".
    const alt = (f.alt_links || "")
      .split(",").map((s) => s.trim()).filter(Boolean)
      .map((pair) => {
        const sep = pair.indexOf("|");
        const src = pair.slice(0, sep), url = pair.slice(sep + 1);
        return `<a class="alt" href="${esc(safeUrl(url))}" target="_blank" rel="noopener">${esc(src)} ↗</a>`;
      }).join("");
    const altRow = alt ? `<div class="alt-row">also on: ${alt}</div>` : "";
    return `
<article class="card" data-url="${esc(f.url)}" data-generated="${esc(f.generated || "")}" data-source="${esc(f.source || "dou")}" data-score="${it.score}" data-search="${esc(((f.title||"")+" "+(f.company||"")+" "+(f.matched_skills||"")).toLowerCase())}">
  <div class="head">
    <span class="score" style="background:${scoreColor(it.score)}">${it.score}</span>
    <div class="titles">
      <h2>${esc(f.title || "—")}</h2>
      <div class="sub">${badge(f.source || "dou")} <strong>${esc(f.company || "—")}</strong> · ${esc(f.location || "")} · <span class="lang">${esc(f.cover_language || "")}</span>${f.salary ? ` · <span class="salary">${esc(f.salary)}</span>` : ""}</div>
      ${it.llm != null ? `<div class="llm-row"><span class="llm">🤖 ${it.llm}</span> <span class="llm-why">${esc(f.llm_why || "")}</span></div>` : ""}
    </div>
    <div class="actions">
      <a class="apply" href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener" onclick="autoStatus(this.closest('.card'),'viewed')">Open job ↗</a>
      <div class="status-seg" role="group" aria-label="Status">
        <button data-status="new" onclick="setStatus(this.closest('.card'),'new')">New</button>
        <button data-status="viewed" onclick="setStatus(this.closest('.card'),'viewed')">Viewed</button>
        <button data-status="applied" onclick="setStatus(this.closest('.card'),'applied')">Applied</button>
        <button data-status="answered" onclick="setStatus(this.closest('.card'),'answered')">Answered</button>
        <button data-status="interview" onclick="setStatus(this.closest('.card'),'interview')">Interview</button>
        <button data-status="rejected" onclick="setStatus(this.closest('.card'),'rejected')">✗</button>
      </div>
      <span class="applied-ago" hidden></span>
    </div>
  </div>
  <div class="skills">${skills}</div>
  ${altRow}
  <details ontoggle="if(this.open) autoStatus(this.closest('.card'),'viewed')">
    <summary>Cover letter</summary>
    <pre id="cover${idx}">${esc(it.cover)}</pre>
    <button class="copy" onclick="copyCover(${idx}, this)">Copy letter</button>
    <span class="resume">📎 resume: ${esc(f.resume || "")}</span>
  </details>
  <details class="note-wrap">
    <summary>📝 Note <span class="note-has" hidden>●</span></summary>
    <textarea class="note" rows="3" placeholder="Private note (saved to disk)…" onblur="saveNote(this.closest('.card'), this.value)"></textarea>
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
  .card.rejected { opacity: .45; }
  .applied-ago { font-size: 11px; color: #1a7f37; text-align: center; }
  .funnel { font-size: 12px; color: #cdd9e5; margin-top: 6px; }
  .note-wrap summary { color: #57606a; }
  .note { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; padding: 8px; border: 1px solid #d0d7de; border-radius: 7px; resize: vertical; }
  .note-has { color: #9a6700; }
  .offline { background: #9a6700; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
  .card.fresh { box-shadow: inset 3px 0 0 #0969da; }
  .ribbon { background: #0969da; color: #fff; font-size: 10px; padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
  #q { flex: 1; min-width: 160px; padding: 5px 10px; border-radius: 7px; border: 1px solid #57606a; background: #32383f; color: #fff; font-size: 13px; }
  #q::placeholder { color: #9aa5b1; }
  .src-seg, .min-seg { display: inline-flex; border: 1px solid #57606a; border-radius: 7px; overflow: hidden; }
  .src-seg button, .min-seg button { background: transparent; color: #cdd9e5; border: 0; border-left: 1px solid #57606a; padding: 5px 10px; font-size: 12px; cursor: pointer; }
  .src-seg button:first-child, .min-seg button:first-child { border-left: 0; }
  .src-seg button.active, .min-seg button.active { background: #0969da; color: #fff; }
</style></head>
<body>
<header>
  <h1>🎯 Matching jobs: ${items.length}</h1>
  <div class="meta">Updated: ${new Date().toLocaleString("en-US")} · sorted by relevance · nothing is sent automatically</div>
  <div class="toolbar">
    <div class="filter-seg" role="group" aria-label="Filter by status">
      <button data-filter="all" onclick="setFilter('all')">All <span class="cnt" id="cnt-all">0</span></button>
      <button data-filter="new" class="active" onclick="setFilter('new')">New <span class="cnt" id="cnt-new">0</span></button>
      <button data-filter="viewed" onclick="setFilter('viewed')">Viewed <span class="cnt" id="cnt-viewed">0</span></button>
      <button data-filter="applied" onclick="setFilter('applied')">Applied <span class="cnt" id="cnt-applied">0</span></button>
      <button data-filter="answered" onclick="setFilter('answered')">Answered <span class="cnt" id="cnt-answered">0</span></button>
      <button data-filter="interview" onclick="setFilter('interview')">Interview <span class="cnt" id="cnt-interview">0</span></button>
      <button data-filter="rejected" onclick="setFilter('rejected')">✗ <span class="cnt" id="cnt-rejected">0</span></button>
      <button data-filter="fresh" onclick="setFilter('fresh')">🆕 New since visit <span class="cnt" id="cnt-fresh">0</span></button>
    </div>
    <input id="q" type="search" aria-label="Search title, company or skills" placeholder="Search title / company / skills…" oninput="setQuery(this.value)" />
    <div class="src-seg" role="group" aria-label="Source">
      <button data-src="all" class="active" onclick="setSource('all')">All</button>
      <button data-src="linkedin" onclick="setSource('linkedin')">LinkedIn</button>
      <button data-src="dou" onclick="setSource('dou')">DOU</button>
      <button data-src="djinni" onclick="setSource('djinni')">Djinni</button>
      <button data-src="jooble" onclick="setSource('jooble')">Jooble</button>
    </div>
    <div class="min-seg" role="group" aria-label="Minimum score">
      <button data-min="0" class="active" onclick="setMin(this,0)">All</button>
      <button data-min="30" onclick="setMin(this,30)">≥30</button>
      <button data-min="40" onclick="setMin(this,40)">≥40</button>
    </div>
  </div>
  <div class="funnel" id="funnel"></div>
</header>
<main>
${items.length ? cards : '<div class="empty">No matching jobs yet. Run <code>node jobs.mjs</code>.</div>'}
</main>
<script>
// ---- State client: server-backed with a localStorage fallback ----------
// When the state server (state-server.mjs) is reachable, job-state.json on disk
// is the source of truth. When it is not (page opened as bare file://, or the
// server is down), we fall back to localStorage and flag it in the header.
const STATUS_KEY = 'jobStatus';        // legacy + offline cache: { url: {status,appliedAt,note} | "viewed" }
let online = false;
let state = { _meta: {} };             // mirror of the server store (or localStorage offline)

const entryOf = (url) => state[url] || {};
const STATUSES = ['viewed','applied','answered','interview','rejected'];
const POST_APPLIED = ['applied','answered','interview','rejected'];
const statusOf = (url) => { const s = entryOf(url).status; return STATUSES.includes(s) ? s : 'new'; };

async function postState(body) {
  const r = await fetch('/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('post failed');
  return r.json();
}

function loadLocal() {
  let map = {};
  try { map = JSON.parse(localStorage.getItem(STATUS_KEY) || '{}'); } catch {}
  if (!map || typeof map !== 'object' || Array.isArray(map)) map = {};
  const out = { _meta: {} };
  for (const [url, v] of Object.entries(map)) {
    if (url === '_meta') { out._meta = v || {}; continue; }
    out[url] = (typeof v === 'string')
      ? (v === 'viewed' || v === 'applied' ? { status: v } : {})
      : v;   // upgrade legacy strings; drop invalid/"new" status to match server normalize
  }
  return out;
}
function saveLocal() { localStorage.setItem(STATUS_KEY, JSON.stringify(state)); }

async function initState() {
  try {
    const ok = await fetch('/health').then((r) => r.ok).catch(() => false);
    if (!ok) throw new Error('offline');
    online = true;
    state = await fetch('/state').then((r) => r.json());
    // One-time migration: push any local entries the server doesn't have yet.
    const local = loadLocal();
    const hadLocalEntries = Object.keys(local).some((k) => k !== '_meta');
    for (const [url, v] of Object.entries(local)) {
      if (url === '_meta' || state[url]) continue;
      const patch = (typeof v === 'string') ? { status: v } : v;
      state = await postState({ url, patch });
    }
    if (hadLocalEntries) localStorage.removeItem(STATUS_KEY);
  } catch {
    online = false;
    state = loadLocal();
    const h = document.querySelector('header .meta');
    if (h) h.insertAdjacentHTML('beforeend', '<span class="offline">offline — not saved to disk</span>');
  }
}

async function patchEntry(url, patch) {
  if (online) { state = await postState({ url, patch }); }
  else {
    // Mirror mergeEntry locally so offline edits round-trip.
    const e = { ...(state[url] || {}) };
    if ('status' in patch) { if (patch.status === 'new') delete e.status; else e.status = patch.status; }
    if ('appliedAt' in patch) { if (patch.appliedAt == null) delete e.appliedAt; else e.appliedAt = patch.appliedAt; }
    if ('note' in patch) { if (!patch.note) delete e.note; else e.note = patch.note; }
    const empty = !(STATUSES.includes(e.status) || (e.note && e.note.length) || e.appliedAt);
    if (empty) delete state[url]; else state[url] = e;
    saveLocal();
  }
}

function daysAgo(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (!isFinite(d)) return '';
  const n = Math.floor(d);
  return n <= 0 ? 'today' : n + 'd ago';
}

function copyCover(i, btn){
  const t = document.getElementById('cover'+i).innerText;
  navigator.clipboard.writeText(t).then(()=>{ btn.textContent='✓ Copied'; setTimeout(()=>btn.textContent='Copy letter',1500); });
}

function renderCard(card){
  const url = card.dataset.url;
  const st = statusOf(url);
  const e = entryOf(url);
  card.classList.toggle('viewed', st === 'viewed');
  card.classList.toggle('applied', POST_APPLIED.includes(st));
  card.classList.toggle('rejected', st === 'rejected');
  card.querySelectorAll('.status-seg button').forEach((b) => b.classList.toggle('active', b.dataset.status === st));
  const ago = card.querySelector('.applied-ago');
  if (ago) { if (POST_APPLIED.includes(st) && e.appliedAt) { ago.textContent = 'applied ' + daysAgo(e.appliedAt); ago.hidden = false; } else ago.hidden = true; }
  const ta = card.querySelector('.note'); if (ta && document.activeElement !== ta) ta.value = e.note || '';
  const dot = card.querySelector('.note-has'); if (dot) dot.hidden = !(e.note && e.note.length);
}

async function setStatus(card, status){
  const url = card.dataset.url;
  const patch = { status };
  if (status === 'applied' && !entryOf(url).appliedAt) patch.appliedAt = new Date().toISOString();
  if (!POST_APPLIED.includes(status)) patch.appliedAt = null;
  await patchEntry(url, patch);
  renderCard(card); applyFilter(); renderFunnel();
}
// Auto-status never downgrades any post-applied card.
async function autoStatus(card, status){ if (POST_APPLIED.includes(statusOf(card.dataset.url))) return; await setStatus(card, status); }

async function saveNote(card, value){ await patchEntry(card.dataset.url, { note: value.trim() }); renderCard(card); }

// A job is "new since last visit" when generated after the stored lastVisit.
function isNew(generatedISO, lastVisitISO) {
  if (!lastVisitISO) return false;
  const g = Date.parse(generatedISO), v = Date.parse(lastVisitISO);
  if (!isFinite(g) || !isFinite(v)) return false;
  return g > v;
}

function markFreshness() {
  const lastVisit = (state._meta && state._meta.lastVisit) || '';
  let count = 0;
  document.querySelectorAll('.card').forEach((card) => {
    const fresh = isNew(card.dataset.generated, lastVisit);
    card.classList.toggle('fresh', fresh);
    if (fresh) {
      count++;
      if (!card.querySelector('.ribbon')) card.querySelector('.titles h2').insertAdjacentHTML('beforeend', ' <span class="ribbon">NEW</span>');
    } else {
      const r = card.querySelector('.ribbon'); if (r) r.remove();
    }
  });
  const el = document.getElementById('cnt-fresh'); if (el) el.textContent = count;
}

function renderFunnel() {
  const bySrc = {};
  let applied = 0, answered = 0, interview = 0, rejected = 0;
  document.querySelectorAll('.card').forEach((card) => {
    const st = statusOf(card.dataset.url);
    if (!POST_APPLIED.includes(st)) return;
    applied++;
    const s = bySrc[card.dataset.source] = bySrc[card.dataset.source] || { a: 0, r: 0, i: 0 };
    s.a++;
    if (st !== 'applied') { answered++; s.r++; }
    if (st === 'interview') { interview++; s.i++; }
    if (st === 'rejected') rejected++;
  });
  const pct = (x, y) => y ? Math.round(x / y * 100) + '%' : '—';
  const src = Object.entries(bySrc).map(([k, s]) => k + ' ' + s.a + '/' + s.r + '/' + s.i).join(' · ');
  const el = document.getElementById('funnel');
  if (el) el.textContent = applied
    ? 'Funnel: ' + applied + ' applied → ' + answered + ' answered (' + pct(answered, applied) + ') → ' + interview + ' interview (' + pct(interview, answered) + ')' + (rejected ? ' · ' + rejected + ' rejected' : '') + (src ? '  ·  applied/answered/interview by source: ' + src : '')
    : '';
}

async function advanceLastVisit() {
  const nowIso = new Date().toISOString();
  if (online) { try { state = await postState({ _meta: { lastVisit: nowIso } }); } catch {} }
  else { state._meta = { ...(state._meta || {}), lastVisit: nowIso }; saveLocal(); }
}

let query = '', minScore = 0;
// Multi-select filters: empty Set === "All". Clicking a chip toggles it, "All" clears.
const srcSel = new Set(), statusSel = new Set(['new']);
function toggleSel(sel, v){ if (v === 'all') sel.clear(); else if (!sel.delete(v)) sel.add(v); }
function syncSeg(sel, selector, attr){
  document.querySelectorAll(selector).forEach((b)=>{
    const v = b.dataset[attr];
    b.classList.toggle('active', v === 'all' ? sel.size === 0 : sel.has(v));
  });
}
const FILTERS_KEY = 'jobFilters';      // filter selection survives reloads (localStorage, per-browser)
function saveFilters(){
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: [...statusSel], src: [...srcSel], minScore, query })); } catch {}
}
function restoreFilters(){
  let f; try { f = JSON.parse(localStorage.getItem(FILTERS_KEY) || 'null'); } catch {}
  if (!f || typeof f !== 'object') return;
  statusSel.clear(); (f.status || []).forEach((v)=>statusSel.add(v));
  srcSel.clear(); (f.src || []).forEach((v)=>srcSel.add(v));
  minScore = Number(f.minScore) || 0;
  query = (f.query || '').trim().toLowerCase();
  const q = document.getElementById('q'); if (q) q.value = query;
  syncSeg(statusSel, '.filter-seg button', 'filter');
  syncSeg(srcSel, '.src-seg button', 'src');
  document.querySelectorAll('.min-seg button').forEach((b)=>b.classList.toggle('active', Number(b.dataset.min) === minScore));
}
function setQuery(v){ query = v.trim().toLowerCase(); applyFilter(); }
function setSource(src){ toggleSel(srcSel, src); syncSeg(srcSel, '.src-seg button', 'src'); applyFilter(); }
function setMin(btn, n){ minScore = n; document.querySelectorAll('.min-seg button').forEach((b)=>b.classList.toggle('active', b===btn)); applyFilter(); }

function applyFilter(){
  const counts = { all: 0, new: 0, viewed: 0, applied: 0, answered: 0, interview: 0, rejected: 0 };
  document.querySelectorAll('.card').forEach((card) => {
    const st = statusOf(card.dataset.url);
    counts.all++; counts[st]++;
    const detailsOpen = !!card.querySelector('details[open]');
    const matchFind =
      (srcSel.size === 0 || srcSel.has(card.dataset.source)) &&
      (Number(card.dataset.score) >= minScore) &&
      (!query || (card.dataset.search || '').includes(query));
    const isFresh = card.classList.contains('fresh');
    const matchStatus = (statusSel.size === 0 || statusSel.has(st) || (statusSel.has('fresh') && isFresh) || detailsOpen);
    card.style.display = (matchStatus && matchFind) ? '' : 'none';
  });
  for (const k of ['all','new','viewed','applied','answered','interview','rejected']) { const el = document.getElementById('cnt-'+k); if (el) el.textContent = counts[k]; }
  saveFilters();
}
function setFilter(filter){ toggleSel(statusSel, filter); syncSeg(statusSel, '.filter-seg button', 'filter'); applyFilter(); }

(async function init(){
  await initState();
  document.querySelectorAll('.card').forEach(renderCard);
  markFreshness();
  restoreFilters();
  applyFilter();
  renderFunnel();
  setTimeout(advanceLastVisit, 4000);
})();
</script>
</body></html>`;

writeFileSync(OUT, html);
console.log(`Dashboard: ${OUT} (${items.length} jobs)`);

if (process.argv.includes("--open")) {
  execFile("open", [OUT], () => {});
}
