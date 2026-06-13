# Source Parser Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fixture-based unit tests for each job source's parsing logic (DOU, Djinni, Jooble, LinkedIn) so parser edits can't silently break extraction of `company`/`title`/`text`/`url`.

**Architecture:** Make the already-pure parsing functions exportable (and, for Jooble, extract one inline `.map` into a named function), then test them against small committed fixtures. No network, no browser. LinkedIn's DOM extraction is out of scope; only its pure `buildUrl` is tested.

**Tech Stack:** Node.js (ESM), `node:test`, no external dependencies.

---

## File Structure

- `lib/sources/dou.mjs` (modify) — `export` on `parseRss`.
- `lib/sources/djinni.mjs` (modify) — `export` on `splitCards`, `parseCard`, `extractDivByClass`.
- `lib/sources/jooble.mjs` (modify) — extract + `export` `mapJoobleJobs(data, max)`; call it in `fetchJooble`.
- `lib/sources/linkedin-jobs.mjs` (modify) — `export` on `buildUrl`.
- `test/fixtures/sources/dou-feed.xml` (exists, committed) — real DOU RSS, 3 items.
- `test/fixtures/sources/djinni-listing.html` (exists, committed) — real Djinni listing, 3 cards.
- `test/fixtures/sources/djinni-detail.html` (exists, committed) — real Djinni detail page.
- `test/fixtures/sources/jooble-response.json` (create) — hand-built API response.
- `test/sources/dou.test.mjs` (create)
- `test/sources/djinni.test.mjs` (create)
- `test/sources/jooble.test.mjs` (create)
- `test/sources/linkedin.test.mjs` (create)

`node --test` discovers `*.test.mjs` recursively, so files under `test/sources/`
run with the existing suite. Run a single file with
`node --test test/sources/<name>.test.mjs`.

Fixture facts the tests rely on (already verified against the current parsers):
- DOU item[0]: title `QA Engineer Dynamics Business Central ERP`, company `AVU SA`,
  raw link ends with `?utm_source=jobsrss`, stripped url
  `https://jobs.dou.ua/companies/avu-sa/vacancies/236651/`.
- Djinni card[0]: title `Senior Python Automation QA Engineer`, company `GlobalLogic`,
  url `https://djinni.co/jobs/810011-senior-python-automation-qa-engineer/`,
  location begins `Full Remote`.

---

## Task 1: DOU parseRss tests

**Files:**
- Modify: `lib/sources/dou.mjs` (line 34: `function parseRss(xml)`)
- Create: `test/sources/dou.test.mjs`

- [ ] **Step 1: Export the parser**

In `lib/sources/dou.mjs`, change:

```js
function parseRss(xml) {
```

to:

```js
export function parseRss(xml) {
```

- [ ] **Step 2: Write the tests**

Create `test/sources/dou.test.mjs`:

```js
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
```

- [ ] **Step 3: Run the tests**

Run: `node --test test/sources/dou.test.mjs`
Expected: PASS — 5 tests.

- [ ] **Step 4: Run the full suite for regressions**

