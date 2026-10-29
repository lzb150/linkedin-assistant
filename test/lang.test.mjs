import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLang } from "../lib/lang.mjs";

test("detectLang: Latin-only or empty text is English", () => {
  assert.equal(detectLang("Senior QA Automation Engineer"), "en");
  assert.equal(detectLang(""), "en");
  assert.equal(detectLang(undefined), "en");
});

test("detectLang: Ukrainian-only letters win", () => {
  assert.equal(detectLang("Шукаємо інженера з автоматизації"), "uk");
  assert.equal(detectLang("Вакансія: QA Engineer (Київ)"), "uk");
});

test("detectLang: Russian-only letters give ru, ambiguous Cyrillic leans uk", () => {
  assert.equal(detectLang("Ищем инженера, опыт обязателен"), "ru");
  assert.equal(detectLang("Тестування та автоматизація"), "uk");
  assert.equal(detectLang("Работа"), "uk"); // no distinguishing letters
});

test("detectLang: a board's own Cyrillic (DOU title tail, Djinni location line) does not turn an English posting Ukrainian", () => {
  const jd = "We are looking for a Senior QA Automation Engineer with Playwright, TypeScript and CI/CD experience to join our remote team.";
  assert.equal(detectLang(`SDET в Ciklum, Київ. ${jd}`), "en", "DOU raw title");
  assert.equal(detectLang(`Automation QA Engineer at Parametic. Part-time · Тільки віддалено · Україна · 2 роки досвіду · Англійська - B2. ${jd}`), "en", "Djinni location line");
  // A Ukrainian posting full of English tooling names is still Ukrainian.
  assert.equal(detectLang("Шукаємо Senior QA Automation Engineer (Playwright, TypeScript) на віддалену позицію, досвід від 3 років"), "uk");
  assert.equal(detectLang("Ищем QA Automation (Playwright, TypeScript), удалённо, опыт от 3 лет"), "ru");
});
