import { test } from "node:test";
import assert from "node:assert/strict";
import { isClosed, selectCandidates } from "../lib/closed.mjs";

test("isClosed: 404/410 is closed on any source; 5xx/network is unknown (not closed)", () => {
  assert.equal(isClosed({ source: "dou", status: 404, html: "" }), true);
  assert.equal(isClosed({ source: "djinni", status: 410, html: "" }), true);
  assert.equal(isClosed({ source: "dou", status: 503, html: "" }), false);
  assert.equal(isClosed({ source: "dou", status: 200, html: "<h1>Senior SDET</h1>" }), false);
});

test("isClosed: per-source inactive markers (observed on live pages, 2026-09)", () => {
  assert.equal(isClosed({ source: "dou", status: 200, html: "<div class='b-vacancy'>… Вакансія неактивна …</div>" }), true);
  assert.equal(isClosed({ source: "djinni", status: 200, html: "<p>Ця вакансія зараз неактивна.</p>" }), true);
  assert.equal(isClosed({ source: "linkedin", status: 200, html: "…See who Forte Group has hired for this role No longer accepting applications Report this job…" }), true);
  assert.equal(isClosed({ source: "linkedin", status: 200, html: "<title>Join now | LinkedIn</title> authwall" }), false, "an authwall page is unknown, not closed");
  // a DOU marker on a Djinni page (job text quoting it) must not count
  assert.equal(isClosed({ source: "djinni", status: 200, html: "вакансія неактивна" }), false);
  assert.equal(isClosed({ source: "jooble", status: 200, html: "Ця вакансія зараз неактивна." }), false, "unsupported source is never closed by marker");
});

const now = new Date("2026-09-07T12:00:00Z");
const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();

test("selectCandidates: dou/djinni/linkedin only, new/viewed only, re-checked at most every N days, oldest check first, capped", () => {
  const packages = [
    { url: "https://jobs.dou.ua/v/1/", source: "dou" },        // new (no entry), never checked → first
    { url: "https://djinni.co/jobs/2/", source: "djinni" },   // viewed, checked 5d ago → due
    { url: "https://jobs.dou.ua/v/3/", source: "dou" },        // checked yesterday → not due
    { url: "https://jobs.dou.ua/v/4/", source: "dou" },        // applied → never touched
    { url: "https://ua.jooble.org/x/5", source: "jooble" },     // unsupported source (Cloudflare)
    { url: "https://www.linkedin.com/jobs/view/8/", source: "linkedin" }, // new, never checked → probed
    { url: "https://jobs.dou.ua/v/6/", source: "dou" },        // already closed
    { url: "https://jobs.dou.ua/v/7/", source: "dou" },        // new, checked 10d ago → due (older check than #2)
  ];
  const stateMap = {
    _meta: {},
    "https://djinni.co/jobs/2/": { status: "viewed" },
    "https://jobs.dou.ua/v/4/": { status: "applied", appliedAt: daysAgo(3) },
    "https://jobs.dou.ua/v/6/": { status: "closed" },
  };
  const checked = { "https://djinni.co/jobs/2/": daysAgo(5), "https://jobs.dou.ua/v/3/": daysAgo(1), "https://jobs.dou.ua/v/7/": daysAgo(10) };
  const all = selectCandidates({ packages, stateMap, checked, now, recheckDays: 3, maxPerRun: 10 });
  assert.deepEqual(all.map((c) => c.url), ["https://jobs.dou.ua/v/1/", "https://www.linkedin.com/jobs/view/8/", "https://jobs.dou.ua/v/7/", "https://djinni.co/jobs/2/"]);
  assert.equal(all[0].source, "dou");
  assert.deepEqual(selectCandidates({ packages, stateMap, checked, now, recheckDays: 3, maxPerRun: 2 }).length, 2, "cap applies after ordering");
});
