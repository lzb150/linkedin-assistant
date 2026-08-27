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

test("parseRss keeps a comma inside the company: location is the LAST part", () => {
  const xml = `<rss><channel><item>
    <title>QA в Маніфай, ТОВ, Київ</title>
    <link>https://jobs.dou.ua/x/3/</link>
    <description>d</description>
  </item></channel></rss>`;
  const [job] = parseRss(xml);
  assert.equal(job.title, "QA");
  assert.equal(job.company, "Маніфай, ТОВ");
  assert.equal(job.location, "Київ");
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

test("parseRss leaves no HTML tags in text (description is XML-escaped HTML)", () => {
  for (const j of parseRss(fixture)) assert.doesNotMatch(j.text, /<\/?[a-z][^>]*>/i, j.text.slice(0, 80));
});

test("parseRss drops a salary part from the company when the rest has 3+ parts", () => {
  const xml = `<rss><channel><item>
    <title>QA Engineer в Acme, $3000-5000, Київ</title>
    <link>https://jobs.dou.ua/x/4/</link>
    <description>d</description>
  </item></channel></rss>`;
  const [job] = parseRss(xml);
  assert.equal(job.company, "Acme");
  assert.equal(job.location, "Київ");
});

test("parseRss keeps the company to the FIRST part when DOU lists several cities", () => {
  const xml = `<rss><channel><item><title>Senior Automation QA Engineer (4367) в Ciklum, Київ, Львів</title><link>https://jobs.dou.ua/companies/ciklum/vacancies/1/</link><description>x</description></item></channel></rss>`;
  const [job] = parseRss(xml);
  assert.equal(job.company, "Ciklum");
  assert.equal(job.location, "Київ, Львів");
});

test("parseRss keeps 'за кордоном' in the location so the location filter sees it", () => {
  const xml = `<rss><channel><item><title>QA Engineer в WinWin.Travel, за кордоном, віддалено</title><link>https://jobs.dou.ua/companies/w/vacancies/2/</link><description>x</description></item></channel></rss>`;
  const [job] = parseRss(xml);
  assert.equal(job.company, "WinWin.Travel");
  assert.equal(job.location, "за кордоном, віддалено");
});

test("parseRss skips an item with no <link> so it cannot produce a blank '::title' identity", () => {
  const xml = `<rss><channel>
    <item><title>QA в Acme</title><description>d</description></item>
    <item><title>QA в Acme</title><link>https://jobs.dou.ua/x/1/</link><description>d</description></item>
  </channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://jobs.dou.ua/x/1/");
});
