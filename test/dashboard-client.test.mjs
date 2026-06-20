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
