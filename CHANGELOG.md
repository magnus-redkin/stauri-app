# Changelog

Все заметные изменения Stauri. Секции генерирует `scripts/release-changelog.sh`
из Conventional Commits; новые версии идут сверху.

## [0.4.0] — 2026-11-15

Стабильный выпуск. Код совпадает с `0.4.0-beta` (тег `v0.4.0-beta`), отличается
только версия. Выпуск нужен, чтобы проверить автообновление: установленная
beta должна получить 0.4.0 через `releases/latest`, который не отдаёт prerelease.

## [0.4.0-beta] — 2026-11-12

### Сборка и релиз
- перенести workflow в репозиторий приложения (`51f67af`)

### Прочее
- привести .gitignore к реальной раскладке (`e73d07c`)

### Без типа
- android start (`7695264`)
- new char scheme (`ddfbe69`)
- README (`523f706`)
- Initial import: Stauri app (Tauri + Svelte 5) (`aa70fd5`)
