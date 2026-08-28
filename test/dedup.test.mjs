import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCompany, normalizeTitle, identityKey, canonicalKey, dedupeJobs } from "../lib/dedup.mjs";

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

test("normalizeCompany treats the '—' frontmatter placeholder as empty", () => {
  assert.equal(normalizeCompany("—"), normalizeCompany(""));
  assert.equal(identityKey({ company: "—", title: "QA" }), identityKey({ company: "", title: "QA" }));
});

test("normalizeCompany keeps a name that is only a legal-form token", () => {
  assert.equal(normalizeCompany("Group"), "group");
  assert.notEqual(normalizeCompany("Group"), normalizeCompany(""));
});

test("dedupeJobs does NOT merge blank-company jobs with the same title from different URLs", () => {
  const jobs = [
    { source: "jooble", company: "", title: "QA Automation Engineer", url: "https://a.example/jobs/1", text: "a" },
    { source: "djinni", company: "—", title: "QA Automation Engineer", url: "https://b.example/jobs/2", text: "b" },
  ];
  const { deduped, mergedCount } = dedupeJobs(jobs);
  assert.equal(deduped.length, 2);
  assert.equal(mergedCount, 0);
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

test("canonicalKey drops req-number tokens so board suffixes match", () => {
  assert.equal(
    canonicalKey({ company: "Ciklum", title: "Senior Automation QA Engineer (3310)" }),
    canonicalKey({ company: "Ciklum", title: "Senior Automation QA Engineer" }),
  );
});

test("canonicalKey keeps 1-2 digit level numbers as part of the role", () => {
  assert.notEqual(
    canonicalKey({ company: "Acme", title: "Test Engineer 2" }),
    canonicalKey({ company: "Acme", title: "Test Engineer" }),
  );
});

test("canonicalKey ignores token order", () => {
  assert.equal(
    canonicalKey({ company: "Acme", title: "Automation QA Engineer" }),
    canonicalKey({ company: "Acme", title: "QA Automation Engineer" }),
  );
});

test("canonicalKey expands the AQA alias", () => {
  assert.equal(
    canonicalKey({ company: "Acme", title: "AQA Engineer" }),
    canonicalKey({ company: "Acme", title: "Automation QA Engineer" }),
  );
});

test("canonicalKey keeps seniority distinct — Lead never merges with Senior", () => {
  assert.notEqual(
    canonicalKey({ company: "Ciklum", title: "Lead Automation QA Engineer (3282)" }),
    canonicalKey({ company: "Ciklum", title: "Senior Automation QA Engineer (3310)" }),
  );
});

test("dedupeJobs merges a reworded cross-source duplicate (req suffix)", () => {
  const jobs = [
    { source: "dou", company: "Ciklum", title: "Senior Automation QA Engineer (3310)", url: "u-dou", text: "long full description text" },
    { source: "linkedin", company: "Ciklum", title: "Senior Automation QA Engineer", url: "u-li", text: "short" },
  ];
  const { deduped, mergedCount } = dedupeJobs(jobs);
  assert.equal(deduped.length, 1);
  assert.equal(mergedCount, 1);
  assert.equal(deduped[0].source, "dou");
  assert.deepEqual(deduped[0].altLinks, [{ source: "linkedin", url: "u-li" }]);
});

test("dedupeJobs keeps same-source req variants separate and folds the other source in", () => {
  const jobs = [
    { source: "dou", company: "Ciklum", title: "Senior AQA Engineer (3310)", url: "u-3310", text: "text one long enough" },
    { source: "dou", company: "Ciklum", title: "Senior AQA Engineer (3650)", url: "u-3650", text: "text two" },
    { source: "linkedin", company: "Ciklum", title: "Senior Automation QA Engineer", url: "u-li", text: "short" },
  ];
  const { deduped, mergedCount } = dedupeJobs(jobs);
  assert.equal(deduped.length, 2);
  assert.equal(mergedCount, 1);
  assert.ok(deduped.every((j) => j.source === "dou"));
  const alt = deduped.flatMap((j) => j.altLinks || []);
  assert.deepEqual(alt, [{ source: "linkedin", url: "u-li" }]);
});

test("dedupeJobs copies the group's longest text onto a keeper for scoring", () => {
  const jobs = [
    { source: "dou", company: "Acme", title: "SDET (1234)", url: "u-dou", text: "tiny" },
    { source: "djinni", company: "Acme", title: "SDET (5678)", url: "u-dj", text: "tiny2" },
    { source: "linkedin", company: "Acme", title: "SDET", url: "u-li", text: "the longest description of them all, rich and detailed" },
  ];
  const { deduped } = dedupeJobs(jobs);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].source, "linkedin");
  assert.ok(deduped[0].text.startsWith("the longest"));
});

