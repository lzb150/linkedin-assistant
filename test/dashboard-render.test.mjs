import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, toItem, collapseItems, scoreBand, langAttr, badge, renderCard, sourceChips } from "../lib/dashboard-render.mjs";

const md = (fm, body = "# x\n") => `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}`;

test("parse prefers the cover delimiters and falls back to the pre-delimiter heading scan", () => {
  const delimited = parse(md({ title: "SDET" }, "# x\n<!--cover:start-->\nHello\n## Action inside the letter\n<!--cover:end-->\n## Action\n"));
  assert.equal(delimited.cover, "Hello\n## Action inside the letter");
  const legacy = parse(md({ title: "SDET" }, "# x\n## Cover note (en)\nOld letter\n## Action\n- apply\n"));
  assert.equal(legacy.cover, "Old letter");
  assert.equal(parse("no frontmatter"), null);
});

test("toItem defaults the source, parses scores once, and rejects a non-numeric llm_score", () => {
  const it = toItem({ fm: { score: "x", llm_score: "8a" }, cover: "" });
  assert.equal(it.source, "dou");
  assert.equal(it.score, 0);
  assert.equal(it.llm, null);
  assert.equal(toItem({ fm: { source: "djinni", score: "41", llm_score: "77" } }).llm, 77);
});

test("collapseItems keeps the newest package per identity and sorts llm desc, then score desc", () => {
  const it = (fm) => toItem({ fm, cover: "" });
  const out = collapseItems([
    it({ company: "A", title: "T", url: "https://a/1", generated: "2026-09-01", score: "40", llm_score: "80" }),
    it({ company: "A", title: "T", url: "https://a/2", generated: "2026-09-02", score: "40", llm_score: "90" }),
    it({ company: "B", title: "U", url: "https://b/1", generated: "2026-09-01", score: "60" }),
    it({ company: "C", title: "V", url: "https://c/1", generated: "2026-09-01", score: "50" }),
  ]);
  assert.deepEqual(out.map((x) => x.fm.url), ["https://a/2", "https://b/1", "https://c/1"]);
});

test("scoreBand, langAttr and badge's unknown-source fallback", () => {
  assert.deepEqual([40, 39, 30, 29].map(scoreBand), ["hi", "mid", "mid", "lo"]);
  assert.equal(langAttr("Senior SDET"), "");
  assert.equal(langAttr("Тестувальник автоматизації"), ' lang="uk"');
  assert.match(badge("dou"), /#c93c33/);
  assert.match(badge("constructor"), /#6e7781">constructor</, "unknown source: gray, raw name, no prototype lookup");
  assert.match(badge("<b>"), />&lt;b&gt;</);
});

test("renderCard: injection note is visible text, not a hover title; a bad url renders read-only", () => {
  const fm = { source: "dou", title: "SDET", company: "Acme", url: "https://a/1", llm_score: "80", llm_suspect: "injection (2 markers)" };
  const html = renderCard(toItem({ fm, cover: "" }), 0);
  assert.match(html, /⚠ injection \(2 markers\) — the posting addresses the screener/);
  assert.doesNotMatch(html, /title="/);
  assert.match(html, /data-url="https:\/\/a\/1"/);
  const ro = renderCard(toItem({ fm: { ...fm, url: "javascript:alert(1)" }, cover: "" }), 1);
  assert.doesNotMatch(ro, /data-url=|status-seg|note-wrap/);
  assert.match(ro, /href="#"/);
});

test("renderCard: a flagged package without an LLM score still shows the injection note", () => {
  const fm = { source: "dou", title: "SDET", company: "Acme", url: "https://a/1", llm_suspect: "injection (1 marker)" };
  const html = renderCard(toItem({ fm, cover: "" }), 0);
  assert.match(html, /⚠ injection \(1 marker\) — the posting addresses the screener, and the LLM gave no usable verdict/);
  assert.doesNotMatch(html, /🤖/);
});

test("renderCard: a url past the server's length limit renders read-only; middle-click marks Viewed", () => {
  const long = `https://a/${"x".repeat(2100)}`;
  const ro = renderCard(toItem({ fm: { source: "dou", title: "SDET", url: long }, cover: "" }), 0);
  assert.doesNotMatch(ro, /data-url=|status-seg|note-wrap|autoStatus/);
  const live = renderCard(toItem({ fm: { source: "dou", title: "SDET", url: "https://a/1" }, cover: "" }), 1);
  assert.match(live, /onauxclick="if\(event\.button===1\) autoStatus\(/);
});

test("sourceChips lists each source on disk once, sorted, with its label", () => {
  const items = [{ source: "linkedin" }, { source: "dou" }, { source: "linkedin" }, { source: "newboard" }];
  const html = sourceChips(items);
  assert.deepEqual([...html.matchAll(/data-src="([^"]+)"/g)].map((m) => m[1]), ["dou", "linkedin", "newboard"]);
  assert.match(html, />LinkedIn</);
  assert.match(html, />newboard</);
});
