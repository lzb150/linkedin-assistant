# LinkedIn Job Assistant

> 🇺🇦 [Українською](README.uk.md)

A local job-search helper: it watches recruiter messages in your LinkedIn inbox,
finds vacancies on DOU, Djinni and LinkedIn, scores them against your resume, and prepares
ready-to-review reply/application drafts. **It never sends anything** — the final
click is always yours.

![Dashboard — matched jobs sorted by relevance, with status counts and filters](docs/dashboard.png)

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
- **Jooble** — via the official Jooble API (free key, structured JSON); **disabled by default** — its snippets are short and scored poorly, flip `jooble.enabled` to try it
- **Work.ua / Robota.ua / Glassdoor** — via the shared browser session, but Cloudflare blocks them in headless mode, so they are **disabled by default** (opt in with `HEADFUL=1`, a Chrome window will appear)
- **LinkedIn Jobs** — search scraping (every 3 hours by default, toggleable; drop to once a day for lower detection risk)
- **Cross-source de-dup** — the same vacancy posted on several boards is collapsed
  into one package (the other source links are kept on the card)
- **Foreign-location filter** — vacancies physically located abroad are dropped
  across all sources (the `excludeLocation` list in `jobs.config.json`)
- Two gates for cold applications: keyword score ≥ 18 + an automation role, then the LLM fit ≥ 70 → only on-target jobs
- Builds an application package: cover letter + link + resume path
- **LLM re-scoring & tailored cover letters** — the strongest keyword matches get a
  second look from a local `claude -p` call (sonnet by default — measured stricter on weak fits and ~2× faster than haiku): a 0–100 verdict,
  a one-line "why", and a tailored cover letter. The keyword score decides what
  reaches the LLM; a fit below `llm.minScore` (default 70) drops the job instead of
  writing a package. Any CLI failure still falls back to a keyword-only package.
  Needs `resume.txt`; tune via the `llm` block in `jobs.config.json` (`enabled`,
  `model`, `maxPerRun`, `concurrency` (parallel CLI calls, default 3), `minScore` — 0 makes the LLM advisory-only). Matches past
  the `maxPerRun` cap are deferred to the next run rather than written unscored. The wrapper
  script must have the `claude` binary on `PATH` (`~/.local/bin`, see
  `run-jobs.sh.example`), otherwise every package silently degrades to keyword-only. LLM-scored cards show a 🤖 badge on the dashboard. The `claude`
  child process runs hardened — tools disallowed, cwd off the repo — since job
  descriptions are untrusted input and must not be able to read local files.

**3. Dashboard & convenience**
- **HTML dashboard** — all jobs on one page, sorted by relevance; cards are
  marked Viewed as you open them, ✗ hides what is not yours; private notes,
  multi-select filters, search, freshness highlights, and a copy-letter button
- **💼 Dock shortcut** — opens the latest dashboard in one click

**4. Automation (launchd)**

| Job (plist example)                              | Frequency              |
|--------------------------------------------------|------------------------|
| LinkedIn inbox check (`linkedin-assistant`)      | hourly                 |
| Djinni inbox check + auto-bump (`djinni-inbox`)  | hourly                 |
| DOU / Djinni discovery (`job-discovery-dou`)     | hourly                 |
| Full discovery incl. LinkedIn (`job-discovery-linkedin`) | every 3 hours (at :45) |
| Closed-vacancy check + archive (`closed-check`)  | daily 08:30            |
| Weekly report (`jobs-report`)                    | Monday 09:00           |
| Dock badge daemon (`jobs-badge`)                 | always on (KeepAlive)  |

A `jobs.mjs` run posts **at most one macOS banner**: the new packages it wrote
(strongest first, up to 3 names) preceded by any breakage alerts — a source far
below its norm, the LLM failing more than twice in the run, an expired LinkedIn
session. A run that found nothing new and broke nothing stays silent — the
dashboard timestamp and the weekly report tell you the scheduler is alive. The
scraper-health check watches each source's found-count against its own recent
history (last 10 runs) and alerts when a source comes in under 30% of its recent
median (median ≥ 5, to ignore sources that are naturally low-volume) — this
catches a slow selector decay (50 → 20 → 6), not just a source dropping to a
clean 0.

