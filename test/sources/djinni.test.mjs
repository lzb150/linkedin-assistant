import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { splitCards, parseCard, extractDivByClass } from "../../lib/sources/djinni.mjs";

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
