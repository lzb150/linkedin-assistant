<h1><img alt="Як задати свою спеціалізацію" src="headers/specialization.uk.png" width="960"></h1>

> **//** Частина [linkedin-assistant](../README.uk.md). Заміна хрому: як перетворити назву посади на зразок **Senior Fullstack Developer** на конфіг, з яким асистент шукатиме вакансії.
>
> 🇬🇧 [English version](specialization.md)

Код нічого не знає про вашу професію — вона живе у чотирьох місцях.

## Коротко

Код нічого не знає про QA — професія повністю живе в конфігурації. Щоб
шукати, наприклад, вакансії розробника:

1. **Профіль навичок** — покладіть своє резюме в `resume.txt` і виконайте
   `node make-skills.mjs`: він складе `skills.json` із нього тим самим
   локальним `claude` CLI, що й скринер, разом з українськими написаннями,
   якими послуговуються місцеві дошки. `--print` покаже результат, нічого не
   записуючи, `--force` перезапише наявний файл; `--resume <файл>`, `--out <файл>` і
   `--model <псевдонім>` задають інший вхід, вихід чи модель `claude` (невідомий
   прапорець відхиляється). Хочете почати з пресета чи
   написати вручну? `cp skills.developer.json.example skills.json` (готовий
   профіль TypeScript/Node), далі налаштуйте `roles` / `skills` /
   `antiKeywords` / `profile`. У будь-якому разі прочитайте результат — це
   перший фільтр, крізь який проходить кожна вакансія. Блок `profile` — це
   фраза спеціалізації для *резервних* супровідних листів (LLM-листи
   будуються з резюме); кириличні значення стоять у місцевому відмінку
   ("досвід в …").
2. **Пошуки** — перенаправте `jobs.config.json` на нову сферу, напр. DOU-фід
   `https://jobs.dou.ua/vacancies/feeds/?category=Node.js`, Djinni
   `https://djinni.co/jobs/?primary_keyword=Node.js`, Himalayas `"Node.js developer"`, LinkedIn
   `{ "keywords": "TypeScript Node.js developer", "location": "Ukraine", "remote": true }`.
3. **Резюме** — замініть `resume.txt` (керує LLM-оцінкою, листами й
   `make-skills.mjs` вище).
4. **Вкладення** — оновіть `RESUME_PATH` у `run.sh`.

Решта сторінки — повний покроковий гайд.

## Де живе ваша спеціалізація

| Файл | Що містить | У git? |
|------|------------|--------|
| `skills.json` | Профіль оцінювання: `roles`, `skills`, `synonyms`, `antiKeywords`, `profile` | так |
| `jobs.config.json` | Де шукати: стрічки й запити для кожного джерела | так |
| `resume.txt` | Резюме звичайним текстом — основа для LLM-оцінки й супровідних листів | ні (gitignored) |
| `run.sh` | `RESUME_PATH` — PDF/DOCX, що додається до чернеток; `CANDIDATE_NAME` — підпис у супровідних листах | ні (gitignored) |

## Від назви посади до конфіга

Наскрізний приклад: **Senior Fullstack Developer** (TypeScript / Node.js / React).

### 1. Ролі — посади, які ви розглядаєте

Перелічіть усі варіанти назви в `skills.json` → `roles`, малими літерами.
Збіг шукається як підрядок із межами слів, тож `"fullstack developer"` уже
збігається з «Senior Fullstack Developer» — окремий запис для кожного рівня
сеньйорності не потрібен. Додайте українські й російські варіанти в називному
відмінку; кирилиця порівнюється за основою (`lib/relevance.mjs`), тож
`"фулстек розробник"` збігається й із «фулстек розробника» у вакансіях.

Знайдена роль додає бонус **+6**, а з `requireRole: true` у
`jobs.config.json` вакансії, в тексті яких немає жодної ролі, пропускаються
повністю.

```json
"roles": [
  "fullstack developer", "full stack developer", "fullstack engineer", "full stack engineer",
  "software engineer", "typescript developer", "node.js developer", "react developer",
  "фулстек розробник", "розробник програмного забезпечення", "програміст",
  "фулстек разработчик", "разработчик программного обеспечения", "программист"
]
```

### 2. Навички — зважені ключові слова

Це ваш хром: беріть навички з резюме, а не з вакансій. Шкала ваг: **5** — основне (за це вас
наймають), **3–4** — сильне додаткове, **1–2** — бажане. До суми йдуть лише
`maxSkills` (типово 8) найважчих збігів, тож поставити всім 5 не допоможе —
це лише розмиє ранжування.

