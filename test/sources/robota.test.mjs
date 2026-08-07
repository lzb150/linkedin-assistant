import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, fetchRobota } from "../../lib/sources/robota.mjs";

test("cleanText squashes SPA innerText whitespace into one line", () => {
  assert.equal(cleanText("QA Engineer\n\n  NETRONIC \n Київ\t·\t10 годин тому"),
    "QA Engineer NETRONIC Київ · 10 годин тому");
  assert.equal(cleanText(""), "");
  assert.equal(cleanText(null), "");
});

test("fetchRobota returns [] when the source is disabled (no page access)", async () => {
  const jobs = await fetchRobota(null, { enabled: false }, () => {});
  assert.deepEqual(jobs, []);
});
