# Dashboard v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move dashboard state to a local disk-backed server so Applied status, applied-dates, and per-job notes survive a browser reset and drive macOS follow-up reminders, and add search/source/score filtering plus a "new since last visit" indicator.

**Architecture:** A tiny `node:http` server (`state-server.mjs`) binds `127.0.0.1:7777`, serves the generated `applications/index.html`, and exposes a `/state` JSON API backed by `job-state.json` (atomic writes). Pure logic lives in `lib/job-state.mjs`, `lib/followup.mjs`, `lib/freshness.mjs` (each unit-tested); the server, `followup.mjs`, and the dashboard client are thin shells. The dashboard falls back to `localStorage` when the server is unreachable.

**Tech Stack:** Node 20 (ESM, `node:http`, `node:fs`, global `fetch`, `node --test`), vanilla browser JS, Swift (`Jobs.app` launcher), launchd, `osascript`.

## Global Constraints

- Node ESM (`"type": "module"`); run tests with `node --test`; test files are `test/<name>.test.mjs`.
- Pure helpers go in `lib/`; fs/HTTP/process shells stay thin. One module = one responsibility.
- All committed documentation and code comments in **English** (no Russian/Ukrainian in code).
- Notifications use **`osascript`**, never `terminal-notifier` (no banners on macOS 26).
- Server binds **`127.0.0.1` only**, port **`7777`**; never exposed beyond localhost.
- State is keyed by vacancy **URL** (same key as the existing `localStorage.jobStatus`).
- Atomic disk writes everywhere state is persisted: write `<file>.tmp`, then `rename` over the target (mirror `lib/notify-state.mjs`).
- Funnel is exactly `new → viewed → applied`. No Interview/Offer/Rejected stages.
- Commit message trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## Phase 1 — Foundation

### Task 1: Pure state model — `lib/job-state.mjs`

**Files:**
- Create: `lib/job-state.mjs`
- Test: `test/job-state.test.mjs`

**Interfaces:**
- Produces:
  - `normalize(raw) -> { _meta: object, [url: string]: Entry }` where `Entry = { status?: "viewed"|"applied", appliedAt?: string, note?: string, updatedAt?: string }`. Accepts the legacy `{ "<url>": "viewed" }` string shape and upgrades each value to `{ status, updatedAt }`. Drops entries with no `status`, no non-empty `note`, and no `appliedAt`.
  - `mergeEntry(map, url, patch) -> newMap` (pure; no mutation). `patch` keys: `status` (`"new"` deletes the status), `appliedAt` (`null` clears), `note` (`""` clears). Sets `updatedAt` to `now`. Deletes the url key if the entry becomes empty.
  - `validatePatch(patch) -> boolean`. `status` if present ∈ `{new,viewed,applied}`; `appliedAt` if present is `string|null`; `note` if present is `string`.
  - `readStore(path) -> map` (fs; returns `{ _meta: {} }` when missing/malformed; runs `normalize`).
  - `writeStore(path, map) -> map` (fs; atomic tmp+rename; pretty 2-space JSON).
  - `statusOf(map, url) -> "new"|"viewed"|"applied"` (missing/empty status → `"new"`).

- [ ] **Step 1: Write the failing tests**

```javascript
// test/job-state.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalize, mergeEntry, validatePatch, readStore, writeStore, statusOf,
} from "../lib/job-state.mjs";

const U = "https://example.com/jobs/1/";
function tmp() { return mkdtempSync(join(tmpdir(), "js-")); }

test("normalize upgrades the legacy string shape to an entry object", () => {
  const out = normalize({ [U]: "viewed" });
  assert.equal(out[U].status, "viewed");
  assert.ok(out[U].updatedAt);
  assert.deepEqual(out._meta, {});
});

test("normalize preserves _meta and drops fully-empty entries", () => {
  const out = normalize({ _meta: { lastVisit: "2026-06-20T00:00:00Z" }, [U]: {} });
  assert.equal(out._meta.lastVisit, "2026-06-20T00:00:00Z");
  assert.equal(out[U], undefined);
});

test("normalize keeps a note-only entry (status defaults to new)", () => {
  const out = normalize({ [U]: { note: "call Anna" } });
  assert.equal(out[U].note, "call Anna");
  assert.equal(statusOf(out, U), "new");
});

test("mergeEntry sets status + appliedAt without mutating the input", () => {
  const before = {};
  const after = mergeEntry(before, U, { status: "applied", appliedAt: "2026-06-15T10:00:00Z" });
  assert.equal(after[U].status, "applied");
  assert.equal(after[U].appliedAt, "2026-06-15T10:00:00Z");
  assert.ok(after[U].updatedAt);
  assert.deepEqual(before, {}); // unchanged
});

test("mergeEntry with status new deletes the entry when nothing else remains", () => {
  const after = mergeEntry({ [U]: { status: "viewed" } }, U, { status: "new" });
  assert.equal(after[U], undefined);
});

test("mergeEntry keeps the entry when a note remains after clearing status", () => {
  const after = mergeEntry({ [U]: { status: "viewed", note: "x" } }, U, { status: "new" });
  assert.equal(after[U].status, undefined);
  assert.equal(after[U].note, "x");
});

test("validatePatch rejects an unknown status and accepts a valid one", () => {
  assert.equal(validatePatch({ status: "offer" }), false);
  assert.equal(validatePatch({ status: "applied" }), true);
  assert.equal(validatePatch({ appliedAt: null, note: "ok" }), true);
  assert.equal(validatePatch({ note: 5 }), false);
});

test("readStore round-trips through writeStore atomically", () => {
  const dir = tmp();
  const p = join(dir, "job-state.json");
  writeStore(p, mergeEntry({ _meta: { lastVisit: "t" } }, U, { status: "applied", appliedAt: "a" }));
  const back = readStore(p);
  assert.equal(back[U].status, "applied");
  assert.equal(back._meta.lastVisit, "t");
  rmSync(dir, { recursive: true, force: true });
});

test("readStore returns an empty store for a missing file", () => {
  assert.deepEqual(readStore("/no/such/job-state.json"), { _meta: {} });
});

test("readStore tolerates malformed JSON", () => {
  const dir = tmp();
  const p = join(dir, "job-state.json");
  writeFileSync(p, "{ not json");
  assert.deepEqual(readStore(p), { _meta: {} });
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/job-state.test.mjs`
Expected: FAIL — `Cannot find module '../lib/job-state.mjs'`.

