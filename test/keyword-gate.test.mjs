import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordGate, titleExcluder, legacyIdOf, findRepost } from "../lib/keyword-gate.mjs";
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

test("keywordGate: a match on a title-only text carries retry, so an LLM drop does not bury it", () => {
  const opts = { seen: new Set(), packageIndex: new Map(), excludedByTitle: () => undefined, minScore: 10, requireRole: false, score: () => ({ score: 50, matchedRole: "sdet" }) };
  assert.equal(keywordGate({ source: "linkedin", title: "SDET", company: "A", url: "u1", text: "SDET at A." }, opts).retry, true);
  assert.equal(keywordGate({ source: "linkedin", title: "SDET", company: "A", url: "u2", text: "x".repeat(400) }, opts).retry, false);
});

test("keywordGate: a merged keeper is seen when a copy folded into it is", () => {
  const djinni = job({ source: "djinni", title: "Strong Middle SDET" });
  const keeper = job({ source: "tgchannels", mergedIds: [identityKey(djinni)] });
  assert.equal(keywordGate(keeper, ctx({ seen: new Set([identityKey(djinni)]) })).kind, "seen");
  assert.equal(keywordGate(keeper, ctx()).kind, "match");
});

test("keywordGate: the same link packaged from another board is that package, whatever the title", () => {
  const repost = job({ source: "tgchannels", title: "QA Automation Engineer", url: "https://djinni.co/jobs/830692-qa-automation-engineer/" });
  const links = new Map([["djinni.co/jobs/830692", "a.md"]]);
  assert.deepEqual(keywordGate(repost, ctx({ packageLinks: links })), { id: identityKey(repost), kind: "packaged", file: "a.md" });
  assert.equal(keywordGate(job({ url: "not a url" }), ctx({ packageLinks: new Map([["", "x.md"]]) })).kind, "match", "no link, no match");
});

test("keywordGate: a folded copy's title hits excludeTitle for the keeper", () => {
  const keeper = job({ title: "QA Automation Engineer", mergedTitles: ["Strong Junior/Middle QA Automation Engineer"] });
  const g = keywordGate(keeper, ctx({ excludedByTitle: titleExcluder(["junior"]) }));
  assert.equal(g.kind, "excluded");
  assert.equal(g.term, "junior");
});

test("keywordGate: a folded copy's key finds a package from another board, judged by the copy's own source", () => {
  const djinni = job({ source: "djinni", title: "Strong Middle SDET (Playwright)", url: "https://djinni.co/jobs/9/" });
  const keeper = job({ source: "tgchannels", title: "QA Automation Engineer (FinTech)", url: "https://djinni.co/jobs/9/",
    mergedKeys: [{ key: canonicalKey(djinni), source: "djinni", url: djinni.url }] });
  const fromLinkedIn = new Map([[canonicalKey(djinni), [{ file: "li.md", source: "linkedin", url: "https://www.linkedin.com/jobs/view/1/" }]]]);
  assert.deepEqual(keywordGate(keeper, ctx({ packageIndex: fromLinkedIn })), { id: identityKey(keeper), kind: "dup", file: "li.md" });
  // A Djinni package of another req under that key: same board as the copy, a distinct req.
  const otherReq = new Map([[canonicalKey(djinni), [{ file: "d.md", source: "djinni", url: "https://djinni.co/jobs/8/" }]]]);
  assert.equal(keywordGate(keeper, ctx({ packageIndex: otherReq })).kind, "match");
  const sameReq = new Map([[canonicalKey(djinni), [{ file: "d.md", source: "djinni", url: djinni.url }]]]);
  assert.deepEqual(keywordGate(keeper, ctx({ packageIndex: sameReq })), { id: identityKey(keeper), kind: "packaged", file: "d.md" });
});

