// closed-check.mjs as a black box. The probe runs for minutes while the
// dashboard may write job-state.json: edits landing meanwhile must win, and a
// status the user set on the probed card beats the board's closure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { makeProject, pkg, spawnScript, runScript } from "./helpers/e2e.mjs";

// A board that reports every vacancy gone.
async function server404(t) {
  const srv = createServer((_req, res) => { res.statusCode = 404; res.end("gone"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}`;
}
const quiet = { osascript: "#!/bin/sh\nexit 0\n", "notify-send": "#!/bin/sh\nexit 0\n" };
// The fixture board lives on loopback; the host allowlist must be told so.
const LOCAL = { CLOSED_HOSTS: JSON.stringify({ dou: "127.0.0.1" }) };

test("closed-check: edits landing during the run win — another url's status survives, and a status set on the probed url beats the closure", async (t) => {
  const U = `${await server404(t)}/vacancies/1/`;
  const p = makeProject(t, {
    scripts: ["closed-check.mjs"],
    packages: { "a.md": pkg({ url: U }) },
    state: { _meta: {}, "https://other/": { status: "viewed" } },
    bins: quiet,
  });

  // Two "dashboard clicks" land after the script's initial read (its stdout
  // shows `probing`) and before its 1 s post-probe sleep. Triggering on output,
  // not a timer: a timer could fire before the read on a slow runner and the
  // test would pass without racing anything.
  const run = spawnScript(p, "closed-check.mjs", LOCAL);
  await run.output(/probing \d+ of/);
  const now = new Date().toISOString();   // a fresh closure: not yet due for archiving
  writeFileSync(p.path("job-state.json"), JSON.stringify({ _meta: {},
    "https://other/": { status: "closed", updatedAt: now },
    [U]: { status: "closed", updatedAt: now } }));
  const out = await run.done;

  assert.match(out, /✗ closed \[404\]/, "the board did report it closed");
  assert.match(out, /0 closed, 1 probed/, "…but the status set during the run wins, so nothing was saved by the probe");
  const state = p.json("job-state.json");
  assert.equal(state[U].status, "closed", "status set during the run is not overwritten by the probe");
  assert.equal(state["https://other/"].status, "closed", "the concurrent edit on another url survived");
  assert.ok(Object.keys(p.json("closed-check-state.json")).includes(U), "check stamp written");
});

test("closed-check: with no concurrent edit the closure is recorded", async (t) => {
  const U = `${await server404(t)}/vacancies/2/`;
  const p = makeProject(t, { scripts: ["closed-check.mjs"], packages: { "b.md": pkg({ url: U }) }, state: { _meta: {} }, bins: quiet });
  assert.match(await runScript(p, "closed-check.mjs", LOCAL), /1 closed, 1 probed/);
  assert.equal(p.json("job-state.json")[U].status, "closed");
});

// Archiving a package must take its job-state entry along, and entries whose
// package is gone for any other reason are dropped too (once a day old — a
// package written and clicked during the probe must survive) — but never when
// applications/ read as empty (that once looked like "delete everything").
// example.com urls are off every board's host allowlist, so nothing is probed.
test("closed-check: archived and orphaned state entries are dropped; an empty applications/ prunes nothing", async (t) => {
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const live = "https://example.com/v/9/", gone = "https://example.com/v/8/", orphan = "https://example.com/v/7/", fresh = "https://example.com/v/6/";
  const p = makeProject(t, {
    scripts: ["closed-check.mjs"],
    packages: { "live.md": pkg({ url: live }), "gone.md": pkg({ url: gone }) },
    state: { _meta: { lastVisit: "2026-09-01T00:00:00Z" }, [live]: { status: "viewed", updatedAt: new Date().toISOString() }, [gone]: { status: "viewed", updatedAt: old }, [orphan]: { status: "closed", updatedAt: old }, [fresh]: { status: "viewed", updatedAt: new Date().toISOString() } },
    bins: quiet,
  });
  const out = await runScript(p, "closed-check.mjs");
  assert.match(out, /1 package\(s\) archived .*2 stale state entries dropped/);
  const state = p.json("job-state.json");
  assert.deepEqual(Object.keys(state).sort(), ["_meta", live, fresh].sort(), "gone (archived now) and orphan removed; live, a fresh no-package entry (clicked during the probe) and _meta kept");
  assert.equal(state._meta.lastVisit, "2026-09-01T00:00:00Z", "_meta untouched");

  const empty = makeProject(t, { scripts: ["closed-check.mjs"], packages: {}, state: { _meta: {}, [orphan]: { status: "closed" } }, bins: quiet });
  await runScript(empty, "closed-check.mjs");
  assert.ok(empty.json("job-state.json")[orphan], "an empty applications/ must not wipe the store");
});

// planArchive reads a missing updatedAt as "old enough to archive" while the
// prune read it as "not stale", so a legacy entry could be archived and then
// kept forever with no package behind it.
test("closed-check: a legacy entry with no updatedAt is pruned, not kept forever", async (t) => {
  const legacy = "https://example.com/v/3/";
  const p = makeProject(t, {
    scripts: ["closed-check.mjs"],
    packages: { "ok.md": pkg({ url: "https://example.com/v/4/" }) },
    state: { _meta: {}, [legacy]: { status: "closed" } },   // no updatedAt at all
    bins: quiet,
  });
  await runScript(p, "closed-check.mjs");
  assert.equal(p.json("job-state.json")[legacy], undefined, "orphaned legacy entry dropped");
});

// The empty-applications/ guard above is all-or-nothing; the realistic failure is
// ONE package readPackages cannot read (a permission error, a rewrite in flight).
// It is missing from the package list, so it looks orphaned and its entry —
// "viewed"/"closed" and all — used to be pruned, bringing the card back as New.
test("closed-check: a package that cannot be read prunes nothing", async (t) => {
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const unreadable = "https://example.com/v/5/";
  const p = makeProject(t, {
    scripts: ["closed-check.mjs"],
    packages: { "ok.md": pkg({ url: "https://example.com/v/4/" }) },
    state: { _meta: {}, [unreadable]: { status: "viewed", updatedAt: old } },
    bins: quiet,
  });
  mkdirSync(p.path("applications/broken.md"));   // a directory reads as EISDIR
  const out = await runScript(p, "closed-check.mjs");
  assert.match(out, /could not read broken\.md/, "the skip is reported, not silent");
  assert.match(out, /0 stale state entries dropped/);
  assert.ok(p.json("job-state.json")[unreadable], "a partial read of applications/ must not prune");
});

// The state entry used to be pruned before the rename: a failed rename left the
// package in applications/ with no entry, and it came back as New.
test("closed-check: a package whose archive rename fails keeps its state entry", async (t) => {
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const gone = "https://example.com/v/8/";
  const p = makeProject(t, { scripts: ["closed-check.mjs"], packages: { "gone.md": pkg({ url: gone }) }, state: { _meta: {}, [gone]: { status: "viewed", updatedAt: old } }, bins: quiet });
  mkdirSync(p.path("applications", "archive", "gone.md"), { recursive: true });   // a file cannot be renamed onto a directory
  const out = await runScript(p, "closed-check.mjs");
  assert.match(out, /could not archive gone\.md, keeping it/);
  assert.match(out, /0 package\(s\) archived .*0 stale state entries dropped/);
  assert.equal(p.json("job-state.json")[gone].status, "viewed", "entry kept with the package");
});

// One corrupt read used to replace the whole stamp file: this run's ~150 stamps
// were written over the accumulated set, so every other url looked never-probed
// and the next run re-probed boards it had just probed — and the fresh stamps
// hid the loss.
test("closed-check: an unreadable closed-check-state.json is reported and left untouched", async (t) => {
  const U = `${await server404(t)}/vacancies/1/`;
  const p = makeProject(t, {
    scripts: ["closed-check.mjs"],
    packages: { "a.md": pkg({ url: U }) },
    state: { _meta: {}, [U]: { status: "new" } },
    bins: quiet,
  });
  const corrupt = '{"https://example.com/v/1/": "2026-09-01T00:00:00.000Z"';   // truncated
  writeFileSync(p.path("closed-check-state.json"), corrupt);
  const out = await runScript(p, "closed-check.mjs", LOCAL);
  assert.match(out, /closed-check-state\.json unreadable/, "the run says stamps are not being updated");
  assert.equal(p.read("closed-check-state.json"), corrupt, "the stamp file is left byte-identical");
  // The run still does its real job — closures are independent of the stamps.
  assert.equal(p.json("job-state.json")[U].status, "closed", "closures are still saved");
});

test("closed-check: a second overlapping run exits quietly instead of clobbering the stamp file", async (t) => {
  // The probe loop runs for minutes (1 req/s over up to 150 urls), so a manual
  // run easily overlaps the scheduled one. Each held its own in-memory `checked`
  // map and wrote it whole, so the last writer won and the other run's fresh
  // stamps vanished — both then re-probed the same urls the next day. jobs.mjs
  // has taken a run lock for this reason all along; this one had none.
  const U = `${await server404(t)}/vacancies/1/`;
  const p = makeProject(t, {
    scripts: ["closed-check.mjs"],
    packages: { "a.md": pkg({ url: U }) },
    state: { _meta: {}, [U]: { status: "new" } },
    bins: quiet,
  });
  // A lock already held by a LIVE process (this test run) — the shape a
  // concurrent run leaves behind.
  mkdirSync(p.path("closed-check.lock"), { recursive: true });
  writeFileSync(p.path("closed-check.lock", "pid"), String(process.pid));

  const out = await runScript(p, "closed-check.mjs", LOCAL);   // resolves ⇒ exit 0
  assert.match(out, /another closed-check\.mjs run is active — exiting/);
  assert.doesNotMatch(out, /closed-check: probing/, "it stopped before touching anything");
  assert.equal(p.json("job-state.json")[U].status, "new", "the other run's state is untouched");
});