- [ ] **Step 3: Write the implementation**

```javascript
// lib/job-state.mjs
// Pure model + atomic store for dashboard job state. State is keyed by vacancy
// URL. A missing entry (or an entry with no status) means status "new".
// Shape: { _meta: { lastVisit? }, "<url>": { status?, appliedAt?, note?, updatedAt? } }
import { writeFileSync, readFileSync, renameSync } from "node:fs";

const STATUSES = new Set(["viewed", "applied"]); // "new" is virtual, never stored

const nonEmpty = (e) =>
  e && (STATUSES.has(e.status) || (typeof e.note === "string" && e.note.length) || e.appliedAt);

export function normalize(raw) {
  const out = { _meta: {} };
  if (!raw || typeof raw !== "object") return out;
  if (raw._meta && typeof raw._meta === "object") out._meta = { ...raw._meta };
  for (const [key, val] of Object.entries(raw)) {
    if (key === "_meta") continue;
    // Legacy shape: a bare status string.
    const e = typeof val === "string"
      ? { status: val, updatedAt: new Date().toISOString() }
      : { ...val };
    if (!STATUSES.has(e.status)) delete e.status;
    if (typeof e.note === "string" && !e.note.length) delete e.note;
    if (nonEmpty(e)) out[key] = e;
  }
  return out;
}

export function mergeEntry(map, url, patch) {
  const out = { ...map };
  const e = { ...(out[url] || {}) };
  if ("status" in patch) {
    if (patch.status === "new") delete e.status;
    else e.status = patch.status;
  }
  if ("appliedAt" in patch) {
    if (patch.appliedAt == null) delete e.appliedAt;
    else e.appliedAt = patch.appliedAt;
  }
  if ("note" in patch) {
    if (!patch.note) delete e.note;
    else e.note = patch.note;
  }
  e.updatedAt = new Date().toISOString();
  if (nonEmpty(e)) out[url] = e;
  else delete out[url];
  return out;
}

export function validatePatch(patch) {
  if (!patch || typeof patch !== "object") return false;
  if ("status" in patch && !["new", "viewed", "applied"].includes(patch.status)) return false;
  if ("appliedAt" in patch && !(patch.appliedAt === null || typeof patch.appliedAt === "string")) return false;
  if ("note" in patch && typeof patch.note !== "string") return false;
  return true;
}

export function readStore(path) {
  try {
    return normalize(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { _meta: {} };
  }
}

export function writeStore(path, map) {
  const clean = normalize(map);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(clean, null, 2));
  renameSync(tmp, path);
  return clean;
}

export function statusOf(map, url) {
  const e = map[url];
  return e && STATUSES.has(e.status) ? e.status : "new";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/job-state.test.mjs`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add lib/job-state.mjs test/job-state.test.mjs
git commit -m "feat: add pure job-state model with atomic disk store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: State server — `state-server.mjs`

**Files:**
- Create: `state-server.mjs`
- Test: `test/state-server.test.mjs`

**Interfaces:**
- Consumes: `readStore`, `writeStore`, `mergeEntry`, `validatePatch` from `lib/job-state.mjs`.
- Produces:
  - `createServer({ statePath, indexPath }) -> http.Server` (not yet listening). Routes:
    - `GET /health` → `200 {"ok":true}`.
    - `GET /state` → `200` the store JSON.
    - `POST /state` body `{ url, patch }` → validates, `mergeEntry`, `writeStore`, returns `200` the updated store; `{ _meta: {...} }` → merges into `_meta`. Invalid body → `400`.
    - `GET /` → serves `indexPath` (`text/html`); `404` with a hint if absent.
  - When run as the main module, calls `createServer(...)` and `listen(7777, "127.0.0.1")`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/state-server.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../state-server.mjs";

function listen(srv) {
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res(srv.address().port)));
}

