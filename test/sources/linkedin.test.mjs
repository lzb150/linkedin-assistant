import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUrl } from "../../lib/sources/linkedin-jobs.mjs";

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
