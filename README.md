# LinkedIn Job Assistant

> 🇺🇦 Краткое описание (рус.) — техническая документация на английском ниже.

## Назначение
Локальный помощник для поиска работы: отслеживает сообщения рекрутеров в LinkedIn,
ищет вакансии на DOU и LinkedIn, оценивает их по твоему резюме и готовит черновики
ответов/откликов. **Ничего не отправляет автоматически** — финальный клик всегда за тобой.

## Что сделано

**1. Ассистент входящих сообщений**
- Читает непрочитанные сообщения в LinkedIn-inbox
- Оценивает релевантность вакансии по профилю навыков
- Готовит черновик ответа на языке собеседника (🇺🇦/🇷🇺/🇬🇧)
- Помечает, когда приложить резюме

**2. Поиск вакансий**
- **DOU** — через официальные RSS-фиды (легально, без скрейпинга)
- **LinkedIn Jobs** — скрейпинг выдачи (осторожно, раз в день, отключаемо)
- Строгий фильтр для холодных откликов (порог 25 + automation-роль) → только целевые вакансии
- Готовит пакет отклика: сопроводительное письмо + ссылка + путь к резюме

**3. Интерфейс и удобство**
- **HTML-дашборд** — все вакансии одной страницей, сортировка по релевантности, кнопка «копировать письмо»
- **Ярлык 💼 в Dock** — открывает свежий дашборд одним кликом

**4. Автоматизация (launchd)**

| Задание | Частота |
|---------|---------|
| Проверка входящих | каждый час |
| Поиск DOU | каждый час |
| Поиск LinkedIn | раз в день (10:45) |

## Ключевые принципы
- 🔒 **Безопасность:** пароль не хранится (логинишься сам один раз), всё локально, без API-ключей
- 🚫 **Без автоотправки:** скрипт только готовит — ты ревьюишь и откликаешься вручную
- ⚖️ **Минимум риска:** DOU через легальный RSS, LinkedIn-скрейпинг умеренный и отключаемый

## Технологии
JavaScript (Node.js) · Playwright · DOU RSS · launchd · Swift/AppKit (иконка) ·
без внешних зависимостей кроме Playwright

## Структура
```
~/linkedin-assistant/
├── check.mjs          входящие → черновики ответов
├── jobs.mjs           поиск вакансий → пакеты откликов
├── login.mjs          разовый вход в LinkedIn
├── dashboard.mjs      генератор HTML-сводки
├── lib/               логика (оценка, шаблоны, источники DOU/LinkedIn)
├── skills.json        профиль навыков + веса
├── jobs.config.json   что и где искать
├── drafts/            черновики ответов
├── applications/      пакеты откликов + index.html
└── Вакансии.app       ярлык в Dock 💼
```

**Повседневный сценарий:** клик по 💼 в Dock → карточки по релевантности →
«Открыть вакансию» → «Копировать письмо» → откликаешься сам.

---

# LinkedIn Assistant (draft-only) — technical docs

Reads **your own** LinkedIn inbox in a browser session **you** logged into, scores
each new job message against your resume, and writes a ready-to-review **draft reply**
(flagging when to attach your resume). It **never sends anything** and never clicks Send.

> ⚠️ LinkedIn's User Agreement restricts automated access. This tool only *reads* your
> own inbox and *drafts* replies for you — it does not auto-message or scrape others.
> Run it modestly. Use at your own discretion; LinkedIn can still flag automation.

## One-time setup

```bash
cd ~/linkedin-assistant
npm install                      # installs playwright
npx playwright install chromium  # downloads the browser
node login.mjs                   # YOU log in manually (handles 2FA). Never stores your password.
```

`login.mjs` opens a real browser. Log in fully, then press ENTER in the terminal to
save the session into `.browser-profile/`.

## Run a check manually

```bash
node check.mjs              # headless
HEADFUL=1 node check.mjs    # watch it (use this if selectors break)
MAX=5 node check.mjs        # cap unread threads opened this run
```

New drafts land in `drafts/` and you get a macOS notification. Each draft is a markdown
file: their message, a suggested reply, the relevance score, and an attach-resume checkbox.

## Schedule it (3×/day)

```bash
cp com.eugene.linkedin-assistant.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.eugene.linkedin-assistant.plist
```

Unload to stop: `launchctl unload ~/Library/LaunchAgents/com.eugene.linkedin-assistant.plist`

## Job discovery (DOU + LinkedIn) — `jobs.mjs`

Separate from the inbox assistant. Finds *new* vacancies, scores them against your
resume, and writes an **application package** (cover note in the job's language +
resume path) for each strong match into `applications/`. **It never submits anything** —
you review and apply manually.

```bash
node jobs.mjs              # both sources (per jobs.config.json)
DOU_ONLY=1 node jobs.mjs   # skip LinkedIn scraping (RSS only — fully ToS-clean)
HEADFUL=1 node jobs.mjs    # watch the LinkedIn part
```

- **DOU** — official RSS feeds (`jobs.dou.ua`), clean and structured. Edit feeds in `jobs.config.json`.
- **LinkedIn Jobs** — scrapes search results (⚠️ ToS-restricted, more detectable). Set `linkedin.enabled=false` to disable. Edit `searches` keywords/location.
- Cold applications use a **high bar**: `minScore` (default 25) + `requireRole`. Far stricter
  than inbox replies, so you only apply to genuine automation matches — not spray-and-pray.
- `jobs-seen.json` prevents re-preparing the same vacancy.

Tune in `jobs.config.json`: feeds, LinkedIn searches, `minScore`, `requireRole`.

## Tuning relevance

Edit `skills.json`:
- `skills` — keyword → weight. Higher weight = stronger match.
- `roles` — titles you'd accept (strong signal).
- `antiKeywords` — phrases that *lower* the score (e.g. "manual testing only").
- `thresholds.relevant` / `.maybe` — score cutoffs for drafting + attaching.

## When it breaks

LinkedIn changes its HTML often. If `check.mjs` finds 0 cards or can't read messages:
1. Run `HEADFUL=1 node check.mjs` and watch.
2. Open DevTools on the messaging page, find the new class names.
3. Update the `SEL` object at the top of `check.mjs`.

Session expired? Re-run `node login.mjs`.

## What's where

| File | Purpose |
|------|---------|
| `login.mjs` | One-time manual login; persists session. |
| `check.mjs` | Scheduled job: read unread → score → draft. Never sends. |
| `lib/relevance.mjs` | Local scoring (no API key, nothing leaves the machine). |
| `lib/draft.mjs` | Builds the draft reply markdown. |
| `skills.json` | Your skill profile + thresholds. Edit freely. |
| `resume.txt` | Extracted from your .docx (reference). |
| `drafts/` | Output — review and send these manually. |
| `seen.json` | Tracks processed threads (no duplicate drafts). |
