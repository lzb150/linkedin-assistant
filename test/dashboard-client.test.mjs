// test/dashboard-client.test.mjs
// Verifies the server persistence contract the dashboard client relies on:
// status+note survive a round-trip and migration shape is accepted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createServer } from "../state-server.mjs";
import { startStateServer } from "./helpers/e2e.mjs";

test("status and note persist across a server restart", async (t) => {
  let { srv, port, statePath, indexPath } = await startStateServer(t);
  const U = "https://example.com/jobs/7/";
  await fetch(`http://127.0.0.1:${port}/state`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: U, patch: { status: "closed" } }) });
  await fetch(`http://127.0.0.1:${port}/state`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: U, patch: { note: "recruiter Anna" } }) });
  await new Promise((r) => srv.close(r));

  // Restart against the same file → state survived to disk.
  srv = createServer({ statePath, indexPath });
  t.after(() => new Promise((r) => srv.close(() => r())));
  port = await new Promise((res) => srv.listen(0, "127.0.0.1", () => res(srv.address().port)));
  const state = await fetch(`http://127.0.0.1:${port}/state`).then((r) => r.json());
  assert.equal(state[U].status, "closed");
  assert.equal(state[U].note, "recruiter Anna");
  // GET / serves the generated dashboard html.
  const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  assert.match(html, /<html>/);
});

