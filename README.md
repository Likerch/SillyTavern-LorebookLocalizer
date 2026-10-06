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

### Лорбуки BunnyMo не локализуются

Основной лорбук [BunnyMo](https://github.com/Coneja-Chibi/BunnyMo) и его паки диалог показывает выключенными, с пометкой
«BunnyMo». Ключи паков — теги вроде `<SPECIES:ELF>`, которые BunnyMo и CarrotKernel ищут ровно в том виде, как они
записаны; переведённые ключи дали бы только ложные срабатывания. Лорбуки узнаются по содержимому, а не по имени:
ключи-теги у большинства записей, обёртка `<BunnymoTags:…>` или служебные записи основного лорбука. Если такой лорбук
всё же нужно выбрать (например, чтобы убрать ключи, добавленные раньше), включите в «Параметрах» пункт
«Разрешить лорбуки и паки BunnyMo». Архивы персонажей CarrotKernel паками не считаются.

### Безопасность данных

- **Резервная копия перед записью:** JSON-файл (по умолчанию), копия в виде нового лорбука или без копии.
- Лорбук перечитывается прямо перед записью, так что ручные правки не затираются.
- Добавленные ключи помечаются в `entry.extensions.lorebook_localizer`. Кнопка **«Удалить добавленные ключи»** убирает их, для одного языка или для всех. Исходные ключи и добавленные ключи, изменённые вручную, не трогаются.
- Для лорбуков, встроенных в карточку персонажа, изменения зеркалируются в `originalData`, как это делает редактор ST.

### Запросы

- **Пакеты** ограничены входными токенами и числом ключей: ответ со словоформами гораздо длиннее запроса.
- **Structured output (JSON schema)** включается для Chat Completion. Если API схему не поддерживает, расширение само переходит на JSON в промпте.
- **Проверка ответа:** каждый `id` должен вернуться. Недостающие записи запрашиваются повторно, обрезанный ответ делится пополам.
- **Ожидание ответа:** запрос, на который модель не ответила за 90 секунд, прерывается и повторяется, как при ошибке. Время задаётся в «Запросах», `0` — ждать без ограничения.
- Для «текущего подключения» используется `generateRawData`, а не `generateRaw`: так пользовательские regex-скрипты (например, замена кавычек на «ёлочки») не ломают JSON.
- «Стоп» и таймаут прерывают только запрос самого расширения: генерация в чате и запросы других расширений не трогаются. Через текущее подключение следующий запрос не начнётся, пока не завершится предыдущий, иначе SillyTavern сбил бы пользователю длину ответа.

## Формат ключей

- **Regex (рекомендуется)** — один ключ на вариант перевода.
- **Обычные ключи** — каждая словоформа отдельным ключом. Так читабельнее, но ST ищет обычные ключи как подстроку, и короткие слова дают ложные срабатывания.

## API для других расширений

Для расширения [Maestro](https://github.com/Likerch/SillyTavern-Maestro) и других расширений есть
`globalThis.LOREBOOK_LOCALIZER_API`. Объект появляется при загрузке расширения. Он версионный: в версии 1 поля только
добавляются.

```ts
type BusyState = { running: boolean; by?: 'dialog' | 'api' };

interface LorebookLocalizerApi {
    version: 1;
    features: string[]; // с 0.3.0: 'progress', 'cancel', 'busy', 'timeout'
    buildKeyRegex(forms: string[], options?: { boundaries?: boolean }): string | null;
    buildPlainKeys(forms: string[]): string[];
    cleanForms(forms: string[]): string[];
    localizeEntries(book: string, uids: number[], options?: {
        language?: string;
        profileId?: string;
        onProgress?: (progress: { phase: 'queued' | 'running' | 'saving'; done: number; total: number }) => void;
        signal?: AbortSignal;
        batchTimeoutMs?: number;
    }): Promise<{
        added: number;
        entries: number;
        failures: number;
        cancelled: boolean;
        failed: Array<{ uid: number; reason: 'timeout' | 'invalid' | 'error' }>;
    }>;
    isProtectedBook(book: string): Promise<boolean>;
    busy(): BusyState;
    onBusyChange(listener: (state: BusyState) => void): () => void;
}
```

- `features` перечисляет то, что появилось после первой версии API, — по нему расширение проверяет, что умеет
  установленный Localizer. В 0.3.0 добавились `progress`, `cancel`, `busy` и `timeout`.
- `buildKeyRegex` собирает из словоформ один regex-ключ (`/…/iu`) с границами слова в Unicode, как в диалоге;
  `boundaries: false` — без границ (для языков без пробелов). `null` — форм нет.
- `buildPlainKeys` — каждая форма отдельным обычным ключом. `cleanForms` чистит формы: пробелы, запятые, дубли
  без учёта регистра и ё/е, не больше 60 форм.
- `localizeEntries` делает то же, что диалог, но без окон: собирает ключи записей `uids` лорбука `book`, переводит
  их, строит ключи и записывает. Предпросмотра и резервной копии нет. Остальные параметры — как их выставил
  пользователь в диалоге (вторичные ключи, контекст, постоянные и выключенные записи, формат ключей, число
  вариантов, пакеты, повторы). `language` — id языка из списка диалога (`ru`, `uk`, `de`…), `profileId` — профиль
  Connection Manager (`''` — текущее подключение); без них берётся выбор из диалога. Возвращает, сколько ключей
  добавлено (`added`), сколько записей их получило (`entries`), сколько записей не удалось (`failures`, причины — в
  `failed`) и была ли отмена (`cancelled`). Лорбуки
  BunnyMo, неизвестный лорбук или язык, сломанный профиль и отсутствие подключения — ошибка (Promise отклоняется).
  Диалог и API работают строго по очереди: вызов, пришедший во время другой работы, ждёт её конца.
- `onProgress` сообщает ход работы в записях:
  - `queued` — задача ждёт другую работу Localizer (окно или другой вызов API). Приходит сразу при вызове,
    `total` — число запрошенных записей.
  - `running` — идёт перевод. Первый раз приходит с `done: 0`, потом после каждого ответа модели. `total` — записи,
    которые ушли модели (записи, где переводить нечего, не считаются), `done` — сколько из них уже готово,
    с переводом или без.
  - `saving` — ключи записываются в лорбук.

  Исключение внутри `onProgress` задачу не ломает.
- `signal` отменяет задачу. Запрос, который идёт в этот момент, прерывается, а готовые пакеты сохраняются.
  Promise не отклоняется: он выполняется с `cancelled: true`. Если задача ещё ждёт очереди, она снимается сразу и
  ничего не делает.
- `batchTimeoutMs` — сколько ждать ответа на один запрос. По умолчанию это «Ожидание ответа» из настроек окна:
  90 секунд, если пользователь их не менял. Запрос без ответа прерывается и считается неудачной попыткой: пауза и
  повтор, как при ошибке. После последнего повтора записи пакета попадают в `failed` с причиной `timeout`. `0` или
  `Infinity` — без ограничения.
- `failed` — записи, которые не получили ключей из-за сбоя, `failures` — их число:
  - `timeout` — модель не ответила вовремя и после повторов;
  - `invalid` — ответ не JSON, обрезан, записи в нём нет, или ни один вариант перевода не дал корректного ключа;
  - `error` — запрос завершился ошибкой (сеть, API).

  Сбоями не считаются записи, на которые модель вернула пустой перевод, и записи, до которых не дошло из-за отмены.
- `busy()` говорит, занят ли Localizer и кем: `dialog` — окно расширения (от нажатия «Локализовать» до конца
  предпросмотра и записи), `api` — вызов `localizeEntries`. `onBusyChange` вызывает слушателя при каждой смене
  состояния и возвращает функцию отписки. Между двумя задачами подряд промежуточного «свободен» нет, а состояние
  меняется раньше, чем выполняется Promise задачи.
- `isProtectedBook` — лорбук BunnyMo или его пак: такие через API не локализуются никогда.

## История версий

Изменения по версиям — в [CHANGELOG.md](CHANGELOG.md).

## Разработка

```bash
npm test
```

Модули `regex-builder`, `prompt`, `batching`, `translator`, `entries`, `protected`, `exclusive`, `headless` и `api` не зависят от ST и покрыты тестами в Node. Код, работающий с ST, лежит в `connection.js`, `lorebook.js`, `ui.js` и `st.js`; запросы из `connection.js` проверяются в тестах на поддельном контексте ST.

---

## English

**Lorebook Localizer** translates World Info keys with an LLM and appends regex keys that match every inflected form of the translation. For Russian that means all cases, singular and plural, and agreeing adjective + noun phrases. English lorebooks then trigger in roleplay written in another language.

- One button in the World Info panel. You pick lorebooks, a target language (Russian, Ukrainian, Polish, German, Japanese… or any custom one) and a connection: the current one, or a Connection Manager profile.
- The model returns word forms. The extension builds a Unicode-aware regex (`(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`, flags `iu`) and validates it with SillyTavern's own parser.
- Entry title and content excerpt are sent as context. Multiple translation variants are supported. Secondary keys are translated too.
- A preview lets you uncheck or edit keys before anything is written. A backup is made before saving.
- Added keys are tracked in `entry.extensions.lorebook_localizer`. Re-runs skip already translated keys, and a "remove added keys" action undoes everything.
- Batches are sized by tokens. Structured output is used when available, with automatic fallback. Missing ids are retried and truncated replies are split.
- A request with no reply in 90 seconds (configurable, `0` = no limit) is stopped and retried like an error. Stop and timeouts abort only the extension's own request: the chat generation and other extensions' requests are left alone.
- BunnyMo's own lorebook and its packs are recognized by their content (tag keys such as `<SPECIES:ELF>`, the `<BunnymoTags:…>` wrapper) and shown disabled: BunnyMo matches those keys exactly as written. They can be allowed in Options.

### API for other extensions

`globalThis.LOREBOOK_LOCALIZER_API` (used by [Maestro](https://github.com/Likerch/SillyTavern-Maestro)) is a versioned
object; within version 1 members are only added.

```ts
type BusyState = { running: boolean; by?: 'dialog' | 'api' };

interface LorebookLocalizerApi {
    version: 1;
    features: string[]; // since 0.3.0: 'progress', 'cancel', 'busy', 'timeout'
    buildKeyRegex(forms: string[], options?: { boundaries?: boolean }): string | null;
    buildPlainKeys(forms: string[]): string[];
    cleanForms(forms: string[]): string[];
    localizeEntries(book: string, uids: number[], options?: {
        language?: string;
        profileId?: string;
        onProgress?: (progress: { phase: 'queued' | 'running' | 'saving'; done: number; total: number }) => void;
        signal?: AbortSignal;
        batchTimeoutMs?: number;
    }): Promise<{
        added: number;
        entries: number;
        failures: number;
        cancelled: boolean;
        failed: Array<{ uid: number; reason: 'timeout' | 'invalid' | 'error' }>;
    }>;
    isProtectedBook(book: string): Promise<boolean>;
    busy(): BusyState;
    onBusyChange(listener: (state: BusyState) => void): () => void;
}
```

- `features` lists what was added after the first API release, for feature detection.
- `buildKeyRegex`, `buildPlainKeys` and `cleanForms` are the pure helpers the dialog uses.
- `localizeEntries` runs the dialog's pipeline (collect keys → translate → build keys → write) for the given entries
  without any UI and without a backup. The user's dialog options apply; `language` is a language id from the dialog's
  list and `profileId` a Connection Manager profile id (`''` = current connection). It resolves to the number of
  added keys, of entries that got keys and of failed entries. It rejects for BunnyMo books, unknown books or
  languages, unusable profiles and when there is no connection. Dialog and API jobs run one at a time.
  - `onProgress` counts entries: `queued` comes at once when the job has to wait for another Localizer job (`total`
    = requested entries); `running` comes with `done: 0` and after every model reply (`total` = entries sent to the
    model, `done` = finished so far, translated or not); `saving` comes before the write.
  - `signal` cancels: the request in flight is dropped, finished batches are still saved, and the promise resolves
    with `cancelled: true`. A job still waiting for its turn is dropped at once.
  - `batchTimeoutMs` (default: the dialog's reply timeout, 90 s unless the user changed it; `0` or `Infinity` = no
    limit): a request with no reply in time counts as a failed attempt and is retried like an error.
  - `failed` lists the entries that got no keys because something failed, with the reason: `timeout` (no reply,
    also after the retries), `invalid` (not JSON, cut off, missing in the reply, no valid key) or `error` (the
    request failed). `failures === failed.length`. Entries the model answered with an empty translation and entries
    skipped by a cancel are not failures.
- `busy()` tells whether a Localizer job runs and whose it is: `dialog` (from "Localize" until the preview is
  applied or closed) or `api`. `onBusyChange` calls the listener on every change and returns an unsubscribe
  function; there is no idle blink between two queued jobs, and the state changes before the job's promise settles.
- `isProtectedBook` tells whether a lorebook is BunnyMo's or one of its packs; the API never localizes those.

Install: *Extensions → Install extension →* `https://github.com/Likerch/SillyTavern-LorebookLocalizer.git`.

## License

MIT
