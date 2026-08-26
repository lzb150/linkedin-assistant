import { test } from "node:test";
import assert from "node:assert/strict";
import { filterByLocation } from "../lib/filters.mjs";

test("filterByLocation matches substrings case-insensitively across sources", () => {
  const jobs = [
    { title: "A", source: "dou", location: "Київ" },
    { title: "B", source: "jooble", location: "Краків, Польща" },
    { title: "C", source: "djinni", location: "Remote (Tbilisi, Georgia)" },
    { title: "D", source: "linkedin" }, // no location → kept
  ];
  const kept = filterByLocation(jobs, ["польща", "tbilisi"]);
  assert.deepEqual(kept.map((j) => j.title), ["A", "D"]);
});

test("filterByLocation coerces non-string patterns and is a no-op without a list", () => {
  const jobs = [{ title: "A", location: "Office 42" }];
  assert.deepEqual(filterByLocation(jobs, [42]), []);
  assert.deepEqual(filterByLocation(jobs, undefined), jobs);
  assert.deepEqual(filterByLocation(jobs, []), jobs);
});
