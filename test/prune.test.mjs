import { test } from "node:test";
import assert from "node:assert/strict";
import { planPrune } from "../prune-applications.mjs";

test("planPrune keeps the newest package per identity and removes older ones", () => {
  const pkgs = [
    { file: "old.md", company: "SoftServe", title: "QA Automation", generated: "2026-06-09T10:00" },
    { file: "new.md", company: "SoftServe LLC", title: "qa automation", generated: "2026-06-12T08:00" },
  ];
  const { keep, remove } = planPrune(pkgs);
  assert.deepEqual(keep, ["new.md"]);
  assert.deepEqual(remove, ["old.md"]);
});

test("planPrune keeps distinct vacancies untouched", () => {
  const pkgs = [
    { file: "a.md", company: "Acme", title: "SDET", generated: "2026-06-10T00:00" },
    { file: "b.md", company: "Acme", title: "QA Lead", generated: "2026-06-10T00:00" },
  ];
  const { keep, remove } = planPrune(pkgs);
  assert.equal(keep.length, 2);
  assert.equal(remove.length, 0);
});

test("planPrune collapses many duplicates to a single newest survivor", () => {
  const pkgs = [
    { file: "d1.md", company: "X", title: "SDET", generated: "2026-06-09T18:55" },
    { file: "d2.md", company: "X", title: "SDET", generated: "2026-06-10T12:26" },
    { file: "d3.md", company: "X", title: "SDET", generated: "2026-06-12T03:58" },
  ];
  const { keep, remove } = planPrune(pkgs);
  assert.deepEqual(keep, ["d3.md"]);
  assert.deepEqual(remove.sort(), ["d1.md", "d2.md"]);
});

test("planPrune breaks a generated-time tie deterministically by filename", () => {
  const pkgs = [
    { file: "bbb.md", company: "X", title: "SDET", generated: "2026-06-12T08:00" },
    { file: "aaa.md", company: "X", title: "SDET", generated: "2026-06-12T08:00" },
  ];
  const { keep, remove } = planPrune(pkgs);
  assert.deepEqual(keep, ["bbb.md"]); // larger filename wins the tie
  assert.deepEqual(remove, ["aaa.md"]);
});

test("planPrune groups by identityKey like the dashboard: distinct req numbers stay separate", () => {
  const pkgs = [
    { file: "a.md", company: "Ciklum", title: "AQA Engineer (3282)", generated: "2026-06-09T00:00" },
    { file: "b.md", company: "Ciklum", title: "Automation QA Engineer", generated: "2026-06-10T00:00" },
  ];
  const { keep, remove } = planPrune(pkgs);
  assert.deepEqual(keep.sort(), ["a.md", "b.md"]);
  assert.deepEqual(remove, []);
});

test("planPrune never removes a package with a non-new status", () => {
  const pkgs = [
    { file: "applied.md", company: "X", title: "SDET", generated: "2026-06-09T00:00", status: "applied" },
    { file: "newer.md", company: "X", title: "SDET", generated: "2026-06-12T00:00", status: "new" },
  ];
  const { keep, remove } = planPrune(pkgs);
  assert.deepEqual(keep.sort(), ["applied.md", "newer.md"]);
  assert.deepEqual(remove, []);
});

test("planPrune keeps every tracked package and still prunes the older 'new' ones", () => {
  const pkgs = [
    { file: "viewed-old.md", company: "X", title: "SDET", generated: "2026-06-01T00:00", status: "viewed" },
    { file: "viewed-older.md", company: "X", title: "SDET", generated: "2026-05-01T00:00", status: "viewed" },
    { file: "new-old.md", company: "X", title: "SDET", generated: "2026-06-09T00:00", status: "new" },
    { file: "new-newest.md", company: "X", title: "SDET", generated: "2026-06-12T00:00" },
  ];
  const { keep, remove } = planPrune(pkgs);
  assert.deepEqual(keep.sort(), ["new-newest.md", "viewed-old.md", "viewed-older.md"]);
  assert.deepEqual(remove, ["new-old.md"]);
});

test("planPrune keeps blank-company packages from different urls apart", () => {
  const plan = planPrune([
    { file: "a.md", company: "—", title: "QA Engineer", url: "https://a.example/jobs/1", generated: "2026-08-01" },
    { file: "b.md", company: "—", title: "QA Engineer", url: "https://b.example/jobs/2", generated: "2026-08-02" },
  ]);
  assert.deepEqual(plan.remove, []);
});
