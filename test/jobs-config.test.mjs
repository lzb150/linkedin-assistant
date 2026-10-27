// lib/jobs-config.mjs: jobs.config.json → one normalized object. These used to
// be black-box runs of jobs.mjs (3–4 s each) because the wiring lived in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJobsConfig, normalizeJobsConfig } from "../lib/jobs-config.mjs";

const collect = () => { const lines = []; return { lines, log: (...a) => lines.push(a.join(" ")) }; };
const shipped = () => ({
  minScore: 25, requireRole: true, excludeTitle: ["junior"], excludeLocation: [], candidateCountry: ["Ukraine"],
  llm: { enabled: true, model: "haiku", maxPerRun: 15, minScore: 50 },
  dou: { enabled: true, feeds: ["http://127.0.0.1/rss"] },
  djinni: { enabled: false }, linkedin: { enabled: false },
});

test("parseJobsConfig: a trailing comma or a non-object is an error that names the problem, not a config", () => {
  assert.throws(() => parseJobsConfig('{"minScore": 25,}'), SyntaxError);
  assert.throws(() => parseJobsConfig("[1]"), /not a JSON object/);
  assert.throws(() => parseJobsConfig("null"), /not a JSON object/);
  assert.equal(parseJobsConfig('{"minScore": 25}').minScore, 25);
});

test("normalizeJobsConfig: a misspelt key is reported at the top level, inside llm and inside a source", () => {
  const { lines, log } = collect();
  const cfg = shipped();
  cfg.llmm = cfg.llm;            // the whole block, misspelt
  cfg.llm.enabledd = true;       // a misspelt key inside it
  cfg.dou.feedz = [];
  cfg._comment = "documentation keys are not typos";
  normalizeJobsConfig(cfg, { log });
  assert.ok(lines.some((l) => /unknown top-level key "llmm"/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /unknown llm\.enabledd/.test(l)));
  assert.ok(lines.some((l) => /unknown dou\.feedz/.test(l)));
  assert.ok(!lines.some((l) => /_comment/.test(l)), "underscore keys are documentation");
});

test("normalizeJobsConfig: a source list entry that cannot be searched is dropped and logged, a non-list is ignored", () => {
  const { lines, log } = collect();
  const cfg = shipped();
  cfg.dou.feeds.push("SDET", 42);
  cfg.djinni.searches = "https://djinni.co/jobs/?all_keywords=SDET";
  const { config } = normalizeJobsConfig(cfg, { log });
  assert.deepEqual(config.dou.feeds, ["http://127.0.0.1/rss"]);
  assert.deepEqual(config.djinni.searches, []);
  assert.ok(lines.some((l) => /dou.feeds item "SDET" is not a feed URL — skipped/.test(l)));
  assert.ok(lines.some((l) => /dou.feeds item 42 is not a feed URL — skipped/.test(l)));
  assert.ok(lines.some((l) => /djinni.searches is "https:\/\/djinni.co\/jobs\/\?all_keywords=SDET", not a list — ignored/.test(l)));
});

test("normalizeJobsConfig: a typo'd numeric knob is replaced by its default and reported, never read as \"gate off\"", () => {
  const { lines, log } = collect();
  const cfg = shipped();
  cfg.minScore = "";
  cfg.dou.minScore = "high";
  cfg.llm.minScore = "abc";
  cfg.llm.maxPerRun = true;
  cfg.llm.concurrency = 0;
  const n = normalizeJobsConfig(cfg, { log });
  assert.equal(n.minScore, 25);
  assert.equal(n.sourceMinScore.dou, 25, "a per-source override falls back to the global gate");
  assert.equal(n.sourceMinScore.djinni, 25);
  assert.equal(n.llmMinScore, 0);
  assert.equal(n.llmMaxPerRun, 15);
  assert.equal(n.llmConcurrency, 1, "0 workers would leave every verdict empty");
  assert.ok(lines.some((l) => /minScore is "", not a number — using 25/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /dou.minScore is "high", not a number — using 25/.test(l)));
  assert.ok(lines.some((l) => /llm.minScore is "abc", not a number — using 0/.test(l)));
  assert.ok(lines.some((l) => /llm.maxPerRun is true, not a number — using 15/.test(l)));
});

