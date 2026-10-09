// jobs.mjs in a DarkWake on battery: LinkedIn is deferred to the catch-up agent
// instead of timing out on the feed. A fake `pmset` on PATH plays the power
// state; a fake `playwright` records whether the browser was ever launched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { makeProject, runScript, SKILLS_FIXTURE } from "./helpers/e2e.mjs";

const DARK = "Current System Capabilities are: CPU Network Disk";
const FULL = "Current System Capabilities are: CPU Graphics Audio Network";
const pmsetBin = (state, source = "Battery Power") =>
  `#!/bin/sh\ncase "$2" in systemstate) echo "${state}" ;; batt) echo "Now drawing from '${source}'" ;; esac\n`;

// Launching the browser writes launched.log and then fails like a missing build
// would — enough to tell "tried" from "deferred" without a real Chromium.
const PLAYWRIGHT = `import { appendFileSync } from "node:fs";
export const chromium = { launchPersistentContext: async (dir) => {
  appendFileSync(new URL("../../launched.log", import.meta.url), dir + "\\n");
  throw new Error("fake launch failure");
} };`;

async function serveEmptyFeed(t) {
  const srv = createServer((_req, res) => { res.setHeader("content-type", "application/rss+xml"); res.end("<?xml version=\"1.0\"?><rss><channel></channel></rss>"); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}/rss`;
}

function project(t, feedUrl, pmset) {
  return makeProject(t, {
    scripts: ["jobs.mjs", "dashboard.mjs"],
    playwright: PLAYWRIGHT,
    bins: { pmset },
    files: {
      "skills.json": SKILLS_FIXTURE,
      "resume.txt": "Eugene, Senior SDET.",
      "jobs.config.json": JSON.stringify({
        minScore: 25, requireRole: true, excludeTitle: [], excludeLocation: [],
        llm: { enabled: false },
        dou: { enabled: true, feeds: [feedUrl] }, djinni: { enabled: false },
        linkedin: { enabled: true, searches: [] },
      }),
      "source-health.json": JSON.stringify({ linkedin: [26, 25, 28, 27, 26] }),
    },
  });
}
const run = (p, env = {}) => runScript(p, "jobs.mjs", env).then((out) => ({ out, code: 0 }), (e) => ({ out: e.message, code: 1 }));

test("a DarkWake on battery defers LinkedIn: DOU still runs, no browser, marker written, no health alert", async (t) => {
  const p = project(t, await serveEmptyFeed(t), pmsetBin(DARK));
  const { out, code } = await run(p);
  assert.equal(code, 0);
  assert.match(out, /Gathering dou/);
  assert.match(out, /linkedin: deferred/);
  assert.ok(!existsSync(p.path("launched.log")), "the browser is never launched in a DarkWake");
  assert.ok(existsSync(p.path("linkedin-pending")), "the catch-up agent is told to run");
  assert.doesNotMatch(out, /not run at all/, "a deferred LinkedIn is not an outage");
  assert.deepEqual(p.json("source-health.json").linkedin, [26, 25, 28, 27, 26], "no 0 enters LinkedIn's history");
});

test("on AC power a DarkWake defers nothing (caffeinate -s keeps the Mac up)", async (t) => {
  const p = project(t, await serveEmptyFeed(t), pmsetBin(DARK, "AC Power"));
  await run(p);
  assert.ok(existsSync(p.path("launched.log")), "LinkedIn was tried");
  assert.ok(!existsSync(p.path("linkedin-pending")));
});

test("catch-up without a marker exits at once and runs nothing", async (t) => {
  const p = project(t, await serveEmptyFeed(t), pmsetBin(FULL));
  const { out, code } = await run(p, { LINKEDIN_CATCHUP: "1" });
  assert.equal(code, 0);
  assert.equal(out, "");
  assert.ok(!existsSync(p.path("launched.log")));
});

test("catch-up still in a DarkWake keeps the marker for the next tick", async (t) => {
  const p = project(t, await serveEmptyFeed(t), pmsetBin(DARK));
  writeFileSync(p.path("linkedin-pending"), "x\n");
  const { out, code } = await run(p, { LINKEDIN_CATCHUP: "1" });
  assert.equal(code, 0);
  assert.match(out, /still in a DarkWake on battery/);
  assert.ok(existsSync(p.path("linkedin-pending")));
  assert.ok(!existsSync(p.path("launched.log")));
});

test("catch-up fully awake runs LinkedIn only and clears the marker, even when LinkedIn fails", async (t) => {
  const p = project(t, await serveEmptyFeed(t), pmsetBin(FULL));
  writeFileSync(p.path("linkedin-pending"), "x\n");
  const { out } = await run(p, { LINKEDIN_CATCHUP: "1" });
  assert.ok(existsSync(p.path("launched.log")), "LinkedIn was tried");
  assert.doesNotMatch(out, /Gathering dou/, "the browserless sources already ran in the deferring run");
  assert.ok(!existsSync(p.path("linkedin-pending")), "a real failure goes to health monitoring, not a 15-minute retry loop");
});

// A lock held by a live process (this test runner) — "profile busy" to jobs.mjs.
const holdLock = (p, name) => { mkdirSync(p.path(`${name}.lock`)); writeFileSync(p.path(`${name}.lock`, "pid"), String(process.pid)); };

test("a busy browser profile leaves LinkedIn pending for the catch-up agent instead of 3 hours", async (t) => {
  const p = project(t, await serveEmptyFeed(t), pmsetBin(FULL));
  holdLock(p, ".browser-profile");
  const { out, code } = await run(p);
  assert.equal(code, 0);
  assert.match(out, /browser profile busy — left pending/);
  assert.ok(existsSync(p.path("linkedin-pending")));
  assert.ok(!existsSync(p.path("launched.log")));
});

test("a busy run lock leaves LinkedIn pending too; a DOU-only run never does", async (t) => {
  const p = project(t, await serveEmptyFeed(t), pmsetBin(FULL));
  holdLock(p, "jobs-run");
  const { out, code } = await run(p);
  assert.equal(code, 0);
  assert.match(out, /another jobs.mjs run is active/);
  assert.ok(existsSync(p.path("linkedin-pending")));

  const q = project(t, await serveEmptyFeed(t), pmsetBin(FULL));
  holdLock(q, "jobs-run");
  await run(q, { DOU_ONLY: "1" });
  assert.ok(!existsSync(q.path("linkedin-pending")), "LinkedIn was not due");
});
