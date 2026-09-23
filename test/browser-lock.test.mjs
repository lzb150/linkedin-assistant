import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
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

test("acquireProfileLock never takes over a lock whose pid is alive, however ancient the mtime", (t) => {
  // This assertion was inverted on purpose. The lock used to evict a live
  // holder once the mtime passed staleMs, on the theory that an old lock whose
  // pid still runs is more likely a reused pid than a long run. But the
  // heartbeat is a setInterval, and timers do not fire while macOS is asleep:
  // after a long sleep launchd fires the missed runs before the still-running
  // holder gets a tick, so the holder looks stale on mtime alone and got
  // evicted — two Chromium instances on one persistent profile, which is the
  // corruption this lock exists to prevent. Refusing costs one skipped run when
  // a pid really was reused; evicting costs the profile.
  const p = join(tmpDir(t), "profile");
  mkdirSync(`${p}.lock`);
  writeFileSync(join(`${p}.lock`, "pid"), String(process.pid));
  // Within staleMs an alive pid holds the lock...
  assert.throws(() => acquireProfileLock(p), /profile busy/);
  // ...and beyond it too: liveness wins over mtime.
  assert.throws(() => acquireProfileLock(p, { now: Date.now() + 3 * 3600_000 }), /profile busy/);
  assert.equal(readFileSync(join(`${p}.lock`, "pid"), "utf8"), String(process.pid), "the live holder still owns it");
});

test("acquireProfileLock reclaims an ancient lock whose pid file is unparsable (no owner to protect)", (t) => {
  const p = join(tmpDir(t), "profile");
  mkdirSync(`${p}.lock`);
  writeFileSync(join(`${p}.lock`, "pid"), "not-a-pid");
  // Fresh: nothing proves it dead, so it is left alone.
  assert.throws(() => acquireProfileLock(p), /profile busy/);
  // Ancient: an unparsable pid names no process that could still be running.
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

test("acquireProfileLock survives the lock directory vanishing between mkdir and the claim", (t) => {
  // Another run's release() removes the whole directory. The lock is free at
  // that point, so failing with a raw ENOENT would turn "free" into an opaque
  // filesystem error; one retry recreates the container and claims it.
  const p = join(tmpDir(t), "profile");
  const release = acquireProfileLock(p);
  release();                                   // the directory is gone now
  assert.ok(!existsSync(`${p}.lock`));
  const again = acquireProfileLock(p);         // must simply succeed
  assert.equal(readFileSync(join(`${p}.lock`, "pid"), "utf8"), String(process.pid));
  again();
});

test("acquireProfileLock names a regular file sitting where the lock directory belongs", (t) => {
  const p = join(tmpDir(t), "profile");
  writeFileSync(`${p}.lock`, "not a directory");
  assert.throws(() => acquireProfileLock(p), /profile lock path is not a directory/);
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

test("a run killed by SIGTERM releases the lock instead of leaving it behind", async (t) => {
  // "exit" does not fire for a default-disposition SIGTERM, so `launchctl kill`,
  // unloading the agent, or Ctrl-C used to leave the lock directory in place.
  // With pids recycled quickly the next run could then find a live unrelated pid
  // sitting in that file and refuse for the whole stale window — and check.mjs
  // reports "profile busy" as a healthy run (exit 0), so hours of hourly scans
  // went missing with only a log line to show for it.
  const p = join(tmpDir(t), "profile");
  const browserUrl = new URL("../lib/browser.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["-e", `
    import(${JSON.stringify(browserUrl)}).then(({ acquireProfileLock }) => {
      acquireProfileLock(${JSON.stringify(p)});
      console.log("ready");
      setInterval(() => {}, 1000);           // stay alive until signalled
    });
  `]);

  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("ready") && resolve());
    child.on("error", reject);
    child.on("exit", (c) => reject(new Error(`child exited early with ${c}`)));
  });
  assert.ok(existsSync(`${p}.lock`), "the child holds the lock");

  const exit = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));
  child.kill("SIGTERM");
  const { code } = await exit;

  assert.ok(!existsSync(`${p}.lock`), "the lock is gone after the signal");
  assert.equal(code, 143, "exits 128+SIGTERM so launchd still sees a signalled run");
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