## Key principles
- 🔒 **Security:** your password is never stored (you log in once yourself), everything is local; the only key is Jooble's free API key, and only if that source is enabled
- 🚫 **No auto-send:** the scripts only prepare — you review and apply manually
- ⚖️ **Minimal risk:** DOU via legal RSS, LinkedIn scraping modest and toggleable

## One-time setup

> **Requires macOS** — scheduling (launchd), notifications, and the Dock apps
> are Mac-only. Node.js 20+.

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
Dock badge. While that count is above zero (and Djinni has nothing unread),
clicking the Dock icon or a banner opens the LinkedIn inbox filtered to unread
and clears the LinkedIn badge on the spot — the next hourly scan brings it back
only if something is still unread. With no unread anywhere the click opens the
dashboard as before.
All macOS banners are posted by this app too (queued as `banners/*.json` by
`lib/notify.mjs`), so they carry its icon and clicking one opens the dashboard.
Without a built `Jobs.app` they fall back to `osascript` (Script Editor icon).

Build it with `./build-jobs.sh`, then start it at login by installing
`com.example.jobs-badge.plist.example` as `com.example.jobs-badge.plist` into
`~/Library/LaunchAgents/` (replace `YOUR_USERNAME` inside first — with a wrong
path launchd respawns `open` every 10 s forever). `check.mjs` also relaunches it
defensively on each scan.

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

Clicking the badge or a Djinni banner opens the unread thread (or the unread bucket) **and clears the Djinni badge on the spot** — the next hourly scan brings it back only if something is still unread. `djinni-check.mjs` is **count-only** for the inbox: it counts the conversation threads in Djinni's unread bucket (`https://djinni.co/my/inbox?bucket=unread`), never opens threads, never drafts, never sends. `Jobs.app` polls both `notify-state.json` (LinkedIn) and `djinni-notify-state.json` (Djinni) every ~3 s and badges their sum.

**Auto-bump:** the same run also keeps your profile fresh — Djinni lets you "Bump My Profile" (raise it in recruiter search results) periodically (every 7 days, as observed; the button itself says when). Once a day (hourly around the expected end of the cooldown) the script checks the button on `djinni.co/my/profile/` and clicks it whenever it is enabled — the button's own state is the source of truth, so any bump frequency Djinni allows is picked up automatically. Confirms the modal and fires a "Profile bumped" banner. Throttle state lives in `djinni-bump-state.json` (gitignored); a bump failure never affects the unread scan.

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
HEADFUL=1 node jobs.mjs    # visible Chrome window (also required for Work.ua / Robota.ua / Glassdoor)
```

Scheduled runs are headless by default — no browser window. Sources that Cloudflare blocks in headless Chrome (Work.ua, Robota.ua, Glassdoor) ship with `enabled: false`; to use them set `enabled: true` in `jobs.config.json` and `export HEADFUL=1` in `run-jobs.sh`, accepting a Chrome window during each full run.

- **DOU** — official RSS feeds (`jobs.dou.ua`), clean and structured. Edit feeds in `jobs.config.json`.
- **Djinni** — public jobs board (`djinni.co/jobs/`), read with a plain fetch (no login, no browser). Each search is a full jobs-search URL — copy them from your browser's filters. Set `djinni.enabled=false` to disable.
- **Jooble** — official Jooble API (`jooble.org/api`). Jooble is behind Cloudflare, so the API is the supported path. Needs a **free** API key from [jooble.org/api/about](https://jooble.org/api/about), set via the `JOOBLE_API_KEY` env var (in `run-jobs.sh`, gitignored — never commit the key). Keys are market-bound — the config pins `apiHost: "ua.jooble.org"` (the Ukrainian market, every vacancy applyable from Ukraine), so register the key there. Searches are `{ keywords, location }` pairs in `jobs.config.json`: `''` = all of Ukraine, `"віддалено"` = remote only, or a city. Set `jooble.enabled=false` to disable.
- **Work.ua** — *disabled by default (headless returns empty result pages).* Public jobs board (`work.ua`), Cloudflare-gated, read through the shared Playwright browser during `HEADFUL=1` full runs (no login). Each search is a full jobs-search URL (e.g. `https://www.work.ua/jobs-qa+automation/`). Set `workua.enabled=true` to enable.
- **Robota.ua** — *disabled by default (Cloudflare hard-blocks headless Chrome).* Only yields results on `HEADFUL=1` runs (otherwise it is skipped with a log hint). Fetched through the same Playwright browser as LinkedIn, no login needed. Each search is a full search URL (e.g. `https://robota.ua/zapros/qa-automation/ukraine`). Set `robota.enabled=true` to enable.
- **Glassdoor** — *disabled by default (headless runs time out on the results page).* Cloudflare-gated, read through the shared Playwright browser during `HEADFUL=1` full runs (no login). Each search is a keyword string (location fixed to Ukraine); clicking a card loads the full description. Set `glassdoor.enabled=true` to enable.
- **LinkedIn Jobs** — scrapes search results (⚠️ ToS-restricted, more detectable). Set `linkedin.enabled=false` to disable.
- **Foreign-location filter** — boards also list vacancies physically located
  abroad (DOU marks them "за кордоном"; Jooble UA carries "Краків, Польща").
  Jobs whose location contains any substring from the top-level
  `excludeLocation` list in `jobs.config.json` (case-insensitive) are dropped
  across **all** sources before scoring.
