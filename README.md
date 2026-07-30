# LinkedIn Job Assistant

> 🇺🇦 [Українською](README.uk.md)

A local job-search helper: it watches recruiter messages in your LinkedIn inbox,
finds vacancies on DOU and LinkedIn, scores them against your resume, and prepares
ready-to-review reply/application drafts. **It never sends anything** — the final
click is always yours.

![Dashboard — matched jobs sorted by relevance, with pipeline tracking and filters](docs/dashboard.png)

> ⚠️ LinkedIn's User Agreement restricts automated access. This tool only *reads*
> your own inbox and *drafts* replies for you — it does not auto-message or scrape
> others. Run it modestly. Use at your own discretion; LinkedIn can still flag
> automation.

## What it does

**1. Inbox assistant — `check.mjs`**
- Reads unread messages in your LinkedIn inbox
- Scores each against your skill profile
- Drafts a reply in the sender's language (🇺🇦/🇷🇺/🇬🇧)
- Flags when to attach your resume

**2. Job discovery — `jobs.mjs`**
- **DOU** — via official RSS feeds (legal, no scraping)
- **Djinni** — via the public jobs board (plain fetch, no login, no browser)
- **Jooble** — via the official Jooble API (free key, structured JSON)
- **LinkedIn Jobs** — search scraping (every 3 hours by default, toggleable; drop to once a day for lower detection risk)
- **Cross-source de-dup** — the same vacancy posted on several boards is collapsed
  into one package (the other source links are kept on the card)
- Strict gate for cold applications (score ≥ 25 + an automation role) → only on-target jobs
- Builds an application package: cover letter + link + resume path

**3. Dashboard & convenience**
- **HTML dashboard** — all jobs on one page, sorted by relevance, with pipeline
  tracking (New → Viewed → Applied), private notes, multi-select filters,
  search, freshness highlights, and a copy-letter button
- **💼 Dock shortcut** — opens the latest dashboard in one click

**4. Automation (launchd)**

| Job                | Frequency           |
|--------------------|---------------------|
| Inbox check        | hourly              |
| DOU discovery      | hourly              |
| LinkedIn discovery | every 3 hours (at :45) |

## Key principles
- 🔒 **Security:** your password is never stored (you log in once yourself), everything is local, no API keys
- 🚫 **No auto-send:** the scripts only prepare — you review and apply manually
- ⚖️ **Minimal risk:** DOU via legal RSS, LinkedIn scraping modest and toggleable

## One-time setup

```bash
cd ~/linkedin-assistant
npm install                      # installs playwright
npx playwright install chromium  # downloads the browser
node login.mjs                   # YOU log in manually (handles 2FA). Never stores your password.
```

`login.mjs` opens a real browser. Log in fully, then press ENTER in the terminal
to save the session into `.browser-profile/`.

## Inbox assistant — `check.mjs`

```bash
node check.mjs              # headless; UNREAD threads only
HEADFUL=1 node check.mjs    # watch it (useful when selectors break)
MAX=5 node check.mjs        # cap unread threads opened this run
SCAN_ALL=1 node check.mjs   # scan recent threads regardless of read state
```

New drafts land in `drafts/`. Each draft is a markdown file: their message, a
suggested reply, the relevance score, and an attach-resume checkbox. It never
clicks Send.

![A reply draft in drafts/ — their message, a suggested reply, score, and action checklist](docs/draft.png)

### Unread badge on the Jobs app

Each scan writes the number of unread LinkedIn message threads to
`notify-state.json`. The **Jobs app** (`Jobs.app`, "Вакансии") runs persistently
in the Dock and reads that file every few seconds, showing the count as a red
Dock badge (cleared once the threads are read on LinkedIn — the next scan
reports a lower count). Clicking the Dock icon opens the dashboard as before.

Build it with `./build-jobs.sh`, then start it at login by installing
`com.eugene.jobs-badge.plist` into `~/Library/LaunchAgents/` (see
`com.example.jobs-badge.plist.example`). `check.mjs` also relaunches it
defensively on each scan. The original AppleScript applet is preserved at
`Jobs.app.orig`.

## Djinni inbox (combined Dock badge)

The Dock badge on `Jobs.app` ("Вакансии") shows the **combined** number of unread message threads from **LinkedIn** and **Djinni**.

One-time login (whenever the Djinni session expires):

```bash
node login.mjs djinni   # opens a browser; log in to Djinni manually (incl. 2FA)
```

Count unread Djinni inbox threads (writes `djinni-notify-state.json`):

```bash
node djinni-check.mjs              # headless
HEADFUL=1 node djinni-check.mjs    # watch it / fix selectors against the live page
```

`djinni-check.mjs` is **count-only**: it counts the conversation threads in Djinni's unread bucket (`https://djinni.co/my/inbox?bucket=unread`), never opens threads, never drafts, never sends. `Jobs.app` polls both `notify-state.json` (LinkedIn) and `djinni-notify-state.json` (Djinni) every ~3 s and badges their sum.

