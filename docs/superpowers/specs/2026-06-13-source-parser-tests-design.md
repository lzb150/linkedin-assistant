# Source Parser Tests — Design

**Date:** 2026-06-13
**Status:** Approved
**Scope:** Add fixture-based unit tests for the parsing logic of each job source
(DOU, Djinni, Jooble, LinkedIn) so parser edits can't silently break extraction
of `company` / `title` / `text` / `url`. No network, no browser.

## Problem (evidence)

`lib/sources/*.mjs` parse external RSS / HTML / JSON, the most fragile code in
the project, and have **zero** test coverage. The run-summary digest now makes a
total `found = 0` visible, but a *silent mis-parse* — wrong company, truncated
description, dropped jobs — produces corrupt identity keys (bad dedup) and wrong
relevance scores with no signal at all. A parser refactor today has no safety
net.

## Decision: test the pure parsing functions against committed fixtures

Parsing is already (mostly) separated from fetching. The move is to **export the
pure functions** and, for one source, extract an inline map into a named
function. The `fetch*` wrapper behaviour does not change. LinkedIn's card
extraction is DOM-driven (Playwright) and tied to the live, ToS-restricted site;
only its pure `buildUrl` is tested. No Playwright in the test suite.

| Source | Export for testing | Source change |
|---|---|---|
| DOU | `parseRss(xml)` | add `export` (no behaviour change) |
| Djinni | `splitCards(html)`, `parseCard(card)`, `extractDivByClass(html, cls)` | add `export` (no behaviour change) |
| Jooble | new `mapJoobleJobs(data, max)` | extract the inline `.map` from the fetch loop and call it (behaviour-preserving refactor) |
| LinkedIn | `buildUrl(search)` | add `export` (no behaviour change) |

### Jooble refactor detail

Today `fetchJooble` maps the API response inline:

```js
const jobs = (data.jobs || []).slice(0, max).map((j) => { ... }).filter((j) => j.title && j.url);
```

Extract the body verbatim into an exported pure function
`mapJoobleJobs(data, max)` that returns the same array, and have `fetchJooble`
call `mapJoobleJobs(data, max)`. No logic change — only relocation so the mapping
is testable from a JSON fixture.

## Fixtures — `test/fixtures/sources/`

Small, committed test data (public job postings, trimmed):

- `dou-feed.xml` — real DOU RSS, trimmed to 3 `<item>` blocks. **Captured.**
- `djinni-listing.html` — real Djinni search page, trimmed to 3 `job-item` cards.
  **Captured.**
- `djinni-detail.html` — real Djinni detail page, windowed around the
  `job-post__description` block (closing `</div>` retained so depth-counting
  terminates correctly). **Captured.**
- `jooble-response.json` — hand-built to the documented API shape
  (`{ totalCount, jobs: [{ title, company, location, snippet, link, ... }] }`);
  no API key is available to capture a live response. Includes at least one job
  missing `title`/`link` to exercise the filter, and HTML entities in a field to
  exercise `stripHtml`.

The three captured fixtures were validated against the current parser functions
before this spec was written (DOU: 3 items, ` в ` split correct; Djinni listing:
3 cards parse with title+company+url; Djinni detail: description extracted, not
truncated to EOF).

## Tests — `test/sources/*.test.mjs` (4 files, node:test)

**dou.test.mjs** — load `dou-feed.xml`, call `parseRss`:
- returns 3 items;
- role/company split on the **last** ` в ` (use an inline XML snippet whose role
  contains a comma and/or ` в ` to pin the "last occurrence" rule);
- `url` has its `?query` stripped;
- `text` equals `` `${rawTitle}. ${desc}` ``;
- HTML entities decoded and CDATA unwrapped.

**djinni.test.mjs** —
- `splitCards(listingHtml)` returns 3 card blocks;
- `parseCard` extracts `title`, `company`, `url` (absolute, query-stripped),
  `location`, `snippet`; returns `null` when href is absent and when title is
  absent (inline minimal snippets for the null cases);
- `extractDivByClass(detailHtml, "job-post__description")` returns the full
  description block (non-empty, and shorter than the whole fixture — i.e. the
  nested-`<div>` depth counter found the real closing tag, not EOF).

**jooble.test.mjs** — load `jooble-response.json`, call `mapJoobleJobs(data, max)`:
- maps `title`/`company`/`location` and builds `text` as
  `` `${title}${company ? ` at ${company}` : ""}. ${location}. ${snippet}` `` (trimmed);
- strips HTML entities from fields;
- drops jobs missing `title` or `link`;
- respects the `max` slice.

**linkedin.test.mjs** — call `buildUrl(search)`:
- includes `keywords` and `location` when present, omits them when absent;
- `remote: true` adds `f_WT=2`; falsy `remote` omits it;
- always sets `sortBy=DD`.

## Affected files

- `lib/sources/dou.mjs` — `export` on `parseRss`
- `lib/sources/djinni.mjs` — `export` on `splitCards`, `parseCard`, `extractDivByClass`
- `lib/sources/jooble.mjs` — extract + `export` `mapJoobleJobs`; call it in `fetchJooble`
- `lib/sources/linkedin-jobs.mjs` — `export` on `buildUrl`
- `test/fixtures/sources/{dou-feed.xml, djinni-listing.html, djinni-detail.html, jooble-response.json}` — fixtures
- `test/sources/{dou,djinni,jooble,linkedin}.test.mjs` — tests

## Out of scope (YAGNI)

- LinkedIn DOM card extraction (live site + ToS; would need Playwright in tests).
- Mocking `fetch`; testing the `fetch*` wrappers themselves.
- Testing Djinni's bounded-concurrency `pool` / the network enrichment path.
- Any change to parsing behaviour — this effort only adds `export`s, one
  behaviour-preserving extraction, fixtures, and tests.
