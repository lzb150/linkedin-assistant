import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, fetchRobota, jobUrl } from "../../lib/sources/robota.mjs";

test("cleanText squashes SPA innerText whitespace into one line", () => {
  assert.equal(cleanText("QA Engineer\n\n  NETRONIC \n Київ\t·\t10 годин тому"),
    "QA Engineer NETRONIC Київ · 10 годин тому");
  assert.equal(cleanText(""), "");
  assert.equal(cleanText(null), "");
});

test("jobUrl keeps robota.ua links and drops anything that would leave the origin", () => {
  assert.equal(jobUrl("/ua/company123/vacancy456?utm=x"), "https://robota.ua/ua/company123/vacancy456");
  assert.equal(jobUrl("https://ROBOTA.UA/vacancy/1"), "https://robota.ua/vacancy/1");
  assert.equal(jobUrl("https://rabota.robota.ua/v/2"), "https://rabota.robota.ua/v/2");
  for (const bad of ["https://evil.com/x", "//evil.com/x", "https://robota.ua.evil.com/x",
    "https://evilrobota.ua/x", "javascript:alert(1)", "ftp://robota.ua/x", "http://[bad", null]) {
    assert.equal(jobUrl(bad), null, bad);
  }
});

test("fetchRobota returns [] when the source is disabled (no page access)", async () => {
  const jobs = await fetchRobota(null, { enabled: false }, () => {});
  assert.deepEqual(jobs, []);
});
