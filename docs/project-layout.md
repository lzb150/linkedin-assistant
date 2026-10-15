# Project layout

> Part of [linkedin-assistant](../README.md). Which file does what.

```
~/linkedin-assistant/
├── check.mjs          inbox → reply drafts
├── jobs.mjs           job discovery → application packages
├── login.mjs          one-time login (LinkedIn by default, `djinni` argument)
├── djinni-check.mjs   Djinni inbox unread count → djinni-notify-state.json
├── dashboard.mjs      HTML dashboard generator
├── state-server.mjs   local HTTP server (127.0.0.1:7777) for job-state persistence
├── report.mjs         weekly digest (Monday launchd job, or run by hand)
├── make-skills.mjs    generate skills.json from resume.txt (one-time setup)
├── closed-check.mjs   mark DOU/Djinni/LinkedIn vacancies the board reports inactive as Closed (daily launchd job)
├── open-dashboard.sh  Dock-click helper: regenerate → open browser
├── lib/               logic (scoring, dedup, templates, DOU/Djinni/LinkedIn sources)
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
| `dashboard.mjs`       | Build the HTML dashboard (Viewed / Closed, notes, filters). |
| `state-server.mjs`    | Local HTTP server at 127.0.0.1:7777; persists job state to `job-state.json`. |
| `report.mjs`          | Weekly digest: runs, packages per source, LLM verdicts, source yield. |
| `closed-check.mjs`    | Probe New/Viewed DOU, Djinni and LinkedIn urls; mark board-inactive vacancies Closed. |
| `open-dashboard.sh`   | Dock-click helper: regenerate dashboard, open browser. |
| `lib/relevance.mjs`   | Local scoring (no API key, nothing leaves the machine).   |
| `lib/dedup.mjs`       | Cross-source de-dup: identity key + collapse duplicates.  |
| `lib/draft.mjs`       | Builds the reply-draft markdown.                          |
| `lib/application.mjs` | Builds the application-package markdown.                  |
| `skills.json`         | Your skill profile + thresholds. Edit freely.             |
| `resume.txt`          | Your full resume as plain text (scoring, LLM, letters).   |
| `drafts/`             | Output — review and send these manually.                  |
| `seen.json`           | Tracks processed messages (thread + newest message), so a follow-up in a known thread is processed again. |
| `jobs-seen.json`      | Tracks processed vacancies by identity (no duplicate packages, across sources). |