Run: `node --test`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add lib/sources/dou.mjs test/sources/dou.test.mjs
git commit -m "test: cover DOU RSS parser against a real feed fixture"
```

---

## Task 2: Djinni HTML parser tests

**Files:**
- Modify: `lib/sources/djinni.mjs` (line 40 `splitCards`, line 55 `extractDivByClass`, line 77 `parseCard`)
- Create: `test/sources/djinni.test.mjs`

- [ ] **Step 1: Export the three pure functions**

In `lib/sources/djinni.mjs`, change each declaration to add `export`:

```js
function splitCards(html) {
```
→
```js
export function splitCards(html) {
```

```js
function extractDivByClass(html, className) {
```
→
```js
export function extractDivByClass(html, className) {
```

```js
function parseCard(card) {
```
→
```js
export function parseCard(card) {
```

(Leave `decodeEntities`, `stripHtml`, `composeText`, `fetchDescription`, `pool`,
and `fetchDjinni` unchanged.)

- [ ] **Step 2: Write the tests**

Create `test/sources/djinni.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { splitCards, parseCard, extractDivByClass } from "../../lib/sources/djinni.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const listing = readFileSync(join(__dir, "../fixtures/sources/djinni-listing.html"), "utf8");
const detail = readFileSync(join(__dir, "../fixtures/sources/djinni-detail.html"), "utf8");

test("splitCards splits the listing into one block per job-item", () => {
  assert.equal(splitCards(listing).length, 3);
});

test("parseCard extracts title, company, absolute query-stripped url, location, snippet, text", () => {
  const job = parseCard(splitCards(listing)[0]);
  assert.equal(job.source, "djinni");
  assert.equal(job.title, "Senior Python Automation QA Engineer");
  assert.equal(job.company, "GlobalLogic");
  assert.equal(job.url, "https://djinni.co/jobs/810011-senior-python-automation-qa-engineer/");
  assert.ok(!job.url.includes("?"), "url query should be stripped");
  assert.ok(job.location.includes("Full Remote"));
  assert.ok(job.snippet.length > 0);
  assert.ok(job.text.includes(job.title));
});

test("parseCard returns null when the card has no job href", () => {
  assert.equal(parseCard(`<div>no link here</div>`), null);
});

test("parseCard returns null when the card has an href but no title", () => {
  assert.equal(parseCard(`<a href="/jobs/123-x/"></a>`), null);
});

test("extractDivByClass captures the full nested description block, not truncated to EOF", () => {
  const desc = extractDivByClass(detail, "job-post__description");
  assert.ok(desc.length > 0);
  assert.ok(desc.length < detail.length, "depth counter found the real closing </div>");
});

test("extractDivByClass returns empty string when the class is absent", () => {
  assert.equal(extractDivByClass(`<div class="other-thing">x</div>`, "job-post__description"), "");
});
```

- [ ] **Step 3: Run the tests**

Run: `node --test test/sources/djinni.test.mjs`
Expected: PASS — 6 tests.

- [ ] **Step 4: Run the full suite for regressions**

Run: `node --test`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add lib/sources/djinni.mjs test/sources/djinni.test.mjs
git commit -m "test: cover Djinni card + description parsers against real fixtures"
```

---

## Task 3: Jooble mapper extraction + tests

**Files:**
- Modify: `lib/sources/jooble.mjs` (the inline `.map` inside `fetchJooble`, lines ~69-82)
- Create: `test/fixtures/sources/jooble-response.json`
- Create: `test/sources/jooble.test.mjs`

- [ ] **Step 1: Create the fixture**

Create `test/fixtures/sources/jooble-response.json`:

```json
{
  "totalCount": 4,
  "jobs": [
    {
      "title": "QA Automation Engineer",
      "company": "Acme &amp; Co",
      "location": "Remote",
      "snippet": "We need <b>Playwright</b> and TypeScript skills.",
      "link": "https://jooble.org/desc/123?utm_source=api"
    },
    {
      "title": "SDET",
      "company": "Beta",
      "location": "Lviv",
      "snippet": "API automation.",
      "link": "https://jooble.org/desc/789"
    },
    {
      "title": "",
      "company": "NoTitle Inc",
      "location": "Kyiv",
      "snippet": "Missing title should be dropped.",
      "link": "https://jooble.org/desc/456"
    },
    {
      "title": "No Link Role",
      "company": "Gamma",
      "location": "Odesa",
      "snippet": "no link.",
      "link": ""
    }
  ]
}
```

- [ ] **Step 2: Write the tests**

Create `test/sources/jooble.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mapJoobleJobs } from "../../lib/sources/jooble.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(
  readFileSync(join(__dir, "../fixtures/sources/jooble-response.json"), "utf8"),
);

test("mapJoobleJobs maps fields, strips html/entities, and builds the text blob", () => {
  const [first] = mapJoobleJobs(data, 15);
  assert.equal(first.source, "jooble");
  assert.equal(first.title, "QA Automation Engineer");
  assert.equal(first.company, "Acme & Co");
  assert.equal(first.url, "https://jooble.org/desc/123");
  assert.equal(
    first.text,
    "QA Automation Engineer at Acme & Co. Remote. We need Playwright and TypeScript skills.",
  );
});

test("mapJoobleJobs drops jobs missing a title or a link", () => {
  const jobs = mapJoobleJobs(data, 15);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((j) => j.title), ["QA Automation Engineer", "SDET"]);
});

test("mapJoobleJobs applies the max slice before filtering", () => {
  assert.equal(mapJoobleJobs(data, 1).length, 1);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/sources/jooble.test.mjs`
Expected: FAIL — `mapJoobleJobs` is not exported yet.

- [ ] **Step 4: Extract and export the mapper**

In `lib/sources/jooble.mjs`, add this exported function above `fetchJooble`
(after the `stripHtml` definition):

```js
// Pure mapper from a Jooble API response to our normalized job records.
// Slice to `max` first, then map, then drop anything without a title or url.
export function mapJoobleJobs(data, max) {
  return (data.jobs || []).slice(0, max).map((j) => {
    const title = stripHtml(j.title || "");
    const company = stripHtml(j.company || "");
    const location = stripHtml(j.location || "");
    const snippet = stripHtml(j.snippet || "");
    return {
      source: "jooble",
      title,
      company,
      url: (j.link || "").split("?")[0],
      location,
      text: `${title}${company ? ` at ${company}` : ""}. ${location}. ${snippet}`.trim(),
    };
  }).filter((j) => j.title && j.url);
}
```

Then, inside `fetchJooble`, replace the inline mapping:

```js
      const jobs = (data.jobs || []).slice(0, max).map((j) => {
        const title = stripHtml(j.title || "");
        const company = stripHtml(j.company || "");
        const location = stripHtml(j.location || "");
        const snippet = stripHtml(j.snippet || "");
        return {
          source: "jooble",
          title,
          company,
          url: (j.link || "").split("?")[0],
          location,
          text: `${title}${company ? ` at ${company}` : ""}. ${location}. ${snippet}`.trim(),
        };
      }).filter((j) => j.title && j.url);
```

with:

```js
      const jobs = mapJoobleJobs(data, max);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/sources/jooble.test.mjs`
Expected: PASS — 3 tests.

- [ ] **Step 6: Run the full suite for regressions**

Run: `node --test`
Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add lib/sources/jooble.mjs test/fixtures/sources/jooble-response.json test/sources/jooble.test.mjs
git commit -m "test: extract and cover the Jooble API mapper"
```

---

## Task 4: LinkedIn buildUrl tests

**Files:**
- Modify: `lib/sources/linkedin-jobs.mjs` (line 15: `function buildUrl(...)`)
- Create: `test/sources/linkedin.test.mjs`

- [ ] **Step 1: Export buildUrl**

In `lib/sources/linkedin-jobs.mjs`, change:

```js
function buildUrl({ keywords, location, remote }) {
```

to:

```js
export function buildUrl({ keywords, location, remote }) {
```

- [ ] **Step 2: Write the tests**

Create `test/sources/linkedin.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUrl } from "../../lib/sources/linkedin-jobs.mjs";

test("buildUrl includes keywords and location and always sorts by date", () => {
  const url = buildUrl({ keywords: "QA Automation", location: "Ukraine" });
  assert.match(url, /^https:\/\/www\.linkedin\.com\/jobs\/search\/\?/);
  const qs = new URL(url).searchParams;
  assert.equal(qs.get("keywords"), "QA Automation");
  assert.equal(qs.get("location"), "Ukraine");
  assert.equal(qs.get("sortBy"), "DD");
  assert.equal(qs.get("f_WT"), null, "no remote filter unless requested");
});

test("buildUrl adds the remote filter f_WT=2 when remote is set", () => {
  const qs = new URL(buildUrl({ keywords: "SDET", remote: true })).searchParams;
  assert.equal(qs.get("f_WT"), "2");
});

test("buildUrl omits empty keywords and location but still sorts by date", () => {
  const qs = new URL(buildUrl({})).searchParams;
  assert.equal(qs.get("keywords"), null);
  assert.equal(qs.get("location"), null);
  assert.equal(qs.get("sortBy"), "DD");
});
```

- [ ] **Step 3: Run the tests**

Run: `node --test test/sources/linkedin.test.mjs`
Expected: PASS — 3 tests.

- [ ] **Step 4: Run the full suite for regressions**

Run: `node --test`
Expected: all suites pass (dou, djinni, jooble, linkedin sources + dedup, prune, relevance, notify-state, run-summary).

- [ ] **Step 5: Commit**

```bash
git add lib/sources/linkedin-jobs.mjs test/sources/linkedin.test.mjs
git commit -m "test: cover LinkedIn buildUrl query construction"
```

---

## Self-Review Notes

- **Spec coverage:** DOU `parseRss` export + tests (Task 1); Djinni `splitCards`/`parseCard`/`extractDivByClass` export + tests (Task 2); Jooble `mapJoobleJobs` extraction + fixture + tests (Task 3); LinkedIn `buildUrl` export + tests (Task 4). All four fixtures referenced (three pre-captured, Jooble created in Task 3 Step 1). Out-of-scope items (LinkedIn DOM, fetch mocking, wrappers, pool) are not touched.
- **Behaviour preservation:** only `export` keywords added (Tasks 1, 2, 4) and one verbatim relocation of the Jooble map (Task 3) whose body is copied exactly, so `fetchJooble` returns identical results.
- **Type/name consistency:** `parseRss`, `splitCards`, `parseCard`, `extractDivByClass`, `mapJoobleJobs(data, max)`, `buildUrl(search)` are named identically in the source edits, the test imports, and the spec. Fixture paths (`../fixtures/sources/...`) and import paths (`../../lib/sources/...`) are consistent across all four test files.
- **No placeholders:** every step has concrete code/JSON and an exact command with expected output. Assertions use values verified against the captured fixtures.
