import { test } from "node:test";
import assert from "node:assert/strict";
import { stemCyrillic, mentionsStem } from "../lib/relevance.mjs";

test("stemCyrillic reduces UA declensions of a noun to one stem prefix", () => {
  const stem = stemCyrillic("автоматизація");
  assert.ok("автоматизації".startsWith(stem), `"автоматизації" should start with "${stem}"`);
  assert.ok("автоматизацію".startsWith(stem), `"автоматизацію" should start with "${stem}"`);
});

test("stemCyrillic reduces a UA verbal noun so other case forms share the stem", () => {
  const stem = stemCyrillic("тестування");
  assert.ok("тестуванні".startsWith(stem), `"тестуванні" should start with "${stem}"`);
  assert.ok("тестувань".startsWith(stem), `"тестувань" should start with "${stem}"`);
});

test("stemCyrillic does not over-stem a short consonant-ending word", () => {
  assert.equal(stemCyrillic("досвід"), "досвід");
});

test("stemCyrillic leaves Latin words unchanged", () => {
  assert.equal(stemCyrillic("Playwright"), "playwright");
});

test("mentionsStem matches a Cyrillic phrase across declensions", () => {
  const hay = "маємо досвід автоматизації тестування продукту".toLowerCase();
  assert.equal(mentionsStem(hay, "автоматизація тестування"), true);
});

test("mentionsStem does not match when the stem is absent", () => {
  const hay = "ручне тестування веб-додатків".toLowerCase();
  assert.equal(mentionsStem(hay, "автоматизація тестування"), false);
});

test("mentionsStem falls back to exact matching for Latin terms", () => {
  assert.equal(mentionsStem("we use playwright daily", "playwright"), true);
  assert.equal(mentionsStem("backend in c# here", "c#"), true);
  assert.equal(mentionsStem("strong ci/cd skills", "ci/cd"), true);
  assert.equal(mentionsStem("we test apis", "api"), false);
});
