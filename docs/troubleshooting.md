# When it breaks

> **//** Part of [linkedin-assistant](../README.md). Glitches and how to patch them: selectors, sessions, the browser build and slow runs.
>
> 🇺🇦 [Українською](troubleshooting.uk.md)

LinkedIn changes its HTML often. If `check.mjs` finds 0 cards or can't read messages:
1. Run `HEADFUL=1 node check.mjs` and watch.
2. Open DevTools on the messaging page, find the new class names.
3. Update the `SEL` object at the top of `check.mjs`.

Session expired? Jack in again: re-run `node login.mjs`.

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
