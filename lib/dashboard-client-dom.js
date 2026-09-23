// DOM/network glue for the dashboard. Inlined into the generated HTML right
// AFTER dashboard-client-core.cjs, whose functions it uses as script-scope
// globals. Everything DOM-free lives in the core (and is unit-tested there);
// this layer only wires state, events and rendering together.
// ---- State client: server-backed with a localStorage fallback ----------
// When the state server (state-server.mjs) is reachable, job-state.json on disk
// is the source of truth. When it is not (page opened as bare file://, or the
// server is down), we fall back to localStorage and flag it in the header.
// NOTE: localStorage is per-origin. The mirror is written on http://127.0.0.1:7777;
// a file:// open of applications/index.html has its own empty store and will not
// see it — offline read-back only works on the server origin.
const STATUS_KEY = 'jobStatus';        // offline store + read mirror of the server: { url: {status,note} }
const DIRTY_KEY = 'jobStatusDirty';    // urls edited while offline — the only ones pushed on reconnect
let online = false;
let dirty = new Set();
let state = { _meta: {} };             // mirror of the server store (or localStorage offline)

const entryOf = (url) => state[url] || {};
const statusOf = (url) => statusOfEntry(entryOf(url));

// Writes are serialized: two in-flight POSTs could otherwise resolve out of
// order and the older response clobber `state` (and the mirror) with stale data.
let queue = Promise.resolve();
const postState = (body) => (queue = queue.then(() => doPost(body), () => doPost(body)));
async function doPost(body) {
  const r = await fetch('/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { const e = new Error('post failed ' + r.status); e.status = r.status; throw e; }
  state = await r.json();
  saveLocal();   // the ONE place the offline mirror is refreshed after a server write
  return state;
}

function loadLocal() {
  let map = {};
  try { map = JSON.parse(localStorage.getItem(STATUS_KEY) || '{}'); } catch {}
  if (!map || typeof map !== 'object' || Array.isArray(map)) map = {};
  const out = { _meta: {} };
  for (const [url, v] of Object.entries(map)) {
    if (url === '_meta') { out._meta = v || {}; continue; }
    if (v && typeof v === 'object') out[url] = v;
  }
  return out;
}
function loadDirty() {
  try { const d = JSON.parse(localStorage.getItem(DIRTY_KEY) || '[]'); return Array.isArray(d) ? d : []; } catch { return []; }
}
function saveLocal() {
  // Dirty list first and on its own: it is tiny and is what guarantees an
  // offline click is pushed later; the (large) mirror may hit the quota.
  try { localStorage.setItem(DIRTY_KEY, JSON.stringify([...dirty])); } catch {}
  try { localStorage.setItem(STATUS_KEY, JSON.stringify(state)); } catch {}   // quota / private mode
}

async function initState() {
  const local = loadLocal(), savedDirty = loadDirty();
  // Restored up front so saveLocal (inside postState) always persists the real
  // remaining list — never an empty one — while patches are still being pushed.
  dirty = new Set(savedDirty);
  try {
    const ok = await fetch('/health').then((r) => r.ok).catch(() => false);
    if (!ok) throw new Error('offline');
    online = true;
    // A 500 here (corrupt job-state.json) must go down the offline path, not
    // become `state` and get mirrored over the real cached statuses.
    state = await fetch('/state').then((r) => { if (!r.ok) throw new Error('state ' + r.status); return r.json(); });
    // Push edits made while offline (dirty urls only — the cache mirrors the
    // whole store, so blindly replaying it would resurrect server deletions).
    // Each url leaves `dirty` as it lands, so a network failure on patch N+1
    // keeps N+1.. on disk for the next reconnect.
    for (const body of offlinePatches(local, savedDirty)) {
      dirty.delete(body.url);
      try { await postState(body); }
      catch (e) {
        // The server rejected this one patch (4xx): drop it, say so, keep going.
        // Only a network failure means we are really offline.
        if (e.status >= 400 && e.status < 500) { flash(`not saved — server rejected an offline edit (${e.status})`); continue; }
        dirty.add(body.url);
        throw e;
      }
    }
    // _meta is not in the dirty list: carry an offline lastVisit forward if newer.
    // In memory only: markFreshness reads it right after `ready`, and the 4 s
    // advanceLastVisit persists a value >= this one. (A POST here that failed
    // would let saveLocal below overwrite the offline visit with the server's.)
    const lv = local?._meta?.lastVisit;
    if (lv && Date.parse(lv) > (Date.parse(state._meta?.lastVisit) || 0)) state._meta = { ...state._meta, lastVisit: lv };
    // Keep the cache as a read mirror of the server store so an offline reload
    // renders real statuses instead of a blank slate; `dirty` is now empty.
    saveLocal();
  } catch {
    // Offline (or the push loop hit a network error): fall back to the cached
    // store; `dirty` still holds every url not yet pushed.
    state = local;
    saveLocal();
    markOffline();
  }
}

// Transient warning in the header (same spot as the offline badge), auto-hides.
function flash(msg) {
  const h = document.querySelector('header .meta');
  if (!h) return;
  const el = document.createElement('span');
  el.className = 'flash'; el.textContent = msg;   // own class: must not trip markOffline's .offline guard
  h.appendChild(el);
  setTimeout(() => el.remove(), 5000);
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
    try { await postState({ url, patch }); return; }
    catch (e) {
      // A 4xx is the server rejecting THIS patch, not the server being gone:
      // drop it instead of going offline and re-queuing it forever.
      if (e.status >= 400 && e.status < 500) { flash(`not saved — server rejected the change (${e.status})`); return; }
      markOffline();
    }
  }
  // Mirror mergeEntry locally so offline edits round-trip (the core holds the
  // one merge implementation, shared with the server).
  const merged = mergeEntryLocal(state[url], patch);
  if (merged) state[url] = merged; else delete state[url];
  dirty.add(url);
  saveLocal();
}