// Boot the inlined client (core + dom) in a vm against a fake window.
async function bootClient({ fetch, store, document }) {
  const ctx = vm.createContext({
    // unref'd: init() schedules advanceLastVisit 4 s out, which must not hold the test open.
    setTimeout: (f, ms) => { const h = setTimeout(f, ms); h.unref?.(); return h; }, clearTimeout, Date, JSON, console, fetch,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    document: document || { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
  });
  vm.runInContext(readFileSync(new URL("../lib/dashboard-client-core.cjs", import.meta.url), "utf8"), ctx);
  vm.runInContext(readFileSync(new URL("../lib/dashboard-client-dom.js", import.meta.url), "utf8"), ctx);
  await vm.runInContext("ready", ctx);
  return { ctx, run: (code) => vm.runInContext(code, ctx) };
}
const fakeCard = (url) => ({ dataset: { url }, classList: { toggle() {} }, querySelectorAll: () => [], querySelector: () => null });

test("a rejected (4xx) offline patch is skipped, the rest still reach the server", async (t) => {
  // Runs the real initState push loop: a 4xx drops that one patch and moves on,
  // only a network failure means offline.
  const { port, statePath } = await startStateServer(t);
  const BAD = "javascript:alert(1)", GOOD = "https://example.com/jobs/1/";
  const store = new Map([
    ["jobStatus", JSON.stringify({ _meta: {}, [BAD]: { status: "viewed" }, [GOOD]: { status: "closed" } })],
    ["jobStatusDirty", JSON.stringify([BAD, GOOD])],
  ]);
  const c = await bootClient({ fetch: (p, o) => fetch(`http://127.0.0.1:${port}${p}`, o), store });
  assert.equal(c.run("online"), true, "a 4xx is not offline");
  assert.deepEqual(JSON.parse(store.get("jobStatusDirty")), []);
  const onDisk = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(onDisk[GOOD].status, "closed");
  assert.ok(!(BAD in onDisk));
});

// A DOM just rich enough for the card/filter code: real cards, the header's
// status and source buttons, and the elements applyFilter writes to.
function fakeDom(cards) {
  const el = (extra = {}) => ({ textContent: "", hidden: false, value: "", ...extra });
  const btn = (dataset) => ({ dataset, classList: { toggle() {} }, setAttribute(k, v) { this[k] = v; } });
  const doc = {
    activeElement: null,
    querySelector: () => null,
    getElementById: (id) => ids[id] ?? null,
    querySelectorAll: (sel) => ({
      ".card": cards,
      ".filter-seg button": [btn({ filter: "new" }), btn({ filter: "viewed" })],
      ".src-seg button": [btn({ src: "all" }), btn({ src: "dou" }), btn({ src: "djinni" })],
    })[sel] || [],
    documentElement: { dataset: {} },
  };
  const ids = {
    q: el({ focus() { doc.activeElement = ids.q; } }),
    shown: el(), "no-match": el({ hidden: true }), "cnt-new": el(), "cnt-viewed": el(),
  };
  return { doc, ids };
}
function domCard({ url, generated = "", source = "dou", search = "" }) {
  const btn = (status) => ({ dataset: { status }, classList: { toggle() {} }, setAttribute(k, v) { this[k] = v; } });
  const card = {
    dataset: { url, generated, source, search }, style: {}, classes: new Set(),
    classList: { toggle: (c, on) => (on ? card.classes.add(c) : card.classes.delete(c)) },
    cue: { textContent: "" }, dot: { hidden: true }, ribbon: null, inner: { blur() {} },
    buttons: [btn("new"), btn("viewed")],
    contains: (x) => x === card.inner,
    querySelectorAll: (sel) => (sel === ".status-seg button" ? card.buttons : []),
    querySelector: (sel) => ({
      ".card-status": card.cue, ".note-has": card.dot, ".ribbon": card.ribbon,
      ".titles h2": { insertAdjacentHTML: () => { card.ribbon = { remove: () => { card.ribbon = null; } }; } },
    })[sel] ?? null,
  };
  return card;
}

test("cards: counts, status cues, NEW ribbon, filtering, no-match and focus relocation run in the real client", async () => {
  const A = "https://a/1", B = "https://b/1", C = "https://c/1";
  const store = new Map([["jobStatus", JSON.stringify({
    _meta: { lastVisit: "2026-09-10T00:00:00Z" },
    [A]: { status: "viewed", note: "called back" },
    [B]: { status: "closed" },
  })]]);
  const cards = [
    domCard({ url: A, generated: "2026-09-01T00:00:00Z", search: "sdet acme" }),
    domCard({ url: B, generated: "2026-09-01T00:00:00Z", source: "djinni", search: "qa beta" }),
    domCard({ url: C, generated: "2026-09-20T00:00:00Z", source: "djinni", search: "playwright gamma" }),
  ];
  const [a, b, c] = cards;
  const { doc, ids } = fakeDom(cards);
  const client = await bootClient({ fetch: () => Promise.reject(new Error("offline")), store, document: doc });
  await new Promise((r) => setImmediate(r));   // init() continues after `ready`

  // renderCard mirrors state into the DOM.
  assert.equal(a.cue.textContent, ", viewed");
  assert.equal(b.cue.textContent, ", closed");
  assert.equal(a.dot.hidden, false, "note dot for a card with a note");
  assert.equal(a.buttons[1]["aria-pressed"], "true");
  assert.equal(a.buttons[0]["aria-pressed"], "false");
  // markFreshness: only the card generated after the last visit gets the ribbon.
  assert.ok(c.ribbon && c.classes.has("fresh"));
  assert.ok(!a.ribbon && !a.classes.has("fresh"));
  // applyFilter with the New+Viewed default: closed hidden, counts per header button.
  assert.equal(ids["cnt-new"].textContent, 1);
  assert.equal(ids["cnt-viewed"].textContent, 1);
  assert.equal(b.style.display, "none");
  assert.equal(a.style.display, "");
  assert.equal(ids.shown.textContent, "2 jobs shown");
  assert.equal(ids["no-match"].hidden, true);

  // Filtering away the card that holds focus moves focus to the search box
  // (WCAG 2.4.3) and shows the on-screen no-match message.
  doc.activeElement = c.inner;
  client.run("query = 'zzz'; applyFilter()");
  assert.equal(doc.activeElement, ids.q);
  assert.equal(ids.shown.textContent, "0 jobs shown");
  assert.equal(ids["no-match"].hidden, false);
  assert.equal(JSON.parse(store.get("jobFilters2")).query, "zzz", "filters saved");

  // A source chip narrows to that board.
  client.run("query = ''; setSource('djinni')");
  assert.equal(ids.shown.textContent, "1 jobs shown");
  assert.equal(c.style.display, "");
  assert.equal(a.style.display, "none");
});

// After an online session the cache stays as a read mirror of the server, so
// an offline reload shows the real statuses and notes.
test("online session mirrors server state to localStorage; offline reload keeps statuses and notes", async (t) => {
  const { port } = await startStateServer(t);
  const store = new Map();
  const U = "https://example.com/jobs/1/";

  const on = await bootClient({ fetch: (p, o) => fetch(`http://127.0.0.1:${port}${p}`, o), store });
  on.ctx.card = fakeCard(U);
  await on.run("setStatus(card, 'closed')");
  await on.run(`patchEntry(${JSON.stringify(U)}, { note: 'no relocation' })`);
  assert.equal(JSON.parse(store.get("jobStatus"))[U].note, "no relocation", "mirror holds the server state");
  assert.deepEqual(JSON.parse(store.get("jobStatusDirty")), []);

  const off = await bootClient({ fetch: () => Promise.reject(new Error("offline")), store });
  assert.equal(off.run(`statusOf(${JSON.stringify(U)})`), "closed");
  off.ctx.card = fakeCard(U);
  await off.run("setStatus(card, 'viewed')");
  assert.equal(off.run(`entryOf(${JSON.stringify(U)}).note`), "no relocation", "a status change keeps the note");
  assert.deepEqual(JSON.parse(store.get("jobStatusDirty")), [U]);
});

// The offline branch of initState must restore the dirty list saved by an
// earlier offline session, or those edits never reach the server.
test("offline: dirty urls from a previous session survive a reload", async () => {
  const store = new Map([
    ["jobStatus", JSON.stringify({ _meta: {}, "https://old/": { status: "viewed" } })],
    ["jobStatusDirty", JSON.stringify(["https://old/"])],
  ]);
  const c = await bootClient({ fetch: () => Promise.reject(new Error("offline")), store });
  await c.run("patchEntry('https://new/', { status: 'viewed' })");
  assert.deepEqual(JSON.parse(store.get("jobStatusDirty")).sort(), ["https://new/", "https://old/"]);
});

// Reconnect push loop: the dirty list on disk must shrink one url at a time, so a
// network failure on patch N+1 leaves N+1.. (and their mirror entries) for next time.
test("reconnect: a network failure mid-push keeps the unpushed dirty urls and their entries", async (t) => {
  const { port } = await startStateServer(t);
  const A = "https://example.com/jobs/a/", B = "https://example.com/jobs/b/";
  const store = new Map([
    ["jobStatus", JSON.stringify({ _meta: {}, [A]: { status: "viewed" }, [B]: { status: "closed", note: "keep me" } })],
    ["jobStatusDirty", JSON.stringify([A, B])],
  ]);
  let posts = 0;
  const flaky = (p, o) => {
    if (o?.method === "POST" && ++posts === 2) return Promise.reject(new TypeError("network down"));
    return fetch(`http://127.0.0.1:${port}${p}`, o);
  };
  const c = await bootClient({ fetch: flaky, store });
  assert.equal(c.run("online"), false, "network error during the push loop → offline");
  assert.deepEqual(JSON.parse(store.get("jobStatusDirty")), [B]);
  assert.equal(JSON.parse(store.get("jobStatus"))[B].note, "keep me");
  const server = await fetch(`http://127.0.0.1:${port}/state`).then((r) => r.json());
  assert.equal(server[A].status, "viewed", "first patch did land");
});

// Regression (#52): flash() used the .offline class, so a flash badge in the
// header made markOffline()'s idempotence guard skip the real offline badge.
test("flash then markOffline still shows the offline badge", async () => {
  const children = [];
  const meta = {
    appendChild: (el) => children.push(el),
    insertAdjacentHTML: (_, html) => children.push({ className: /class="([^"]+)"/.exec(html)[1] }),
    querySelector: (sel) => children.find((c) => c.className === sel.slice(1)) || null,
  };
  const c = await bootClient({
    fetch: (_p) => Promise.resolve({ ok: true, json: async () => ({ _meta: {} }) }),
    store: new Map(),
    document: {
      querySelector: (sel) => (sel === "header .meta" ? meta : null), querySelectorAll: () => [], getElementById: () => null,
      createElement: () => ({ className: "", textContent: "", remove() {} }),
    },
  });
  c.run("flash('not saved'); markOffline()");
  assert.ok(children.some((el) => el.className === "offline"), "offline badge present after a flash");
  assert.ok(children.some((el) => el.className === "flash"));
});

// Radar mode: board-closed cards are never re-opened by the auto-viewed hook
// (Open job / expanding the letter); a saved filter for a status that has no
// header button (pre-radar "applied", "closed") is dropped instead of showing an empty board.
test("autoStatus never overrides closed; restoreFilters drops unknown statuses", async () => {
  const U2 = "https://example.com/jobs/2/", U3 = "https://example.com/jobs/3/";
  const store = new Map([["jobFilters2", JSON.stringify({ status: ["applied", "closed", "new"], src: [], query: "" })]]);
  // The header's status buttons are what restoreFilters checks against.
  const { doc } = fakeDom([]);
  const c = await bootClient({ fetch: () => Promise.reject(new Error("offline")), store, document: doc });
  await new Promise((r) => setTimeout(r, 0));   // let the boot IIFE finish (restoreFilters + applyFilter)
  assert.equal(c.run("JSON.stringify([...statusSel])"), JSON.stringify(["new"]));
  for (const [u, st] of [[U2, "closed"], [U3, "viewed"]]) await c.run(`patchEntry(${JSON.stringify(u)}, { status: ${JSON.stringify(st)} })`);
  for (const u of [U2, U3]) { c.ctx.card = fakeCard(u); await c.run("autoStatus(card, 'viewed')"); }
  assert.equal(c.run(`statusOf(${JSON.stringify(U2)})`), "closed");
  assert.equal(c.run(`statusOf(${JSON.stringify(U3)})`), "viewed");
  c.ctx.card = fakeCard(U2); await c.run("setStatus(card, 'new')");
  assert.equal(c.run(`statusOf(${JSON.stringify(U2)})`), "new", "an explicit status change still clears closed");
});

// A saved source filter for a board whose last package was archived (its chip is
// gone from the header) is dropped like an unknown status, so the board is not
// empty with no pressed chip.
test("restoreFilters keeps only sources that still have a header chip", async () => {
  const chip = (src) => ({ dataset: { src }, classList: { toggle() {} }, setAttribute() {} });
  const chips = [chip("all"), chip("dou")];
  const store = new Map([["jobFilters2", JSON.stringify({ status: ["new"], src: ["linkedin", "dou"], query: "" })]]);
  const c = await bootClient({
    fetch: () => Promise.reject(new Error("offline")), store,
    document: { querySelector: () => null, getElementById: () => null, querySelectorAll: (sel) => (sel === ".src-seg button" ? chips : []) },
  });
  await new Promise((r) => setTimeout(r, 0));   // let the boot IIFE finish (restoreFilters + applyFilter)
  assert.equal(c.run("JSON.stringify([...srcSel])"), JSON.stringify(["dou"]));
});

// buildApplication neutralises heading-like lines in the letter with a
// zero-width space after the #s. The card shows nothing different, but
// innerText carries the character, and so would the pasted email.
test("Copy letter strips the zero-width space the package uses to neutralise headings", async () => {
  const letter = "Dear team,\n#​ Not a heading\n##​ Action\nRegards";
  const c = await bootClient({
    fetch: () => Promise.reject(new Error("offline")), store: new Map(),
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: (id) => (id === "cover3" ? { innerText: letter } : null) },
  });
  const copied = [];
  c.ctx.navigator = { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } };
  c.ctx.btn = { nextElementSibling: { textContent: "" } };
  c.run("copyCover(3, btn)");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(copied, ["Dear team,\n# Not a heading\n## Action\nRegards"]);
  assert.doesNotMatch(copied[0], /​/);
  assert.equal(c.ctx.btn.nextElementSibling.textContent, "Copied");
});

