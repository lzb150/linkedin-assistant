import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUrl, fetchLinkedInJobs } from "../../lib/sources/linkedin-jobs.mjs";

test("buildUrl includes keywords and location and always sorts by date", () => {
  const url = buildUrl({ keywords: "QA Automation", location: "Ukraine" });
  assert.match(url, /^https:\/\/www\.linkedin\.com\/jobs\/search\/\?/);
  const qs = new URL(url).searchParams;
  assert.equal(qs.get("keywords"), "QA Automation");
  assert.equal(qs.get("location"), "Ukraine");
  assert.equal(qs.get("sortBy"), "DD");
  assert.equal(qs.get("f_WT"), null, "no remote filter unless requested");
});

test("buildUrl adds the remote filter f_WT=2 when remote is set", () => {
  const qs = new URL(buildUrl({ keywords: "SDET", remote: true })).searchParams;
  assert.equal(qs.get("f_WT"), "2");
});

test("buildUrl omits empty keywords and location but still sorts by date", () => {
  const qs = new URL(buildUrl({})).searchParams;
  assert.equal(qs.get("keywords"), null);
  assert.equal(qs.get("location"), null);
  assert.equal(qs.get("sortBy"), "DD");
});

// fetchLinkedInJobs reads each card in ONE evaluate() before clicking (a clicked
// list re-renders and detaches the other handles; per-action calls on detached
// handles each burned the full 30s default timeout — 15 cards ≈ 35 min).
function fakePage(cards) {
  const calls = [];
  const page = {
    calls,
    goto: async () => { calls.push("goto"); },
    mouse: { wheel: async () => {} },
    $$: async () => cards.map((c) => ({
      evaluate: async () => c,
      click: async (opts) => { calls.push(`click:${opts?.timeout}`); },
    })),
    locator: () => ({ first: () => ({ innerText: async (opts) => { calls.push(`desc:${opts?.timeout}`); return "  Job description  "; } }) }),
  };
  return page;
}

test("fetchLinkedInJobs extracts cards via a single evaluate, de-dups by url before the cap, skips cards without href", async () => {
  const page = fakePage([
    { title: "SDET", href: "/jobs/view/123/?refId=x", company: "Acme", location: "Kyiv" },
    { title: "No link", href: "", company: "Ghost", location: "" },
    { title: "Abs", href: "https://www.linkedin.com/jobs/view/456/?a=1", company: "Beta", location: "" },
    // SEL.card matches the <li> AND its inner div → the same job appears twice
    { title: "SDET", href: "/jobs/view/123/?refId=y", company: "Acme", location: "Kyiv" },
    { title: "Over cap", href: "/jobs/view/789/", company: "Gamma", location: "" },
  ]);
  const jobs = await fetchLinkedInJobs(page, { maxResults: 2, searches: [{ keywords: "SDET", location: "Ukraine" }] }, () => {}, { sleep: async () => {} });
  assert.deepEqual(jobs.map((j) => j.url), ["https://www.linkedin.com/jobs/view/123/", "https://www.linkedin.com/jobs/view/456/"], "de-dup before the cap: 2 unique jobs, not 1");
  assert.equal(page.calls.filter((c) => c.startsWith("click")).length, 2, "duplicates and over-cap cards are never clicked");
  assert.equal(jobs[0].company, "Acme");
  assert.equal(jobs[0].location, "Kyiv");
  assert.equal(jobs[1].location, "Ukraine", "search location is the fallback");
  assert.match(jobs[0].text, /^SDET at Acme\. Kyiv\. Job description$/);
  assert.ok(page.calls.every((c) => !c.endsWith(":undefined")), "every click/desc wait carries an explicit short timeout");
});
