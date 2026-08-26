import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSalary } from "../lib/salary.mjs";

test("range with currency prefix and dash", () => {
  assert.equal(extractSalary("salary $3,000-$5,000/mo"), "$3,000-$5,000/mo");
});

test("range with k shorthand and en-dash", () => {
  assert.equal(extractSalary("compensation $3k–5k"), "$3k–5k");
});

test("range with currency word suffix", () => {
  assert.equal(extractSalary("3000-5000 USD"), "3000-5000 USD");
});

test("ceiling: up to", () => {
  assert.equal(extractSalary("up to $4,000"), "up to $4,000");
});

test("ceiling: Cyrillic до", () => {
  assert.equal(extractSalary("зарплата до $5 000"), "до $5 000");
});

test("single value with /month suffix", () => {
  assert.equal(extractSalary("$4,000/month"), "$4,000/month");
});

test("single value with /hr suffix", () => {
  assert.equal(extractSalary("$25/hr"), "$25/hr");
});

test("no salary in text returns null", () => {
  assert.equal(extractSalary("competitive compensation, great team"), null);
});

test("euro range with space-separated thousands", () => {
  assert.equal(extractSalary("€3 000 – €5 000"), "€3 000 – €5 000");
});

test("ceiling does not match non-salary 'up to N' phrases", () => {
  assert.equal(extractSalary("up to 5 years experience required"), null);
});

test("range followed by a sentence comma keeps the number clean", () => {
  assert.equal(extractSalary("Salary $2800–3500, fully remote"), "$2800–3500");
});

test("long digit/comma runs finish in linear time (no catastrophic backtracking)", () => {
  for (const big of ["1".repeat(50_000), "111,".repeat(12_500), "1 1,".repeat(12_500)]) {
    const t = performance.now();
    extractSalary(big);
    assert.ok(performance.now() - t < 100, "50 KB scan took too long");
  }
});
