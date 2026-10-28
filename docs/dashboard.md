<h1><img alt="Dashboard — dashboard.mjs" src="headers/dashboard.png" width="960"></h1>

> **//** Part of [linkedin-assistant](../README.md). Your HUD for the job market: every package on one local page, plus the daily closed-vacancy check and the weekly report.
>
> 🇺🇦 [Українською](dashboard.uk.md)

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

On Himalayas and Telegram-channel cards, a green **✓ UKRAINE LISTED** next to the
location means the employer named your country itself (`Remote · Poland,
Ukraine`), not just the whole world. Those roles were picked for your country,
so they are a better bet than a worldwide one. The country is the first
`candidateCountry` entry in `jobs.config.json`. Djinni and DOU cards are not
marked: naming Ukraine is the norm there.

A yellow **AI ?** badge marks a package with no LLM verdict while other cards
have one: the `claude` call failed twice (or the package predates the retry),
so the fit gate never ran and the cover note is the generic keyword template.
Read the posting yourself before applying. Those cards sort below every
LLM-scored one.

### State server, statuses & filters

**State server (`state-server.mjs`)** replaces in-browser localStorage as the
persistence layer. The dashboard is served by a tiny local HTTP server at
`http://127.0.0.1:7777/` (localhost only, never exposed), kept running by the
`state-server` launchd agent. Clicking the Jobs.app Dock icon runs
`open-dashboard.sh`, which regenerates the dashboard and opens the browser (it
finds `node` on `PATH`, in `/opt/homebrew/bin` or `/usr/local/bin`, or under
`~/.nvm`; launchd starts it with a bare `PATH`). Job state (status,
per-card notes, last-visit timestamp) is written to `job-state.json` on disk, so
it survives a browser reset or a full OS restart. If the server is unreachable
the dashboard falls back to `localStorage` and shows an **"offline — not saved
to disk"** badge. Before the first write of each day the store is snapshotted to
`job-state.YYYY-MM-DD.bak` (last 7 kept) — to roll back a bad day, copy a
snapshot over `job-state.json`. After pulling a new version restart the server
with `launchctl kickstart -k gui/$UID/com.<you>.state-server`. `com.<you>.…`
there is the plist's **`Label`**, not its filename — launchctl addresses
services by label, so renaming only the file leaves every agent registered as
`com.example.…` and this command fails.

**Statuses** — the tool is a radar: it finds and prepares, you apply
selectively on the job site, so the dashboard tracks only what it needs to stay
readable. A card is **New** until you open the job or expand its letter, which
marks it **Viewed** automatically; **Closed** is set by the closed-vacancy check
below and drops out of the New
and Viewed views (deselect both tabs to see everything). That is the whole model —
there is no applied/answered/interview pipeline (the few real applications live
in your mailbox, not here). You can attach private notes to any card; they are
saved to disk via the state server. The header shows New / Viewed with live
counts, both selected by default. A third **Borderline** tab appears only while
there are borderline packages — LLM verdicts just under `llm.minScore`, or
packages the LLM failed to judge twice (see [Job discovery](job-discovery.md)).
It is off by default; a borderline card shows under that tab alone, whatever its
status, with a dashed `borderline` tag, and is archived 30 days after it was
written — closed or not (the 14-day rule for closed cards does not apply to it).

![Card expanded in the Night City skin — cover letter, private note](card.png)

**Find & freshness** — a search box filters cards by title, company, or skill
keywords; the source chips (All, plus one per board that has cards in the selected New /
Viewed tabs; a selected chip always stays) narrow the list to a single board. Cards that arrived since your last visit are highlighted with a
**NEW** ribbon. A card's subtitle says when the board posted it ("posted 3 d
ago", from the package's `posted`) and, in the hazard colour, **reposted ×N**
when the board closed an earlier listing of the same vacancy and listed it
again (see [Job discovery](job-discovery.md)). Viewed cards you have not touched for 30 days are archived by the
daily closed-check run (see "Closed-vacancy check (`closed-check.mjs`)" below).

![The Djinni chip and a search query narrowing the list](filters.png)

**Theme** — a cyberpunk "Night City" skin: neon cyan, magenta and signal yellow
on near-black in dark mode, the same hues deepened in light mode. It follows the
system light/dark preference; the **Dark** button pins one or the other (per
browser). Every text/background pair is ≥ 4.5:1 in both modes. Neon halos and
scanlines are dark-mode only; `prefers-reduced-motion` stops the title glitch
and the NEW-ribbon pulse.

![Light theme — the same neon hues, deepened for daylight](dashboard-light.png)

**Closed-vacancy check (`closed-check.mjs`)** — a daily launchd job
(`com.eugene.closed-check.plist`, ships as `.example`, 08:30) probes the DOU,
Djinni and LinkedIn vacancies that are still **New** or **Viewed** (plain GET, one per
second, each url at most every 3 days, 150 per run) and marks the ones the board
reports inactive ("вакансія неактивна", LinkedIn's public "No longer accepting
applications") as **Closed**. Closed cards leave the
New and Viewed views (with both tabs deselected they show a muted "· closed" cue) and are never
auto-reopened by clicking them. Closed packages are moved to
`applications/archive/` after a 14-day grace period, Viewed packages you have not
touched for 30 days go the same way, and nothing reads that folder. `run.sh`
deletes archived packages older than 180 days. It never posts a banner — closures show up as the muted
"· closed" cue on the dashboard. While the state server answers, closures and
prunes go through it (`POST /state`, the same payload a dashboard click sends),
so a click landing mid-run is never overwritten; with the server down the
script writes `job-state.json` directly, as before. Install like the weekly
report below, with `com.example.closed-check.plist.example`.

**Weekly report (`report.mjs`)** — the weekly debrief, one command that sums up the last 7 days:
runs and new vacancies considered, packages written per source, LLM verdicts
(dropped / failed / scored, plus the top match) and the
median per-run yield of every source. `node report.mjs` prints it;
`--notify` also posts a one-line macOS notification and, with
[Telegram alerts](setup.md#phone-alerts-telegram-optional) set up, sends the whole digest to your phone — which is what the weekly
launchd job (`com.eugene.jobs-report.plist`, ships as `.example`, Monday
09:00) does. `REPORT_DAYS=14` widens the window. LLM counts come from the run
logs in `logs/`, so they cover only what the log rotation still holds. Install:

```bash
cp com.example.jobs-report.plist.example \
   ~/Library/LaunchAgents/com.eugene.jobs-report.plist   # edit paths inside
launchctl load ~/Library/LaunchAgents/com.eugene.jobs-report.plist
```
