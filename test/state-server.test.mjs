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
