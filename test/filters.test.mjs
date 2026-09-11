import { test } from "node:test";
import assert from "node:assert/strict";
import { filterByLocation, djinniEligible } from "../lib/filters.mjs";

test("filterByLocation: foreign terms drop a job unless it is a remote DOU listing (offices); Djinni uses its eligible-countries rule", () => {
  const jobs = [
    { title: "A", source: "dou", location: "Київ" },
    { title: "B", source: "dou", location: "Краків, Польща" },
    { title: "C", source: "linkedin" }, // no location → kept
    { title: "D", source: "dou", location: "Київ, Варшава (Польща), віддалено" },   // DOU: offices + remote → kept
    { title: "E", source: "linkedin", location: "Poland (Remote)" },               // remote but not DOU → dropped
    { title: "F", source: "djinni", location: "Тільки віддалено · Канада, Польща, Сербія · 5 років досвіду" },   // Djinni: must live there → dropped
    { title: "G", source: "djinni", location: "Тільки віддалено · Країни ЄС · 3 роки досвіду" },                 // EU only, no excludeLocation term → still dropped
    { title: "H", source: "djinni", location: "Тільки віддалено · Країни Європи та Україна · 4 роки досвіду" },  // Ukraine named → kept
  ];
  const kept = filterByLocation(jobs, ["польща", "poland"]);
  assert.deepEqual(kept.map((j) => j.title), ["A", "C", "D", "H"]);
  // Another candidate: living in Poland, F (Канада, Польща, Сербія) becomes eligible and H (Європи та Україна) does not
  const pl = filterByLocation(jobs, ["ukraine"], ["Poland", "Польща"]);
  assert.deepEqual(pl.map((j) => j.title), ["A", "B", "C", "D", "E", "F"]);
});

test("djinniEligible: the countries segment must name Ukraine or the whole world; no segment means keep", () => {
  const ok = ["Тільки віддалено · Україна · 2 роки досвіду", "Україна (Київ) · 1 рік досвіду", "Тільки офіс · Україна (Львів) · 3 роки досвіду · Англійська - B2",
    "Тільки віддалено · Країни Європи та Україна · 4 роки досвіду", "Тільки віддалено · Весь світ · 5 років досвіду", "Хорватія, Румунія, Україна · 2 роки досвіду",
    "Part-time · 3 роки досвіду · Англійська - B2", "", "3 роки досвіду · Англійська - B2"];
  for (const l of ok) assert.equal(djinniEligible(l), true, l);
  const no = ["Тільки віддалено · Канада, Польща, Сербія · 5 років досвіду · Англійська - B2", "Гібридний формат роботи · Польща · 3 роки досвіду", "Тільки віддалено · Країни ЄС · 3 роки досвіду",
    "Тільки віддалено · Аргентина, Бразилія, Канада, Мексика, Сполучені Штати · 5 років досвіду"];
  for (const l of no) assert.equal(djinniEligible(l), false, l);
  assert.equal(djinniEligible("Тільки віддалено · Країни ЄС · 3 роки досвіду", ["Poland", "Польща", "Країни ЄС"]), true, "an EU candidate can list the board's region wording as a spelling");
});

test("filterByLocation coerces non-string patterns and is a no-op without a list", () => {
  const jobs = [{ title: "A", location: "Office 42" }];
  assert.deepEqual(filterByLocation(jobs, [42]), []);
  assert.deepEqual(filterByLocation(jobs, undefined), jobs);
  assert.deepEqual(filterByLocation(jobs, []), jobs);
  const abroad = [{ title: "B", source: "djinni", location: "Тільки віддалено · Польща" }];
  assert.deepEqual(filterByLocation(abroad, []), [], "Djinni country eligibility applies even without an exclude list");
});
