import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProfileLock } from "../lib/browser.mjs";

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "profile");
}

test("acquireProfileLock creates the lock, rejects a second holder, releases", (t) => {
  const p = tmp(t);
  const release = acquireProfileLock(p);
  assert.ok(existsSync(`${p}.lock`));
  assert.throws(() => acquireProfileLock(p), /profile busy: another run holds .*profile\.lock/);
  release();
  assert.ok(!existsSync(`${p}.lock`));
});

test("acquireProfileLock takes over a stale lock", (t) => {
  const p = tmp(t);
  mkdirSync(`${p}.lock`);
  // pretend "now" is 3h in the future so the fresh dir looks stale
  const release = acquireProfileLock(p, { now: Date.now() + 3 * 3600_000 });
  assert.ok(existsSync(`${p}.lock`));
  release();
});
