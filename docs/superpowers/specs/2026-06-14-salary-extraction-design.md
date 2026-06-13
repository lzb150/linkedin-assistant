# Salary Extraction Design

**Goal:** Extract a raw salary string from each job description and display it on the dashboard card so the candidate can see compensation at a glance without opening the vacancy.

**Scope:** Display only. No filtering, no normalization, no currency conversion.

---

## Architecture

A new pure module `lib/salary.mjs` exports `extractSalary(text)`. It is called inside `buildApplication()` in `lib/application.mjs` — no API change to callers. The result is written as a `salary` frontmatter field in the generated `.md` package. `dashboard.mjs` reads the field and renders a small inline tag on the card.

---

## `lib/salary.mjs`

### Interface

```js
export function extractSalary(text: string): string | null
```

Returns the raw matched substring from `text` (untrimmed of surrounding words, trimmed of whitespace), or `null` if no salary pattern is found. No normalization, no conversion.

### Pattern groups (applied in order; first match wins)

**Group 1 — Range** (most specific, checked first):
- `$3,000–$5,000`, `$3,000 - $5,000`
- `$3k–5k`, `$3k-5k`
- `3,000–5,000 USD`, `3000-5000 EUR`
- `€3 000 – €5 000`

**Group 2 — Upper bound / ceiling**:
- `up to $4,000`, `up to $4k`
- `до $5 000`, `до 5000$`, `до €4k`
- `не більше $4,000`

**Group 3 — Single value with unit** (least specific):
- `$4,000/mo`, `$4,000/month`, `$4,000 per month`
- `$25/hour`, `$25/hr`
- `4,000 USD`, `4000 EUR`

### Regex strategy

Three compiled regexes, one per group. The function tries Group 1, then Group 2, then Group 3. Returns `match[0].trim()` of the first regex that matches, or `null`.

All three groups optionally capture a trailing rate suffix: `/mo`, `/month`, `/hr`, `/hour`, `/мо`, `/місяць` (case-insensitive). The suffix is included in the returned string when present in the source text.

Currency symbols recognised: `$`, `€`, `£`, `₴` (hryvnia).
Suffix keywords recognised: `USD`, `EUR`, `UAH`, `GBP` (case-insensitive).
Magnitude shorthands: `k` suffix (e.g. `3k` = three thousand; kept as-is in output).

### Out of scope

- Normalization to a canonical format
- Currency conversion
- Hourly → monthly arithmetic

---

## `lib/application.mjs` changes

Inside `buildApplication(job, scored)`, call:

```js
import { extractSalary } from "./salary.mjs";
// ...
const salary = extractSalary(job.text);
```

Add to the frontmatter block (only when non-null):

```
salary: $3 000–5 000/мо
```

If `extractSalary` returns `null`, the `salary:` line is omitted entirely (no `salary: —` placeholder that would clutter diffs).

---

## `dashboard.mjs` changes

In the `parse()` helper, `fm.salary` is already available after frontmatter parsing (no code change needed there).

In the card template, append the salary tag to the `.sub` line, after location, only when `fm.salary` is non-empty:

```html
<div class="sub">
  {badge} <strong>{company}</strong> · {location} · <span class="lang">{lang}</span>
  {salary ? `· <span class="salary">${esc(salary)}</span>` : ""}
</div>
```

Add one CSS rule (inline in the `<style>` block):

```css
.salary { color: #1a7f37; font-size: .8rem; white-space: nowrap; }
```

---

## Tests — `test/salary.test.mjs`

Uses `node:test` + `node:assert/strict`. No fixtures needed — inputs are inline strings.

| Test | Input excerpt | Expected output |
|---|---|---|
| Range with $ and dash | `"salary $3,000-$5,000/mo"` | `"$3,000-$5,000/mo"` |
| Range with k shorthand | `"compensation $3k–5k"` | `"$3k–5k"` |
| Range USD suffix | `"3000-5000 USD"` | `"3000-5000 USD"` |
| Upper bound "up to" | `"up to $4,000"` | `"up to $4,000"` |
| Upper bound Cyrillic "до" | `"зарплата до $5 000"` | `"до $5 000"` |
| Single value /mo | `"$4,000/month"` | `"$4,000/month"` |
| Single value /hr | `"$25/hr"` | `"$25/hr"` |
| No salary in text | `"competitive compensation"` | `null` |
| Euro range | `"€3 000 – €5 000"` | `"€3 000 – €5 000"` |

---

## File map

| File | Action |
|---|---|
| `lib/salary.mjs` | Create |
| `test/salary.test.mjs` | Create |
| `lib/application.mjs` | Modify — import + call + frontmatter line |
| `dashboard.mjs` | Modify — salary tag in card + CSS rule |
