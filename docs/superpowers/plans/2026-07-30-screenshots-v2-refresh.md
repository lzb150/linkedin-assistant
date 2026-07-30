# Screenshots v2 Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the README screenshot gallery to show Dashboard v2, sync stale README text, and apply two micro-cleanups in `dashboard.mjs`.

**Architecture:** Screenshots are captured with the repo's own Playwright against a *temporary* state-server instance (port 7788) that uses a scratchpad copy of `job-state.json` — real user state is never touched. The capture script is a one-off in the session scratchpad and is NOT committed. README edits reference the four PNGs committed to `docs/`.

**Tech Stack:** Node 20, Playwright (already installed), `state-server.mjs`'s exported `createServer({statePath, indexPath})`.

## Global Constraints

- All committed docs and code comments in English (user rule).
- Branch: `docs/screenshots-v2-refresh` (already checked out; spec committed).
- Never modify `job-state.json`, `notify-state.json`, or anything in `drafts/` / `applications/` besides the regenerated `applications/index.html` (gitignored anyway).
- The draft screenshot must contain NO real recruiter name, message text, or thread URL.
- Capture script lives in the session scratchpad (`$SCRATCH` below), not in the repo.

---

### Task 1: Micro-refactor dashboard.mjs

**Files:**
- Modify: `dashboard.mjs:94` (copyCover onclick), `dashboard.mjs:275-278` (copyCover fn), `dashboard.mjs:182-186` (source buttons), `dashboard.mjs:363` (setSource), `dashboard.mjs:174-178` (filter buttons), `dashboard.mjs:383` (setFilter)

**Interfaces:**
- Produces: generated dashboard HTML whose inline JS no longer uses the deprecated implicit `event` global and has no unused parameters. No behavior change.

- [ ] **Step 1: Fix `copyCover` — pass the button explicitly**

In the card template, change:

```js
<button class="copy" onclick="copyCover(${idx})">Copy letter</button>
```

to:

```js
<button class="copy" onclick="copyCover(${idx}, this)">Copy letter</button>
```

In the inline script, change:

```js
function copyCover(i){
  const t = document.getElementById('cover'+i).innerText;
  navigator.clipboard.writeText(t).then(()=>{ event.target.textContent='✓ Copied'; setTimeout(()=>event.target.textContent='Copy letter',1500); });
}
```

to:

```js
function copyCover(i, btn){
  const t = document.getElementById('cover'+i).innerText;
  navigator.clipboard.writeText(t).then(()=>{ btn.textContent='✓ Copied'; setTimeout(()=>btn.textContent='Copy letter',1500); });
}
```

- [ ] **Step 2: Drop unused `btn` param from `setSource` and `setFilter`**

Change the five status-filter buttons from the pattern `onclick="setFilter(this,'all')"` to `onclick="setFilter('all')"` (same for `new`, `viewed`, `applied`, `fresh`), and the five source buttons from `onclick="setSource(this,'all')"` to `onclick="setSource('all')"` (same for `linkedin`, `dou`, `djinni`, `jooble`).

Change the two function definitions:

```js
function setSource(btn, src){ toggleSel(srcSel, src); syncSeg(srcSel, '.src-seg button', 'src'); applyFilter(); }
...
function setFilter(btn, filter){ toggleSel(statusSel, filter); syncSeg(statusSel, '.filter-seg button', 'filter'); applyFilter(); }
```

to:

```js
function setSource(src){ toggleSel(srcSel, src); syncSeg(srcSel, '.src-seg button', 'src'); applyFilter(); }
...
function setFilter(filter){ toggleSel(statusSel, filter); syncSeg(statusSel, '.filter-seg button', 'filter'); applyFilter(); }
```

(`setMin` keeps its `btn` parameter — it actually uses it.)

- [ ] **Step 3: Regenerate the dashboard and run tests**

Run: `cd ~/linkedin-assistant && node dashboard.mjs && npm test`
Expected: `Dashboard: .../applications/index.html (N jobs)` and `# pass 100`, `# fail 0`.
(No test asserts on the onclick strings — verified. The real smoke test is Task 2, whose Playwright clicks exercise `setFilter`/`setSource`/`setStatus` on the regenerated page.)