- Cold applications pass a keyword pre-gate — `minScore` (default 18) + `requireRole` — and then the LLM gate (`llm.minScore`, 70), which does the real screening. A remote listing is never dropped by `excludeLocation` for also naming a foreign office.
- **Cross-source de-dup** — the same vacancy arriving from several sources (its URL
  differs per board) is collapsed into one record before scoring. The record with
  the fullest description is kept; the other source links are recorded under
  `alt_links` in the package and shown as an "also on:" row on the dashboard.
- `jobs-seen.json` prevents re-preparing the same vacancy. It is keyed by
  **identity** (`normalize(company) + normalize(title)`), so a job is remembered
  regardless of which source it came from. Entries carry a last-seen date and
  expire after 90 days, so the file stops growing forever. Legacy URL-keyed
  files migrate automatically on the next run (the old history is reset once).
- Only one `jobs.mjs` runs at a time (`jobs-run.lock/`); an overlapping run logs "another jobs.mjs run is active" and exits 0. Browser-profile locks record the holder's pid, so a crashed run is taken over immediately.

## Dashboard — `dashboard.mjs`

```bash
node dashboard.mjs          # rebuild applications/index.html
node dashboard.mjs --open   # rebuild and open it
```

Renders the packages in `applications/` as cards, sorted by score. Per-card
state (status, notes) is keyed by job URL and stored on disk by
the state server (see below), so it survives dashboard
regeneration and browser resets. Opening a job link or expanding its cover
letter marks the card Viewed automatically.

`applications/` is append-only, so the dashboard **collapses duplicate packages
by identity** (`company + title`) at render time, keeping the most recently
generated one. You see each vacancy once even when older packages linger on disk.

### State server, statuses & filters

**State server (`state-server.mjs`)** replaces in-browser localStorage as the
persistence layer. The dashboard is served by a tiny local HTTP server at
`http://127.0.0.1:7777/` (localhost only, never exposed). Clicking the Jobs.app
Dock icon runs `open-dashboard.sh`, which regenerates the dashboard, starts the
server if it is not already running, and opens the browser. Job state (status,
per-card notes, last-visit timestamp) is written to `job-state.json` on disk, so
it survives a browser reset or a full OS restart. If the server is unreachable
the dashboard falls back to `localStorage` and shows an **"offline — not saved
to disk"** badge. Before the first write of each day the store is snapshotted to
`job-state.YYYY-MM-DD.bak` (last 7 kept) — to roll back a bad day, copy a
snapshot over `job-state.json`. The server keeps running across updates; the
Dock-click launcher (`open-dashboard.sh`) compares its start time (`/health`)
with the server sources and restarts it when they are newer, so no manual
`pkill` is needed after pulling a new version.

