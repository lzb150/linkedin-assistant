<div align="center">

<img alt="linkedin-assistant — локальний радар вакансій: шукає, оцінює й готує чернетки, але нічого не надсилає" src="docs/banner.uk.png" width="960">

<br>

[![Джерела](https://img.shields.io/badge/%D0%B4%D0%B6%D0%B5%D1%80%D0%B5%D0%BB%D0%B0-DOU_%C2%B7_Djinni_%C2%B7_LinkedIn-00f0ff?style=for-the-badge&labelColor=0b0a16)](docs/job-discovery.uk.md)
[![Дані](https://img.shields.io/badge/%D0%B4%D0%B0%D0%BD%D1%96-%D0%BB%D0%B8%D1%88%D0%B5_%D0%BB%D0%BE%D0%BA%D0%B0%D0%BB%D1%8C%D0%BD%D0%BE-05ffa1?style=for-the-badge&labelColor=0b0a16)](#ключові-принципи)
[![Автовідправка](https://img.shields.io/badge/%D0%B0%D0%B2%D1%82%D0%BE%D0%B2%D1%96%D0%B4%D0%BF%D1%80%D0%B0%D0%B2%D0%BA%D0%B0-%D0%BD%D1%96%D0%BA%D0%BE%D0%BB%D0%B8-ff2a6d?style=for-the-badge&labelColor=0b0a16)](#ключові-принципи)
[![macOS](https://img.shields.io/badge/macOS-launchd-fcee0a?style=for-the-badge&labelColor=0b0a16)](docs/setup.uk.md#розклад-launchd)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-ff9e00?style=for-the-badge&labelColor=0b0a16)](#швидкий-старт)
[![Ліцензія](https://img.shields.io/badge/%D0%BB%D1%96%D1%86%D0%B5%D0%BD%D0%B7%D1%96%D1%8F-MIT-45406b?style=for-the-badge&labelColor=0b0a16)](LICENSE)

`//` [Що вміє](#що-вміє) · [Швидкий старт](#швидкий-старт) · [Документація](#документація) · [Пошук](docs/job-discovery.uk.md) · [Дашборд](docs/dashboard.uk.md) · [Інша професія](docs/specialization.uk.md) `//`

</div>

> 🇬🇧 [English version](README.md)

Ваш нетраннер на ринку праці. Він тихо працює на вашому Mac: стежить за
повідомленнями рекрутерів у скриньці LinkedIn, прочісує DOU, Djinni та
LinkedIn, міряє кожну вакансію вашим резюме і готує чернетки відповідей та
відгуків, готові до перегляду. **Сам нічого не надсилає** — останній клік
завжди за вами.

![Дашборд у скіні Night City — підібрані вакансії, відсортовані за релевантністю, з лічильниками статусів і фільтрами](docs/dashboard.png)

> ⚠️ **Правила корпорації.** Угода користувача LinkedIn обмежує
> автоматизований доступ. Цей інструмент лише *читає* вашу власну скриньку і
> *готує чернетки* відповідей — він не розсилає повідомлення і не скрейпить
> чужі дані. Запускайте помірно. Використовуйте на власний розсуд: LinkedIn
> усе одно може розцінити це як автоматизацію.

## Що вміє

**`01` Скринька** — читає непрочитані повідомлення LinkedIn, оцінює кожне за
вашим профілем навичок і готує чернетку відповіді мовою відправника
(🇺🇦/🇷🇺/🇬🇧), підказуючи, коли додати резюме. Непрочитані треди Djinni
світяться на тому самому бейджі в Dock.

**`02` Пошук вакансій** — бере нові вакансії з DOU (RSS), Djinni (публічна
дошка) і LinkedIn Jobs (пошук, можна вимкнути), склеює одну вакансію з кількох
дощок і відкидає вакансії за кордоном. Кожна вакансія проходить два фільтри:
keyword-бали з вашого профілю (≥ 18 і відповідна роль), потім локальна оцінка
`claude -p` за вашим резюме (≥ 70). Збіг стає пакетом для відгуку:
супровідний лист під вакансію, посилання і шлях до резюме.

<details>
<summary>Як вакансія отримує оцінку, фільтр за фільтром, із прикладами</summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/scoring-dark.uk.png">
  <img alt="Схема оцінювання: фільтр локації, keyword gate (minScore 18 + роль), LLM gate (llm.minScore 70), приклади" src="docs/scoring-light.uk.png" width="800">
</picture>

</details>

**`03` Дашборд** — усі пакети на одній локальній сторінці в неоновому скіні
Night City (світла й темна теми): за релевантністю, з вкладками New/Viewed,
приватними нотатками, пошуком і фільтром за джерелом. Вакансії, які дошка
закрила, щодня позначаються як Closed.

**`04` Працює сам** — агенти launchd щогодини перевіряють скриньки та
DOU/Djinni, а LinkedIn кожні 3 години. Прогін показує один банер macOS, і лише
коли щось знайшов або щось зламалося.

## Ключові принципи
- 🔒 **Безпека:** пароль ніде не зберігається (логінитесь один раз самі), все локально; жодних API-ключів
- 🚫 **Жодної автовідправки:** скрипти лише готують — переглядаєте і відгукуєтесь ви
- ⚖️ **Мінімальний ризик:** DOU через легальний RSS, скрейпінг LinkedIn помірний і вимикається

## Швидкий старт

macOS і Node.js 20+. Підключення — вісім рядків:

```bash
git clone https://github.com/lzb150/linkedin-assistant.git ~/linkedin-assistant
cd ~/linkedin-assistant
npm install && npx playwright install chromium
cp ~/path/to/your-resume.txt resume.txt   # звичайний текст
node make-skills.mjs                      # skills.json: що шукати
$EDITOR jobs.config.json                  # де шукати і ваша країна
node login.mjs                            # логінитесь самі один раз; пароль не зберігається
node jobs.mjs && node dashboard.mjs --open
```

Далі — розклад: [docs/setup.uk.md](docs/setup.uk.md).

## Документація

| Сторінка | Що там |
|----------|--------|
| [Налаштування](docs/setup.uk.md) | Встановлення, перший запуск, агенти launchd, LinkedIn на сплячому Mac |
| [Асистент скриньки](docs/inbox.uk.md) | `check.mjs`, чернетки відповідей, бейдж у Dock, скринька Djinni й автопідняття профілю |
| [Пошук вакансій](docs/job-discovery.uk.md) | Джерела, фільтри, обидва фільтри оцінки, захист LLM, здоров'я джерел, `skills.json` |
| [Дашборд](docs/dashboard.uk.md) | Сервер стану, статуси, фільтри, перевірка закритих вакансій, тижневий звіт |
| [Ваша спеціалізація](docs/specialization.uk.md) | Як перевести з QA на будь-яку професію |
| [Коли щось ламається](docs/troubleshooting.uk.md) | Селектори, сесія, відсутній Chromium, повільні прогони |
| [Структура проєкту](docs/project-layout.uk.md) | Який файл за що відповідає |

## Внесок у проєкт
Issues та pull requests вітаються. Гілка `main` захищена: зміни потрапляють
лише через PR зі схвальним ревю власника репозиторію — зробіть fork,
відкрийте PR, і його буде розглянуто.

## Технології
JavaScript (Node.js) · Playwright · DOU RSS · launchd · Swift/AppKit (неонова
іконка в Dock) · жодних зовнішніх залежностей, крім Playwright. Картинки цього
README малюються з HTML у [docs/src](docs/src/render.mjs).

## Ліцензія
[MIT](LICENSE)