- [ ] **Step 4: Commit**

```bash
git add dashboard.mjs
git commit -m "refactor: drop deprecated implicit event global and unused btn params in dashboard client JS"
```

---

### Task 2: Capture the three dashboard screenshots

**Files:**
- Create: `$SCRATCH/shots.mjs` (NOT committed), `$SCRATCH/shot-state.json` (copy of job-state.json)
- Create: `docs/dashboard.png`, `docs/filters.png`, `docs/card.png` (committed in Task 4)

**Interfaces:**
- Consumes: `createServer({ statePath, indexPath })` from `state-server.mjs`; regenerated `applications/index.html` from Task 1.
- Produces: three PNGs in `docs/` at devicePixelRatio 2, viewport 1280px wide.

- [ ] **Step 1: Write the capture script**

`$SCRATCH` = the session scratchpad directory. Write `$SCRATCH/shots.mjs`
(adjust nothing else; REPO and SCRATCH absolute paths at the top):

```js
// One-off screenshot capture. Run: node $SCRATCH/shots.mjs
// Serves the dashboard from a TEMP state copy on :7788 — never touches real state.
const REPO = "/Users/eugenelazeba/linkedin-assistant";
const SCRATCH = process.env.SCRATCH; // exported before running
import { copyFileSync } from "node:fs";
import { join } from "node:path";
const { createServer } = await import(join(REPO, "state-server.mjs"));
const { chromium } = await import(join(REPO, "node_modules/playwright/index.mjs"));

const statePath = join(SCRATCH, "shot-state.json");
copyFileSync(join(REPO, "job-state.json"), statePath);
const srv = createServer({ statePath, indexPath: join(REPO, "applications/index.html") });
await new Promise((r) => srv.listen(7788, "127.0.0.1", r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
await page.goto("http://127.0.0.1:7788/");
await page.waitForTimeout(1000); // init(): state load, renderCard, markFreshness

// 1) Hero — top of the page as-is (default "New" filter, NEW ribbons visible).
await page.screenshot({ path: join(REPO, "docs/dashboard.png") });

// 2) Filters in action — multi-select sources + search.
await page.click('button[data-src="dou"]');
await page.click('button[data-src="djinni"]');
await page.fill("#q", "qa");
await page.waitForTimeout(300);
if (await page.locator(".card:visible").count() === 0) { await page.fill("#q", ""); await page.waitForTimeout(300); }
await page.screenshot({ path: join(REPO, "docs/filters.png"), clip: { x: 0, y: 0, width: 1280, height: 560 } });

// 3) Expanded card — Applied + note + cover letter open.
await page.fill("#q", "");
await page.click('button[data-src="all"]');
await page.click('button[data-filter="all"]');   // toggleSel('all') clears the set → every status shown
await page.waitForTimeout(200);
const card = page.locator(".card:visible").first();
await card.locator('button[data-status="applied"]').click();
await card.locator(".note-wrap summary").click();
await card.locator(".note").fill("Recruiter replied — tech interview scheduled for Friday.");
await card.locator(".note").blur();
await card.locator("details:not(.note-wrap) summary").click(); // open cover letter
await page.waitForTimeout(300);
await card.screenshot({ path: join(REPO, "docs/card.png") });

await browser.close();
await new Promise((r) => srv.close(r));
console.log("done");
```

Note on the `setFilter('all')` click: `toggleSel` treats `all` as "clear the
set", and an empty set means "show everything" — so one click switches from the
default `{new}` selection to All. Do NOT click any other status chip afterwards
(that would re-enable filtering and hide the Applied card). Verification:
`card.png` must show an "Applied"-active card.

- [ ] **Step 2: Run it**

```bash
export SCRATCH=<session scratchpad dir>
cd ~/linkedin-assistant && node $SCRATCH/shots.mjs
```

Expected: `done`; three PNGs appear in `docs/`.

- [ ] **Step 3: Inspect all three PNGs (Read tool)**

Check: `dashboard.png` shows header + ≥2 cards, NEW ribbons if any card is fresher than lastVisit; `filters.png` shows DOU+Djinni chips active and search text; `card.png` shows Applied active (green), "applied today", the note text, and the cover letter open. Re-run with tweaks if a shot is empty or clipped badly.

