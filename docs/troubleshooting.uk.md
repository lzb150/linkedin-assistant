<h1><img alt="Коли щось ламається" src="headers/troubleshooting.uk.png" width="960"></h1>

> **//** Частина [linkedin-assistant](../README.uk.md). Глюки і як їх латати: селектори, сесії, збірка браузера і повільні прогони.
>
> 🇬🇧 [English version](troubleshooting.md)

LinkedIn часто змінює свій HTML. Якщо `check.mjs` знаходить 0 карток або не
може прочитати повідомлення:
1. Запустіть `HEADFUL=1 node check.mjs` і подивіться.
2. Відкрийте DevTools на сторінці повідомлень, знайдіть нові назви класів.
3. Оновіть об'єкт `SEL` на початку `check.mjs`.

Сесія закінчилась? Підключіться знову: перезапустіть `node login.mjs`.

Відсутня збірка Chromium (пакет Playwright оновили, а браузер ні, або хтось
стер `~/Library/Caches/ms-playwright`) лікується сама: перший браузерний
скрипт, що впав з «Executable doesn't exist», пише в лог `installing
chromium…`, скачує збірку (~100 МБ, до 5 хвилин) і стартує повторно.
`npx playwright install chromium` руками потрібен лише коли той запуск
завершився банером «Playwright browser build missing … (install failed: …)» —
не було мережі або Mac заснув під час завантаження.

Запуск, що тривав набагато довше звичайного (`search took 3010s` у `logs/`
або щогодинний запуск, що вийшов з «another jobs.mjs run is active»), —
зазвичай Mac спав, а не зламався скрейпер: launchd стартує завдання під час
коротких сервісних пробуджень, і вони просуваються лише в ці вікна. Перевірте
`pmset -g log | grep -E "Sleep|Wake"`, перш ніж чіпати селектори. Нормальні
цифри: один пошук LinkedIn ≈ 40 с, повний запуск 2–5 хв плюс ~20 с на кожні
три виклики LLM.

Банер `<job>: no successful run for N h while M other runs finished — is its
launchd job loaded?` — це сторож (`last-success.json`, див. docs/setup.uk.md →
«Розклад»): це завдання давно не завершувалось чисто, тоді як сусідні
працювали. `launchctl list | grep <label>` показує, чи воно завантажене, і
останній код виходу; `logs/<job>.err.log` каже, чому воно впало (класика —
шлях до node, який видалив `nvm`). Щоденне сповіщення про `jobs-dou` на Mac,
де щогодинного plist-а `job-discovery-dou` ніколи не було, — залишок: до
2026-10-28 повний запуск ставив цю позначку, а тепер ні, тож один раз видаліть
запис `jobs-dou` із `last-success.json` (сторож чекає лише на завдання, які
вже ставили позначку). Власний лог демона бейджа в Dock —
`logs/jobs-badge.app-err.log` (рядки `jobs:`: зміни бейджа, кліки в Dock,
падіння); `logs/jobs-badge.err.log` містить лише помилки `open(1)`.
