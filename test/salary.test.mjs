import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLinear } from "./helpers/linear.mjs";
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
  assertLinear("digits", (n) => extractSalary("1".repeat(n)), 12_500);
  assertLinear("digit+comma runs", (n) => extractSalary("111,".repeat(n)), 3_125);
  assertLinear("digit+space+comma runs", (n) => extractSalary("1 1,".repeat(n)), 3_125);
});

test("a range needs a real upper bound, not any digit that follows the dash", () => {
  // "$3000 – 5" was written to frontmatter and the dashboard as the salary.
  assert.equal(extractSalary("Вилка $3000 – 5 років досвіду"), null);
  assert.equal(extractSalary("$3000–5000"), "$3000–5000");
  assert.equal(extractSalary("$3k–5k"), "$3k–5k");
});
