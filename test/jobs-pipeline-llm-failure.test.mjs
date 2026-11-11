// End-to-end runs of jobs.mjs — an LLM call that fails: the match is deferred,
// re-judged next run, and written keyword-only (borderline) only after a
// second failure, with the breakage alert. Helpers and the fake `claude` live
// in test/helpers/jobs-pipeline.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { waitFor } from "./helpers/e2e.mjs";
import { rss, serveFeed, setupProject, runJobs, mdFiles, claudeCalls, ACME, BETA, GAMMA } from "./helpers/jobs-pipeline.mjs";

test("jobs.mjs: LLM failing on every call → deferred once, borderline keyword-only packages on the second run + breakage alert", async (t) => {
  // Exits non-zero without reading stdin (logs each attempt; llmJSON retries once per job).
  // A failed verdict used to write the keyword-only package at once, so a
  // 180 s timeout — a busy Mac, not a broken CLI — let a match skip the LLM
  // gate for good: 19 of 64 real packages had no llm_score by 2026-10-22.
  const claude = `#!/bin/sh\necho "args=$*" >> "$(dirname "$0")/../claude.log"; exit 1\n`;
  const p = setupProject(t, await serveFeed(t, () => rss([ACME, BETA, GAMMA])), { claude });
  const out = await runJobs(p);
  assert.equal((out.match(/llm failed for: .* — deferred, next run/g) || []).length, 3);
  assert.match(out, /wrote 0 application package/);
  assert.equal(claudeCalls(p), 6, "each of the three jobs was retried once");
  assert.deepEqual(Object.keys(p.json("jobs-seen.json")).filter((k) => !k.startsWith("llm-retry:")), [], "nothing marked seen");
  const notify = await waitFor(p.path("notify.log"), /LLM failed/);
  assert.match(notify, /LLM failed 3× — 3 deferred to the next run/, "llmFailed > 2 alert reaches the banner");
  // Still down on the next run: the keyword-only package after all, so an
  // outage never loses a match — but only after one more try.
  // …under a real gate it lands in the borderline tab, not among the matches:
  // 4 of DOU's last 5 keyword-only packages were titles the owner excludes.
  const out2 = await runJobs(p);
  assert.equal((out2.match(/llm failed again for: .* — keyword-only package \(borderline\)/g) || []).length, 3);
  assert.match(out2, /wrote 0 application package\(s\) \+ 3 borderline/);
  assert.equal(claudeCalls(p), 12);
  for (const f of mdFiles(p)) {
    assert.doesNotMatch(p.read("applications", f), /^llm_score:/m, `${f} is keyword-only`);
    assert.match(p.read("applications", f), /^tier: borderline$/m, `${f} is borderline`);
  }
  assert.match(p.read("applications", "index.html"), /data-filter="borderline"/, "the dashboard grows the Borderline tab");
  assert.equal(Object.keys(p.json("jobs-seen.json")).filter((k) => !k.startsWith("llm-retry:")).length, 3, "marked seen with the package");
  assert.match(await waitFor(p.path("notify.log"), /keyword-only/), /LLM failed 3× — 3 keyword-only/);
});

test("jobs.mjs: a match whose verdict failed once is re-judged next run and gets its LLM package", async (t) => {
  // Fails until the project has an `up` file; the test flips it between runs.
  const claude = `#!/bin/sh
echo "args=$*" >> "$(dirname "$0")/../claude.log"
[ -f "$(dirname "$0")/../up" ] || exit 1
cat > /dev/null; echo '{"score": 85, "why": "great fit", "red_flags": [], "cover": "Dear team, hire me."}'
`;
  const p = setupProject(t, await serveFeed(t, () => rss([ACME])), { claude });
  assert.match(await runJobs(p), /llm failed for: .* — deferred, next run/);
  assert.equal(mdFiles(p).length, 0, "no package without a verdict");
  writeFileSync(p.path("up"), "");
  const out = await runJobs(p);
  assert.match(out, /✓ MATCH \[\d+ \/ llm 85\] dou: Senior SDET \(Playwright\) @ Acme/);
  assert.match(p.read("applications", mdFiles(p)[0]), /^llm_score: 85$/m, "the LLM package, not the keyword template");
  await runJobs(p);
  assert.equal(claudeCalls(p), 3, "two failed attempts, one verdict, nothing after");
});
