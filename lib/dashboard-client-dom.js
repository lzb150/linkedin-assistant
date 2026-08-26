// DOM/network glue for the dashboard. Inlined into the generated HTML right
// AFTER dashboard-client-core.cjs, whose functions it uses as script-scope
// globals. Everything DOM-free lives in the core (and is unit-tested there);
// this layer only wires state, events and rendering together.
// ---- State client: server-backed with a localStorage fallback ----------
// When the state server (state-server.mjs) is reachable, job-state.json on disk
// is the source of truth. When it is not (page opened as bare file://, or the
// server is down), we fall back to localStorage and flag it in the header.
const STATUS_KEY = 'jobStatus';        // legacy + offline cache: { url: {status,appliedAt,note} | "viewed" }
const DIRTY_KEY = 'jobStatusDirty';    // urls edited while offline — the only ones pushed on reconnect
let online = false;
let dirty = new Set();
let state = { _meta: {} };             // mirror of the server store (or localStorage offline)

const entryOf = (url) => state[url] || {};
const statusOf = (url) => statusOfEntry(entryOf(url));

async function postState(body) {
  const r = await fetch('/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { const e = new Error('post failed ' + r.status); e.status = r.status; throw e; }
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
// null when the cache predates dirty-tracking (legacy migration path in core).
function loadDirty() {
  try { const d = JSON.parse(localStorage.getItem(DIRTY_KEY) || 'null'); return Array.isArray(d) ? d : null; } catch { return null; }
}
function saveLocal() {
  try {
    localStorage.setItem(STATUS_KEY, JSON.stringify(state));
    localStorage.setItem(DIRTY_KEY, JSON.stringify([...dirty]));
  } catch {}   // quota / private mode: keep the in-memory state, nothing else to do
}

async function initState() {
  try {
    const ok = await fetch('/health').then((r) => r.ok).catch(() => false);
    if (!ok) throw new Error('offline');
    online = true;
    state = await fetch('/state').then((r) => r.json());
    // Push edits made while offline (dirty urls only — the cache mirrors the
    // whole store, so blindly replaying it would resurrect server deletions).
    const local = loadLocal();
    for (const body of offlinePatches(local, loadDirty(), state)) {
      try { state = await postState(body); }
      catch (e) {
        // The server rejected this one patch (4xx): drop it and keep going.
        // Only a network failure means we are really offline.
        if (e.status >= 400 && e.status < 500) continue;
        throw e;
      }
    }
    try { localStorage.removeItem(STATUS_KEY); localStorage.removeItem(DIRTY_KEY); } catch {}
    dirty = new Set();
  } catch {
    state = loadLocal();
    markOffline();
  }
}

function markOffline() {
  online = false;
  const h = document.querySelector('header .meta');
  if (h && !h.querySelector('.offline')) h.insertAdjacentHTML('beforeend', '<span class="offline">offline — not saved to disk</span>');
}

// Every write awaits this so a click during the /health probe cannot clobber
// the offline cache before initState has decided online/offline.
const ready = initState();

async function patchEntry(url, patch) {
  await ready;
  if (online) {
    // The server can die mid-session; losing the click silently is worse than
    // degrading — fall back to localStorage and show the offline badge.
    try { state = await postState({ url, patch }); return; }
    catch { markOffline(); }
  }
  // Mirror mergeEntry locally so offline edits round-trip (core keeps the
  const merged = mergeEntryLocal(state[url], patch);
  if (merged) state[url] = merged; else delete state[url];
  dirty.add(url);
  saveLocal();
}

function copyCover(i, btn){
  const t = document.getElementById('cover'+i).innerText;
  navigator.clipboard.writeText(t)
    .then(()=>{ btn.textContent='✓ Copied'; })
    .catch(()=>{ btn.textContent='Copy failed'; })
    .finally(()=>setTimeout(()=>btn.textContent='Copy letter',1500));
}

function renderCard(card){
  const url = card.dataset.url;
  const st = statusOf(url);
  const e = entryOf(url);
  card.classList.toggle('viewed', st === 'viewed');
  card.classList.toggle('applied', POST_APPLIED.includes(st));
  card.classList.toggle('rejected', st === 'rejected');
  card.querySelectorAll('.status-seg button').forEach((b) => setPressed(b, b.dataset.status === st));
  const ago = card.querySelector('.applied-ago');
  if (ago) { if (POST_APPLIED.includes(st) && e.appliedAt) { ago.textContent = 'applied ' + daysAgo(e.appliedAt); ago.hidden = false; } else ago.hidden = true; }
  const ta = card.querySelector('.note'); if (ta && document.activeElement !== ta) ta.value = e.note || '';
  const dot = card.querySelector('.note-has'); if (dot) dot.hidden = !(e.note && e.note.length);
}

async function setStatus(card, status){
  const url = card.dataset.url;
  const patch = { status };
  // First entry into any post-applied stage IS the apply moment (a card can
  // jump straight to Answered when the reply arrives before bookkeeping).
  if (POST_APPLIED.includes(status)) {
    if (!entryOf(url).appliedAt) patch.appliedAt = new Date().toISOString();
  } else {
    patch.appliedAt = null;
  }
  await patchEntry(url, patch);
  renderCard(card); applyFilter(); renderFunnel();
}
// Auto-status never downgrades any post-applied card.
async function autoStatus(card, status){ if (POST_APPLIED.includes(statusOf(card.dataset.url))) return; await setStatus(card, status); }

async function saveNote(card, value){
  const note = value.trim().slice(0, 10000);   // mirrors the server's note limit
  if (note === (entryOf(card.dataset.url).note || '')) return;   // blur without a change: no POST
  await patchEntry(card.dataset.url, { note }); renderCard(card);
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
  const cards = [...document.querySelectorAll('.card')]
    .map((card) => ({ status: statusOf(card.dataset.url), source: card.dataset.source }));
  const el = document.getElementById('funnel');
  if (el) el.textContent = formatFunnel(computeFunnel(cards));
}

async function advanceLastVisit() {
  await ready;
  const nowIso = new Date().toISOString();
  if (online) { try { state = await postState({ _meta: { lastVisit: nowIso } }); } catch {} }
  else { state._meta = { ...(state._meta || {}), lastVisit: nowIso }; saveLocal(); }
}

let query = '', minScore = 0;
// Multi-select filters: empty Set === "All". Clicking a chip toggles it, "All" clears.
const srcSel = new Set(), statusSel = new Set(['new']);
// .active drives the styling, aria-pressed tells AT the same thing.
function setPressed(b, on){ b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
function toggleSel(sel, v){ if (v === 'all') sel.clear(); else if (!sel.delete(v)) sel.add(v); }
function syncSeg(sel, selector, attr){
  document.querySelectorAll(selector).forEach((b)=>{
    const v = b.dataset[attr];
    setPressed(b, v === 'all' ? sel.size === 0 : sel.has(v));
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
  document.querySelectorAll('.min-seg button').forEach((b)=>setPressed(b, Number(b.dataset.min) === minScore));
}
function setQuery(v){ query = v.trim().toLowerCase(); applyFilter(); }
function setSource(src){ toggleSel(srcSel, src); syncSeg(srcSel, '.src-seg button', 'src'); applyFilter(); }
function setMin(btn, n){ minScore = n; document.querySelectorAll('.min-seg button').forEach((b)=>setPressed(b, b===btn)); applyFilter(); }

function applyFilter(){
  const counts = { all: 0, new: 0, viewed: 0, applied: 0, answered: 0, interview: 0, rejected: 0 };
  const filters = { statusSel: [...statusSel], srcSel: [...srcSel], minScore, query };
  document.querySelectorAll('.card').forEach((card) => {
    const st = statusOf(card.dataset.url);
    counts.all++; counts[st]++;
    const show = cardMatches({
      status: st,
      source: card.dataset.source,
      score: Number(card.dataset.score),
      search: card.dataset.search || '',
      fresh: card.classList.contains('fresh'),
      detailsOpen: !!card.querySelector('details[open]'),
    }, filters);
    card.style.display = show ? '' : 'none';
  });
  for (const k of ['all','new','viewed','applied','answered','interview','rejected']) { const el = document.getElementById('cnt-'+k); if (el) el.textContent = counts[k]; }
  saveFilters();
}
function setFilter(filter){ toggleSel(statusSel, filter); syncSeg(statusSel, '.filter-seg button', 'filter'); applyFilter(); }

(async function init(){
  await ready;
  document.querySelectorAll('.card').forEach(renderCard);
  markFreshness();
  restoreFilters();
  applyFilter();
  renderFunnel();
  setTimeout(advanceLastVisit, 4000);
})();