test("POST /state persists a patch and GET /state reads it back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "srv-"));
  const statePath = join(dir, "job-state.json");
  const srv = createServer({ statePath, indexPath: join(dir, "index.html") });
  const port = await listen(srv);
  const base = `http://127.0.0.1:${port}`;
  const U = "https://example.com/jobs/9/";

  const health = await fetch(`${base}/health`).then((r) => r.json());
  assert.deepEqual(health, { ok: true });

  const post = await fetch(`${base}/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: U, patch: { status: "applied", appliedAt: "2026-06-15T10:00:00Z" } }),
  });
  assert.equal(post.status, 200);

  const state = await fetch(`${base}/state`).then((r) => r.json());
  assert.equal(state[U].status, "applied");
  assert.equal(state[U].appliedAt, "2026-06-15T10:00:00Z");

  const meta = await fetch(`${base}/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ _meta: { lastVisit: "2026-06-20T09:00:00Z" } }),
  }).then((r) => r.json());
  assert.equal(meta._meta.lastVisit, "2026-06-20T09:00:00Z");

  const bad = await fetch(`${base}/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: U, patch: { status: "offer" } }),
  });
  assert.equal(bad.status, 400);

  await new Promise((r) => srv.close(r));
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/state-server.test.mjs`
Expected: FAIL — `Cannot find module '../state-server.mjs'`.

- [ ] **Step 3: Write the implementation**

```javascript
// state-server.mjs
// Tiny localhost-only state server for the jobs dashboard. Serves the generated
// applications/index.html and a /state JSON API backed by job-state.json.
// Never bind anything but 127.0.0.1. Run:  node state-server.mjs
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readStore, writeStore, mergeEntry, validatePatch } from "./lib/job-state.mjs";

const PORT = 7777;
const HOST = "127.0.0.1";

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve(null); } });
  });
}

export function createServer({ statePath, indexPath }) {
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });

    if (req.method === "GET" && req.url === "/state") return send(res, 200, readStore(statePath));

    if (req.method === "POST" && req.url === "/state") {
      const body = await readBody(req);
      if (!body || typeof body !== "object") return send(res, 400, { error: "bad body" });
      let map = readStore(statePath);
      if (body._meta && typeof body._meta === "object") {
        map = { ...map, _meta: { ...map._meta, ...body._meta } };
      } else if (typeof body.url === "string" && validatePatch(body.patch)) {
        map = mergeEntry(map, body.url, body.patch);
      } else {
        return send(res, 400, { error: "invalid patch" });
      }
      return send(res, 200, writeStore(statePath, map));
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      try { return send(res, 200, readFileSync(indexPath, "utf8"), "text/html; charset=utf-8"); }
      catch { return send(res, 404, "Dashboard not generated yet. Run: node dashboard.mjs", "text/plain"); }
    }

    send(res, 404, { error: "not found" });
  });
}

// Run directly: start the long-lived server on 127.0.0.1:7777.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = dirname(fileURLToPath(import.meta.url));
  const server = createServer({
    statePath: join(dir, "job-state.json"),
    indexPath: join(dir, "applications", "index.html"),
  });
  server.listen(PORT, HOST, () => console.log(`state-server: http://${HOST}:${PORT}/`));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/state-server.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add state-server.mjs test/state-server.test.mjs
git commit -m "feat: add localhost state server for dashboard job state

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Launch wiring — `open-dashboard.sh` + `Jobs.app`

**Files:**
- Create: `open-dashboard.sh`
- Modify: `jobs-app.swift` (the `nodeInvocation()` / `openDashboard()` functions)
- Reference (manual rebuild): `build-jobs.sh`

**Interfaces:**
- Consumes: `state-server.mjs`, `dashboard.mjs`.
- Produces: a single entry point the dock app calls — regenerate the dashboard, ensure the server is up on 7777 (guarded), open `http://127.0.0.1:7777/`.

This task is shell/Swift glue (not unit-testable); verify manually.

- [ ] **Step 1: Create the launcher script**

```bash
# open-dashboard.sh
#!/bin/bash
# Regenerate the dashboard, ensure the state server is running on 127.0.0.1:7777,
# then open it in the default browser. Idempotent: a second call reuses the
# already-running server instead of starting a duplicate.
set -euo pipefail
export PATH="/Users/eugenelazeba/.nvm/versions/node/v20.14.0/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")"

node dashboard.mjs   # regenerate applications/index.html (no --open)

# Start the server only if port 7777 is not already listening.
if ! /usr/bin/nc -z 127.0.0.1 7777 >/dev/null 2>&1; then
  nohup node state-server.mjs >> "logs/state-server.log" 2>&1 &
  # Give it a moment to bind before we open the browser.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    /usr/bin/nc -z 127.0.0.1 7777 >/dev/null 2>&1 && break
    sleep 0.2
  done
fi

open "http://127.0.0.1:7777/"
```

Make it executable:

```bash
chmod +x open-dashboard.sh
```

- [ ] **Step 2: Point the dock app at the launcher**

In `jobs-app.swift`, replace the body of `nodeInvocation()` and `openDashboard()` so the dock click runs `open-dashboard.sh` instead of `node dashboard.mjs --open`:

```swift
// Resolve the dashboard launcher script next to the app bundle.
let dashboardLauncher = (projectDir as NSString).appendingPathComponent("open-dashboard.sh")

func openDashboard() {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/bin/bash")
    proc.arguments = [dashboardLauncher]
    do { try proc.run(); dbg("opened dashboard via \(dashboardLauncher)") }
    catch { dbg("openDashboard failed: \(error)") }
}
```

Delete the now-unused `nodeInvocation()` function and the `dashboardScript` constant (the launcher owns node invocation).

- [ ] **Step 3: Rebuild and verify manually**

```bash
./build-jobs.sh
open -a ./Jobs.app
```

Expected: the dock click regenerates the dashboard, starts `state-server.mjs` (visible: `pgrep -fl state-server.mjs` returns a pid; `logs/state-server.log` shows the listen line), and the browser opens `http://127.0.0.1:7777/` showing the dashboard. A second dock click does NOT start a second server (`pgrep -fl state-server.mjs` still shows one pid).

- [ ] **Step 4: Commit**

```bash
git add open-dashboard.sh jobs-app.swift
git commit -m "feat: launch dashboard via state server on dock click

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 2 — Tracking + Notes (dashboard client)

### Task 4: Server-backed dashboard client — status, Applied, notes

**Files:**
- Modify: `dashboard.mjs` (card template `actions`/`details` block, CSS, and the entire inline `<script>`)
- Test: `test/dashboard-client.test.mjs` (node integration test against the live server)

**Interfaces:**
- Consumes: `GET/POST /state` from `state-server.mjs`; `applications/index.html` from `dashboard.mjs`.
- Produces: a dashboard whose status (`new/viewed/applied`), `appliedAt`, and per-card `note` persist to `job-state.json` via the server, with a `localStorage` fallback when the server is unreachable.

- [ ] **Step 1: Update the card template in `dashboard.mjs`**

Replace the `<div class="actions">…</div>` block (currently the `Open job` link + 2-button status segment, `dashboard.mjs:84-90`) with a 3-button segment that includes Applied:

```javascript
    <div class="actions">
      <a class="apply" href="${esc(f.url)}" target="_blank" rel="noopener" onclick="autoStatus(this.closest('.card'),'viewed')">Open job ↗</a>
      <div class="status-seg" role="group" aria-label="Status">
        <button data-status="new" onclick="setStatus(this.closest('.card'),'new')">New</button>
        <button data-status="viewed" onclick="setStatus(this.closest('.card'),'viewed')">Viewed</button>
        <button data-status="applied" onclick="setStatus(this.closest('.card'),'applied')">Applied</button>
      </div>
      <span class="applied-ago" hidden></span>
    </div>
```

Add a note expander immediately after the existing cover-letter `</details>` inside the card (after `dashboard.mjs:99`):

```javascript
  <details class="note-wrap">
    <summary>📝 Note <span class="note-has" hidden>●</span></summary>
    <textarea class="note" rows="3" placeholder="Private note (saved to disk)…" onblur="saveNote(this.closest('.card'), this.value)"></textarea>
  </details>
```

Bake the first-built date onto each card so Phase 4 can read it — change the opening `<article …>` tag (`dashboard.mjs:77`) to include `data-generated`:

```javascript
<article class="card" data-url="${esc(f.url)}" data-generated="${esc(f.generated || "")}">
```

And make `generated` available on each item by adding it where items are built (in the `.map(...)` near `dashboard.mjs:34`, extend the mapped object):

```javascript
  .map((x) => ({ ...x, score: parseInt(x.fm.score || "0", 10), generated: x.fm.generated || "" }));
```

- [ ] **Step 2: Add CSS for Applied + notes + offline badge**

In the `<style>` block, add the `applied` button colour, the applied accent, the note styles, and the offline badge:

```css
  .status-seg button.active[data-status="applied"] { background: #1a7f37; color: #fff; }
  .card.applied { border-left: 4px solid #1a7f37; }
  .applied-ago { font-size: 11px; color: #1a7f37; text-align: center; }
  .note-wrap summary { color: #57606a; }
  .note { width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; padding: 8px; border: 1px solid #d0d7de; border-radius: 7px; resize: vertical; }
  .note-has { color: #9a6700; }
  .offline { background: #9a6700; color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
```

- [ ] **Step 3: Replace the entire inline `<script>` block**

Replace everything between `<script>` and `</script>` (`dashboard.mjs:167-254`) with the server-backed client:

```javascript
// ---- State client: server-backed with a localStorage fallback ----------
// When the state server (state-server.mjs) is reachable, job-state.json on disk
// is the source of truth. When it is not (page opened as bare file://, or the
// server is down), we fall back to localStorage and flag it in the header.
const STATUS_KEY = 'jobStatus';        // legacy + offline cache: { url: {status,appliedAt,note} | "viewed" }
let online = false;
let state = { _meta: {} };             // mirror of the server store (or localStorage offline)

const entryOf = (url) => state[url] || {};
const statusOf = (url) => { const s = entryOf(url).status; return (s === 'viewed' || s === 'applied') ? s : 'new'; };

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
    out[url] = (typeof v === 'string') ? { status: v } : v;   // upgrade legacy strings
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
    let migrated = false;
    for (const [url, v] of Object.entries(local)) {
      if (url === '_meta' || state[url]) continue;
      const patch = (typeof v === 'string') ? { status: v } : v;
      state = await postState({ url, patch });
      migrated = true;
    }
    if (migrated) localStorage.removeItem(STATUS_KEY);
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
    const empty = !(e.status === 'viewed' || e.status === 'applied' || (e.note && e.note.length) || e.appliedAt);
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

function copyCover(i){
  const t = document.getElementById('cover'+i).innerText;
  navigator.clipboard.writeText(t).then(()=>{ event.target.textContent='✓ Copied'; setTimeout(()=>event.target.textContent='Copy letter',1500); });
}

function renderCard(card){
  const url = card.dataset.url;
  const st = statusOf(url);
  const e = entryOf(url);
  card.classList.toggle('viewed', st === 'viewed');
  card.classList.toggle('applied', st === 'applied');
  card.querySelectorAll('.status-seg button').forEach((b) => b.classList.toggle('active', b.dataset.status === st));
  const ago = card.querySelector('.applied-ago');
  if (ago) { if (st === 'applied' && e.appliedAt) { ago.textContent = 'applied ' + daysAgo(e.appliedAt); ago.hidden = false; } else ago.hidden = true; }
  const ta = card.querySelector('.note'); if (ta && document.activeElement !== ta) ta.value = e.note || '';
  const dot = card.querySelector('.note-has'); if (dot) dot.hidden = !(e.note && e.note.length);
}

async function setStatus(card, status){
  const url = card.dataset.url;
  const patch = { status };
  if (status === 'applied' && !entryOf(url).appliedAt) patch.appliedAt = new Date().toISOString();
  if (status !== 'applied') patch.appliedAt = null;
  await patchEntry(url, patch);
  renderCard(card); applyFilter();
}
// Auto-status never downgrades an Applied card.
async function autoStatus(card, status){ if (statusOf(card.dataset.url) === 'applied') return; await setStatus(card, status); }

async function saveNote(card, value){ await patchEntry(card.dataset.url, { note: value.trim() }); renderCard(card); }

let activeFilter = 'new';
function applyFilter(){
  const counts = { all: 0, new: 0, viewed: 0, applied: 0 };
  document.querySelectorAll('.card').forEach((card) => {
    const st = statusOf(card.dataset.url);
    counts.all++; counts[st]++;
    const detailsOpen = !!card.querySelector('details[open]');
    const show = (activeFilter === 'all' || activeFilter === st || detailsOpen);
    card.style.display = show ? '' : 'none';
  });
  for (const k of ['all','new','viewed','applied']) { const el = document.getElementById('cnt-'+k); if (el) el.textContent = counts[k]; }
}
function setFilter(btn, filter){ activeFilter = filter; document.querySelectorAll('.filter-seg button').forEach((b)=>b.classList.toggle('active', b===btn)); applyFilter(); }

(async function init(){
  await initState();
  document.querySelectorAll('.card').forEach(renderCard);
  applyFilter();
})();
```

- [ ] **Step 4: Add the Applied filter button to the header**

In the `.filter-seg` toolbar (`dashboard.mjs:157-161`), add the Applied filter button after Viewed:

```javascript
      <button data-filter="applied" onclick="setFilter(this,'applied')">Applied <span class="cnt" id="cnt-applied">0</span></button>
```

- [ ] **Step 5: Write the integration test**

```javascript
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

test("status, appliedAt and note persist across a server restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-"));
  const statePath = join(dir, "job-state.json");
  const indexPath = join(dir, "index.html");
  writeFileSync(indexPath, "<html></html>");
  const U = "https://example.com/jobs/7/";

  let srv = createServer({ statePath, indexPath });
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
  await new Promise((r) => srv.close(r));
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/dashboard-client.test.mjs`
Expected: PASS.

- [ ] **Step 7: Manual verification**

```bash
node dashboard.mjs && node state-server.mjs &
open "http://127.0.0.1:7777/"
```

Expected: clicking **Applied** on a card shows "applied today", green accent; reload keeps it; `cat job-state.json` shows the entry with `status:"applied"`, `appliedAt`, and (after typing a note + clicking away) `note`. Kill the server, open `applications/index.html` directly (`file://`) → header shows the amber "offline — not saved to disk" badge and edits still work locally.

- [ ] **Step 8: Commit**

```bash
git add dashboard.mjs test/dashboard-client.test.mjs
git commit -m "feat: server-backed dashboard status, applied-date and notes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 3 — Follow-up reminders

### Task 5: Pure reminder logic — `lib/followup.mjs`

**Files:**
- Create: `lib/followup.mjs`
- Test: `test/followup.test.mjs`

**Interfaces:**
- Produces: `dueReminders({ stateMap, now, thresholdDays = 7, alreadyNotified = [] }) -> [{ url, daysSince }]`. Includes a url iff its entry has `status === "applied"`, an `appliedAt` at least `thresholdDays` days before `now`, and its url is not in `alreadyNotified`. `daysSince` is a whole-day integer.

- [ ] **Step 1: Write the failing test**

```javascript
// test/followup.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { dueReminders } from "../lib/followup.mjs";

const now = new Date("2026-06-20T12:00:00Z");
const daysBefore = (n) => new Date(now.getTime() - n * 86400000).toISOString();

test("includes an applied job older than the threshold", () => {
  const map = { "u1": { status: "applied", appliedAt: daysBefore(8) } };
  const out = dueReminders({ stateMap: map, now });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "u1");
  assert.equal(out[0].daysSince, 8);
});

test("excludes jobs younger than the threshold", () => {
  const map = { "u1": { status: "applied", appliedAt: daysBefore(3) } };
  assert.equal(dueReminders({ stateMap: map, now }).length, 0);
});

test("excludes non-applied jobs and already-notified urls", () => {
  const map = {
    "u1": { status: "viewed", appliedAt: daysBefore(30) },
    "u2": { status: "applied", appliedAt: daysBefore(30) },
    "u3": { status: "applied", appliedAt: daysBefore(30) },
  };
  const out = dueReminders({ stateMap: map, now, alreadyNotified: ["u2"] });
  assert.deepEqual(out.map((r) => r.url), ["u3"]);
});

test("ignores _meta and entries without appliedAt", () => {
  const map = { _meta: { lastVisit: "x" }, "u1": { status: "applied" } };
  assert.equal(dueReminders({ stateMap: map, now }).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/followup.test.mjs`
Expected: FAIL — `Cannot find module '../lib/followup.mjs'`.

- [ ] **Step 3: Write the implementation**

```javascript
// lib/followup.mjs
// Pure selection of "applied" jobs that are due for a follow-up reminder.
export function dueReminders({ stateMap, now, thresholdDays = 7, alreadyNotified = [] }) {
  const seen = new Set(alreadyNotified);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const out = [];
  for (const [url, e] of Object.entries(stateMap)) {
    if (url === "_meta" || !e || e.status !== "applied" || !e.appliedAt) continue;
    if (seen.has(url)) continue;
    const days = Math.floor((nowMs - new Date(e.appliedAt).getTime()) / 86400000);
    if (Number.isFinite(days) && days >= thresholdDays) out.push({ url, daysSince: days });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/followup.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/followup.mjs test/followup.test.mjs
git commit -m "feat: add pure follow-up reminder selection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Reminder runner — `followup.mjs` + launchd

**Files:**
- Create: `followup.mjs`
- Create: `com.eugene.jobs-followup.plist`
- Create: `com.example.jobs-followup.plist.example`
- Reference: `lib/followup.mjs`, `lib/job-state.mjs`, `lib/notify-state.mjs` (dedupe pattern)

**Interfaces:**
- Consumes: `dueReminders` (`lib/followup.mjs`), `readStore` (`lib/job-state.mjs`).
- Produces: a CLI that fires one macOS notification per due reminder via `osascript`, joining titles/companies from `applications/*.md`, and records fired urls in `followup-notify-state.json` so the same job is not re-notified the same day.

This runner spawns `osascript` and writes a dedupe file; verify manually.

- [ ] **Step 1: Write the runner**

```javascript
// followup.mjs
// Daily reminder: notify about jobs marked "applied" with no movement for N days.
// Notifications go through osascript (terminal-notifier shows no banners on macOS 26).
import { readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readStore } from "./lib/job-state.mjs";
import { dueReminders } from "./lib/followup.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const STATE = join(dir, "job-state.json");
const APPS = join(dir, "applications");
const DEDUPE = join(dir, "followup-notify-state.json");
const THRESHOLD_DAYS = Number(process.env.FOLLOWUP_DAYS || 7);

// Map url -> { title, company } from the application packages.
function jobIndex() {
  const idx = {};
  for (const f of readdirSync(APPS).filter((x) => x.endsWith(".md"))) {
    const md = readFileSync(join(APPS, f), "utf8");
    const fm = (md.match(/^---\n([\s\S]*?)\n---/) || [])[1] || "";
    const get = (k) => (fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m")) || [])[1]?.trim() || "";
    const url = get("url");
    if (url) idx[url] = { title: get("title"), company: get("company") };
  }
  return idx;
}

// Dedupe per calendar day: { day: "YYYY-MM-DD", urls: [...] }.
function loadDedupe(today) {
  try { const d = JSON.parse(readFileSync(DEDUPE, "utf8")); if (d.day === today) return d.urls || []; } catch {}
  return [];
}
function saveDedupe(today, urls) {
  const tmp = `${DEDUPE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ day: today, urls }, null, 0));
  renameSync(tmp, DEDUPE);
}

function notify(title, body) {
  const esc = (s) => String(s).replace(/["\\]/g, "\\$&");
  execFileSync("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`]);
}

const today = new Date().toISOString().slice(0, 10);
const already = loadDedupe(today);
const due = dueReminders({ stateMap: readStore(STATE), now: new Date(), thresholdDays: THRESHOLD_DAYS, alreadyNotified: already });
const idx = jobIndex();

for (const { url, daysSince } of due) {
  const j = idx[url] || {};
  const where = j.company || j.title || "a job";
  notify("Follow up on your application", `${where} — applied ${daysSince}d ago, no reply yet`);
  already.push(url);
}
saveDedupe(today, already);
console.log(`followup: ${due.length} reminder(s) fired`);
```

- [ ] **Step 2: Manual verification**

```bash
# Seed an old applied job, then run the reminder.
node -e 'import("./lib/job-state.mjs").then(m=>{const map=m.mergeEntry({},"https://example.com/x/",{status:"applied",appliedAt:new Date(Date.now()-10*864e5).toISOString()});m.writeStore("./job-state.json",map);})'
node followup.mjs
```

Expected: a macOS banner "Follow up on your application" appears; console prints `followup: 1 reminder(s) fired`; running it again the same day prints `0` (deduped). Restore real state afterward (the seed url is harmless but can be removed from `job-state.json`).

- [ ] **Step 3: Create the launchd plists**

Create `com.example.jobs-followup.plist.example` (committed template) and the real `com.eugene.jobs-followup.plist` (git-ignored like the others — confirm `.gitignore` covers `com.eugene.*.plist`). Both run daily at 09:30:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.eugene.jobs-followup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/eugenelazeba/.nvm/versions/node/v20.14.0/bin/node</string>
    <string>/Users/eugenelazeba/linkedin-assistant/followup.mjs</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>/Users/eugenelazeba/linkedin-assistant/logs/followup.log</string>
  <key>StandardErrorPath</key><string>/Users/eugenelazeba/linkedin-assistant/logs/followup.log</string>
</dict>
</plist>
```

Load it:

```bash
cp com.eugene.jobs-followup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.eugene.jobs-followup.plist
```

- [ ] **Step 4: Commit**

```bash
git add followup.mjs com.example.jobs-followup.plist.example
git commit -m "feat: daily follow-up reminders via osascript and launchd

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 4 — Find + Freshness

### Task 7: Freshness — "new since last visit"

**Files:**
- Create: `lib/freshness.mjs`
- Test: `test/freshness.test.mjs`
- Modify: `dashboard.mjs` (header markup + inline `<script>`)

**Interfaces:**
- Produces: `isNew(generatedISO, lastVisitISO) -> boolean` — true iff both parse and `generated > lastVisit`; false when `lastVisitISO` is missing/invalid (no baseline yet → nothing flagged).

- [ ] **Step 1: Write the failing test**

```javascript
// test/freshness.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isNew } from "../lib/freshness.mjs";

test("flags a job generated after the last visit", () => {
  assert.equal(isNew("2026-06-20T10:00:00Z", "2026-06-19T00:00:00Z"), true);
});
test("does not flag a job generated before the last visit", () => {
  assert.equal(isNew("2026-06-18T10:00:00Z", "2026-06-19T00:00:00Z"), false);
});
test("flags nothing when there is no last-visit baseline", () => {
  assert.equal(isNew("2026-06-20T10:00:00Z", ""), false);
  assert.equal(isNew("2026-06-20T10:00:00Z", undefined), false);
});
test("returns false for an unparseable generated date", () => {
  assert.equal(isNew("not-a-date", "2026-06-19T00:00:00Z"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/freshness.test.mjs`
Expected: FAIL — `Cannot find module '../lib/freshness.mjs'`.

- [ ] **Step 3: Write the implementation**

```javascript
// lib/freshness.mjs
// A job is "new since last visit" when it was generated after the stored
// lastVisit timestamp. With no baseline yet, nothing is flagged.
export function isNew(generatedISO, lastVisitISO) {
  if (!lastVisitISO) return false;
  const g = Date.parse(generatedISO);
  const v = Date.parse(lastVisitISO);
  if (!Number.isFinite(g) || !Number.isFinite(v)) return false;
  return g > v;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/freshness.test.mjs`
Expected: PASS.

- [ ] **Step 5: Wire freshness into the dashboard client**

In `dashboard.mjs`, add a 🆕 counter to the `.filter-seg` header (after the Applied filter button):

```javascript
      <button data-filter="fresh" onclick="setFilter(this,'fresh')">🆕 New since visit <span class="cnt" id="cnt-fresh">0</span></button>
```

Add CSS for the ribbon:

```css
  .card.fresh { box-shadow: inset 3px 0 0 #0969da; }
  .ribbon { background: #0969da; color: #fff; font-size: 10px; padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
```

In the inline `<script>`, add the freshness logic. Inline a copy of `isNew` (the browser cannot import the lib), mark cards on init, advance `lastVisit` a few seconds after load, and extend `applyFilter` to support the `fresh` filter:

```javascript
// Inlined from lib/freshness.mjs (browser has no module import here).
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
    }
  });
  const el = document.getElementById('cnt-fresh'); if (el) el.textContent = count;
}

async function advanceLastVisit() {
  const nowIso = new Date().toISOString();
  if (online) { try { state = await postState({ _meta: { lastVisit: nowIso } }); } catch {} }
  else { state._meta = { ...(state._meta || {}), lastVisit: nowIso }; saveLocal(); }
}
```

Extend `applyFilter` so `fresh` filters on the `.fresh` class (add to the per-card visibility test):

```javascript
    const isFresh = card.classList.contains('fresh');
    const show = (activeFilter === 'all' || (activeFilter === 'fresh' ? isFresh : activeFilter === st) || detailsOpen);
```

Call `markFreshness()` inside the `init()` IIFE after `renderCard`, and schedule `advanceLastVisit()` 4s later:

```javascript
(async function init(){
  await initState();
  document.querySelectorAll('.card').forEach(renderCard);
  markFreshness();
  applyFilter();
  setTimeout(advanceLastVisit, 4000);
})();
```

- [ ] **Step 6: Manual verification**

```bash
node dashboard.mjs && node state-server.mjs &
open "http://127.0.0.1:7777/"
```

Expected: on first visit nothing is flagged (no baseline). Reload after 5s, then regenerate with a freshly-`generated` package — its card shows a blue **NEW** ribbon and the "🆕 New since visit" counter increments; clicking that filter shows only fresh cards.

- [ ] **Step 7: Commit**

```bash
git add lib/freshness.mjs test/freshness.test.mjs dashboard.mjs
git commit -m "feat: highlight jobs new since last dashboard visit

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Find — search + source + min-score filters

**Files:**
- Modify: `dashboard.mjs` (card data attributes, header toolbar, inline `<script>`)

This task is client-side DOM filtering; verify manually.

- [ ] **Step 1: Add filterable data to each card**

In the card template (`<article …>`), add searchable text and source/score data attributes:

```javascript
<article class="card" data-url="${esc(f.url)}" data-generated="${esc(f.generated || "")}" data-source="${esc(f.source || "dou")}" data-score="${it.score}" data-search="${esc(((f.title||"")+" "+(f.company||"")+" "+(f.matched_skills||"")).toLowerCase())}">
```

- [ ] **Step 2: Add the find toolbar to the header**

After the `.filter-seg` group inside `.toolbar`, add a search box, source chips, and min-score presets:

```javascript
    <input id="q" type="search" placeholder="Search title / company / skills…" oninput="setQuery(this.value)" />
    <div class="src-seg" role="group" aria-label="Source">
      <button data-src="all" class="active" onclick="setSource(this,'all')">All</button>
      <button data-src="linkedin" onclick="setSource(this,'linkedin')">LinkedIn</button>
      <button data-src="dou" onclick="setSource(this,'dou')">DOU</button>
      <button data-src="djinni" onclick="setSource(this,'djinni')">Djinni</button>
      <button data-src="jooble" onclick="setSource(this,'jooble')">Jooble</button>
    </div>
    <div class="min-seg" role="group" aria-label="Minimum score">
      <button data-min="0" class="active" onclick="setMin(this,0)">All</button>
      <button data-min="30" onclick="setMin(this,30)">≥30</button>
      <button data-min="40" onclick="setMin(this,40)">≥40</button>
    </div>
```

- [ ] **Step 3: Add CSS for the find controls**

```css
  #q { flex: 1; min-width: 160px; padding: 5px 10px; border-radius: 7px; border: 1px solid #57606a; background: #32383f; color: #fff; font-size: 13px; }
  #q::placeholder { color: #9aa5b1; }
  .src-seg, .min-seg { display: inline-flex; border: 1px solid #57606a; border-radius: 7px; overflow: hidden; }
  .src-seg button, .min-seg button { background: transparent; color: #cdd9e5; border: 0; border-left: 1px solid #57606a; padding: 5px 10px; font-size: 12px; cursor: pointer; }
  .src-seg button:first-child, .min-seg button:first-child { border-left: 0; }
  .src-seg button.active, .min-seg button.active { background: #0969da; color: #fff; }
```

- [ ] **Step 4: Add the find state to `applyFilter`**

Add module-level find state and setters, and fold them into `applyFilter`'s per-card visibility test:

```javascript
let query = '', srcFilter = 'all', minScore = 0;
function setQuery(v){ query = v.trim().toLowerCase(); applyFilter(); }
function setSource(btn, src){ srcFilter = src; document.querySelectorAll('.src-seg button').forEach((b)=>b.classList.toggle('active', b===btn)); applyFilter(); }
function setMin(btn, n){ minScore = n; document.querySelectorAll('.min-seg button').forEach((b)=>b.classList.toggle('active', b===btn)); applyFilter(); }
```

Update the visibility line in `applyFilter` so all filters AND together (status counters still count only the status dimension, computed before the find filters hide cards):

```javascript
    const matchFind =
      (srcFilter === 'all' || card.dataset.source === srcFilter) &&
      (Number(card.dataset.score) >= minScore) &&
      (!query || (card.dataset.search || '').includes(query));
    const isFresh = card.classList.contains('fresh');
    const matchStatus = (activeFilter === 'all' || (activeFilter === 'fresh' ? isFresh : activeFilter === st) || detailsOpen);
    card.style.display = (matchStatus && matchFind) ? '' : 'none';
```

- [ ] **Step 5: Manual verification**

```bash
node dashboard.mjs && node state-server.mjs &
open "http://127.0.0.1:7777/"
```

Expected: typing in the search box narrows cards live by title/company/skill; the source chips restrict to one board; `≥40` hides lower-scored cards. All three compose with the status/fresh filters. Clearing search + `All` + `All` restores the full list.

- [ ] **Step 6: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: add search, source and min-score filters to dashboard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the whole test suite**

Run: `npm test`
Expected: PASS — `job-state`, `state-server`, `dashboard-client`, `followup`, `freshness`, plus all pre-existing suites (`dedup`, `notify-state`, `prune`, `relevance`, `run-summary`, `salary`, `source-health`).

- [ ] **End-to-end smoke**

```bash
node jobs.mjs            # discovery → regenerates applications/index.html
./open-dashboard.sh      # server up on 7777, browser opens
```

Expected: dashboard loads from the server; set a card to Applied, add a note, confirm both land in `job-state.json`; the find/fresh filters work; `node followup.mjs` (after the threshold) fires a reminder.

- [ ] **Update docs**

Add a short "Dashboard v2 / state server" section to `README.md` and `README.uk.md` describing the `127.0.0.1:7777` server, `job-state.json`, the follow-up reminder launchd job, and the offline fallback. Commit:

```bash
git add README.md README.uk.md
git commit -m "docs: document dashboard state server and follow-up reminders

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
