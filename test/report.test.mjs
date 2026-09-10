import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, countRunStats } from "../lib/report.mjs";

const now = new Date("2026-09-07T12:00:00Z");
const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();

const packages = [
  { source: "dou", generated: daysAgo(1), score: 32, llm_score: 60, llm_model: "haiku", title: "QA", company: "Meest" },
  { source: "djinni", generated: daysAgo(2), score: 33, llm_score: 88, llm_model: "sonnet", title: "AQA", company: "Plexsupply" },
  { source: "dou", generated: daysAgo(4), score: 40, title: "SDET", company: "Kw" },          // keyword-only
  { source: "linkedin", generated: daysAgo(10), score: 50, llm_score: 95, title: "Old", company: "Old" }, // outside window
];
const logText = [
  "2026-09-06T00:59:00Z Done. Considered 3 new, wrote 1 application package(s) to /x",
  "2026-09-06T01:00:00Z   · skip [25 / llm 38] dou: Automation QA @ X",
  "2026-09-06T01:00:01Z   · skip [10 no-role] linkedin: Full Stack",
  "2026-09-06T01:00:02Z   · llm failed for: Foo — keyword-only package",
  "2026-09-06T01:00:03Z   ✓ MATCH [32 / llm 72] dou: QA @ Meest",
  "2026-09-06T02:00:00Z Done. Considered 4 new, wrote 0 application package(s) to /x",
].join("\n");
const health = { dou: [45, 45, 44], linkedin: [11, 0, 15] };

test("countRunStats sums runs and considered-new, counts only LLM-rejected skips and LLM failures", () => {
  assert.deepEqual(countRunStats(logText), { runs: 2, considered: 7, dropped: 1, failed: 1 });
});

test("buildReport aggregates the last N days into text + a one-line notification", () => {
  const r = buildReport({ now, days: 7, packages, logText, health });
  assert.match(r.text, /2026-08-31 → 2026-09-07 \(7 days\)/);
  assert.match(r.text, /2 runs · 7 new vacancies considered/);
  assert.match(r.text, /3 packages written/);
  assert.match(r.text, /LLM dropped 1, failed 1/);
  assert.match(r.text, /Packages by source: dou 2 · djinni 1/);
  assert.match(r.text, /2 scored \(haiku 1, sonnet 1\), 1 at ≥70/, "per-model count so haiku-era and sonnet-era scores are not mixed up when tuning the gate");
  assert.match(r.text, /top: 88 AQA @ Plexsupply \(djinni\)/);
  assert.match(r.text, /dou 45 · linkedin 11/, "median per run from source-health");
  assert.equal(r.notification, "3 packages (LLM ≥70: 1) · 7 new considered");
});

test("buildReport survives empty inputs", () => {
  const r = buildReport({ now, days: 7, packages: [], logText: "", health: {} });
  assert.match(r.text, /0 runs · 0 new vacancies considered/);
  assert.match(r.text, /top: —/);
  assert.equal(r.notification, "0 packages (LLM ≥70: 0) · 0 new considered");
});
