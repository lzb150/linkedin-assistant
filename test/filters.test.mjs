import { test } from "node:test";
import assert from "node:assert/strict";
import { filterByLocation } from "../lib/filters.mjs";

test("filterByLocation: foreign terms drop a job unless Ukraine is named, or (DOU only) the listing is remote — offices vs Djinni's eligible-countries list", () => {
  const jobs = [
    { title: "A", source: "dou", location: "Київ" },
    { title: "B", source: "dou", location: "Краків, Польща" },
    { title: "C", source: "djinni", location: "Тільки офіс · Tbilisi" },
    { title: "D", source: "linkedin" }, // no location → kept
    { title: "E", source: "dou", location: "Київ, Варшава (Польща), віддалено" },   // DOU: offices + remote → kept
    { title: "F", source: "djinni", location: "Тільки віддалено · Канада, Польща, Сербія · 5 років досвіду" },   // Djinni: eligible countries, none is Ukraine → dropped even though remote
    { title: "G", source: "djinni", location: "Тільки віддалено · Країни Європи та Україна · 4 роки досвіду" },  // Ukraine named → kept
    { title: "H", source: "djinni", location: "Тільки віддалено · Канада, Польща, Україна" },                     // Ukraine among foreign ones → kept
    { title: "I", source: "linkedin", location: "Poland (Remote)" },                                               // remote but not DOU, no Ukraine → dropped
  ];
  const kept = filterByLocation(jobs, ["польща", "poland", "tbilisi"]);
  assert.deepEqual(kept.map((j) => j.title), ["A", "D", "E", "G", "H"]);
});

test("filterByLocation coerces non-string patterns and is a no-op without a list", () => {
  const jobs = [{ title: "A", location: "Office 42" }];
  assert.deepEqual(filterByLocation(jobs, [42]), []);
  assert.deepEqual(filterByLocation(jobs, undefined), jobs);
  assert.deepEqual(filterByLocation(jobs, []), jobs);
});
