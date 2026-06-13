import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseRss } from "../../lib/sources/dou.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dir, "../fixtures/sources/dou-feed.xml"), "utf8");

test("parseRss returns one record per <item>", () => {
  assert.equal(parseRss(fixture).length, 3);
});

test("parseRss splits role/company on the last ' в ' and strips the url query", () => {
  const [first] = parseRss(fixture);
  assert.equal(first.source, "dou");
  assert.equal(first.title, "QA Engineer Dynamics Business Central ERP");
  assert.equal(first.company, "AVU SA");
  assert.equal(first.url, "https://jobs.dou.ua/companies/avu-sa/vacancies/236651/");
  assert.ok(!first.url.includes("?"), "url query should be stripped");
});

test("parseRss builds text as the raw title followed by the stripped description", () => {
  const [first] = parseRss(fixture);
  assert.ok(
    first.text.startsWith("QA Engineer Dynamics Business Central ERP в AVU SA"),
    "text should begin with the raw (unsplit) title",
  );
  assert.ok(first.text.length > first.title.length);
});

test("parseRss splits on the LAST ' в ' so a role containing ' в ' keeps its company", () => {
  const xml = `<rss><channel><item>
    <title>QA Engineer в Playwright в Acme Corp, Kyiv</title>
    <link>https://jobs.dou.ua/x/1/?utm=1</link>
    <description><![CDATA[<p>auto</p>]]></description>
  </item></channel></rss>`;
  const [job] = parseRss(xml);
  assert.equal(job.title, "QA Engineer в Playwright");
  assert.equal(job.company, "Acme Corp");
  assert.equal(job.location, "Kyiv");
});

test("parseRss decodes HTML entities and unwraps CDATA in the description", () => {
  const xml = `<rss><channel><item>
    <title>QA в Acme</title>
    <link>https://jobs.dou.ua/x/2/</link>
    <description><![CDATA[Build &amp; ship quality]]></description>
  </item></channel></rss>`;
  const [job] = parseRss(xml);
  assert.ok(job.text.includes("Build & ship quality"), "entity decoded, CDATA unwrapped");
  assert.ok(!job.text.includes("CDATA"));
});
