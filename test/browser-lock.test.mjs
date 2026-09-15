import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { acquireProfileLock } from "../lib/browser.mjs";
import { tmpDir } from "./helpers/e2e.mjs";
import { explainLaunchError } from "../lib/browser.mjs";

test("acquireProfileLock creates the lock, rejects a second holder, releases", (t) => {
  const p = join(tmpDir(t), "profile");
  const release = acquireProfileLock(p);
  assert.ok(existsSync(`${p}.lock`));
  assert.throws(() => acquireProfileLock(p), /profile busy: another run holds .*profile\.lock/);
  release();
  assert.ok(!existsSync(`${p}.lock`));
});

test("acquireProfileLock takes over a stale lock (no pid file → mtime fallback)", (t) => {
  const p = join(tmpDir(t), "profile");
  mkdirSync(`${p}.lock`);
  // pretend "now" is 3h in the future so the fresh dir looks stale
  const release = acquireProfileLock(p, { now: Date.now() + 3 * 3600_000 });
  assert.ok(existsSync(`${p}.lock`));
  assert.equal(readFileSync(join(`${p}.lock`, "pid"), "utf8"), String(process.pid));
  release();
});

test("acquireProfileLock takes over a fresh lock whose pid is dead", (t) => {
  const p = join(tmpDir(t), "profile");
  mkdirSync(`${p}.lock`);
  // a child that has already exited: its pid is guaranteed dead
  const dead = spawnSync("true").pid;
  writeFileSync(join(`${p}.lock`, "pid"), String(dead));
  const release = acquireProfileLock(p); // mtime is fresh — pid check must win
  assert.equal(readFileSync(join(`${p}.lock`, "pid"), "utf8"), String(process.pid));
  release();
});

test("acquireProfileLock takes over an ancient lock even if its pid is alive (pid reuse)", (t) => {
  const p = join(tmpDir(t), "profile");
  mkdirSync(`${p}.lock`);
  writeFileSync(join(`${p}.lock`, "pid"), String(process.pid));
  // Within staleMs an alive pid holds the lock...
  assert.throws(() => acquireProfileLock(p), /profile busy/);
  // ...beyond it, an alive pid is far more likely a reused pid than a 3h run.
  const release = acquireProfileLock(p, { now: Date.now() + 3 * 3600_000 });
  assert.equal(readFileSync(join(`${p}.lock`, "pid"), "utf8"), String(process.pid));
  release();
});

test("a second run cannot take over a lock that was stale but has since been claimed", (t) => {
  // The old design made the mkdir the lock and wrote the pid afterwards, so two
  // runs that both judged the same lock stale could both remove it and both
  // "win" — the second rm deleted the first's directory. The pid file is the
  // lock now, created with O_EXCL, and a takeover re-reads it before unlinking.
  const p = join(tmpDir(t), "profile");
  const dead = spawnSync("true").pid;
  mkdirSync(`${p}.lock`);
  writeFileSync(join(`${p}.lock`, "pid"), String(dead));

  const release = acquireProfileLock(p);                       // run A takes the stale lock over
  assert.equal(readFileSync(join(`${p}.lock`, "pid"), "utf8"), String(process.pid));
  // Run B reached the same conclusion about the dead pid a moment later. It must
  // now see A's live lock, not take it.
  assert.throws(() => acquireProfileLock(p), /profile busy/);
  assert.equal(readFileSync(join(`${p}.lock`, "pid"), "utf8"), String(process.pid), "A still holds it");
  release();
});

test("release() leaves a lock alone once another pid has taken it over", (t) => {
  const p = join(tmpDir(t), "profile");
  const release = acquireProfileLock(p);
  // Simulate a takeover by another run (e.g. one that misjudged our pid dead).
  writeFileSync(join(`${p}.lock`, "pid"), "999999");
  release();
  assert.ok(existsSync(`${p}.lock`));
  assert.equal(readFileSync(join(`${p}.lock`, "pid"), "utf8"), "999999");
});

test("explainLaunchError: a missing browser build gets the install hint, other errors pass through untouched", () => {
  const e = new Error("browserType.launchPersistentContext: Executable doesn't exist at /x/chromium_headless_shell-1243/chrome\n╔═ Looks like Playwright was just installed ═╗");
  assert.match(explainLaunchError(e).message, /^Playwright browser build missing — run: npx playwright install chromium/);
  assert.doesNotMatch(explainLaunchError(e).message, /╔═/, "only the first line of Playwright's banner is kept");
  const other = new Error("profile busy");
  assert.equal(explainLaunchError(other), other);
});

test("acquireProfileLock heartbeats the lock mtime so a long live run is never judged stale", async (t) => {
  const p = join(tmpDir(t), "profile");
  const release = acquireProfileLock(p, { heartbeatMs: 5 });
  const { utimesSync, statSync } = await import("node:fs");
  const old = new Date(Date.now() - 3 * 3600_000);
  utimesSync(`${p}.lock`, old, old);
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(Date.now() - statSync(`${p}.lock`).mtimeMs < 3600_000, "mtime refreshed by the heartbeat");
  release();
  assert.ok(!existsSync(`${p}.lock`));
});