test("normalizeJobsConfig: flags, country and countryOnly come out normalized; defaults when absent", () => {
  const { log } = collect();
  const cfg = shipped();
  cfg.requireRole = "false";
  cfg.dou.enabled = "yes";
  cfg.himalayas = { enabled: "true", worldwide: false, searches: ["QA"] };
  cfg.candidateCountry = [];
  const n = normalizeJobsConfig(cfg, { log });
  assert.equal(n.config.requireRole, false);
  assert.equal(n.config.dou.enabled, true, "an unreadable flag is its default");
  assert.equal(n.config.himalayas.enabled, true);
  assert.deepEqual([...n.countryOnly], ["himalayas"]);
  assert.ok(n.candidateCountry.length > 0, "an empty list falls back to the default country");
  const bare = normalizeJobsConfig({}, { log });
  assert.equal(bare.minScore, 25);
  assert.equal(bare.llmMaxPerRun, 15);
  assert.equal(bare.llmConcurrency, 3);
  assert.deepEqual([...bare.countryOnly], []);
});

test("normalizeJobsConfig: a top-level list given as a bare string is reported, not silently emptied", () => {
  // lib/filters.mjs degraded "excludeTitle": "junior" to [] so the run survived,
  // but nothing said the exclude was never applied.
  const { lines, log } = collect();
  const cfg = shipped();
  cfg.excludeTitle = "junior";
  const { config } = normalizeJobsConfig(cfg, { log });
  assert.deepEqual(config.excludeTitle, [], "still ignored");
  assert.ok(lines.some((l) => /excludeTitle is "junior", not a list — ignored/.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /excludeLocation|candidateCountry/.test(l)), "a well-formed list is quiet");
});

test("normalizeJobsConfig: llm.model must be a model name; anything else is sonnet, reported", () => {
  const { lines, log } = collect();
  const cfg = shipped();
  assert.equal(normalizeJobsConfig(cfg, { log }).llmModel, "haiku");
  cfg.llm.model = 5;
  assert.equal(normalizeJobsConfig(cfg, { log }).llmModel, "sonnet", "a number must never reach the CLI argv");
  assert.ok(lines.some((l) => /llm.model is 5, not a model name — using sonnet/.test(l)), lines.join("\n"));
  cfg.llm.model = " opus ";
  assert.equal(normalizeJobsConfig(cfg, { log }).llmModel, "opus", "trimmed");
  delete cfg.llm.model;
  assert.equal(normalizeJobsConfig(cfg, { log }).llmModel, "sonnet");
  assert.equal(lines.length, 1, "an absent or valid model is quiet");
});

test("normalizeJobsConfig: llm.timeoutSec is a knob (seconds in the file, ms for the wrapper), bounded and reported like the others", () => {
  const { lines, log } = collect();
  const cfg = shipped();
  cfg.llm.timeoutSec = 300;
  assert.equal(normalizeJobsConfig(cfg, { log }).llmTimeoutMs, 300_000);
  assert.ok(!lines.some((l) => /unknown llm\.timeoutSec/.test(l)), "a known key");
  cfg.llm.timeoutSec = "long";
  assert.equal(normalizeJobsConfig(cfg, { log }).llmTimeoutMs, 60_000, "the default");
  assert.ok(lines.some((l) => /llm.timeoutSec is "long", not a number — using 60/.test(l)), lines.join("\n"));
  cfg.llm.timeoutSec = 5;
  assert.equal(normalizeJobsConfig(cfg, { log }).llmTimeoutMs, 30_000, "clamped: 5 s would time out every real call");
  delete cfg.llm.timeoutSec;
  assert.equal(normalizeJobsConfig(cfg, { log }).llmTimeoutMs, 60_000);
});
