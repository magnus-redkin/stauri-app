# Стиль комментариев в коде

Документ описывает, как пишутся комментарии в Stauri. Он нужен и при правках,
и при ревью: если комментарий не соответствует разделу ниже — это замечание к
коду, а не вкусовщина.

Комментарии в коде — на английском. Русский остаётся в `docs/ru/` и в
пользовательских строках интерфейса (локали), но не в исходниках.

## Принципы

1. **Сначала польза, потом история.** Первая строка отвечает, зачем функция
   нужна и что делает. Что было раньше — в `git log` и `CHANGELOG.md`.
2. **Одно неочевидное «почему» — обязательно.** Если код обходит поведение
   status-go, ограничение протокола или чужую ошибку, это пишется явно:
   иначе следующий читатель «упростит» обход и сломает.
3. **Не пересказывать сигнатуру.** `/// Returns the account address.` бесполезно,
   если из имени это уже видно; полезно знать, *почему* адрес берётся именно
   такой (например, что chat-аккаунт исключается).
4. **Обращаться к читателю кода, а не к конкретному человеку.** «We», «you»,
   имена в комментариях не используются: комментарий переживёт и автора, и
   адресата.

## Rust

Модуль начинается с `//!`: одна строка — назначение, пустая строка, детали.

```rust
//! Typed errors for Tauri commands.
//!
//! Every command returns `AppError`, so the frontend can branch on `kind`
//! instead of matching on message text.
```

Функция получает `///`. Обязательные части:

```rust
/// Kills a backend process left over from a previous run.
///
/// Reads the PID file and compares `/proc/<pid>/comm` before signalling, so a
/// stale PID file cannot kill an unrelated process.
///
/// # Errors
/// Returns [`ErrorKind::Io`] when the data directory cannot be determined.
pub fn kill_stale_backend(dir: &Path) -> AppResult<()>
```

- **Summary** — одна-две строки, законченное предложение с точкой.
- **Детали** — пустая строка после summary, только если summary мало.
- **`# Errors`** — для всего, что возвращает `Result`:
  какая категория и при каких условиях.
- **`# Panics`** — только если функция правда может паниковать.
- **`# Safety`** — обязателен для `unsafe fn`.
- Публичные поля структур и варианты `enum` — короткий `///`, если имя не
  исчерпывающе.
- Внутри тела — обычный `//` для неочевидных шагов. Такой комментарий
  объясняет *шаг*, а не функцию.

Аргументы и возвращаемое значение не описываются тегами (в Rust для этого
нет стандартных тегов `@param`); если нужно — отдельным абзацем прозы.

## TypeScript / JavaScript

Стиль — JSDoc/TSDoc. Типы уже в сигнатуре, поэтому `{type}` в тегах не пишется.

```ts
/**
 * Joins a community by signing the request with the profile password.
 *
 * status-go returns signing params with a `0x` prefix that the signature must
 * not carry, so the prefix is stripped before sending.
 *
 * @param communityId - Community id from the invite link.
 * @returns The pending join request, or `null` when the account was already a
 * member.
 * @throws When the signed request is rejected by the backend.
 */
```

- **Summary** — одна-две строки.
- **`@param name - описание`** — тире обязательно, тип не указывается: он в
  сигнатуре. **Исключение — файлы `.js`** (`vite.config.js`, `eslint.config.js`):
  там JSDoc и есть система типов, и без `@param {{ methods: string[] }} options`
  проверка типов теряет вывод и начинает ругаться на `any`. В `.js` тип в теге
  остаётся.
- **`@returns`** — если функция что-то возвращает и это не очевидно.
- **`@throws`** — если функция бросает.
- **`@remarks`** — неочевидное ограничение, обход чужого поведения.
- **`@deprecated`** — с указанием замены.
- Экспортируемые константы и типы документируются так же, но без тегов.

## Svelte

- В `<script>` — тот же JSDoc, что и в TypeScript.
- Экспортированные через `$props()` свойства описываются в интерфейсе пропсов,
  а не отдельным блоком.
- Комментарий в разметке (`<!-- -->`) — только там, где без него непонятно,
  почему элемент устроен именно так. Не помечать секции («header», «list»).

## Shell

Верхний блок файла — назначение и причина существования, затем использование:

```bash
# clean-env.sh — runs a build against an empty profile directory.
#
# Release builds read the developer's own profile unless data and config
# directories are overridden, so checks would run against real data.
```

Функции — одна строка над объявлением: `# name — что делает`.

## Чего не делать

- Не оставлять комментарий, описывающий прошлое поведение: он устаревает в
  момент коммита. Для этого есть `CHANGELOG.md`.
- Не комментировать очевидное (`// increment i`).
- Не дублировать комментарий в двух местах: подробности — у определения,
  в вызове — только ссылка, если она нужна.
- Не переводить русские строки интерфейса и `it(...)`-описания тестов этим
  документом: он про комментарии.
