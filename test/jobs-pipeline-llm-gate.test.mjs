// End-to-end runs of jobs.mjs — the LLM gate's settings: the borderline band,
// llm.maxPerRun, the LLM turned off, the advisory gate (llm.minScore 0).
// Helpers and the fake `claude` live in test/helpers/jobs-pipeline.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitFor } from "./helpers/e2e.mjs";
import { rss, serveFeed, setupProject, runJobs, mdFiles, claudeCalls, ACME, BETA, GAMMA } from "./helpers/jobs-pipeline.mjs";

test("jobs.mjs: a verdict between llm.borderlineMin and llm.minScore writes a borderline package, below the band it drops", async (t) => {
  const claude = `#!/bin/sh
PROMPT="$(cat)"; echo "args=$*" >> "$(dirname "$0")/../claude.log"
case "$PROMPT" in *Beta*) echo '{"score": 62, "why": "partial fit", "red_flags": [], "cover": "Maybe."}' ;;
  *Gamma*) echo '{"score": 45, "why": "weak", "red_flags": [], "cover": "No."}' ;;
  *) echo '{"score": 85, "why": "great fit", "red_flags": [], "cover": "Dear team, hire me."}' ;; esac
`;
  const p = setupProject(t, await serveFeed(t, () => rss([ACME, BETA, GAMMA])), { claude, llm: { minScore: 70, borderlineMin: 50 } });
  const out = await runJobs(p);
  assert.match(out, /✓ MATCH \[\d+ \/ llm 85\] dou: Senior SDET \(Playwright\) @ Acme/);
  assert.match(out, /~ BORDERLINE \[\d+ \/ llm 62\] dou: SDET Automation Engineer @ Beta/);
  assert.match(out, /· skip \[\d+ \/ llm 45\] dou: Test Automation Engineer @ Gamma/, "below the band: dropped as before");
  assert.match(out, /wrote 1 application package\(s\) \+ 1 borderline/);
  const files = mdFiles(p);
  assert.equal(files.length, 2);
  const beta = files.find((f) => /beta/i.test(f));
  assert.match(p.read("applications", beta), /^llm_score: 62$/m);
  assert.match(p.read("applications", beta), /^tier: borderline$/m);
  assert.doesNotMatch(p.read("applications", files.find((f) => f !== beta)), /^tier:/m, "a match carries no tier");
  assert.equal(Object.keys(p.json("jobs-seen.json")).length, 3, "all three judged jobs are seen");
  const html = p.read("applications", "index.html");
  assert.match(html, /data-tier="borderline"/);
  assert.match(html, /data-filter="borderline"/);
  const notify = await waitFor(p.path("notify.log"), /new:/);
  assert.match(notify, /1 new: Senior SDET \(Playwright\) @ Acme \(\+1 borderline\)/, "banner counts it, never names it");
  // Turned off: the band collapses into the old drop.
  const q = setupProject(t, await serveFeed(t, () => rss([BETA])), { claude, llm: { minScore: 70, borderlineMin: 0 } });
  assert.match(await runJobs(q), /· skip \[\d+ \/ llm 62\]/);
  assert.equal(mdFiles(q).length, 0);
});

test("jobs.mjs: llm.maxPerRun defers the weaker match to the next run (not written, not seen)", async (t) => {
  const p = setupProject(t, await serveFeed(t, () => rss([ACME, BETA])), { llm: { maxPerRun: 1 } });
  const out = await runJobs(p);
  assert.match(out, /· deferred \[\d+\] dou: .* — llm\.maxPerRun reached, next run/);
  assert.match(out, /wrote 1 application package/);
  assert.equal(claudeCalls(p), 1, "exactly one LLM call");
  assert.equal(mdFiles(p).length, 1);
  assert.equal(Object.keys(p.json("jobs-seen.json")).length, 1, "the deferred job is not marked seen");
  // Next run picks the deferred one up.
  await runJobs(p);
  assert.equal(claudeCalls(p), 2);
  assert.equal(mdFiles(p).length, 2);
});

test("jobs.mjs: with the LLM off every keyword match is written keyword-only and announced as a match, no CLI call", async (t) => {
  const p = setupProject(t, await serveFeed(t, () => rss([ACME, BETA])), { llm: { enabled: false } });
  const out = await runJobs(p);
  assert.match(out, /✓ MATCH \[\d+\] dou: Senior SDET \(Playwright\) @ Acme/);
  assert.match(out, /✓ MATCH \[\d+\] dou: SDET Automation Engineer @ Beta/);
  assert.match(out, /wrote 2 application package/);
  assert.equal(claudeCalls(p), 0);
  for (const f of mdFiles(p)) assert.doesNotMatch(p.read("applications", f), /^(llm_score|tier):/m, `${f} is a keyword-only match`);
});

test("jobs.mjs: under an advisory gate (llm.minScore 0) a match whose verdict failed twice is written as a match, not parked as borderline", async (t) => {
  const claude = `#!/bin/sh\necho "args=$*" >> "$(dirname "$0")/../claude.log"; exit 1\n`;
  const p = setupProject(t, await serveFeed(t, () => rss([ACME])), { claude, llm: { minScore: 0 } });
  assert.match(await runJobs(p), /llm failed for: .* — deferred, next run/);
  const out = await runJobs(p);
  assert.match(out, /llm failed again for: .* — keyword-only package$/m);
  assert.match(out, /✓ MATCH \[\d+\] dou: Senior SDET \(Playwright\) @ Acme/);
  assert.doesNotMatch(p.read("applications", mdFiles(p)[0]), /^tier:/m);
});
