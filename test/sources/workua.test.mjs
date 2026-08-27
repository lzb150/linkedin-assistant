import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { splitCards, parseCard } from "../../lib/sources/workua.mjs";
import { extractDiv, stripHtml } from "../../lib/sources/html.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const listing = readFileSync(join(__dir, "../fixtures/sources/workua-listing.html"), "utf8");
const detail = readFileSync(join(__dir, "../fixtures/sources/workua-detail.html"), "utf8");

test("splitCards splits the listing into one block per job card", () => {
  assert.equal(splitCards(listing).length, 2);
});

test("parseCard extracts title, company, url, location, snippet, text", () => {
  const job = parseCard(splitCards(listing)[0]);
  assert.equal(job.source, "workua");
  assert.equal(job.title, "PHP Fullstack Developer (Vue.js)");
  assert.equal(job.company, "Маніфай, ТОВ");
  assert.equal(job.url, "https://www.work.ua/jobs/5873844/");
  assert.equal(job.location, "Дистанційно");
  assert.ok(job.snippet.length > 0);
  assert.ok(job.text.includes(job.title));
});

test("parseCard keeps a comma-bearing company name intact (splits on markup, not commas)", () => {
  const job = parseCard(splitCards(listing)[1]);
  assert.equal(job.company, "Saga-alliance");
  assert.equal(job.location, "Дистанційно");
});

test("parseCard returns null when the card has no job href", () => {
  assert.equal(parseCard(`<div>no link here</div>`), null);
});

test("detail page description extracts from #job-description", () => {
  const text = stripHtml(extractDiv(detail, /<div[^>]*id="job-description"[^>]*>/i));
  assert.ok(text.length > 500, `description too short: ${text.length}`);
  assert.ok(text.includes("Fullstack Senior PHP Developer"));
});

test("parseCard stays fast on a 1.5 MB card of unclosed openers (bounded captures)", () => {
  const opener = '<a href="/jobs/1/">x</a><h2><a><div class="text-indent"><span class="glyphicon-company"><span class="strong-600"><span class=""><p class="ellipsis">';
  const card = opener.repeat(Math.ceil(1.5e6 / opener.length));
  const t0 = performance.now();
  parseCard(card);
  assert.ok(performance.now() - t0 < 500, "parseCard took too long on an unclosed-opener card");
});
