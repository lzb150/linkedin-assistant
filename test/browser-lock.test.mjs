import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

test("acquireProfileLock takes over a stale lock (no pid file → mtime fallback)", (t) => {
  const p = tmp(t);
  mkdirSync(`${p}.lock`);
  // pretend "now" is 3h in the future so the fresh dir looks stale
  const release = acquireProfileLock(p, { now: Date.now() + 3 * 3600_000 });
  assert.ok(existsSync(`${p}.lock`));
  assert.equal(readFileSync(join(`${p}.lock`, "pid"), "utf8"), String(process.pid));
  release();
});

test("acquireProfileLock takes over a fresh lock whose pid is dead", (t) => {
  const p = tmp(t);
  mkdirSync(`${p}.lock`);
  // a child that has already exited: its pid is guaranteed dead
  const dead = spawnSync("true").pid;
  writeFileSync(join(`${p}.lock`, "pid"), String(dead));
  const release = acquireProfileLock(p); // mtime is fresh — pid check must win
  assert.equal(readFileSync(join(`${p}.lock`, "pid"), "utf8"), String(process.pid));
  release();
});

test("acquireProfileLock does not take over an old lock whose pid is alive", (t) => {
  const p = tmp(t);
  mkdirSync(`${p}.lock`);
  writeFileSync(join(`${p}.lock`, "pid"), String(process.pid));
  assert.throws(() => acquireProfileLock(p, { now: Date.now() + 3 * 3600_000 }), /profile busy/);
});

test("release() leaves a lock alone once another pid has taken it over", (t) => {
  const p = tmp(t);
  const release = acquireProfileLock(p);
  // Simulate a takeover by another run (e.g. one that misjudged our pid dead).
  writeFileSync(join(`${p}.lock`, "pid"), "999999");
  release();
  assert.ok(existsSync(`${p}.lock`));
  assert.equal(readFileSync(join(`${p}.lock`, "pid"), "utf8"), "999999");
});
