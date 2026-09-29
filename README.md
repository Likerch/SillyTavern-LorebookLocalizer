# Lorebook Localizer

Расширение для [SillyTavern](https://github.com/SillyTavern/SillyTavern). Оно переводит ключи лорбуков (World Info) с помощью LLM и добавляет к ним regex-ключи, которые ловят **все словоформы**: падежи, число, формы прилагательных. Английский лорбук начинает срабатывать в русском RP. Всё делается одной кнопкой и сразу для нескольких лорбуков.

*English summary below.*

## Зачем regex

- Английский ключ `Hermione` никогда не сработает на тексте «…сказала Гермионе».
- Обычный русский ключ `Гермиона` не поймает остальные падежи.
- Галочка «Только полное совпадение» в ST на кириллице не работает: `\W` в JS считает русские буквы «не-словом». Из-за этого ключ `Рон` срабатывает внутри «корона».

Поэтому расширение просит у модели **список словоформ**, а regex собирает само и проверяет:

```
Hermione → Гермиона, Гермионы, Гермионе, Гермиону, Гермионой, Гермионою
         → /(?<![\p{L}\p{N}])г[её]рмион(?:ой|ою|а|ы|[её]|у)(?![\p{L}\p{N}])/iu
```

- Границы слова в Unicode-виде, поэтому «корона» не совпадёт с «Рон».
- Регистр не важен, ё и е взаимозаменяемы, пробелы в словосочетаниях гибкие.
- Каждый regex проверяется: его должен принимать парсер ST, и он должен находить все свои формы.

## Установка

1. SillyTavern → **Extensions** (кубики) → **Install extension**.
2. Вставить ссылку на репозиторий: `https://github.com/Likerch/SillyTavern-LorebookLocalizer.git`.
3. Открыть панель **«Миры и лорбуки»**: рядом с кнопкой «Дублировать» появится иконка языка (`fa-language`).

Проверено на SillyTavern 1.19.0.

## Как пользоваться

1. Нажать иконку перевода в панели лорбуков (или **Extensions → Lorebook Localizer → Открыть**).
2. Отметить лорбуки: есть поиск и кнопки «Выбрать все» / «Снять все». Открытый в редакторе лорбук отмечен заранее.
3. Выбрать **язык** и **подключение**:
   - «Текущее подключение» — запросы идут через активный API, строго по одному.
   - **Профиль Connection Manager** — можно взять дешёвую быструю модель и слать несколько запросов параллельно. Активное подключение при этом не переключается, RP-пресет профиля не применяется.
4. Нажать **«Локализовать»**. Кнопка «Стоп» прерывает работу, уже готовая часть сохраняется для просмотра.
5. В **предпросмотре** снять лишнее или поправить ключи. Наведите курсор на перевод, чтобы увидеть словоформы. Нажать **«Применить»**.

### Что отправляется модели

- Ключи записи.
- Опционально — название записи и первые N символов содержимого, чтобы модель отличала имя «Rose» от цветка.
- Модель возвращает до N вариантов перевода: у фандомов бывает несколько устоявшихся переводов (Snape → Снейп / Снегг). Каждый вариант становится отдельным ключом.

### Что пропускается

- Ключи, которые уже являются regex.
- Ключи, которые уже на целевом языке (для кириллицы, японского, китайского, корейского).
- Ключи, которые расширение добавило само.
- Ключи, переведённые на этот язык при прошлом запуске. Повторный запуск переводит только новые ключи, а галочка «Перевести заново» заменяет старые переводы.
- Постоянные (синие) записи, у них ключи не используются. Это можно отключить.
- Отключённые записи, если не включить их отдельно.

### Безопасность данных

- **Резервная копия перед записью:** JSON-файл (по умолчанию), копия в виде нового лорбука или без копии.
- Лорбук перечитывается прямо перед записью, так что ручные правки не затираются.
- Добавленные ключи помечаются в `entry.extensions.lorebook_localizer`. Кнопка **«Удалить добавленные ключи»** убирает их, для одного языка или для всех. Исходные ключи и добавленные ключи, изменённые вручную, не трогаются.
- Для лорбуков, встроенных в карточку персонажа, изменения зеркалируются в `originalData`, как это делает редактор ST.

### Запросы

- **Пакеты** ограничены входными токенами и числом ключей: ответ со словоформами гораздо длиннее запроса.
- **Structured output (JSON schema)** включается для Chat Completion. Если API схему не поддерживает, расширение само переходит на JSON в промпте.
- **Проверка ответа:** каждый `id` должен вернуться. Недостающие записи запрашиваются повторно, обрезанный ответ делится пополам.
- Для «текущего подключения» используется `generateRawData`, а не `generateRaw`: так пользовательские regex-скрипты (например, замена кавычек на «ёлочки») не ломают JSON.

## Формат ключей

- **Regex (рекомендуется)** — один ключ на вариант перевода.
- **Обычные ключи** — каждая словоформа отдельным ключом. Так читабельнее, но ST ищет обычные ключи как подстроку, и короткие слова дают ложные срабатывания.

## Разработка

```bash
npm test
```

Модули `regex-builder`, `prompt`, `batching`, `translator` и `entries` не зависят от ST и покрыты тестами в Node. Код, работающий с ST, лежит в `connection.js`, `lorebook.js`, `ui.js` и `st.js`.

---

## English

**Lorebook Localizer** translates World Info keys with an LLM and appends regex keys that match every inflected form of the translation. For Russian that means all cases, singular and plural, and agreeing adjective + noun phrases. English lorebooks then trigger in roleplay written in another language.

- One button in the World Info panel. You pick lorebooks, a target language (Russian, Ukrainian, Polish, German, Japanese… or any custom one) and a connection: the current one, or a Connection Manager profile.
- The model returns word forms. The extension builds a Unicode-aware regex (`(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`, flags `iu`) and validates it with SillyTavern's own parser.
- Entry title and content excerpt are sent as context. Multiple translation variants are supported. Secondary keys are translated too.
- A preview lets you uncheck or edit keys before anything is written. A backup is made before saving.
- Added keys are tracked in `entry.extensions.lorebook_localizer`. Re-runs skip already translated keys, and a "remove added keys" action undoes everything.
- Batches are sized by tokens. Structured output is used when available, with automatic fallback. Missing ids are retried and truncated replies are split.

Install: *Extensions → Install extension →* `https://github.com/Likerch/SillyTavern-LorebookLocalizer.git`.

## License

MIT