**Statuses** — the tool is a radar: it finds and prepares, you apply
selectively on the job site, so the dashboard tracks only what it needs to stay
readable. A card is **New** until you open the job or expand its letter, which
marks it **Viewed** automatically; **✗** hides a vacancy that is not for you;
**Closed** is set by the closed-vacancy check below; both drop out of the New
and Viewed views (deselect both tabs to see everything). That is the whole model —
there is no applied/answered/interview pipeline (the few real applications live
in your mailbox, not here). You can attach private notes to any card; they are
saved to disk via the state server. The header shows New / Viewed with live
counts, both selected by default.

![Card expanded — cover letter, private note](docs/card.png)

**Find & freshness** — a search box filters cards by title, company, or skill
keywords; source chips (one per board that has packages on disk) narrow the
list further. Cards that arrived since your last visit are highlighted with a
🆕 badge. Viewed cards you have not touched for 30 days are archived by the
daily closed-check run (see "Clean up stale packages").

![Multi-select filters, source chips and search](docs/filters.png)

**Closed-vacancy check (`closed-check.mjs`)** — a daily launchd job
(`com.eugene.closed-check.plist`, ships as `.example`, 08:30) probes the DOU,
Djinni and LinkedIn vacancies that are still **New** or **Viewed** (plain GET, one per
second, each url at most every 3 days, 150 per run) and marks the ones the board
reports inactive ("вакансія неактивна", LinkedIn's public "No longer accepting
applications") as **Closed**. Closed cards leave the
New and Viewed views (with both tabs deselected they show a muted "· closed" cue) and are never
auto-reopened by clicking them. ✗ cards are left alone. Jooble/Work.ua/Robota.ua/Glassdoor urls are skipped (they answer a plain GET
with a Cloudflare 403). Tune with `CLOSED_MAX` and
`CLOSED_RECHECK_DAYS`; it never posts a banner — closures show up as the muted
"· closed" cue on the dashboard. Install like the weekly report below, with
`com.example.closed-check.plist.example`.

**Weekly report (`report.mjs`)** — one command that sums up the last 7 days:
runs and new vacancies considered, packages written per source, LLM verdicts
(dropped / failed / scored / at ≥70, plus the top match) and the
median per-run yield of every source. `node report.mjs` prints it;
`--notify` also posts a one-line macOS notification, which is what the weekly
launchd job (`com.eugene.jobs-report.plist`, ships as `.example`, Monday
09:00) does. `REPORT_DAYS=14` widens the window. LLM counts come from the run
logs in `logs/`, so they cover only what the log rotation still holds. Install:

```bash
cp com.example.jobs-report.plist.example \
   ~/Library/LaunchAgents/com.eugene.jobs-report.plist   # edit paths inside
launchctl load ~/Library/LaunchAgents/com.eugene.jobs-report.plist
```

## Clean up stale packages — `prune-applications.mjs`

The dashboard hides on-disk duplicates, but you can reclaim the space. This
script keeps the newest package per identity and deletes the rest. It also
moves packages whose vacancy has been **Closed** (see the closed-vacancy check)
for 14+ days, and **Viewed** packages you have not touched for 30+ days, into
`applications/archive/` — nothing reads that folder, so the dashboard sheds
those cards. The daily `closed-check.mjs` run does the same archiving on its
own (`CLOSED_ARCHIVE_DAYS` / `VIEWED_ARCHIVE_DAYS` to tune), drops the
`job-state.json` entries of packages that are no longer live (once they are a
day old), and `run-jobs.sh` deletes archived packages after 180 days.

```bash
node prune-applications.mjs                      # dry run — lists what would be removed / archived
node prune-applications.mjs --apply              # delete the stale duplicates, archive closed 14+ days
node prune-applications.mjs --closed-days 0 --apply   # archive every closed package right now
```

## Adapting to another profession

Nothing in the code knows you are a QA engineer — the profession lives
entirely in config. To hunt, say, developer jobs instead:

1. **Skill profile** — `cp skills.developer.json.example skills.json` (a
   ready TypeScript/Node preset), or edit your own `roles` / `skills` /
   `antiKeywords` / `profile`. The `profile` block is the specialization
   phrase the *fallback* cover letters use (LLM letters derive from your
   resume instead); Cyrillic values sit in genitive position ("досвід в …").
2. **Searches** — point `jobs.config.json` at the new field, e.g. DOU feed
   `https://jobs.dou.ua/vacancies/feeds/?category=Node.js`, Djinni
   `https://djinni.co/jobs/?primary_keyword=Node.js`, Jooble
   `{ "keywords": "node.js developer", "location": "remote" }`, LinkedIn
   `{ "keywords": "TypeScript Node.js developer", "location": "Ukraine", "remote": true }`.
3. **Resume** — replace `resume.txt` (drives LLM scoring and letters).
4. **Attachment** — update `RESUME_PATH` in `run.sh` / `run-jobs.sh`.

The full walkthrough — from a job title like "Senior Fullstack Developer" to a
working config, including seniority handling and the profile-coupled tests —
lives in [docs/specialization.md](docs/specialization.md).

## Tuning relevance — `skills.json`

- `skills` — keyword → weight. Higher weight = stronger match.
- `roles` — titles you'd accept (strong signal).
- `antiKeywords` — phrases that *lower* the score (e.g. "manual testing only").
- `maxSkills` — only the N highest-weight matched skills count toward the score
  (guards against keyword-stuffed postings; default 8).
- `thresholds.relevant` / `.maybe` — score cutoffs for drafting + attaching.
- `profile` — the per-language specialization phrase for fallback cover letters
  (see "Adapting to another profession" above).

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

Every browser script failing at launch with "Executable doesn't exist" (or a
banner "Playwright browser build missing") means the Playwright package was
upgraded but its Chromium build was not: run `npx playwright install chromium`.
Do this after every `playwright` version bump.

A run that took far longer than usual (`search took 3010s` in `logs/`, or an
hourly run exiting with "another jobs.mjs run is active") is usually the Mac
asleep, not a broken scraper: launchd starts jobs during the short maintenance
wakes and they only progress in those windows. Check with
`pmset -g log | grep -E "Sleep|Wake"` before touching selectors. Normal figures:
one LinkedIn search ≈ 40 s, a full run 2–5 min plus ~20 s per three LLM calls.

## Project layout

```
~/linkedin-assistant/
├── check.mjs          inbox → reply drafts
├── jobs.mjs           job discovery → application packages
├── login.mjs          one-time login (LinkedIn by default, `djinni` argument)
├── djinni-check.mjs   Djinni inbox unread count → djinni-notify-state.json
├── dashboard.mjs      HTML dashboard generator
├── state-server.mjs   local HTTP server (127.0.0.1:7777) for job-state persistence
├── report.mjs         weekly digest (Monday launchd job, or run by hand)
├── closed-check.mjs   mark DOU/Djinni/LinkedIn vacancies the board reports inactive as Closed (daily launchd job)
├── open-dashboard.sh  Dock-click helper: regenerate → start server → open browser
├── prune-applications.mjs  remove stale duplicate packages from applications/
├── lib/               logic (scoring, dedup, templates, DOU/Djinni/Jooble/Work.ua/Robota.ua/Glassdoor/LinkedIn sources)
├── skills.json        skill profile + weights
├── jobs.config.json   what and where to search
├── job-state.json     per-card state (status, notes, last-visit) — gitignored
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
| `dashboard.mjs`       | Build the HTML dashboard (Viewed / ✗ / Closed, notes, filters). |
| `state-server.mjs`    | Local HTTP server at 127.0.0.1:7777; persists job state to `job-state.json`. |
| `report.mjs`          | Weekly digest: runs, packages per source, LLM verdicts, source yield. |
| `closed-check.mjs`    | Probe New/Viewed DOU, Djinni and LinkedIn urls; mark board-inactive vacancies Closed. |
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

## Contributing
Issues and pull requests are welcome. `main` is protected: changes land only
through a PR with an approving review from the repository owner — fork, open a
PR, and it will be reviewed.

## Technologies
JavaScript (Node.js) · Playwright · DOU RSS · launchd · Swift/AppKit (icon) ·
no external dependencies beyond Playwright.

## License
[MIT](LICENSE)
