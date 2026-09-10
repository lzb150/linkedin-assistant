import { test } from "node:test";
import assert from "node:assert/strict";
import { isClosed, selectCandidates, planArchive, onBoardHost } from "../lib/closed.mjs";

test("onBoardHost: only the board's own host (or a subdomain) is probed", () => {
  assert.equal(onBoardHost("dou", "https://jobs.dou.ua/companies/x/vacancies/1/"), true);
  assert.equal(onBoardHost("djinni", "https://djinni.co/jobs/1-x/"), true);
  assert.equal(onBoardHost("linkedin", "https://www.linkedin.com/jobs/view/1/"), true);
  assert.equal(onBoardHost("dou", "https://dou.ua.evil.com/x"), false);
  assert.equal(onBoardHost("dou", "https://127.0.0.1:7777/state"), false);
  assert.equal(onBoardHost("dou", "not a url"), false);
  assert.equal(onBoardHost("dou", "file://dou.ua/etc/passwd"), false, "only http(s) is ever probed");
  assert.equal(onBoardHost("dou", "https://dou.ua@evil.com/x"), false, "userinfo trick: hostname is evil.com");
  assert.equal(onBoardHost("jooble", "https://jooble.org/x"), false);
  assert.equal(onBoardHost("dou", "http://127.0.0.1:8080/v/1/", { dou: "127.0.0.1" }), true, "extra host per board (tests / mirrors)");
});

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
    { url: "https://evil.example/v/9/", source: "dou" },       // wrong host for the board → never probed
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

test("planArchive: closed past the grace period and viewed untouched for viewedDays move to archive; recent, new and post-applied stay", () => {
  const packages = [
    { file: "old-closed.md", url: "https://jobs.dou.ua/v/1/" },
    { file: "fresh-closed.md", url: "https://jobs.dou.ua/v/2/" },
    { file: "stale-viewed.md", url: "https://jobs.dou.ua/v/3/" },
    { file: "applied.md", url: "https://jobs.dou.ua/v/4/" },
    { file: "no-stamp.md", url: "https://jobs.dou.ua/v/5/" },
    { file: "fresh-viewed.md", url: "https://ua.jooble.org/x/6" },
    { file: "new.md", url: "https://ua.jooble.org/x/7" },
  ];
  const stateMap = {
    _meta: {},
    "https://jobs.dou.ua/v/1/": { status: "closed", updatedAt: daysAgo(20) },
    "https://jobs.dou.ua/v/2/": { status: "closed", updatedAt: daysAgo(3) },
    "https://jobs.dou.ua/v/3/": { status: "viewed", updatedAt: daysAgo(40) },
    "https://jobs.dou.ua/v/4/": { status: "applied", appliedAt: daysAgo(40), updatedAt: daysAgo(40) },
    "https://jobs.dou.ua/v/5/": { status: "closed" },   // legacy entry without updatedAt → treat as old enough
    "https://ua.jooble.org/x/6": { status: "viewed", updatedAt: daysAgo(10) },
    // x/7: no entry = new → never archived
  };
  assert.deepEqual(planArchive({ packages, stateMap, now, closedDays: 14, viewedDays: 30 }), ["old-closed.md", "stale-viewed.md", "no-stamp.md"]);
  assert.deepEqual(planArchive({ packages, stateMap, now, closedDays: 0, viewedDays: 30 }), ["old-closed.md", "fresh-closed.md", "stale-viewed.md", "no-stamp.md"], "grace 0 archives every closed package");
  assert.deepEqual(planArchive({ packages, stateMap, now, closedDays: 14, viewedDays: 365 }), ["old-closed.md", "no-stamp.md"], "a long viewedDays keeps viewed cards");
});
