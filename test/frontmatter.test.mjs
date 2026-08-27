import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, fmValue } from "../lib/frontmatter.mjs";

test("parseFrontmatter keeps a colon inside the value", () => {
  assert.deepEqual(parseFrontmatter("---\nurl: https://x/a:b\ntitle: QA\n---\nbody"), { url: "https://x/a:b", title: "QA" });
});

test("parseFrontmatter returns null without a frontmatter block", () => {
  assert.equal(parseFrontmatter("# just markdown\n---\n"), null);
  assert.equal(parseFrontmatter(""), null);
  assert.equal(parseFrontmatter(null), null);
});

test("parseFrontmatter handles CRLF line endings", () => {
  assert.deepEqual(parseFrontmatter("---\r\ntitle: QA\r\ncompany: Acme\r\n---\r\nbody"), { title: "QA", company: "Acme" });
});

test("fmValue collapses whitespace/newlines to one line", () => {
  assert.equal(fmValue("  a\n\tb  c \r\n"), "a b c");
  assert.equal(fmValue(null), "");
  assert.equal(fmValue(5), "5");
});
