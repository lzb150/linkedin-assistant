// report.mjs as a black box. It had no test at all, and it is the one
// entrypoint that needs no browser: everything it does is read files, filter
// them by a window, and print. The two regressions pinned here both shipped —
// a log unlinked by run.sh's rotation killing the whole digest, and line counts
// that ignored the window the package counts respected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { makeProject, pkg, runScript } from "./helpers/e2e.mjs";

const quiet = { osascript: "#!/bin/sh\nexit 0\n", "notify-send": "#!/bin/sh\nexit 0\n" };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const runLine = (iso, n) => `${iso} Done. Considered ${n} new, wrote ${n} package(s)\n`;

function project(t, logs = {}, packages = {}) {
  const p = makeProject(t, { scripts: ["report.mjs"], packages, bins: quiet });
  mkdirSync(p.path("logs"));
  for (const [name, text] of Object.entries(logs)) writeFileSync(p.path("logs", name), text);
  return p;
}

test("report.mjs prints the digest for the window and counts the runs in it", async (t) => {
  const p = project(t,
    { "jobs_20260915.log": runLine(daysAgo(1), 3) + runLine(daysAgo(2), 4) },
    { "a.md": pkg({ url: "https://example.com/v/1/", generated: daysAgo(1) }) });
  const out = await runScript(p, "report.mjs");
  assert.match(out, /2 runs · 7 new vacancies considered · 7 packages written/, "written comes from the runs (the log here), not from applications/");
  assert.match(out, /Packages by source: dou 1/, "the on-disk package still feeds the per-source line");
});

test("report.mjs ignores log lines older than the window", async (t) => {
  // The file is selected by mtime, so the oldest file in range drags in lines
  // from before the window; those used to be counted while the package counts
  // beside them were filtered exactly.
  const p = project(t, { "jobs_20260915.log": runLine(daysAgo(30), 99) + runLine(daysAgo(1), 3) });
  const out = await runScript(p, "report.mjs");
  assert.match(out, /1 runs? · 3 new vacancies considered/);
  assert.doesNotMatch(out, /99/);
});

test("report.mjs survives a log file that rotation unlinks mid-read", async (t) => {
  const p = project(t, { "jobs_20260915.log": runLine(daysAgo(1), 2), "jobs_20260101.log": runLine(daysAgo(1), 5) });
  // Backdate the second file past the window: it is skipped by mtime, which is
  // the same branch that must not throw when the file is gone entirely.
  const old = new Date(Date.now() - 60 * 86400000);
  utimesSync(p.path("logs", "jobs_20260101.log"), old, old);
  const out = await runScript(p, "report.mjs");
  assert.match(out, /1 runs? · 2 new vacancies considered/);
});

test("report.mjs runs with no logs/ and no packages at all", async (t) => {
  const p = makeProject(t, { scripts: ["report.mjs"], bins: quiet });   // no logs/ directory
  const out = await runScript(p, "report.mjs");
  assert.match(out, /0 runs/);
});

test("report.mjs takes the \"strong\" bucket from llm.minScore in jobs.config.json", async (t) => {
  const scored = pkg({ url: "https://example.com/v/1/", generated: daysAgo(1) }).replace("\n---\n#", "\nllm_score: 75\n---\n#");
  const packages = { "a.md": scored };
  const p = makeProject(t, { scripts: ["report.mjs"], packages, bins: quiet, files: { "jobs.config.json": JSON.stringify({ llm: { minScore: 80 } }) } });
  assert.match(await runScript(p, "report.mjs"), /1 scored.*, 0 at ≥80/);
  writeFileSync(p.path("jobs.config.json"), JSON.stringify({ llm: { minScore: 70 } }));
  assert.match(await runScript(p, "report.mjs"), /1 scored.*, 1 at ≥70/);
});
