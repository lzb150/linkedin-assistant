# Browser helper extraction + login script merge

Date: 2026-07-29
Status: approved

## Goal

Remove the last two pieces of duplication left after the previous refactor pass:

1. The `chromium.launchPersistentContext` block (headless flag, viewport,
   anti-automation args) is copy-pasted in 5 files.
2. `login.mjs` and `djinni-login.mjs` are ~90% identical scripts.

Behavior must not change.

## Design

### 1. `lib/browser.mjs`

One export:

```js
// Shared persistent-context launcher. Visible browser when headful (login
// scripts always; scheduled jobs with HEADFUL=1), headless "new" mode otherwise.
export function launchBrowser(profileDir, { headful = HEADFUL } = {}) {
  return chromium.launchPersistentContext(profileDir, {
    headless: !headful,
    viewport: { width: 1280, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      ...(headful ? [] : ["--headless=new", "--no-first-run", "--no-default-browser-check"]),
    ],
  });
}
```

`HEADFUL` is read from `process.env` inside the module. The `headful` option
exists because the login scripts always open a visible window regardless of
`HEADFUL` (they pass `{ headful: true }`). Scheduled callers replace their
inline block with `await launchBrowser(PROFILE)`:

- `check.mjs`
- `jobs.mjs` — the LinkedIn branch currently lazy-imports playwright; it will
  import `launchBrowser` statically instead. Playwright is the repo's only
  (unconditional) dependency and its module-load cost is negligible, so the
  lazy import was an artifact, not a feature.
- `djinni-check.mjs`
- merged `login.mjs`

### 2. Merged `login.mjs`

`node login.mjs [site]` where `site` is `linkedin` (default) or `djinni`.
Default keeps `npm run login` and every existing README mention working.

Internal site table:

```js
const SITES = {
  linkedin: { profile: ".browser-profile", loginUrl: "...", label: "LinkedIn", isLoggedIn },
  djinni:   { profile: ".djinni-profile",  loginUrl: "...", label: "Djinni",   isLoggedIn },
};
```

The login-detection differences are preserved verbatim, including comments:

- LinkedIn: `li_at` cookie present (plus existing fallbacks).
- Djinni: `a[href='/logout']` present and not on `/login` — with the existing
  comment explaining why the `sessionid` cookie is NOT a reliable signal.

Unknown site argument → print usage, exit 1.

`djinni-login.mjs` is deleted.

### 3. Reference updates

`node djinni-login.mjs` → `node login.mjs djinni` in:

- `djinni-check.mjs` (session-expired log + notification, header comment)
- `README.md` (4 mentions)

## Testing

No behavior change intended. Existing suite (`node --test`) must stay green.
Login scripts are interactive; no new tests.

## Out of scope

- Deduplicating `loadSeen` between `check.mjs` and `jobs.mjs` (semantics differ).
- Splitting `dashboard.mjs` (self-contained single-file HTML is a feature).