- [ ] **Step 4: Confirm real state untouched**

Run: `git status --short && git diff --stat -- job-state.json`
Expected: only `docs/*.png` new/modified; `job-state.json` is not even tracked — `git status` must not show it.

---

### Task 3: Capture the anonymized draft screenshot

**Files:**
- Create: `$SCRATCH/draft.html` (NOT committed)
- Create: `docs/draft.png` (committed in Task 4)

**Interfaces:**
- Consumes: nothing from other tasks (fully synthetic content).
- Produces: `docs/draft.png`.

- [ ] **Step 1: Write `$SCRATCH/draft.html`**

Fully synthetic draft styled as a markdown file in an editor-like window. No real names, URLs, or message text:

```html
<style>
  body { margin:0; background:#f6f8fa; font-family:-apple-system,system-ui,sans-serif; padding:24px; }
  .win { max-width:860px; margin:0 auto; background:#fff; border:1px solid #d0d7de; border-radius:10px; overflow:hidden; box-shadow:0 4px 14px rgba(0,0,0,.08); }
  .bar { background:#f6f8fa; border-bottom:1px solid #d0d7de; padding:8px 14px; font-size:13px; color:#57606a; display:flex; align-items:center; gap:8px; }
  .dot { width:11px; height:11px; border-radius:50%; display:inline-block; }
  pre { margin:0; padding:18px 22px; font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; color:#1f2328; }
  .fm { color:#6e7781; } .h { color:#0969da; font-weight:700; } .q { color:#57606a; }
</style>
<div class="win">
  <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>&nbsp;drafts/2026-07-300912_relevant_Maryna_K.md</div>
  <pre><span class="fm">---
thread: Maryna K.
url: https://www.linkedin.com/messaging/thread/…
generated: 2026-07-30T09:12:04.511Z
reply_language: uk
verdict: relevant
score: 34
matched_role: automation qa
matched_skills: playwright, typescript, api testing, ci/cd
attach_resume: YES — ~/Documents/resume.docx
---</span>

<span class="h"># Maryna K. — RELEVANT (score 34)</span>

<span class="h">## Their message</span>
<span class="q">&gt; Привіт! Маємо віддалену позицію Senior Automation QA
&gt; (Playwright + TypeScript, продуктова компанія, EU-клієнт).
&gt; Підкажіть, чи цікаво було б поспілкуватися?</span>

<span class="h">## Suggested reply (review before sending)</span>
Привіт, Марино! Дякую, що написали — так, звучить цікаво.
Маю 5+ років в автоматизації (Playwright/TypeScript, API-тести,
CI/CD). Надсилаю резюме — буду радий обговорити деталі.

<span class="h">## Action</span>
- [ ] Review the reply above
- [ ] Attach resume (~/Documents/resume.docx)
- [ ] Send it yourself — the assistant never sends anything
</pre>
</div>
```

- [ ] **Step 2: Screenshot it**

Append to a tiny script or run inline (same Playwright import as Task 2):

```js
const REPO = "/Users/eugenelazeba/linkedin-assistant";
const { chromium } = await import(REPO + "/node_modules/playwright/index.mjs");
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 960, height: 830 }, deviceScaleFactor: 2 });
await p.goto("file://" + process.env.SCRATCH + "/draft.html");
await p.screenshot({ path: REPO + "/docs/draft.png" });
await b.close();
```

- [ ] **Step 3: Inspect the PNG (Read tool)**

Check: window chrome renders, no clipping at the bottom (grow viewport height if the Action list is cut), no real personal data anywhere.

---

### Task 4: README gallery + stale-text fixes, commit docs

**Files:**
- Modify: `README.md:8` (hero alt), `README.md:34-36` (features bullet), `README.md:73-75` (add draft image), `README.md:152-156` (stale localStorage paragraph), `README.md:174-184` (add card + filters images)
- Commit: the four PNGs from Tasks 2-3 + README.md

**Interfaces:**
- Consumes: `docs/dashboard.png`, `docs/filters.png`, `docs/card.png`, `docs/draft.png`.

- [ ] **Step 1: Update the hero alt text (line 8)**

