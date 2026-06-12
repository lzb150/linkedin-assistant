import { test } from "node:test";
import assert from "node:assert/strict";
import { stemCyrillic } from "../lib/relevance.mjs";

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