test("a note still being typed is staged offline and sent with keepalive on pagehide", async (t) => {
  // Saved only on blur, a note was lost to Cmd-W or a reload mid-typing.
  const { port, statePath } = await startStateServer(t);
  const U = "https://example.com/jobs/9/";
  const sent = [];
  const store = new Map();
  const c = await bootClient({ fetch: (p, o) => { if (o?.keepalive) sent.push(JSON.parse(o.body)); return fetch(`http://127.0.0.1:${port}${p}`, o); }, store });
  c.ctx.card = fakeCard(U);
  c.ctx.ta = { value: "  call back Friday  " };
  c.run("noteInput(card, ta); flushNotes()");
  assert.deepEqual(sent, [{ url: U, patch: { note: "call back Friday" } }]);
  assert.deepEqual(JSON.parse(store.get("jobNoteOutbox")), { [U]: "call back Friday" }, "staged, note only, for the next load in case the request never lands");
  assert.ok(!JSON.parse(store.get("jobStatusDirty")).includes(U), "not dirty: a dirty url replays the whole entry");
  assert.equal(JSON.parse(store.get("jobStatus"))[U].note, "call back Friday");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(JSON.parse(readFileSync(statePath, "utf8"))[U].note, "call back Friday");
  // Nothing pending afterwards: the debounce timer was cancelled with it.
  assert.equal(c.run("pendingNotes.size"), 0);
});

test("a note sent at unload is re-sent note-only on the next load and cannot roll back a later status", async (t) => {
  // The note landed, then closed-check set the job closed overnight. The old
  // dirty-list replay pushed the mirrored { note, status: "viewed" } back.
  const { port, statePath } = await startStateServer(t);
  const U = "https://example.com/jobs/11/";
  const post = (body) => fetch(`http://127.0.0.1:${port}/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await post({ url: U, patch: { status: "closed" } });
  const store = new Map([
    ["jobStatus", JSON.stringify({ _meta: {}, [U]: { status: "viewed", note: "call back" } })],
    ["jobNoteOutbox", JSON.stringify({ [U]: "call back" })],
  ]);
  const c = await bootClient({ fetch: (p, o) => fetch(`http://127.0.0.1:${port}${p}`, o), store });
  assert.equal(c.run("online"), true);
  const onDisk = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(onDisk[U].status, "closed", "the later status survives");
  assert.equal(onDisk[U].note, "call back");
  assert.deepEqual(JSON.parse(store.get("jobNoteOutbox")), {}, "outbox drained");
});