test("keywordGate: a same-board re-listing of a CLOSED package under a new url is a repost, judged past the seen store once", () => {
  const prior = { file: "old.md", source: "dou", url: "https://jobs.dou.ua/1/", generated: "2026-10-01T00:00:00Z", reposts: 1 };
  const j = job({ url: "https://jobs.dou.ua/9/" });
  const packageIndex = new Map([[canonicalKey(j), [prior]]]);
  const seen = new Set([identityKey(j)]);   // the title was seen with the old listing
  const closed = ctx({ packageIndex, seen, closedFiles: new Set(["old.md"]) });
  const g = keywordGate(j, closed);
  assert.equal(g.kind, "match");
  assert.deepEqual(g.repost, { file: "old.md", url: "https://jobs.dou.ua/1/", reposts: 2 }, "counts on from the prior package");
  // Not closed: the old rules — a seen identity stays seen.
  assert.equal(keywordGate(j, ctx({ packageIndex, seen })).kind, "seen");
  assert.equal(keywordGate(j, ctx({ packageIndex, seen, closedFiles: new Set(["other.md"]) })).kind, "seen");
  // The very same url is the package itself, closed or not; another board is a dup
  // (a fresh seen store: the seen check still comes first for anything but a repost).
  const fresh = ctx({ packageIndex, closedFiles: new Set(["old.md"]) });
  assert.equal(keywordGate(job({ url: prior.url }), fresh).kind, "packaged");
  assert.equal(keywordGate(job({ source: "djinni", url: "https://djinni.co/jobs/5-x/" }), fresh).kind, "dup");
  // Once jobs.mjs stamps the new url, the repost is not re-judged every run.
  seen.add("repost:jobs.dou.ua/9");
  assert.equal(keywordGate(j, closed).kind, "seen");
  // excluded/low carry the repost too, so the stamp lands with the outcome.
  const low = keywordGate(job({ url: "https://jobs.dou.ua/10/" }), ctx({ packageIndex, closedFiles: new Set(["old.md"]), minScore: 99 }));
  assert.equal(low.kind, "low");
  assert.equal(low.repost.reposts, 2);
  assert.equal(findRepost(j, { packageIndex, closedFiles: new Set() }), null);
});

test("keywordGate: a score exactly at minScore matches, and a 300-char description is not a retry", () => {
  const at = keywordGate(job({ text: "x".repeat(300) }), ctx({ minScore: 20 }));
  assert.equal(at.kind, "match");
  assert.equal(at.retry, false);
  assert.equal(keywordGate(job({ text: "x".repeat(299) }), ctx({ minScore: 21 })).retry, true);
  assert.equal(keywordGate(job(), ctx({ minScore: 21 })).kind, "low");
});

test("findRepost: a closed prior with no reposts count makes this the first repost", () => {
  const j = job({ url: "https://jobs.dou.ua/9/" });
  const prior = { file: "a.md", source: "dou", url: "https://jobs.dou.ua/1/", generated: "2026-09-01T00:00:00Z" };
  const packageIndex = new Map([[canonicalKey(j), [prior]]]);
  assert.equal(findRepost(j, { packageIndex, closedFiles: new Set(["a.md"]) }).reposts, 1);
});

test("findRepost: of several closed priors the newest counts on, whatever their index order", () => {
  const j = job({ url: "https://jobs.dou.ua/9/" });
  const older = { file: "a.md", source: "dou", url: "https://jobs.dou.ua/1/", generated: "2026-09-01T00:00:00Z", reposts: 5 };
  const newest = { file: "b.md", source: "dou", url: "https://jobs.dou.ua/2/", generated: "2026-10-01T00:00:00Z", reposts: 1 };
  const closedFiles = new Set(["a.md", "b.md"]);
  for (const priors of [[older, newest], [newest, older]]) {
    const packageIndex = new Map([[canonicalKey(j), priors]]);
    assert.deepEqual(findRepost(j, { packageIndex, closedFiles }), { file: "b.md", url: newest.url, reposts: 2 });
  }
});