```markdown
![Dashboard — matched jobs sorted by relevance, with pipeline tracking and filters](docs/dashboard.png)
```

- [ ] **Step 2: Fix the features bullet (lines 34-36)**

Replace:

```markdown
- **HTML dashboard** — all jobs on one page, sorted by relevance, with per-card
  status tracking (New → Viewed), a status filter with counters, and a
  copy-letter button
```

with:

```markdown
- **HTML dashboard** — all jobs on one page, sorted by relevance, with pipeline
  tracking (New → Viewed → Applied), private notes, multi-select filters,
  search, freshness highlights, and a copy-letter button
```

- [ ] **Step 3: Add the draft screenshot after the drafts paragraph (after line 75)**

After "…It never clicks Send.", insert a blank line then:

```markdown
![A reply draft in drafts/ — their message, a suggested reply, score, and action checklist](docs/draft.png)
```

- [ ] **Step 4: Rewrite the stale v1 paragraph (lines 152-156)**

Replace:

```markdown
Renders the packages in `applications/` as cards, sorted by score. Per-card
status (New / Viewed) is stored in the browser's localStorage keyed by job URL,
so it survives dashboard regeneration. Opening a job link or expanding its cover
letter marks the card Viewed automatically. Use the header filter to focus on a
status.
```

with:

```markdown
Renders the packages in `applications/` as cards, sorted by score. Per-card
state (status, applied date, notes) is keyed by job URL and stored on disk by
the state server (see Dashboard v2 below), so it survives dashboard
regeneration and browser resets. Opening a job link or expanding its cover
letter marks the card Viewed automatically.
```

- [ ] **Step 5: Add card and filters screenshots in the v2 section**

After the "Pipeline tracking" paragraph (ends "…lets you filter by stage.", line 178), insert a blank line then:

```markdown
![Card expanded — cover letter, private note, Applied state](docs/card.png)
```

After the "Find & freshness" paragraph (ends "…"New since last visit" filter.", line 184), insert a blank line then:

```markdown
![Multi-select filters, source chips and search](docs/filters.png)
```

- [ ] **Step 6: Verify image links resolve**

Run: `cd ~/linkedin-assistant && grep -o 'docs/[a-z]*\.png' README.md | sort -u | xargs ls -la`
Expected: all four PNGs listed, no `ls` error.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/dashboard.png docs/filters.png docs/card.png docs/draft.png
git commit -m "docs: refresh screenshot gallery for Dashboard v2, sync stale README text"
```

---

### Task 5: Push and open draft PR

**Files:** none (git/gh only)

**Interfaces:**
- Consumes: commits from Tasks 1 and 4 (plus the already-committed spec/plan).

- [ ] **Step 1: Run the full test suite one last time**

Run: `cd ~/linkedin-assistant && npm test`
Expected: `# pass 100`, `# fail 0`.

- [ ] **Step 2: Push and create the draft PR**

```bash
git push -u origin docs/screenshots-v2-refresh
gh pr create --draft --title "docs: refresh screenshots for Dashboard v2 + micro-refactor" --body "$(cat <<'EOF'
## What

- Replaces the June 8 (pre-v2) screenshot with a 4-image gallery: dashboard hero, filters in action, expanded card (Applied + note + cover letter), anonymized inbox reply draft.
- Syncs stale README text: "New → Viewed" → full pipeline; v1 localStorage description replaced by the state-server model (localStorage remains as documented offline fallback).
- Micro-refactor in dashboard.mjs client JS: deprecated implicit `event` global in copyCover, unused `btn` params in setFilter/setSource.

## Data

Job cards show public postings as-is. The draft screenshot is fully synthetic — no real recruiter name, message, or thread URL.

## Verification

- `npm test`: 100/100 pass.
- Screenshots captured against a temp state-server (:7788) on a scratch copy of job-state.json — real state untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

- [ ] **Step 3: Check images render on GitHub**

Run: `gh pr view --web` is not needed — instead verify the branch README renders the images: `gh api repos/lzb150/linkedin-assistant/contents/docs?ref=docs/screenshots-v2-refresh --jq '.[].name'`
Expected: all four PNG names listed.