```json
"skills": {
  "typescript": 5, "node.js": 5, "react": 5,
  "next.js": 4, "nestjs": 4, "rest": 4, "microservices": 4,
  "postgresql": 3, "graphql": 3, "docker": 3, "ci/cd": 3, "aws": 3,
  "redis": 2, "jest": 2, "kubernetes": 2, "git": 1
}
```

Додайте `synonyms` для навичок-понять, які у вакансіях пишуть українською чи
російською (`"microservices": ["мікросервіси", "микросервисы"]`). Латинським
технічним термінам (typescript, react) синоніми не потрібні — у кириличному
тексті вони лишаються латиницею.

### 3. antiKeywords — неприйнятне

Фрази, що *знижують* бал. Використовуйте їх для стеків чи умов, на які ви не
підете, а не для легких уподобань:

```json
"antiKeywords": {
  "wordpress": -3, "unpaid": -6, "internship": -3,
  "relocation required": -1, "on-site only": -1
}
```

### 4. profile — фраза для запасного листа

Фраза про спеціалізацію для кожної мови, яку використовують лише *запасні*
супровідні листи (листи від LLM спираються на `resume.txt`). Кириличні
значення стоять у місцевому відмінку — вони завершують «досвід в …» /
«опыт в …»:

```json
"profile": {
  "en": "full-stack development (TypeScript, Node.js, React)",
  "uk": "фулстек розробці (TypeScript, Node.js, React)",
  "ru": "фулстек-разработке (TypeScript, Node.js, React)"
}
```

### 5. Пошук — `jobs.config.json`

Переведіть на нову сферу **кожне** увімкнене джерело — їх чотири (`dou`,
`djinni`, `himalayas`, `linkedin`); джерело зі старими запитами далі тягне вакансії старої
професії. Копіюйте справжні URL із фільтрів у браузері — так параметри
лишаються правильними:

```json
"dou":      { "feeds": ["https://jobs.dou.ua/vacancies/feeds/?search=fullstack"] },
"djinni":   { "searches": ["https://djinni.co/jobs/?primary_keyword=Fullstack"] },
"himalayas": { "searches": ["Fullstack TypeScript", "Node.js developer"] },
"linkedin": { "searches": [{ "keywords": "Fullstack TypeScript React", "location": "Ukraine", "remote": true }] }
```

Загальний `minScore` (18) — лише попередній keyword-фільтр; справжній відбір
робить LLM-фільтр (`llm.minScore`, 70).

### 5b. Країна — `candidateCountry`

Де кандидат живе і звідки працює віддалено, в усіх написаннях, які
використовують дошки (типово `["Ukraine", "Україна"]`). Сегмент країн на Djinni
має містити одне з них або весь світ; пошуки Himalayas фільтруються за першим
написанням, тож ставте першою англійську назву; LLM-фільтр ставить вакансії, закритій для
цієї країни, не більше 10. Людина в Польщі задає
`["Poland", "Польща", "Країни ЄС"]` і прибирає `"Poland"`/`"Польща"` з
`excludeLocation`.

### 6. Резюме

Замініть `resume.txt` своїм резюме звичайним текстом (воно керує
LLM-оцінкою й листами), а в `run.sh` вкажіть у `RESUME_PATH` PDF/DOCX для
вкладення і в `CANDIDATE_NAME` ім'я для підпису листів. Усі три файли в
gitignore.

## Сеньйорність

- `excludeTitle` у `jobs.config.json` відкидає заголовки зі словами
  `junior` / `intern` / `internship` / `trainee` / `manual` ще до оцінки —
  цілими словами, лише в заголовку.
- Позитивного фільтра «лише senior» немає: бал залежить від навичок, а
  заголовки senior-посад і так збігаються з вашими ролями як підрядки.
- Потрібні лише senior+ посади? Тримайте `excludeTitle` суворим і підніміть
  `minScore`.

## Готовий пресет

`skills.developer.json.example` — готовий профіль backend/full-stack
TS-Node: `cp skills.developer.json.example skills.json`, потім підлаштуйте
ваги під своє резюме.

## Чекліст

1. `skills.json` — оновлено roles, skills, synonyms, antiKeywords, profile.
2. `jobs.config.json` — запити переведено для **кожного увімкненого**
   джерела; `excludeTitle` досі підходить.
3. `resume.txt` замінено; `RESUME_PATH` і `CANDIDATE_NAME` оновлено в
   `run.sh`.
4. Перевірка: `npm test` (тести працюють на замороженому профілі-фікстурі,
   тож лишаються зеленими незалежно від вашого `skills.json`), потім підключіться
   одним запуском `node jobs.mjs` — найновіший файл в `applications/` має читатися як
   ваша нова спеціалізація.
