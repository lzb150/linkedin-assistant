import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordGate, titleExcluder, legacyIdOf } from "../lib/keyword-gate.mjs";
import { identityKey, canonicalKey } from "../lib/dedup.mjs";

const LONG = "x".repeat(400);
const job = (over = {}) => ({ source: "dou", title: "SDET", company: "Acme", url: "https://jobs.dou.ua/1/", text: LONG, ...over });
const ctx = (over = {}) => ({
  seen: new Set(),
  packageIndex: new Map(),
  excludedByTitle: () => undefined,
  minScore: 18,
  requireRole: true,
  score: () => ({ score: 20, matchedRole: "sdet" }),
  ...over,
});

test("keywordGate: a job stamped under the pre-2026-08-28 key spelling counts as seen", () => {
  const j = job({ title: "C++ SDET" });
  const legacy = legacyIdOf(identityKey(j));
  assert.notEqual(legacy, identityKey(j), "the fixture must actually differ in the two spellings");
  const g = keywordGate(j, ctx({ seen: new Set([legacy]) }));
  assert.equal(g.kind, "seen");
  assert.equal(g.id, identityKey(j), "re-stamped under the current spelling");
  assert.ok(!g.considered);
});

test("keywordGate: a per-source minScore override changes the verdict", () => {
  const j = job();
  assert.equal(keywordGate(j, ctx({ minScore: 18 })).kind, "match");
  const g = keywordGate(j, ctx({ minScore: 30 }));   // what SOURCE_MIN_SCORE.dou = 30 passes in
  assert.equal(g.kind, "low");
  assert.equal(g.retry, false);
  assert.ok(g.considered);
});

test("keywordGate: requireRole drops a high score with no role match; a short text is retried", () => {
  const g = keywordGate(job({ text: "short" }), ctx({ score: () => ({ score: 99, matchedRole: null }) }));
  assert.equal(g.kind, "low");
  assert.equal(g.retry, true);
  assert.equal(keywordGate(job(), ctx({ requireRole: false, score: () => ({ score: 99, matchedRole: null }) })).kind, "match");
});

test("keywordGate: same source + url is the existing package; another board is a dup", () => {
  const j = job();
  const index = new Map([[canonicalKey(j), [{ file: "a.md", source: "dou", url: j.url }]]]);
  assert.deepEqual(keywordGate(j, ctx({ packageIndex: index })), { id: identityKey(j), kind: "packaged", file: "a.md" });
  const other = new Map([[canonicalKey(j), [{ file: "b.md", source: "djinni", url: "https://djinni.co/jobs/1/" }]]]);
  assert.equal(keywordGate(j, ctx({ packageIndex: other })).kind, "dup");
  // Same source, different url: a distinct req, scored normally.
  const req = new Map([[canonicalKey(j), [{ file: "c.md", source: "dou", url: "https://jobs.dou.ua/2/" }]]]);
  assert.equal(keywordGate(j, ctx({ packageIndex: req })).kind, "match");
});

test("titleExcluder matches whole words only, Cyrillic included", () => {
  const ex = titleExcluder(["intern", "інтерн", "c++"]);
  assert.equal(ex("QA Intern"), "intern");
  assert.equal(ex("Internet QA"), undefined);
  assert.equal(ex("Інтерн QA"), "інтерн");
  assert.equal(ex("QA для інтернет-магазину"), undefined, "an ASCII-only boundary matched inside інтернет");
  assert.equal(ex("C++ tester"), "c++");
  assert.equal(ex(undefined), undefined);
});
