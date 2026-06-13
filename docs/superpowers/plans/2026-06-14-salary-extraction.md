# Salary Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a raw salary string from each job description and display it as a green tag on the dashboard card.

**Architecture:** A new pure module `lib/salary.mjs` exports `extractSalary(text)` — three regex groups tried in order (range → ceiling → single value), first match wins, raw substring returned. Called inside `buildApplication()` which writes it to frontmatter. `dashboard.mjs` reads the frontmatter field and renders a `<span class="salary">` tag in the card subtitle row.

**Tech Stack:** Node.js ESM, `node:test`, no external dependencies.

---

## File Structure

| File | Action |
|---|---|
| `lib/salary.mjs` | Create — pure `extractSalary(text)` |
| `test/salary.test.mjs` | Create — 9 unit tests |
| `lib/application.mjs` | Modify — import + call + frontmatter line |
| `dashboard.mjs` | Modify — salary tag in card + CSS rule |

---

## Task 1: Pure salary extractor module

**Files:**
- Create: `lib/salary.mjs`
- Create: `test/salary.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `test/salary.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
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
```

- [ ] **Step 2: Run to verify tests fail**

Run: `node --test test/salary.test.mjs`
Expected: all 9 tests FAIL with `Cannot find module '../lib/salary.mjs'`

- [ ] **Step 3: Implement `lib/salary.mjs`**

Create `lib/salary.mjs`:

```js
// Number: digits with optional comma or space thousands separators, optional k suffix.
// Matches: 3000  3,000  3 000  3k  5k
const N = String.raw`\d[\d,]*(?:\s\d{3})*k?`;
const C = String.raw`[$€£₴]`;           // currency symbol
const CW = String.raw`(?:USD|EUR|UAH|GBP)`;  // currency word
const RS = String.raw`(?:\s*\/\s*(?:mo|month|hr|hour|мо|місяць))?`;  // rate suffix

// Group 1: range — $3,000–$5,000 / $3k–5k / 3000–5000 USD / €3 000 – €5 000
const RANGE = new RegExp(
  `(?:${C}${N}\\s*[-–—]\\s*${C}?${N}(?:\\s+${CW})?|${N}\\s*[-–—]\\s*${N}\\s+${CW})${RS}`,
  "i"
);

// Group 2: ceiling — up to $4,000 / до $5 000 / не більше $4k
const CEILING = new RegExp(
  `(?:up\\s+to|до|не\\s+більше)\\s+${C}?${N}(?:\\s+${CW})?${RS}`,
  "i"
);

// Group 3: single value — $4,000/month / $25/hr / 4000 USD
const SINGLE = new RegExp(
  `${C}${N}\\s*\\/\\s*(?:mo|month|hr|hour|мо|місяць)|${N}\\s+${CW}`,
  "i"
);

export function extractSalary(text) {
  if (!text) return null;
  for (const re of [RANGE, CEILING, SINGLE]) {
    const m = re.exec(text);
    if (m) return m[0].trim();
  }
  return null;
}
```

> Note: Unicode escapes are used for Cyrillic literals in regex source strings (`до` = `до`, `не більше` = `не\s+більше`, `/мо` = `\/мо`, `/місяць` = `\/місяць`) to keep the `new RegExp()` call unambiguous. The `–` and `—` dash variants are `–` and `—`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/salary.test.mjs`
Expected: 9 tests PASS

- [ ] **Step 5: Run the full test suite**

Run: `node --test`
Expected: all suites pass (70 existing + 9 new = 79 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/salary.mjs test/salary.test.mjs
git commit -m "feat: add pure salary extractor (regex, display-only)"
```

---

## Task 2: Wire into `lib/application.mjs`

**Files:**
- Modify: `lib/application.mjs`

- [ ] **Step 1: Add the import**

In `lib/application.mjs`, after line 3 (`import { detectLang } from "./lang.mjs";`), add:

```js
import { extractSalary } from "./salary.mjs";
```

- [ ] **Step 2: Call `extractSalary` and add to frontmatter**

In `buildApplication`, after line 31 (`const skills = scored.matchedSkills.slice(0, 6).join(", ");`), add:

```js
const salary = extractSalary(job.text);
```

In the frontmatter template, change the `url` line (currently `url: ${job.url}${altFront}`) to:

```js
url: ${job.url}${altFront}${salary ? `\nsalary: ${salary}` : ""}
```

The full updated frontmatter block will look like:

```js
  const md = `---
source: ${job.source}
title: ${job.title}
company: ${job.company || "—"}
location: ${job.location || "—"}
url: ${job.url}${altFront}${salary ? `\nsalary: ${salary}` : ""}
generated: ${when}
cover_language: ${lang}
score: ${scored.score}
matched_role: ${scored.matchedRole || "—"}
matched_skills: ${scored.matchedSkills.join(", ") || "—"}
penalties: ${scored.penalties.join(", ") || "—"}
resume: ${RESUME_PATH}
---
```

- [ ] **Step 3: Syntax-check**

Run: `node --check lib/application.mjs`
Expected: no output (syntax OK)

- [ ] **Step 4: Run the full test suite**

Run: `node --test`
Expected: all 79 tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/application.mjs
git commit -m "feat: include extracted salary in application package frontmatter"
```

---

## Task 3: Render salary on the dashboard

**Files:**
- Modify: `dashboard.mjs`

- [ ] **Step 1: Add the `.salary` CSS rule**

In `dashboard.mjs`, find the line (around line 121):

```css
  .lang { text-transform: uppercase; font-size: 11px; color: #57606a; }
```

Add immediately after it:

```css
  .salary { color: #1a7f37; font-size: .8rem; white-space: nowrap; }
```

- [ ] **Step 2: Add salary tag to the card subtitle**

In the `cards` map (around line 82), find:

```js
      <div class="sub">${badge(f.source || "dou")} <strong>${esc(f.company || "—")}</strong> · ${esc(f.location || "")} · <span class="lang">${esc(f.cover_language || "")}</span></div>
```

Replace with:

```js
      <div class="sub">${badge(f.source || "dou")} <strong>${esc(f.company || "—")}</strong> · ${esc(f.location || "")} · <span class="lang">${esc(f.cover_language || "")}</span>${f.salary ? ` · <span class="salary">${esc(f.salary)}</span>` : ""}</div>
```

- [ ] **Step 3: Syntax-check**

Run: `node --check dashboard.mjs`
Expected: no output (syntax OK)

- [ ] **Step 4: Run the full test suite**

Run: `node --test`
Expected: all 79 tests pass

- [ ] **Step 5: Regenerate dashboard and visually verify**

Run: `node dashboard.mjs --open`
Expected: dashboard opens in browser. Cards where a salary was found show a green `$X–Y` tag after the language chip. Cards without salary show nothing extra.

- [ ] **Step 6: Commit**

```bash
git add dashboard.mjs
git commit -m "feat: show extracted salary on dashboard card"
```

---

## Self-Review Notes

- **Spec coverage:** Three regex groups (Task 1) ✓ · raw string returned, no normalization (Task 1) ✓ · frontmatter `salary:` field omitted when null (Task 2) ✓ · green `.salary` tag on card (Task 3) ✓ · 9 test cases matching spec table (Task 1) ✓
- **No placeholders:** all steps have concrete code, exact commands, expected output.
- **Type consistency:** `extractSalary` defined in Task 1, imported in Task 2; `f.salary` read from frontmatter in Task 3 (populated by Task 2) — consistent chain.
- **Out of scope confirmed absent:** no filtering, no normalization, no currency conversion, no run-summary changes.
