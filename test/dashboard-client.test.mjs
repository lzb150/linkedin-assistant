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

test("a rejected (4xx) offline patch is skipped, the rest still reach the server", async (t) => {
  const { port } = await startStateServer(t);
  // Same postState as lib/dashboard-client-dom.js: a non-ok response throws with .status.
  async function postState(body) {
    const r = await fetch(`http://127.0.0.1:${port}/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { const e = new Error("post failed " + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  let state = {}, offline = false;
  const patches = [
    { url: "javascript:alert(1)", patch: { status: "viewed" } },          // 400
    { url: "https://example.com/jobs/1/", patch: { status: "closed" } }, // ok
  ];
  try {
    for (const body of patches) {
      try { state = await postState(body); }
      catch (e) { if (e.status >= 400 && e.status < 500) continue; throw e; }
    }
  } catch { offline = true; }
  assert.equal(offline, false);
  assert.equal(state["https://example.com/jobs/1/"].status, "closed");
});

// Boot the inlined client (core + dom) in a vm against a fake window.
async function bootClient({ fetch, store, document }) {
  const ctx = vm.createContext({
    setTimeout, clearTimeout, Date, JSON, console, fetch,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    document: document || { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
  });
  vm.runInContext(readFileSync(new URL("../lib/dashboard-client-core.cjs", import.meta.url), "utf8"), ctx);
  vm.runInContext(readFileSync(new URL("../lib/dashboard-client-dom.js", import.meta.url), "utf8"), ctx);
  await vm.runInContext("ready", ctx);
  return { ctx, run: (code) => vm.runInContext(code, ctx) };
}
const fakeCard = (url) => ({ dataset: { url }, classList: { toggle() {} }, querySelectorAll: () => [], querySelector: () => null });

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
    fetch: (p) => Promise.resolve({ ok: true, json: async () => ({ _meta: {} }) }),
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
  const c = await bootClient({ fetch: () => Promise.reject(new Error("offline")), store });
  await new Promise((r) => setTimeout(r, 0));   // let the boot IIFE finish (restoreFilters + applyFilter)
  assert.equal(c.run("JSON.stringify([...statusSel])"), JSON.stringify(["new"]));
  for (const [u, st] of [[U2, "closed"], [U3, "viewed"]]) await c.run(`patchEntry(${JSON.stringify(u)}, { status: ${JSON.stringify(st)} })`);
  for (const u of [U2, U3]) { c.ctx.card = fakeCard(u); await c.run("autoStatus(card, 'viewed')"); }
  assert.equal(c.run(`statusOf(${JSON.stringify(U2)})`), "closed");
  assert.equal(c.run(`statusOf(${JSON.stringify(U3)})`), "viewed");
  c.ctx.card = fakeCard(U2); await c.run("setStatus(card, 'new')");
  assert.equal(c.run(`statusOf(${JSON.stringify(U2)})`), "new", "an explicit status change still clears closed");
});
