# Specialization Documentation — Design

**Goal:** A standalone guide, `docs/specialization.md`, explaining how to express your
specialization (e.g. "senior fullstack developer") in the assistant's config, plus
cross-links from README.md and a mirrored short section in README.uk.md.

**Why:** The README's "Adapting to another profession" section (line 239) is a terse
4-point list. Users switching professions need the full path from a job title to a
working config — including seniority handling and the profile-coupled tests gotcha —
without reverse-engineering `skills.json` comments.

## Deliverables

1. **`docs/specialization.md`** (English, ~150 lines) — task-oriented guide,
   structured "from a job title to config", with "Senior Fullstack Developer"
   as the running example:
   - **Where your specialization lives** — table of the 4 touchpoints:
     `skills.json` (roles / skills / synonyms / antiKeywords / profile),
     `jobs.config.json` (per-source searches), `resume.txt` (grounds LLM scoring
     and cover letters), `RESUME_PATH` in `run.sh`/`run-jobs.sh` (attachment).
   - **From a job title to config** — steps: role title variants incl. UA/RU
     translations; skill weights (5 = core, 3 = secondary, 1 = nice-to-have) and
     the `maxSkills` cap; `antiKeywords` for deal-breakers; `profile` phrases in
     genitive position for fallback letters; search URLs per source (DOU feed,
     Djinni, Jooble, LinkedIn) with copy-from-browser advice.
   - **Seniority** — `excludeTitle` drops junior/intern/trainee titles;
     "senior …" variants belong in `roles`; substring matching means
     "fullstack developer" already matches "Senior Fullstack Developer";
     there is no senior-only filter — scoring is skill-based.
   - **Worked example** — complete `skills.json` for a senior fullstack (TS/Node/React)
     profile and the four search arrays; points at `skills.developer.json.example`
     as the starting preset.
   - **Checklist & verification** — `node --test test/`, one `node jobs.mjs` run,
     inspect newest `applications/` draft; warning that `test/relevance.test.mjs`
     `scoreMessage` tests pin scores of the active profile and must be updated in
     the same commit as `skills.json`.
2. **README.md** — one sentence + link to the guide appended to
   "Adapting to another profession".
3. **README.uk.md** — short mirrored subsection "Як вказати свою спеціалізацію"
   under "Адаптація під іншу професію" (line 252), linking to the English guide.

## Non-goals

- No new preset files (`skills.fullstack.json.example` etc.) — the guide's worked
  example plus the existing `skills.developer.json.example` cover it.
- No changes to code, configs, or tests.
- No Russian version (repo rule: docs in English; only README.uk.md is Ukrainian).

## Constraints / facts the guide must state correctly

- Global `minScore` 25 (`jobs.config.json`), Jooble per-source override 18.
- Role match bonus is 6; default `maxSkills` cap is 8; `thresholds` relevant 8 / maybe 4.
- `excludeTitle` matches whole words in the title only, before scoring.
- Cyrillic role/skill matching is stem-based (`lib/relevance.mjs`), so nominative
  forms in config match declensions in postings.
- `resume.txt`, `run.sh`, `run-jobs.sh` are gitignored — edited, never committed.
- `profile.uk`/`profile.ru` sit in genitive position ("досвід в …" / "опыт в …").

## Testing

Docs-only change: verify README link anchors resolve and the worked-example JSON
parses (`node -e "JSON.parse(...)"` on the extracted snippet during review).