function copyCover(i, btn){
  // buildApplication puts a zero-width space after the #s of any heading-like
  // line so it cannot read as Markdown; invisible on the card, but it would
  // travel into the pasted email. Strip it: the clipboard gets the letter as written.
  const t = document.getElementById('cover'+i).innerText.replace(/\u200b/g, '');
  const live = btn.nextElementSibling;   // sr-only role=status sibling: announces without renaming the button
  // No clipboard API (a non-secure context) must land on "Copy failed", not on
  // a TypeError thrown inside the onclick that leaves the status silent.
  (navigator.clipboard?.writeText(t) ?? Promise.reject(new Error('clipboard unavailable')))
    .then(()=>{ live.textContent='Copied'; })
    .catch(()=>{ live.textContent='Copy failed'; })
    .finally(()=>setTimeout(()=>live.textContent='',1500));
}

function renderCard(card){
  const url = card.dataset.url;
  const st = statusOf(url);
  const e = entryOf(url);
  card.classList.toggle('viewed', st === 'viewed');
  card.classList.toggle('closed', st === 'closed');
  // The visible cues for these two states are a colour, a border and a CSS
  // ::after — none of which reach the accessibility tree. Mirror the state as
  // real text inside the heading.
  const cue = card.querySelector('.card-status');
  if (cue) cue.textContent = st === 'closed' ? ', closed' : st === 'viewed' ? ', viewed' : '';
  card.querySelectorAll('.status-seg button').forEach((b) => setPressed(b, b.dataset.status === st));
  const ta = card.querySelector('.note'); if (ta && document.activeElement !== ta) ta.value = e.note || '';
  const dot = card.querySelector('.note-has'); if (dot) dot.hidden = !(e.note && e.note.length);
}

async function setStatus(card, status){
  await patchEntry(card.dataset.url, { status });
  renderCard(card); applyFilter();
}
// Auto-status never reopens a board-closed card.
async function autoStatus(card, status){ if (statusOf(card.dataset.url) === 'closed') return; await setStatus(card, status); }

