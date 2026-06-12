import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCompany, normalizeTitle, identityKey, dedupeJobs } from "../lib/dedup.mjs";

test("normalizeCompany strips a company suffix so SoftServe LLC == SoftServe", () => {
  assert.equal(normalizeCompany("SoftServe LLC"), normalizeCompany("SoftServe"));
});

test("normalizeCompany is case- and punctuation-insensitive", () => {
  assert.equal(normalizeCompany("EPAM Systems, Inc."), normalizeCompany("epam systems"));
});

test("normalizeCompany strips Cyrillic legal forms (ТОВ/ООО)", () => {
  assert.equal(normalizeCompany("ТОВ Genesis"), normalizeCompany("Genesis"));
  assert.equal(normalizeCompany("ООО Грамарли"), normalizeCompany("Грамарли"));
});

test("normalizeTitle is case/punctuation/whitespace insensitive", () => {
  assert.equal(normalizeTitle("QA  Automation Engineer!"), normalizeTitle("qa automation engineer"));
});

test("normalizeTitle keeps a parenthetical qualifier so distinct roles do not merge", () => {
  assert.notEqual(
    normalizeTitle("QA Automation (Playwright)"),
    normalizeTitle("QA Automation"),
  );
});

test("identityKey combines normalized company and title", () => {
  const a = { company: "SoftServe LLC", title: "QA Automation Engineer" };
  const b = { company: "softserve", title: "qa automation engineer" };
  assert.equal(identityKey(a), identityKey(b));
});

test("dedupeJobs merges the same job from two sources and keeps the longest text", () => {
  const jobs = [
    { source: "jooble", company: "SoftServe LLC", title: "QA Automation", url: "u-jooble", text: "short snippet" },
    { source: "djinni", company: "SoftServe", title: "QA Automation", url: "u-djinni", text: "a much longer full description with many details" },
  ];
  const { deduped, mergedCount } = dedupeJobs(jobs);
  assert.equal(deduped.length, 1);
  assert.equal(mergedCount, 1);
  assert.equal(deduped[0].url, "u-djinni");
  assert.equal(deduped[0].source, "djinni");
});

test("dedupeJobs records dropped duplicates in altLinks (excluding the kept record)", () => {
  const jobs = [
    { source: "jooble", company: "SoftServe", title: "QA Automation", url: "u-jooble", text: "short" },
    { source: "djinni", company: "SoftServe", title: "QA Automation", url: "u-djinni", text: "a longer description" },
    { source: "dou", company: "SoftServe", title: "QA Automation", url: "u-dou", text: "mid" },
  ];
  const { deduped } = dedupeJobs(jobs);
  assert.equal(deduped.length, 1);
  const alt = deduped[0].altLinks;
  assert.equal(alt.length, 2);
  const urls = alt.map((a) => a.url).sort();
  assert.deepEqual(urls, ["u-dou", "u-jooble"]);
  assert.ok(!urls.includes("u-djinni"));
});

test("dedupeJobs does NOT merge distinct roles at the same company", () => {
  const jobs = [
    { source: "djinni", company: "SoftServe", title: "Manual QA", url: "u1", text: "x" },
    { source: "djinni", company: "SoftServe", title: "QA Automation", url: "u2", text: "y" },
  ];
  const { deduped, mergedCount } = dedupeJobs(jobs);
  assert.equal(deduped.length, 2);
  assert.equal(mergedCount, 0);
});

test("dedupeJobs leaves a unique job without an altLinks entry or with an empty one", () => {
  const jobs = [
    { source: "dou", company: "Acme", title: "SDET", url: "u1", text: "x" },
  ];
  const { deduped, mergedCount } = dedupeJobs(jobs);
  assert.equal(deduped.length, 1);
  assert.equal(mergedCount, 0);
  assert.ok(!deduped[0].altLinks || deduped[0].altLinks.length === 0);
});
