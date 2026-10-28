import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { searchUrl, toJob, parseResponse, fetchHimalayas } from "../../lib/sources/himalayas.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dir, "../fixtures/sources/himalayas-search.json"), "utf8");

// A fetch stub serving JSON per page number (missing page = empty jobs list);
// records every url it was asked for.
function api(pages) {
  const urls = [];
  const doFetch = async (url) => {
    urls.push(url);
    const body = pages[new URL(url).searchParams.get("page") || "1"] ?? JSON.stringify({ jobs: [] });
    if (typeof body === "number") return { ok: false, status: body, text: async () => "" };
    return { ok: true, status: 200, text: async () => body };
  };
  return { urls, doFetch };
}
const page = (...ids) => JSON.stringify({ jobs: ids.map((id) => ({ title: `SDET ${id}`, companyName: "Acme", guid: `https://himalayas.app/companies/acme/jobs/${id}`, description: "<p>Playwright</p>" })) });

test("searchUrl: free-text query, the candidate's country, newest first; page only past the first", () => {
  const u = new URL(searchUrl("QA automation", "Ukraine"));
  assert.equal(u.origin + u.pathname, "https://himalayas.app/jobs/api/search");
  assert.equal(u.searchParams.get("q"), "QA automation");
  assert.equal(u.searchParams.get("country"), "Ukraine");
  assert.equal(u.searchParams.get("sort"), "recent");
  assert.equal(u.searchParams.has("page"), false);
  assert.equal(new URL(searchUrl("SDET", "", 2)).searchParams.get("page"), "2");
  assert.equal(new URL(searchUrl("SDET", "")).searchParams.has("country"), false, "no country = no filter, not country=");
});

test("parseResponse maps the real API shape to source records", () => {
  const [open, ua] = parseResponse(fixture);
  assert.equal(open.source, "himalayas");
  assert.equal(open.title, "QA Automation Engineer (Playwright + Typescript)");
  assert.equal(open.company, "Resourceful Talent Group");
  assert.equal(open.url, "https://himalayas.app/companies/resourceful-talent-group/jobs/qa-automation-engineer-playwright-typescript");
  assert.equal(open.location, "Remote · Worldwide", "no location restriction = open worldwide");
  assert.match(open.text, /^QA Automation Engineer \(Playwright \+ Typescript\) at Resourceful Talent Group\. Remote · Worldwide\. \S/);
  assert.doesNotMatch(open.text, /<p>|<\/?strong>/, "description HTML is stripped");
  assert.equal(ua.location, "Remote · Ukraine");
});

test("parseResponse: null for a body that is not a jobs response, [] for an empty page", () => {
  assert.equal(parseResponse("<html>Just a moment…</html>"), null);
  assert.equal(parseResponse(JSON.stringify({ error: "rate limited" })), null);
  assert.deepEqual(parseResponse(JSON.stringify({ jobs: [] })), []);
});

test("toJob: no https link or no title = no record; restriction objects and control characters are tolerated", () => {
  assert.equal(toJob({ title: "SDET", guid: "javascript:alert(1)" }), null);
  assert.equal(toJob({ title: "SDET" }), null);
  assert.equal(toJob({ title: " ", guid: "https://himalayas.app/x" }), null);
  assert.equal(toJob(null), null);
  const j = toJob({ title: "SDET\nDone. Considered 500 new", companyName: "Acme‮", guid: "https://himalayas.app/x",
    locationRestrictions: [{ name: "Poland" }, "Ukraine", 7, null] });
  assert.equal(j.title, "SDET Done. Considered 500 new", "one line: a board title cannot forge a log line");
  assert.equal(j.company, "Acme");
  assert.equal(j.location, "Remote · Poland, Ukraine");
  assert.equal(toJob({ title: "SDET", applicationLink: "https://apply.example/1" }).url, "https://apply.example/1", "applicationLink when there is no guid");
});