async function saveNote(card, value){
  const note = value.trim().slice(0, 10000);   // mirrors the server's note limit
  if (note === (entryOf(card.dataset.url).note || '')) return;   // blur without a change: no POST
  await patchEntry(card.dataset.url, { note }); renderCard(card);
}

// Cards are server-rendered above this inline script and never added at
// runtime: query the DOM once, before init() so pre-`ready` clicks see them.
const cards = [...document.querySelectorAll('.card')];

// Set by markFreshness, read by advanceLastVisit: how many cards this page
// showed as NEW, and the newest card it actually rendered.
let freshCount = 0, newestOnPage = '';

function markFreshness() {
  const lastVisit = (state._meta && state._meta.lastVisit) || '';
  let count = 0;
  newestOnPage = '';
  cards.forEach((card) => {
    const generated = card.dataset.generated || '';
    if (generated > newestOnPage) newestOnPage = generated;   // ISO strings sort lexicographically
    const fresh = isNew(generated, lastVisit);
    card.classList.toggle('fresh', fresh);
    if (fresh) {
      count++;
      if (!card.querySelector('.ribbon')) card.querySelector('.titles h2').insertAdjacentHTML('beforeend', ' <span class="ribbon">NEW</span>');
    } else {
      const r = card.querySelector('.ribbon'); if (r) r.remove();
    }
  });
  freshCount = count;
}

// Acknowledge what this visit showed. Two guards keep the NEW markers useful:
//   - nothing was marked NEW -> do not touch the mark. Otherwise opening the
//     board after an uneventful run (the banner fires either way) burns the
//     next visit's highlights for no reason.
//   - advance to the newest card ON THIS PAGE, never to "now". A run finishing
//     while the page sits open would otherwise be pre-acknowledged and never
//     show up as NEW.
async function advanceLastVisit() {
  await ready;
  if (!freshCount || !newestOnPage) return;
  if (online) { try { await postState({ _meta: { lastVisit: newestOnPage } }); } catch {} }
  else { state._meta = { ...state._meta, lastVisit: newestOnPage }; saveLocal(); }
}

let query = '';
// Multi-select filters: empty Set === "All". Clicking a chip toggles it, "All" clears.
// Default New + Viewed: the radar is usually quiet (New 0), and an empty board
// on open reads as broken; Closed stays hidden until both tabs are deselected.
const srcSel = new Set(), statusSel = new Set(['new', 'viewed']);
// .active drives the styling, aria-pressed tells AT the same thing.
function setPressed(b, on){ b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
function toggleSel(sel, v){ if (v === 'all') sel.clear(); else if (!sel.delete(v)) sel.add(v); }
function syncSeg(sel, selector, attr){
  document.querySelectorAll(selector).forEach((b)=>{
    const v = b.dataset[attr];
    setPressed(b, v === 'all' ? sel.size === 0 : sel.has(v));
  });
}
const FILTERS_KEY = 'jobFilters2';     // filter selection survives reloads (localStorage, per-browser); v2 = reset once for the New+Viewed default
function saveFilters(){
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify({ status: [...statusSel], src: [...srcSel], query })); } catch {}
}
function restoreFilters(){
  let f; try { f = JSON.parse(localStorage.getItem(FILTERS_KEY) || 'null'); } catch {}
  if (!f || typeof f !== 'object') return;
  // Only statuses / sources with a header button (dashboard.mjs): a saved filter
  // for a removed one (or a board whose last package was archived) would show an
  // empty board with no pressed chip.
  const srcs = [...document.querySelectorAll('.src-seg button')].map((b)=>b.dataset.src);
  statusSel.clear(); (f.status || []).filter((v)=>['new', 'viewed'].includes(v)).forEach((v)=>statusSel.add(v));
  srcSel.clear(); (f.src || []).filter((v)=>srcs.includes(v)).forEach((v)=>srcSel.add(v));
  query = (f.query || '').trim().toLowerCase();
  const q = document.getElementById('q'); if (q) q.value = query;
  syncSeg(statusSel, '.filter-seg button', 'filter');
  syncSeg(srcSel, '.src-seg button', 'src');
}
let queryTimer;
function setQuery(v){ query = v.trim().toLowerCase(); clearTimeout(queryTimer); queryTimer = setTimeout(applyFilter, 120); }
function setSource(src){ toggleSel(srcSel, src); syncSeg(srcSel, '.src-seg button', 'src'); applyFilter(); }

