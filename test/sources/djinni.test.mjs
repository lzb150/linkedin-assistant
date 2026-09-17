import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLinear } from "../helpers/linear.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { splitCards, parseCard, fetchDjinni } from "../../lib/sources/djinni.mjs";
import { extractDivByClass } from "../../lib/sources/html.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const listing = readFileSync(join(__dir, "../fixtures/sources/djinni-listing.html"), "utf8");
const detail = readFileSync(join(__dir, "../fixtures/sources/djinni-detail.html"), "utf8");

test("splitCards splits the listing into one block per job-item", () => {
  assert.equal(splitCards(listing).length, 3);
});

test("parseCard extracts title, company, absolute query-stripped url, location, snippet, text", () => {
  const job = parseCard(splitCards(listing)[0]);
  assert.equal(job.source, "djinni");
  assert.equal(job.title, "Senior Python Automation QA Engineer");
  assert.equal(job.company, "GlobalLogic");
  assert.equal(job.url, "https://djinni.co/jobs/810011-senior-python-automation-qa-engineer/");
  assert.ok(!job.url.includes("?"), "url query should be stripped");
  assert.ok(job.location.includes("Full Remote"));
  assert.ok(job.snippet.length > 0);
  assert.ok(job.text.includes(job.title));
});

test("parseCard returns null when the card has no job href", () => {
  assert.equal(parseCard(`<div>no link here</div>`), null);
});

test("parseCard returns null when the card has an href but no title", () => {
  assert.equal(parseCard(`<a href="/jobs/123-x/"></a>`), null);
});

test("extractDivByClass captures the full nested description block, not truncated to EOF", () => {
  const desc = extractDivByClass(detail, "job-post__description");
  assert.ok(desc.length > 0);
  assert.ok(desc.length < detail.length, "depth counter found the real closing </div>");
});

test("extractDivByClass returns empty string when the class is absent", () => {
  assert.equal(extractDivByClass(`<div class="other-thing">x</div>`, "job-post__description"), "");
});

test("parseCard stays fast on a 1.5 MB card of unclosed openers (bounded captures)", () => {
  const opener = '<a href="/jobs/1/">x</a><h2 class="job-item__position"><span class="small text-gray-800"><span class="js-truncated-text">';
  assertLinear("parseCard openers", (n) => parseCard(opener.repeat(n)), 2_500);
});

// Djinni is not newest-first: a fresh vacancy can live on page 2 (847039 @
// DevPulse, 2026-09-07, never on page 1). Each search reads up to `pages`
// pages and stops at the first empty one; detail pages are fetched only for
// jobs the caller does not already know.
test("fetchDjinni reads several pages per search, stops at an empty page, and fetches details only for unknown jobs", async (t) => {
  const cards = splitCards(listing);                      // 3 fixture cards
  const page = (...blocks) => `<html>${blocks.join("")}</html>`;
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(url);
    const body = url.endsWith("page=2") ? page(cards[2]) : url.includes("page=") ? page() : url.includes("/jobs/?") ? page(cards[0], cards[1]) : detail;
    return { ok: true, status: 200, text: async () => body };
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const lines = [];
  const known = "https://djinni.co/jobs/810011-senior-python-automation-qa-engineer/";
  const jobs = await fetchDjinni({ enabled: true, searches: ["https://djinni.co/jobs/?primary_keyword=QA+Automation"], pages: 3 }, (l) => lines.push(l), { skip: (j) => j.url === known });
  assert.deepEqual(urls.filter((u) => u.includes("/jobs/?")), [
    "https://djinni.co/jobs/?primary_keyword=QA+Automation",
    "https://djinni.co/jobs/?primary_keyword=QA+Automation&page=2",
    "https://djinni.co/jobs/?primary_keyword=QA+Automation&page=3",   // empty → stop (pages=3 anyway)
  ]);
  assert.equal(jobs.length, 3, "cards from both pages");
  // 2, not 3: page 3 was probed and came back empty, so only two pages yielded jobs.
  assert.match(lines.join("\n"), /Djinni search ok \(3 over 2 pages\)/);
  const detailUrls = urls.filter((u) => !u.includes("/jobs/?"));
  assert.equal(detailUrls.length, 2, "only the two unknown jobs get a detail fetch");
  assert.ok(!detailUrls.includes(known));
  assert.match(lines.join("\n"), /fetching 2 full description\(s\) \(1 already known — skipped\)/);
  const k = jobs.find((j) => j.url === known);
  assert.ok(k && k.text.length > 0, "known job is still returned (with its snippet) so the seen store re-stamps it");
});

test("splitCards and parseCard accept single-quoted attributes", () => {
  const card = `<div id='job-item-848732' class='job-item'>`
    + `<h2 class='job-item__position'>QA Automation Engineer</h2>`
    + `<a href='/jobs/848732-qa-automation-engineer/?from=x'>link</a>`
    + `<span class='small text-gray-800'>Flamingo</span>`
    + `<span class='js-truncated-text'>Role Overview</span></div>`;
  const cards = splitCards(card);
  assert.equal(cards.length, 1, "the job-item id is found with either quote style");
  const job = parseCard(cards[0]);
  assert.equal(job.url, "https://djinni.co/jobs/848732-qa-automation-engineer/");
  assert.equal(job.title, "QA Automation Engineer");
  assert.equal(job.company, "Flamingo");
});