Run it hourly via launchd:

```bash
cp run-djinni.sh.example run-djinni.sh                      # then edit PATH/version
cp com.example.djinni-inbox.plist.example \
   ~/Library/LaunchAgents/com.eugene.djinni-inbox.plist      # then edit the paths
launchctl load ~/Library/LaunchAgents/com.eugene.djinni-inbox.plist
```

## Job discovery — `jobs.mjs`

Finds *new* vacancies, scores them against your resume, and writes an
**application package** (cover letter in the job's language + resume path) for
each strong match into `applications/`. **It never submits anything.**

```bash
node jobs.mjs              # all sources (per jobs.config.json)
DOU_ONLY=1 node jobs.mjs   # skip LinkedIn scraping (DOU + Djinni still run — fully ToS-clean)
HEADFUL=1 node jobs.mjs    # watch the LinkedIn part
```

- **DOU** — official RSS feeds (`jobs.dou.ua`), clean and structured. Edit feeds in `jobs.config.json`.
- **Djinni** — public jobs board (`djinni.co/jobs/`), read with a plain fetch (no login, no browser). Each search is a full jobs-search URL — copy them from your browser's filters. Set `djinni.enabled=false` to disable.
- **Jooble** — official Jooble API (`jooble.org/api`). Jooble is behind Cloudflare, so the API is the supported path. Needs a **free** API key from [jooble.org/api/about](https://jooble.org/api/about), set via the `JOOBLE_API_KEY` env var (in `run-jobs.sh`, gitignored — never commit the key). Searches are `{ keywords, location }` pairs in `jobs.config.json`. Set `jooble.enabled=false` to disable.
- **LinkedIn Jobs** — scrapes search results (⚠️ ToS-restricted, more detectable). Set `linkedin.enabled=false` to disable.
- Cold applications use a **high bar**: `minScore` (default 25) + `requireRole`.
- **Cross-source de-dup** — the same vacancy arriving from several sources (its URL
  differs per board) is collapsed into one record before scoring. The record with
  the fullest description is kept; the other source links are recorded under
  `alt_links` in the package and shown as an "also on:" row on the dashboard.
- `jobs-seen.json` prevents re-preparing the same vacancy. It is keyed by
  **identity** (`normalize(company) + normalize(title)`), so a job is remembered
  regardless of which source it came from. Legacy URL-keyed files migrate
  automatically on the next run (the old history is reset once).

## Dashboard — `dashboard.mjs`

```bash
node dashboard.mjs          # rebuild applications/index.html
node dashboard.mjs --open   # rebuild and open it
```

Renders the packages in `applications/` as cards, sorted by score. Per-card
state (status, applied date, notes) is keyed by job URL and stored on disk by
the state server (see Dashboard v2 below), so it survives dashboard
regeneration and browser resets. Opening a job link or expanding its cover
letter marks the card Viewed automatically.

`applications/` is append-only, so the dashboard **collapses duplicate packages
by identity** (`company + title`) at render time, keeping the most recently
generated one. You see each vacancy once even when older packages linger on disk.

### Dashboard v2 — state server, pipeline tracking & follow-up reminders

**State server (`state-server.mjs`)** replaces in-browser localStorage as the
persistence layer. The dashboard is now served by a tiny local HTTP server at
`http://127.0.0.1:7777/` (localhost only, never exposed). Clicking the Jobs.app
Dock icon runs `open-dashboard.sh`, which regenerates the dashboard, starts the
server if it is not already running, and opens the browser. Job state (status,
applied-date, per-card notes, last-visit timestamp) is written to `job-state.json`
on disk, so it survives a browser reset or a full OS restart. If the server is
unreachable the dashboard falls back to `localStorage` and shows an
**"offline — not saved to disk"** badge.

**Pipeline tracking** — each card now moves through a three-stage pipeline:
**New → Viewed → Applied**. Marking a job Applied records the date and shows it
as "applied 5d ago". You can attach private notes to any card; they are saved to
disk via the state server. The header shows live status/freshness counters and
lets you filter by stage.

![Card expanded — cover letter, private note, Applied state](docs/card.png)

**Find & freshness** — a search box filters cards by title, company, or skill
keywords. Source chips (LinkedIn / DOU / Djinni / Jooble) and min-score presets
(≥ 30 / ≥ 40) narrow the list further. Cards that arrived since your last visit
are highlighted with a 🆕 badge and can be isolated with the "New since last
visit" filter.

![Multi-select filters, source chips and search](docs/filters.png)

**Follow-up reminders (`followup.mjs`)** — a daily launchd job
(`com.eugene.jobs-followup.plist`, ships as `.example`) posts a macOS
notification (via `osascript`) for every job you marked **Applied** with no
status movement for 7+ days. Tune the threshold with the `FOLLOWUP_DAYS` env
var. Install:

```bash
cp com.example.jobs-followup.plist.example \
   ~/Library/LaunchAgents/com.eugene.jobs-followup.plist   # edit paths inside
launchctl load ~/Library/LaunchAgents/com.eugene.jobs-followup.plist
```

## Clean up stale packages — `prune-applications.mjs`

The dashboard hides on-disk duplicates, but you can reclaim the space. This
script keeps the newest package per identity and deletes the rest:

```bash
node prune-applications.mjs           # dry run — lists what would be removed
node prune-applications.mjs --apply   # actually delete the stale duplicates
```

## Tuning relevance — `skills.json`

- `skills` — keyword → weight. Higher weight = stronger match.
- `roles` — titles you'd accept (strong signal).
- `antiKeywords` — phrases that *lower* the score (e.g. "manual testing only").
- `thresholds.relevant` / `.maybe` — score cutoffs for drafting + attaching.

Job-discovery search config (feeds, LinkedIn searches, `minScore`, `requireRole`)
lives in `jobs.config.json`.

## Schedule it (launchd)

The run wrappers and launchd agents are machine-specific (absolute paths,
your resume location), so they ship as `*.example` templates. Copy each, fill in
your own values, and the real copies stay local (gitignored):

```bash
cp run.sh.example run.sh && cp run-jobs.sh.example run-jobs.sh   # then edit node version + RESUME_PATH
cp com.example.linkedin-assistant.plist.example com.you.linkedin-assistant.plist  # replace YOUR_USERNAME inside
cp com.you.linkedin-assistant.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.you.linkedin-assistant.plist
```

Unload to stop: `launchctl unload ~/Library/LaunchAgents/com.you.linkedin-assistant.plist`.
Discovery has its own templates: `com.example.job-discovery-dou.plist.example`
and `com.example.job-discovery-linkedin.plist.example`.

## When it breaks

LinkedIn changes its HTML often. If `check.mjs` finds 0 cards or can't read messages:
1. Run `HEADFUL=1 node check.mjs` and watch.
2. Open DevTools on the messaging page, find the new class names.
3. Update the `SEL` object at the top of `check.mjs`.

Session expired? Re-run `node login.mjs`.

## Project layout

```
~/linkedin-assistant/
├── check.mjs          inbox → reply drafts
├── jobs.mjs           job discovery → application packages
├── login.mjs          one-time login (LinkedIn by default, `djinni` argument)
├── djinni-check.mjs   Djinni inbox unread count → djinni-notify-state.json
├── dashboard.mjs      HTML dashboard generator
├── state-server.mjs   local HTTP server (127.0.0.1:7777) for job-state persistence
├── followup.mjs       follow-up reminder script (daily launchd job)
├── open-dashboard.sh  Dock-click helper: regenerate → start server → open browser
├── prune-applications.mjs  remove stale duplicate packages from applications/
├── lib/               logic (scoring, dedup, templates, DOU/Djinni/Jooble/LinkedIn sources)
├── skills.json        skill profile + weights
├── jobs.config.json   what and where to search
├── job-state.json     per-card state (status, applied-date, notes, last-visit) — gitignored
├── drafts/            reply drafts
├── applications/      application packages + index.html
└── Jobs.app           Dock shortcut 💼
```

## What's where

| File                  | Purpose                                                   |
|-----------------------|-----------------------------------------------------------|
| `login.mjs`           | One-time manual login (LinkedIn default, `node login.mjs djinni`); persists session. |
| `check.mjs`           | Read unread → score → draft. Never sends.                 |
| `djinni-check.mjs`    | Count unread Djinni inbox threads. Count-only, never opens threads. |
| `jobs.mjs`            | Discover vacancies → application packages. Never submits. |
| `dashboard.mjs`       | Build the HTML dashboard with status tracking.            |
| `state-server.mjs`    | Local HTTP server at 127.0.0.1:7777; persists job state to `job-state.json`. |
| `followup.mjs`        | Post macOS notifications for Applied jobs with no movement for 7+ days. |
| `open-dashboard.sh`   | Dock-click helper: regenerate dashboard, start server, open browser. |
| `prune-applications.mjs` | Delete stale duplicate packages (dry-run by default).  |
| `lib/relevance.mjs`   | Local scoring (no API key, nothing leaves the machine).   |
| `lib/dedup.mjs`       | Cross-source de-dup: identity key + collapse duplicates.  |
| `lib/draft.mjs`       | Builds the reply-draft markdown.                          |
| `lib/application.mjs` | Builds the application-package markdown.                  |
| `skills.json`         | Your skill profile + thresholds. Edit freely.             |
| `resume.txt`          | Extracted from your .docx (reference).                    |
| `drafts/`             | Output — review and send these manually.                  |
| `seen.json`           | Tracks processed threads (no duplicate drafts).           |
| `jobs-seen.json`      | Tracks processed vacancies by identity (no duplicate packages, across sources). |

## Technologies
JavaScript (Node.js) · Playwright · DOU RSS · launchd · Swift/AppKit (icon) ·
no external dependencies beyond Playwright.

## License
[MIT](LICENSE)