function applyFilter(){
  const counts = { all: 0, new: 0, viewed: 0, closed: 0 };   // closed counted, no header button (shows only with both tabs deselected)
  const filters = { statusSel: [...statusSel], srcSel: [...srcSel], query };
  let shown = 0;
  cards.forEach((card) => {
    const st = statusOf(card.dataset.url);
    counts.all++; counts[st]++;
    const show = cardMatches({
      status: st,
      source: card.dataset.source,
      search: card.dataset.search || '',
      detailsOpen: !!card.querySelector('details[open]'),
    }, filters);
    // Moving focus out BEFORE hiding: a filter that hides the card holding
    // focus used to drop it on <body>, so the next Tab restarted at the top of
    // the page (WCAG 2.4.3).
    if (!show && card.contains(document.activeElement)) {
      const q = document.getElementById('q');
      if (q && q.focus) q.focus();
      else if (document.activeElement.blur) document.activeElement.blur();
    }
    card.style.display = show ? '' : 'none';
    if (show) shown++;
  });
  for (const k of ['new', 'viewed']) { const el = document.getElementById('cnt-'+k); if (el) el.textContent = counts[k]; }   // the only header buttons with a count (dashboard.mjs)
  const shownEl = document.getElementById('shown'); if (shownEl) shownEl.textContent = shown + ' jobs shown';   // sr-only role=status in the header: announces filter results
  // …and say it on screen too: filtering everything away left <main> simply
  // blank, with the sr-only counter as the only sign anything had happened.
  const noMatch = document.getElementById('no-match');
  if (noMatch) noMatch.hidden = !(cards.length && shown === 0);
  saveFilters();
}
function setFilter(filter){ toggleSel(statusSel, filter); syncSeg(statusSel, '.filter-seg button', 'filter'); applyFilter(); }

// ---- Theme ------------------------------------------------------------
// System preference by default; the header button pins light/dark on <html>
// (data-theme, persisted) — an inline <head> script re-applies it before paint.
const THEME_KEY = 'jobTheme';
function currentTheme(){
  const pinned = document.documentElement.dataset.theme;
  if (pinned) return pinned;
  return (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function syncThemeButton(){
  const b = document.getElementById('theme'); if (!b) return;
  const dark = currentTheme() === 'dark';
  b.setAttribute('aria-pressed', dark ? 'true' : 'false');   // toggle button: label and name stay "Dark" (WCAG 2.5.3), aria-pressed carries the state
}
function toggleTheme(){
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  syncThemeButton();
}

// The dashboard is a static file regenerated by every run, so an already-open
// tab keeps showing the cards it was loaded with — clicking a "2 new" banner
// would just focus that stale tab. Poll index.html's build stamp and reload
// when it changes, but never while the tab is in front: a reload under the
// user's cursor loses scroll position and any half-typed note.
function watchForRebuilds(buildAtLoad) {
  if (!buildAtLoad) return;
  let pending = false;
  const check = async () => {
    if (document.visibilityState === 'visible') return;   // reload on return instead
    try {
      const h = await fetch('/health').then((r) => r.ok ? r.json() : null);
      if (h && h.build && h.build !== buildAtLoad) pending = true;
    } catch {}
  };
  setInterval(check, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pending) location.reload();
  });
}

(async function init(){
  syncThemeButton();
  await ready;
  cards.forEach(renderCard);
  markFreshness();
  restoreFilters();
  applyFilter();
  setTimeout(advanceLastVisit, 4000);
  try {
    const h = await fetch('/health').then((r) => r.ok ? r.json() : null);
    watchForRebuilds(h && h.build);
  } catch {}
})();
