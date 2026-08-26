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
    setTimeout, Date, JSON, console,
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
