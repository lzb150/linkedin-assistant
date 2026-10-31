<h1><img alt="When it breaks" src="headers/troubleshooting.png" width="960"></h1>

> **//** Part of [linkedin-assistant](../README.md). Glitches and how to patch them: selectors, sessions, the browser build and slow runs.
>
> 🇺🇦 [Українською](troubleshooting.uk.md)

LinkedIn changes its HTML often. If `check.mjs` finds 0 cards or can't read messages:
1. Run `HEADFUL=1 node check.mjs` and watch.
2. Open DevTools on the messaging page, find the new class names.
3. Update the `SEL` object at the top of `check.mjs`.

Session expired? Jack in again: re-run `node login.mjs`.

`LinkedIn rate-limited (HTTP 429)` in a run's log is LinkedIn throttling a burst
of searches: the page comes back blank. The run waits 90 s and retries that
search once; a retry that is throttled too logs `still rate-limited` and the
next run picks the search up. Nothing to fix unless it shows up on every run.

A missing Chromium build (the Playwright package was upgraded but its browser
was not, or `~/Library/Caches/ms-playwright` was wiped) repairs itself: the
first browser script to hit "Executable doesn't exist" logs `installing
chromium…`, downloads the build (~100 MB, up to 5 minutes) and relaunches.
Run `npx playwright install chromium` by hand only when that run ends with a
"Playwright browser build missing … (install failed: …)" banner — no network,
or the Mac slept through the download.

A run that took far longer than usual (`search took 3010s` in `logs/`, or an
hourly run exiting with "another jobs.mjs run is active") is usually the Mac
asleep, not a broken scraper: launchd starts jobs during the short maintenance
wakes and they only progress in those windows. Check with
`pmset -g log | grep -E "Sleep|Wake"` before touching selectors. Normal figures:
one LinkedIn search ≈ 40 s, a full run 2–5 min plus ~20 s per three LLM calls.

A banner saying `<job>: no successful run for N h while M other runs finished
— is its launchd job loaded?` is the watchdog (`last-success.json`, see
docs/setup.md → "Schedule it"): that job has not finished cleanly for a long
time while its siblings kept running. `launchctl list | grep <label>` shows
whether it is loaded and its last exit code; `logs/<job>.err.log` says why it
died (a node path `nvm` removed is the classic). A daily `jobs-dou` alert on a
Mac that never had the hourly `job-discovery-dou` plist is a leftover: the full
run stamped that id before 2026-10-28 and no longer does, so delete the
`jobs-dou` entry from `last-success.json` once (the watchdog only expects jobs
that have stamped). The Dock badge daemon's own
log is `logs/jobs-badge.app-err.log` (`jobs:` lines: badge changes, Dock
clicks, crashes); `logs/jobs-badge.err.log` only ever holds `open(1)` errors.
