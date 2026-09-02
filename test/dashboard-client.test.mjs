// test/dashboard-client.test.mjs
// Verifies the server persistence contract the dashboard client relies on:
// status+appliedAt+note survive a round-trip and migration shape is accepted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../state-server.mjs";

function listen(srv) { return new Promise((res) => srv.listen(0, "127.0.0.1", () => res(srv.address().port))); }

test("status, appliedAt and note persist across a server restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, "job-state.json");
  const indexPath = join(dir, "index.html");
  writeFileSync(indexPath, "<html></html>");
  const U = "https://example.com/jobs/7/";

  let srv = createServer({ statePath, indexPath });
  // closes whichever server instance is current, even if an assert throws
  t.after(() => new Promise((r) => srv.close(() => r())));
  let port = await listen(srv);
  await fetch(`http://127.0.0.1:${port}/state`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: U, patch: { status: "applied", appliedAt: "2026-06-15T10:00:00Z" } }) });
  await fetch(`http://127.0.0.1:${port}/state`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: U, patch: { note: "recruiter Anna" } }) });
  await new Promise((r) => srv.close(r));

  // Restart against the same file → state survived to disk.
  srv = createServer({ statePath, indexPath });
  port = await listen(srv);
  const state = await fetch(`http://127.0.0.1:${port}/state`).then((r) => r.json());
  assert.equal(state[U].status, "applied");
  assert.equal(state[U].appliedAt, "2026-06-15T10:00:00Z");
  assert.equal(state[U].note, "recruiter Anna");
  // GET / serves the generated dashboard html.
  const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  assert.match(html, /<html>/);
});

test("the state server round-trips the new funnel statuses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-"));
  writeFileSync(join(dir, "index.html"), "<html></html>");
  const U = "https://example.com/jobs/9/";
  const srv = createServer({ statePath: join(dir, "job-state.json"), indexPath: join(dir, "index.html") });
  const port = await listen(srv);
  await fetch(`http://127.0.0.1:${port}/state`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: U, patch: { status: "interview" } }) });
  const state = await fetch(`http://127.0.0.1:${port}/state`).then((r) => r.json());
  assert.equal(state[U].status, "interview");
  await new Promise((r) => srv.close(r));
  rmSync(dir, { recursive: true, force: true });
});

test("a rejected (4xx) offline patch is skipped, the rest still reach the server", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "index.html"), "<html></html>");
  const srv = createServer({ statePath: join(dir, "job-state.json"), indexPath: join(dir, "index.html") });
  t.after(() => new Promise((r) => srv.close(() => r())));
  const port = await listen(srv);
  // Same postState as lib/dashboard-client-dom.js: a non-ok response throws with .status.
  async function postState(body) {
    const r = await fetch(`http://127.0.0.1:${port}/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { const e = new Error("post failed " + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  let state = {}, offline = false;
  const patches = [
    { url: "javascript:alert(1)", patch: { status: "viewed" } },          // 400
    { url: "https://example.com/jobs/1/", patch: { status: "applied" } }, // ok
  ];
  try {
    for (const body of patches) {
      try { state = await postState(body); }
      catch (e) { if (e.status >= 400 && e.status < 500) continue; throw e; }
    }
  } catch { offline = true; }
  assert.equal(offline, false);
  assert.equal(state["https://example.com/jobs/1/"].status, "applied");
});

// Boot the inlined client (core + dom) in a vm against a fake window.
async function bootClient({ fetch, store, document }) {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
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
// an offline reload shows the real statuses; re-applying keeps appliedAt.
test("online session mirrors server state to localStorage; offline reload keeps statuses and appliedAt", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "index.html"), "<html></html>");
  const srv = createServer({ statePath: join(dir, "job-state.json"), indexPath: join(dir, "index.html") });
  t.after(() => new Promise((r) => srv.close(() => r())));
  const port = await listen(srv);
  const store = new Map();
  const U = "https://example.com/jobs/1/";

  const on = await bootClient({ fetch: (p, o) => fetch(`http://127.0.0.1:${port}${p}`, o), store });
  on.ctx.card = fakeCard(U);
  await on.run("setStatus(card, 'applied')");
  const appliedAt = JSON.parse(store.get("jobStatus"))[U].appliedAt;
  assert.ok(appliedAt, "mirror holds the server-assigned appliedAt");
  assert.deepEqual(JSON.parse(store.get("jobStatusDirty")), []);

  const off = await bootClient({ fetch: () => Promise.reject(new Error("offline")), store });
  assert.equal(off.run(`statusOf(${JSON.stringify(U)})`), "applied");
  off.ctx.card = fakeCard(U);
  await off.run("setStatus(card, 'applied')");
  assert.equal(off.run(`entryOf(${JSON.stringify(U)}).appliedAt`), appliedAt);
  assert.deepEqual(JSON.parse(store.get("jobStatusDirty")), [U]);
});

// The offline branch of initState must restore the dirty list saved by an
// earlier offline session, or those edits never reach the server.
test("offline: dirty urls from a previous session survive a reload", async () => {
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  const store = new Map([
    ["jobStatus", JSON.stringify({ _meta: {}, "https://old/": { status: "viewed" } })],
    ["jobStatusDirty", JSON.stringify(["https://old/"])],
  ]);
  const ctx = vm.createContext({
    setTimeout, clearTimeout, Date, JSON, console,
    fetch: () => Promise.reject(new Error("offline")),
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
  });
  vm.runInContext(readFileSync(new URL("../lib/dashboard-client-core.cjs", import.meta.url), "utf8"), ctx);
  vm.runInContext(readFileSync(new URL("../lib/dashboard-client-dom.js", import.meta.url), "utf8"), ctx);
  await vm.runInContext("ready", ctx);
  await vm.runInContext("patchEntry('https://new/', { status: 'applied' })", ctx);
  assert.deepEqual(JSON.parse(store.get("jobStatusDirty")).sort(), ["https://new/", "https://old/"]);
});

// Reconnect push loop: the dirty list on disk must shrink one url at a time, so a
// network failure on patch N+1 leaves N+1.. (and their mirror entries) for next time.
test("reconnect: a network failure mid-push keeps the unpushed dirty urls and their entries", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "index.html"), "<html></html>");
  const srv = createServer({ statePath: join(dir, "job-state.json"), indexPath: join(dir, "index.html") });
  t.after(() => new Promise((r) => srv.close(() => r())));
  const port = await listen(srv);
  const A = "https://example.com/jobs/a/", B = "https://example.com/jobs/b/";
  const store = new Map([
    ["jobStatus", JSON.stringify({ _meta: {}, [A]: { status: "viewed" }, [B]: { status: "applied", note: "keep me" } })],
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

// A cache from before dirty-tracking (no list at all) must still get its
// one-time "push what the server lacks" migration when booted offline.
test("offline boot with a legacy cache seeds dirty with every entry", async () => {
  const U = "https://example.com/jobs/legacy/";
  const store = new Map([["jobStatus", JSON.stringify({ _meta: {}, [U]: "viewed" })]]);
  await bootClient({ fetch: () => Promise.reject(new Error("offline")), store });
  assert.deepEqual(JSON.parse(store.get("jobStatusDirty")), [U]);
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
