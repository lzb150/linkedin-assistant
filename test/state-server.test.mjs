import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../state-server.mjs";

function listen(srv) {
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res(srv.address().port)));
}

test("POST /state persists a patch and GET /state reads it back", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "srv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, "job-state.json");
  const srv = createServer({ statePath, indexPath: join(dir, "index.html") });
  t.after(() => new Promise((r) => srv.close(() => r())));
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
});

test("rejects cross-origin shaped requests: foreign Host and non-JSON POST", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "srv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const srv = createServer({ statePath: join(dir, "job-state.json"), indexPath: join(dir, "index.html") });
  t.after(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${await listen(srv)}`;

  // DNS-rebinding shape: request reaches the server with a foreign Host header.
  // (fetch strips a custom Host — it's a forbidden header — so use node:http.)
  const { request } = await import("node:http");
  const rebindStatus = await new Promise((resolve, reject) => {
    const r = request(`${base}/state`, { headers: { host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    r.on("error", reject);
    r.end();
  });
  assert.equal(rebindStatus, 403);

  // CSRF shape: a no-preflight "simple request" POST (text/plain body).
  const csrf = await fetch(`${base}/state`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ url: "https://x/", patch: { status: "applied" } }),
  });
  assert.equal(csrf.status, 415);

  // Legit same-origin JSON still works.
  const ok = await fetch(`${base}/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://x/", patch: { status: "viewed" } }),
  });
  assert.equal(ok.status, 200);
});

test("oversize POST body is dropped without hanging the request", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "srv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const srv = createServer({ statePath: join(dir, "job-state.json"), indexPath: join(dir, "index.html") });
  t.after(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${await listen(srv)}`;

  // >1MB body → server destroys the connection; the client sees an error
  // instead of an eternally pending request (the old behavior).
  await assert.rejects(
    fetch(`${base}/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"url":"https://x/","patch":{"note":"${"x".repeat(1_100_000)}"}}`,
    })
  );
});

test("rejects non-http(s) urls and oversized notes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "srv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const srv = createServer({ statePath: join(dir, "job-state.json"), indexPath: join(dir, "index.html") });
  t.after(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${await listen(srv)}`;
  const post = (body) => fetch(`${base}/state`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.status);

  assert.equal(await post({ url: "javascript:alert(1)", patch: { status: "viewed" } }), 400);
  assert.equal(await post({ url: "__proto__", patch: { status: "viewed" } }), 400);
  assert.equal(await post({ url: "https://x/", patch: { note: "n".repeat(10_001) } }), 400);
  assert.equal(await post({ url: "https://x/", patch: { note: "n".repeat(10_000) } }), 200);
});

test("multi-byte body split across two chunks mid-character round-trips intact", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "srv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, "job-state.json");
  const srv = createServer({ statePath, indexPath: join(dir, "index.html") });
  t.after(() => new Promise((r) => srv.close(() => r())));
  const port = await listen(srv);

  const note = "Київ — QA 🚀";
  const body = Buffer.from(JSON.stringify({ url: "https://x/", patch: { note } }));
  // Cut inside the multi-byte "К" (2 bytes) so per-chunk decoding would mangle it.
  const cut = body.indexOf(Buffer.from("К")) + 1;
  const { request } = await import("node:http");
  const status = await new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path: "/state", method: "POST", headers: { "content-type": "application/json" } },
      (res) => { res.resume(); resolve(res.statusCode); });
    r.on("error", reject);
    r.write(body.subarray(0, cut));
    setTimeout(() => r.end(body.subarray(cut)), 20);
  });
  assert.equal(status, 200);
  const state = await fetch(`http://127.0.0.1:${port}/state`).then((r) => r.json());
  assert.equal(state["https://x/"].note, note);
});

test("corrupt state file → GET /state 500, file left byte-identical", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "srv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, "job-state.json");
  const corrupt = '{"https://x/": {"status": "applied" ';
  writeFileSync(statePath, corrupt);
  const srv = createServer({ statePath, indexPath: join(dir, "index.html") });
  t.after(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${await listen(srv)}`;

  assert.equal((await fetch(`${base}/state`)).status, 500);
  // A POST must not turn the failed read into a truncating write.
  const post = await fetch(`${base}/state`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://y/", patch: { status: "viewed" } }),
  });
  assert.equal(post.status, 500);
  assert.equal(readFileSync(statePath, "utf8"), corrupt);
});

test("unwritable state path → POST 500, server still alive", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "srv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "notadir"), "");
  const statePath = join(dir, "notadir", "job-state.json"); // ENOTDIR on write
  const srv = createServer({ statePath, indexPath: join(dir, "index.html") });
  t.after(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${await listen(srv)}`;

  const post = await fetch(`${base}/state`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ _meta: { lastVisit: "t" } }),
  });
  assert.equal(post.status, 500);
  assert.deepEqual(await fetch(`${base}/health`).then((r) => r.json()), { ok: true });
});