test("identityKey/canonicalKey scope a blank company by url so unrelated postings stay apart", () => {
  const a = { company: "", title: "QA Automation Engineer", url: "https://a.example/jobs/1" };
  const b = { company: "—", title: "QA Automation Engineer", url: "https://b.example/jobs/2" };
  assert.notEqual(identityKey(a), identityKey(b));
  assert.notEqual(canonicalKey(a), canonicalKey(b));
  assert.equal(identityKey(a), identityKey({ ...a, company: "—" })); // placeholder == blank
});

test("normalizeCompany is monotonic for suffix-only names", () => {
  assert.equal(normalizeCompany("Group"), "group");
  assert.equal(normalizeCompany("Group LLC"), "group");
  assert.equal(normalizeCompany("Acme LLC"), "acme");
});

test("normalizeCompany strips Unicode punctuation («» and curly quotes) like ASCII", () => {
  assert.equal(normalizeCompany("Компанія «Люкс»"), normalizeCompany("Компанія Люкс"));
  assert.equal(normalizeCompany("O’Reilly"), normalizeCompany("O'Reilly"));
  assert.equal(normalizeCompany("Acme™"), normalizeCompany("Acme"));
});

test("dedupeJobs is idempotent: a second pass adds no altLinks and merges nothing", () => {
  const jobs = [
    { source: "dou", company: "Acme", title: "QA Engineer", url: "https://dou/1", text: "long text" },
    { source: "djinni", company: "Acme", title: "QA Engineer", url: "https://djinni/1", text: "t" },
    { source: "dou", company: "Acme", title: "QA Engineer (100)", url: "https://dou/2", text: "t" },
  ];
  const first = dedupeJobs(jobs);
  const second = dedupeJobs(first.deduped);
  assert.equal(second.mergedCount, 0);
  assert.deepEqual(second.deduped, first.deduped);
  const links = first.deduped.flatMap((j) => j.altLinks || []);
  assert.equal(links.length, 1);
});

test("identityKey keeps C++ / C# / C apart (+ and # are identity characters)", () => {
  const k = (t) => identityKey({ company: "Acme", title: t, url: "https://a/1" });
  assert.notEqual(k("Senior C++ Developer"), k("Senior C# Developer"));
  assert.notEqual(k("Senior C# Developer"), k("Senior C Developer"));
  assert.equal(normalizeCompany("Компанія «Люкс»"), normalizeCompany("Компанія Люкс")); // Unicode stripping still works
});

test("identity keys do not depend on Unicode normalization form (NFD input == NFC input)", () => {
  const nfc = "Тестувальник ПЗ (Київ)";
  assert.equal(normalizeTitle(nfc.normalize("NFD")), normalizeTitle(nfc));
  assert.equal(normalizeCompany("München Robotics".normalize("NFD")), normalizeCompany("München Robotics"));
});

test("canonicalKey drops a #-prefixed req number like a bare one", () => {
  const k = (t) => canonicalKey({ company: "Ciklum", title: t, url: "https://a/1" });
  assert.equal(k("QA Engineer (#3282)"), k("QA Engineer (3282)"));
  assert.equal(k("QA Engineer (#3282)"), k("QA Engineer"));
});
