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
