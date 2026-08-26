import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, stripHtml, composeText } from "../../lib/sources/html.mjs";

test("stripHtml strips tags before decoding, so escaped markup survives as text", () => {
  assert.equal(stripHtml("Use <b>&lt;Playwright&gt;</b> here"), "Use <Playwright> here");
});

test("decodeEntities handles numeric (decimal + hex) and extra named entities", () => {
  assert.equal(decodeEntities("a &#8212; b &#x27;c&#x27; &mdash; &ndash; &apos; &hellip;&nbsp;x"), "a — b 'c' — – ' … x");
});

test("decodeEntities is single-pass: &amp;lt; stays a literal &lt;", () => {
  assert.equal(decodeEntities("&amp;lt;div&amp;gt;"), "&lt;div&gt;");
  assert.equal(decodeEntities("A &amp; B"), "A & B");
});

test("composeText joins title, company, location and description", () => {
  assert.equal(composeText({ title: "QA", company: "Acme", location: "Kyiv" }, "desc"), "QA at Acme. Kyiv. desc");
  assert.equal(composeText({ title: "QA", company: "", location: "Kyiv" }, "desc"), "QA. Kyiv. desc");
});
