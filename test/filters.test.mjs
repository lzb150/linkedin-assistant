import { test } from "node:test";
import assert from "node:assert/strict";
import { filterByLocation, djinniEligible, candidateCountryList, excludeList, numberIn, DEFAULT_CANDIDATE_COUNTRY } from "../lib/filters.mjs";

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

test("djinniEligible: a country whose name contains the experience stem is still a country", () => {
  // "рок" unanchored matches Ма[рок]ко, which made the segment look like
  // "3 роки досвіду" — nothing to judge — and passed an ineligible vacancy.
  assert.equal(djinniEligible("Тільки віддалено · Марокко"), false);
  assert.equal(djinniEligible("Part-time · 3 роки досвіду"), true);
});

test("filterByLocation coerces non-string patterns and is a no-op without a list", () => {
  const jobs = [{ title: "A", location: "Office 42" }];
  assert.deepEqual(filterByLocation(jobs, [42]), []);
  assert.deepEqual(filterByLocation(jobs, undefined), jobs);
  assert.deepEqual(filterByLocation(jobs, []), jobs);
  const abroad = [{ title: "B", source: "djinni", location: "Тільки віддалено · Польща" }];
  assert.deepEqual(filterByLocation(abroad, []), [], "Djinni country eligibility applies even without an exclude list");
});

test("config lists normalize instead of throwing: a non-array degrades to empty/default", () => {
  // jobs.config.json is hand-edited. Before this, a bare string reached
  // .map()/.some() and a TypeError took the whole run down.
  assert.deepEqual(excludeList("Poland"), [], "a string is not a one-item list");
  assert.deepEqual(excludeList(undefined), []);
  assert.deepEqual(excludeList([" Польща ", "", 42]), ["польща", "42"], "trimmed, lowercased, blanks dropped");
  assert.deepEqual(candidateCountryList("Ukraine"), DEFAULT_CANDIDATE_COUNTRY);
  assert.deepEqual(candidateCountryList(["  ", ""]), DEFAULT_CANDIDATE_COUNTRY, "a list of blanks is no list at all");
  assert.deepEqual(candidateCountryList(["Poland"]), ["Poland"]);

  const jobs = [{ title: "A", source: "djinni", location: "Тільки віддалено · Україна" }];
  assert.deepEqual(filterByLocation(jobs, "Poland", "Ukraine"), jobs, "neither bad list throws");
});

test("an empty candidateCountry falls back to the default instead of rejecting everything", () => {
  // [] is truthy, so it used to slip past `config.candidateCountry || undefined`
  // and leave the Djinni gate passing only "Весь світ" while the LLM prompt,
  // reading `?.[0]` -> undefined, still said Ukraine.
  assert.equal(djinniEligible("Тільки віддалено · Україна", []), true);
  assert.equal(djinniEligible("Тільки віддалено · Польща", []), false, "the default still rejects a foreign-only vacancy");
  assert.equal(candidateCountryList([])[0], DEFAULT_CANDIDATE_COUNTRY[0], "and the LLM prompt reads the same first spelling");
});

test("numberIn: a typo'd numeric knob falls back instead of switching a gate off", () => {
  // `score < "abc"` is false for every score — the config error read as "no gate".
  assert.equal(numberIn("abc", 25), 25);
  assert.equal(numberIn(undefined, 25), 25);
  assert.equal(numberIn(null, 25), 25);
  assert.equal(numberIn("", 25), 25);
  assert.equal(numberIn(true, 25), 25);
  assert.equal(numberIn(NaN, 25), 25);
  assert.equal(numberIn(0, 25), 0, "0 is a real value (llm.minScore: 0 = advisory only)");
  assert.equal(numberIn("40", 25), 40, "a quoted number is still a number");
  assert.equal(numberIn(500, 0, [0, 100]), 100);
  assert.equal(numberIn(0, 15, [1, Infinity]), 1);
});
