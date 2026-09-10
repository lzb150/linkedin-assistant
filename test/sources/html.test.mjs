import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, stripHtml, composeText, fetchText, extractDiv, extractDivByClass, stripBlocks, pool } from "../../lib/sources/html.mjs";

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
  assert.equal(await fetchText("https://x/1", (l) => logs.push(l), "dou", fakeFetch), "");
  assert.match(logs[0], /dou 404: https:\/\/x\/1/);
  const okFetch = async () => ({ ok: true, status: 200, text: async () => "body" });
  assert.equal(await fetchText("https://x/1", () => {}, "dou", okFetch), "body");
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

// Linearity guard that does not depend on the machine: run at n and 4n and
// compare. Linear scales ~4×, quadratic ~16×; the +20 ms absorbs timer
// granularity and JIT warm-up. (Absolute "< 500 ms" caps flaked on shared CI.)
function assertLinear(label, run, n) {
  run(n);                                          // warm up
  const ms = (k) => { const t = performance.now(); run(k); return performance.now() - t; };
  const t1 = ms(n), t4 = ms(4 * n);
  assert.ok(t4 < 8 * t1 + 20, `${label}: ${n}→${4 * n} took ${t1.toFixed(1)}ms→${t4.toFixed(1)}ms (not linear)`);
}

test("extractDivByClass stays linear when the opening div DOES match (depth scan + comment strip)", () => {
  const open = '<div class="job x">';
  assertLinear("depth scan", (n) => extractDivByClass(open + "<div".repeat(n), "job"), 25_000);
  assertLinear("comment strip", (n) => extractDivByClass(open + "<!--".repeat(n), "job"), 25_000);
  assertLinear("script strip", (n) => extractDivByClass(open + "<script>".repeat(n), "job"), 10_000);
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
  assertLinear("comments", (n) => stripBlocks("<!-- c -->".repeat(n)), 25_000);
  assertLinear("scripts", (n) => stripBlocks("<script></script>".repeat(n)), 10_000);
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


test("uniqueByUrl keeps the first record per url (was copy-pasted in every source)", async () => {
  const { uniqueByUrl, pool } = await import("../../lib/sources/html.mjs");
  const a = { url: "https://x/1", title: "first" }, b = { url: "https://x/2" }, a2 = { url: "https://x/1", title: "second" };
  assert.deepEqual(uniqueByUrl([a, b, a2]), [a, b]);
  assert.deepEqual(uniqueByUrl([]), []);
  // pool: a bad limit must still run the workers (0 workers = Promise.all([]) resolving with nothing done)
  const ran = [];
  await pool([1, 2, 3], "five", async (n) => { ran.push(n); });
  assert.deepEqual(ran.sort(), [1, 2, 3]);
});
