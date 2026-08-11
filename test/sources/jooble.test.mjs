import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mapJoobleJobs } from "../../lib/sources/jooble.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(
  readFileSync(join(__dir, "../fixtures/sources/jooble-response.json"), "utf8"),
);

test("mapJoobleJobs maps fields, strips html/entities, and builds the text blob", () => {
  const [first] = mapJoobleJobs(data, 15);
  assert.equal(first.source, "jooble");
  assert.equal(first.title, "QA Automation Engineer");
  assert.equal(first.company, "Acme & Co");
  assert.equal(first.url, "https://jooble.org/desc/123");
  assert.equal(
    first.text,
    "QA Automation Engineer at Acme & Co. Remote. We need Playwright and TypeScript skills.",
  );
});

test("mapJoobleJobs drops jobs missing a title or a link", () => {
  const jobs = mapJoobleJobs(data, 15);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((j) => j.title), ["QA Automation Engineer", "SDET"]);
});

test("mapJoobleJobs applies the max slice before filtering", () => {
  assert.equal(mapJoobleJobs(data, 1).length, 1);
});

// --- filterByLocation (foreign relocation vacancies on the UA market) ---
import { filterByLocation } from "../../lib/sources/jooble.mjs";

test("filterByLocation drops foreign locations case-insensitively", () => {
  const jobs = [
    { title: "A", location: "Київ" },
    { title: "B", location: "Краків, Польща" },
    { title: "C", location: "Віддалено" },
    { title: "D", location: "за кордоном" },
    { title: "E", location: "ПОЛЬЩА" },
  ];
  const kept = filterByLocation(jobs, ["Польща", "за кордоном"]);
  assert.deepEqual(kept.map((j) => j.title), ["A", "C"]);
});

test("filterByLocation is a no-op without an exclude list", () => {
  const jobs = [{ title: "A", location: "Польща" }];
  assert.deepEqual(filterByLocation(jobs, undefined), jobs);
  assert.deepEqual(filterByLocation(jobs, []), jobs);
});
