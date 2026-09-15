// check.mjs as a black box. It had no test at all: it imports playwright at
// module scope through lib/browser.mjs, so covering it means replacing that
// module, which `playwright` in makeProject now does. The behaviours pinned
// here are the ones a scheduled run depends on and nothing else could see — the
// exit code launchd reads, and whether seen.json is written back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { makeProject, spawnScript } from "./helpers/e2e.mjs";

const quiet = { osascript: "#!/bin/sh\nexit 0\n", "notify-send": "#!/bin/sh\nexit 0\n" };
const SEEN = { "thread-kept": new Date().toISOString() };

// Launch throws before any page work — enough for the two failure paths.
const throwingPlaywright = (msg) => `
export const chromium = {
  launchPersistentContext: async () => { throw new Error(${JSON.stringify(msg)}); },
};
`;

function project(t, playwright) {
  const p = makeProject(t, { scripts: ["check.mjs", "skills.json"], bins: quiet, playwright });
  writeFileSync(p.path("seen.json"), JSON.stringify(SEEN));
  return p;
}

test("check.mjs: a run that never took the profile lock exits 0 and leaves seen.json alone", async (t) => {
  // The lock is held by a live pid — this process. launchBrowser throws
  // "profile busy" before anything else happens.
  const p = project(t, null);
  mkdirSync(p.path(".browser-profile.lock"), { recursive: true });
  writeFileSync(p.path(".browser-profile.lock", "pid"), String(process.pid));

  const out = await spawnScript(p, "check.mjs").done;   // resolves only on exit 0
  assert.match(out, /Skipped \(profile busy\)/);
  assert.doesNotMatch(out, /^Done\./m, "a skipped run must not claim it was done");
  // The lock holder is mid-run and owns seen.json; writing back the snapshot
  // this process loaded would roll its entries back.
  assert.deepEqual(JSON.parse(readFileSync(p.path("seen.json"), "utf8")), SEEN);
});

test("check.mjs: a run that fails after launch exits 1 so launchd sees the failure", async (t) => {
  const p = project(t, throwingPlaywright("chromium exploded"));
  await assert.rejects(spawnScript(p, "check.mjs").done, /check\.mjs exit 1/);
});

test("check.mjs: a launch failure reports FAILED, not Done", async (t) => {
  const p = project(t, throwingPlaywright("chromium exploded"));
  const run = spawnScript(p, "check.mjs");
  await run.done.catch(() => {});
  await run.output(/FAILED/);
});
