import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, stripHtml, composeText, fetchText, extractDiv, extractDivByClass, stripBlocks, pool, siteUrl } from "../../lib/sources/html.mjs";

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

test("decodeEntities drops NUL and lone surrogates, keeps valid code points", () => {
  assert.equal(decodeEntities("&#0;"), "");
  assert.equal(decodeEntities("&#xD800;"), "");
  assert.equal(decodeEntities("&#8212;"), "—");
});

test("fetchText returns \"\" and logs on a non-2xx status", async () => {
  const logs = [];
  const fakeFetch = async () => ({ ok: false, status: 404, text: async () => "body" });
  assert.equal(await fetchText("https://x/1", (l) => logs.push(l), "dou", undefined, fakeFetch), "");
  assert.match(logs[0], /dou 404: https:\/\/x\/1/);
  const okFetch = async () => ({ ok: true, status: 200, text: async () => "body" });
  assert.equal(await fetchText("https://x/1", () => {}, "dou", undefined, okFetch), "body");
});

test("extractDiv ignores a '</div>' string inside <script> and a commented-out <div>", () => {
  const re = /<div id="d">/;
  const script = `<div id="d"><SCRIPT>var s = "</div>";</SCRIPT><p>body</p></div><p>after</p>`;
  assert.equal(stripHtml(extractDiv(script, re)), "body");
  const comment = `<div id="d"><!-- <div class="old"> --><p>body</p></div><p>after</p>`;
  assert.equal(stripHtml(extractDiv(comment, re)), "body");
});

test("stripHtml / extractDivByClass stay linear on junk full of unclosed '<' (ReDoS guard)", () => {
  const junk = "<".repeat(200_000);
  let t = Date.now(); stripHtml(junk); assert.ok(Date.now() - t < 500, "stripHtml too slow");
  t = Date.now(); extractDivByClass("<a ".repeat(50_000), "x"); assert.ok(Date.now() - t < 500, "extractDivByClass too slow");
});

test("extractDivByClass stays linear when the opening div DOES match (depth scan + comment strip)", () => {
  const open = '<div class="job x">';
  let t = Date.now(); extractDivByClass(open + "<div".repeat(50_000), "job"); assert.ok(Date.now() - t < 500, "depth scan too slow");
  t = Date.now(); extractDivByClass(open + "<!--".repeat(50_000), "job"); assert.ok(Date.now() - t < 500, "comment strip too slow");
  t = Date.now(); extractDivByClass(open + "<script>".repeat(20_000), "job"); assert.ok(Date.now() - t < 500, "script strip too slow");
});

test("stripHtml drops tags longer than the bounded scan (inline SVG / data: URI)", () => {
  assert.equal(stripHtml('<img src="' + "a".repeat(5000) + '">hello'), "hello");
});

test("stripBlocks: abrupt comments, mixed case, İ (length-changing lowercase), unterminated blocks", () => {
  assert.equal(stripBlocks("İ<script>x</script>keep"), "İkeep");
  assert.equal(stripBlocks("<!--><div>keep</div>"), "<div>keep</div>");
  assert.equal(stripBlocks("<!---><b>k</b>"), "<b>k</b>");
  assert.equal(stripBlocks('a<!-- <div> --><SCRIPT>var s="</div>";</SCRIPT><style>a{}</style>b'), "ab");
  assert.equal(stripBlocks("x<!-- unterminated"), "x");
});

test("stripBlocks stays linear on many TERMINATED blocks", () => {
  let t = Date.now(); stripBlocks("<!-- c -->".repeat(50_000)); assert.ok(Date.now() - t < 500, "comments");
  t = Date.now(); stripBlocks("<script></script>".repeat(20_000)); assert.ok(Date.now() - t < 500, "scripts");
});

test("stripHtml second pass removes only tag-like tokens, keeping prose between stray < and >", () => {
  assert.equal(stripHtml("salary < 5000 and more > 3 years"), "salary < 5000 and more > 3 years");
  assert.equal(stripHtml('<img src="' + "a".repeat(5000) + '">hi'), "hi");
});

test("extractDiv counts a div with a >2 KB attribute list toward depth", () => {
  const big = '<div data-x="' + "y".repeat(3000) + '">n</div>';
  assert.equal(extractDivByClass(`<div class="job">A${big}B</div>T`, "job"), `A${big}B`);
});

test("pool caps in-flight workers at the limit and visits every item", async () => {
  let inFlight = 0, peak = 0;
  const seen = [];
  await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    seen.push(n); inFlight--;
  });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
});

test("pool resolves on an empty list without calling the worker", async () => {
  let calls = 0;
  await pool([], 5, async () => { calls++; });
  assert.equal(calls, 0);
});

test("siteUrl keeps links on the site (incl. subdomains) and drops everything else", () => {
  assert.equal(siteUrl("/v/1?x=1", "https://robota.ua"), "https://robota.ua/v/1?x=1");
  assert.equal(siteUrl("https://ROBOTA.UA/v/1", "https://robota.ua"), "https://robota.ua/v/1");
  assert.equal(siteUrl("https://uk.glassdoor.com/j", "https://www.glassdoor.com"), "https://uk.glassdoor.com/j");
  for (const bad of ["https://evil.com/x", "//evil.com/x", "https://robota.ua.evil.com/x",
    "https://evilrobota.ua/x", "javascript:alert(1)", "ftp://robota.ua/x", "http://[bad", "", null,
    "https://evil.com@robota.ua/x", "https://user:pw@robota.ua/x", "https://robota.ua:8443/x"]) {
    assert.equal(siteUrl(bad, "https://robota.ua"), null, String(bad));
  }
});
