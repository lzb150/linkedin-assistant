<h1><img alt="Структура проєкту" src="headers/project-layout.uk.png" width="960"></h1>

> **//** Частина [linkedin-assistant](../README.uk.md). Мапа репозиторію на HUD: який файл за що відповідає.
>
> 🇬🇧 [English version](project-layout.md)

```
~/linkedin-assistant/
├── check.mjs          скринька → чернетки відповідей
├── jobs.mjs           пошук вакансій → пакети для відгуку
├── login.mjs          одноразовий логін (типово LinkedIn, аргумент `djinni`)
├── djinni-check.mjs   кількість непрочитаного на Djinni → djinni-notify-state.json
├── dashboard.mjs      генератор HTML-дашборда
├── state-server.mjs   локальний HTTP-сервер (127.0.0.1:7777) для збереження job-state
├── report.mjs         тижневий звіт (launchd-завдання в понеділок або вручну)
├── make-skills.mjs    згенерувати skills.json з resume.txt (одноразове налаштування)
├── telegram-setup.mjs одноразове налаштування необов'язкових сповіщень у Telegram → telegram.json
├── closed-check.mjs   позначити вакансії DOU/Djinni/LinkedIn, які дошка вважає неактивними, як Closed (щоденне launchd-завдання)
├── open-dashboard.sh  помічник кліку в Dock: перегенерувати → відкрити браузер
├── lib/               логіка (оцінювання, склейка, шаблони, джерела DOU/Djinni/Himalayas/LinkedIn)
├── docs/              ці сторінки, їхні шапки headers/ + картинки README (HTML-джерела і render.mjs у docs/src/)
├── test/              юніт- і black-box тести CLI (`npm test`, без браузера)
├── e2e/               end-to-end тести дашборда в справжньому браузері (`npm run test:e2e`)
├── skills.json        профіль навичок + ваги
├── jobs.config.json   що і де шукати
├── job-state.json     стан карток (статус, нотатки, останній візит) — у gitignore
├── drafts/            чернетки відповідей
├── applications/      пакети для відгуку + index.html
└── Jobs.app           ярлик у Dock 💼
```

## Що де лежить

| Файл                  | Призначення                                               |
|-----------------------|-----------------------------------------------------------|
| `login.mjs`           | Одноразовий ручний логін (типово LinkedIn, `node login.mjs djinni`); зберігає сесію. |
| `check.mjs`           | Прочитати непрочитане → оцінити → чернетка. Ніколи не надсилає. |
| `djinni-check.mjs`    | Порахувати непрочитані треди Djinni. Лише рахує, тредів не відкриває. |
| `jobs.mjs`            | Знайти вакансії → пакети для відгуку. Ніколи не подає.    |
| `dashboard.mjs`       | Зібрати HTML-дашборд (Viewed / Closed, нотатки, фільтри). |
| `state-server.mjs`    | Локальний HTTP-сервер на 127.0.0.1:7777; зберігає стан у `job-state.json`. |
| `report.mjs`          | Тижневий звіт: запуски, пакети за джерелами, вердикти LLM, вихід джерел. |
| `closed-check.mjs`    | Опитати New/Viewed адреси DOU, Djinni і LinkedIn; позначити неактивні вакансії Closed. |
| `open-dashboard.sh`   | Помічник кліку в Dock: перегенерувати дашборд, відкрити браузер. |
| `telegram-setup.mjs`  | Одноразове налаштування необов'язкових сповіщень у Telegram: знаходить ваш чат, записує `telegram.json`. |
| `lib/telegram.mjs`    | Копія сповіщень у Telegram: формат повідомлень, черга `telegram-outbox/`, відправник. |
| `lib/relevance.mjs`   | Локальне оцінювання (без API-ключа, нічого не покидає машину). |
| `lib/dedup.mjs`       | Склейка між джерелами: ключ ідентичності + згортання дублікатів. |
| `lib/draft.mjs`       | Збирає markdown чернетки відповіді.                       |
| `lib/application.mjs` | Збирає markdown пакета для відгуку.                       |
| `skills.json`         | Ваш профіль навичок + пороги. Редагуйте вільно.           |
| `resume.txt`          | Повний текст резюме (оцінка, LLM, листи).                 |
| `drafts/`             | Результат — переглядайте і надсилайте вручну.             |
| `seen.json`           | Оброблені повідомлення (тред + найновіше повідомлення), тож відповідь у відомому треді обробляється знову. |
| `jobs-seen.json`      | Оброблені вакансії за ідентичністю (без повторних пакетів, крізь джерела). |

## Тести

```bash
npm test                          # юніт- і black-box тести CLI (node --test, без браузера)
npm run lint                      # oxlint
npx playwright install chromium   # один раз на машину, для e2e-набору
npm run test:e2e                  # end-to-end тести дашборда (Playwright, Chromium)
```

`e2e/` проганяє дашборд у справжньому браузері: вкладки New / Viewed, чипи
джерел, кнопки статусу, нотатки, Copy letter, перемикач Dark, бейдж offline,
стрічку NEW і стани «порожньо» / «нічого не знайдено». Глобальне налаштування збирає сторінку
справжнім `dashboard.mjs` із пакетів-фікстур (`e2e/support/jobs.mjs`) у
тимчасовій теці, а кожен тест отримує власний екземпляр `createServer` на
випадковому loopback-порту зі свіжим `job-state.json`; браузер може дістатися
лише до цього сервера. Набір ніколи не
звертається до живого сервера на `:7777` і не читає й не пише ваш
`job-state.json` чи `applications/`. Він лежить поза `test/`, бо голий
`node --test` запускає кожен файл звідти. CI запускає його в окремому job
`e2e` (Ubuntu, Node 20 і 24).