test("fetchHimalayas reads pages until an empty one, passes the country, and dedups across searches", async () => {
  const { urls, doFetch } = api({ 1: page(1, 2), 2: page(3) });
  const lines = [];
  const jobs = await fetchHimalayas({ enabled: true, searches: ["SDET", "QA"], pages: 5 }, (l) => lines.push(l), { countries: ["Ukraine"], doFetch });
  assert.deepEqual(jobs.map((j) => j.title), ["SDET 1", "SDET 2", "SDET 3"], "the second search's copies collapse by url");
  assert.equal(urls.filter((u) => new URL(u).searchParams.get("q") === "SDET").length, 3, "pages 1, 2 and the empty page 3 — not all 5");
  assert.ok(urls.every((u) => new URL(u).searchParams.get("country") === "Ukraine"));
  assert.deepEqual(lines, ["  Himalayas search ok (3 over 2 pages): SDET", "  Himalayas search ok (3 over 2 pages): QA"], "config order");
});

test("fetchHimalayas: pages defaults to 2", async () => {
  const { urls, doFetch } = api({ 1: page(1), 2: page(2), 3: page(3) });
  const jobs = await fetchHimalayas({ enabled: true, searches: ["SDET"] }, () => {}, { doFetch });
  assert.equal(jobs.length, 2);
  assert.equal(urls.length, 2);
});

test("fetchHimalayas: a failed later page is a partial read, not an outage", async () => {
  const { doFetch } = api({ 1: page(1), 2: 429 });
  const lines = [];
  const jobs = await fetchHimalayas({ enabled: true, searches: ["SDET"] }, (l) => lines.push(l), { doFetch });
  assert.equal(jobs.length, 1);
  assert.ok(lines.includes("  Himalayas search 429: https://himalayas.app/jobs/api/search?q=SDET&sort=recent&page=2"));
  assert.ok(lines.includes("  Himalayas search partial (1 over 1 page): SDET — stopped at page 2: fetch failed"));
});

test("fetchHimalayas throws when every search fails, so the run counts the source as down", async () => {
  const { doFetch } = api({ 1: "<html>blocked</html>" });
  const lines = [];
  await assert.rejects(fetchHimalayas({ enabled: true, searches: ["SDET", "QA"] }, (l) => lines.push(l), { doFetch }), /all 2 Himalayas search\(es\) failed/);
  assert.ok(lines.includes("  Himalayas search partial (0 over 0 pages): SDET — stopped at page 1: not a jobs response"));
  // One search down out of two is not an outage.
  const mixed = api({ 1: page(1) });
  const ok = await fetchHimalayas({ enabled: true, searches: ["SDET", "QA"] }, () => {}, {
    doFetch: (url, init) => (new URL(url).searchParams.get("q") === "QA" ? Promise.reject(new Error("ECONNRESET")) : mixed.doFetch(url, init)),
  });
  assert.equal(ok.length, 1);
});

test("fetchHimalayas: off unless enabled, and no searches means no requests", async () => {
  const { urls, doFetch } = api({ 1: page(1) });
  assert.deepEqual(await fetchHimalayas({ searches: ["SDET"] }, () => {}, { doFetch }), []);
  assert.deepEqual(await fetchHimalayas(undefined, () => {}, { doFetch }), []);
  assert.deepEqual(await fetchHimalayas({ enabled: true }, () => {}, { doFetch }), []);
  assert.equal(urls.length, 0);
});

test("toJob keeps the API's pubDate (unix seconds) as an ISO `posted`", () => {
  const j = toJob({ title: "SDET", companyName: "Acme", guid: "https://himalayas.app/companies/acme/jobs/1", pubDate: 1791658143 });
  assert.equal(j.posted, new Date(1791658143 * 1000).toISOString());
  assert.equal("posted" in toJob({ title: "SDET", companyName: "Acme", guid: "https://himalayas.app/companies/acme/jobs/1" }), false);
  const [first] = parseResponse(fixture);
  assert.match(first.posted, /^\d{4}-\d{2}-\d{2}T/);
});

test("toJob scores the full description; the excerpt only stands in when there is none", () => {
  // The text is what the keyword gate and the LLM judge, and the excerpt is a
  // one-sentence teaser: it must not replace a description that is there.
  const job = (fields) => toJob({ title: "SDET", companyName: "Acme", guid: "https://himalayas.app/companies/acme/jobs/1", ...fields });
  assert.match(job({ description: "<p>Playwright and k6</p>", excerpt: "Teaser" }).text, /\. Playwright and k6$/);
  assert.match(job({ excerpt: "Teaser with Cypress" }).text, /\. Teaser with Cypress$/);
  assert.equal(job({}).text, "SDET at Acme. Remote · Worldwide.");
});
