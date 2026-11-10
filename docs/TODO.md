# TODO

Открытые задачи Stauri. Крестик ставим, когда задача проверена (код + живой прогон там, где он нужен).
Подробности и обоснования — в [`PLAN.md`](PLAN.md); сборка — в [`BUILDING.md`](BUILDING.md).

Состояние на 2026-11-10.

## Android (B.2)

- [x] Мост `libstatus.so` на телефоне: загрузка, `InitializeApplication` отвечает
  - [x] Собрать `libsds.so` (arm64) через флейк `nim-sds`
  - [x] Собрать `libstatus.so` (arm64) с Nim 2.2.10 и `make -o build-libsds-android`
  - [x] Положить библиотеки в `jniLibs/arm64-v8a`
  - [x] Загрузка и вызов `InitializeApplication` на телефоне (`{"accounts":null}`)
- [x] `statusFetch` через мост на Android (`status_call`)
  - [x] Rust: `inprocess::direct()` для `InitializeApplication`, `LoginAccount`, `CreateAccountAndLogin`, `Logout`, `CallRPC`
  - [x] Фронтенд: ветка Android в `statusFetch`, разбор ответа вынесен в `parseBody`
  - [x] `start_backend` на Android возвращает `StartBackendResponse` (маркер `authPort`)
  - [x] `openWs` пропускается на Android (сигналов пока нет)
  - [x] Каталог конфигурации от Tauri (`appdirs`, `setup`) — секрет RPC-прокси на Android
- [ ] Вход на телефоне
  - [ ] Пробный вход: создать тестовый профиль на телефоне (пароль вводит пользователь)
  - [ ] Проверить `configureWalletRpc` и `startMessenger` после логина
  - [ ] Проверить вызовы `CallRPC` (аккаунты, баланс, сети) через мост
- [ ] Сигналы на Android (`SetSignalEventCallback`)
  - [ ] Rust: колбэк из `libstatus.so` и пересылка сигналов в webview (`emit`)
  - [ ] Фронтенд: подписка на события вместо `ws.ts` на Android
  - [ ] Проверить обновление списка чатов и сообщений без перезапуска
- [ ] Чистка временного кода
  - [ ] Убрать `probe`-отметку (`http.ts`, `statusStore.svelte.ts`, `MainEntryScreen.svelte`), когда вход заработает
  - [ ] Предупреждения `dead_code` в `inprocess.rs` (`initialize`, `login`) — уйдут после подключения входа
- [ ] Android: `dirs::data_local_dir()` в `logging.rs` (лог в файл) — на Android логируем в `logcat`, файловый путь пока не работает
- [ ] Android: `open_dapp` (окна dApp) — сейчас заглушка, решить: убрать или перенести
- [ ] Android: хранение секретов в Keystore (сейчас `rpc-proxy.secret` и seed в app-data)
- [ ] Android: фон и опрос балансов (каждые 3 с) и `node.stopped` — пересмотреть для мобильного режима
- [ ] Android: сборка release и подпись APK (сейчас только debug)

## Windows (B.3)

- [ ] Сборка на Windows 11 (KVM): ставим KVM и Windows 11 Pro
  - [ ] Установить `status-backend.exe` (`go build` под `GOOS=windows`, в Makefile цели нет)
  - [ ] Собрать `libsds.dll` (`libsdsDynamicWindows`) на настоящей Windows (проверка `when defined(windows)`)
  - [ ] Решить с флейком `nim-sds` для `x86_64-windows` (падает на `buildInputs`) — черновик правок в `/home/michael/ETH/nim-sds/flake.nix`
- [ ] `sidecar.rs`: замена `/proc` и `kill` на Windows (`tasklist`/`taskkill` или `windows-sys`)
- [ ] `rpc-proxy.secret` на Windows: ACL через `SetNamedSecurityInfoW` (шаг 25 PLAN)
- [ ] Установщик NSIS/MSI и подпись Authenticode
- [ ] CI на `windows-latest`

## Безопасность и архитектура (PLAN, этапы 1–3)

- [ ] Шаг 4. Типизированные ошибки в Rust (`error.rs` на `thiserror`, `#[serde(tag = "kind")]`)
  - [ ] Перевести `AppError` на `thiserror` с `tag = "kind"`
  - [ ] Обновить разбор ошибок во фронтенде под новый формат
- [ ] Шаг 5. Seed-фраза вне webview — проверить полностью
  - [ ] Подтвердить, что `fetch_seed_phrase` не отдаёт фразу в webview (только `word_count`)
  - [ ] Убрать остатки `seed_word` во фронтенде, если они есть
- [ ] Шаг 8. Целостность загрузок в `release.sh`
  - [ ] Зафиксировать версии `linuxdeploy` и плагина (уже с sha256 — проверить)
  - [ ] Проверка `sha256sum` после `wget` для всех загрузок
- [ ] Шаг 10. Единый модуль конфигурации ключей — `src/lib/config/keys.ts` создан, но **не используется** (0 импортов)
  - [ ] Перевести RPC-адреса и ключи на `keys.ts`
  - [ ] Удалить дублирующие константы
- [ ] Шаг 11. `PREFERRED_PORT` без молчаливого fallback (`rpc_proxy.rs`)
  - [ ] Ошибка при занятом порте вместо тихого перехода на другой
  - [ ] Обновить URL в БД status-go при смене порта
- [ ] Шаг 15. Граница status-go (вариант A): изолировать `wakuext_*` в `status/messaging.ts`
- [ ] Шаг 24. CSP вместо `csp: null` (`tauri.conf.json`)
  - [ ] Описать CSP для webview (`connect-src`, `img-src` с `data:`)
  - [ ] Проверить, что приложение работает под CSP на десктопе и Android
- [ ] Шаг 25. Права на `rpc-proxy.secret` вне Unix (см. Windows выше)

## Чат и АКК (docs/ru/akk_scheme.md)

- [ ] Входящий контакт: Accept/Reject и значок «1» — проверить live (Z3)
  - [ ] Новый входящий чат появляется без ручного обновления
- [ ] Z4: форма ответа в личном 1-1 (`reply-sync/input-state`) — ждём лог пользователя
- [ ] Z5: ссылка `status.app/u/…` в поиске — проверить live
- [ ] Ссылка на контакт `status.app/u/<payload>#<ключ>` — формат payload не подтверждён
- [ ] Левая колонка: замечания по иконкам, поиску, правой панели (пользователь обещал обработать позже)
- [ ] История канала: решить (принимать как есть / архив / изменение status-go)
- [ ] Название «general» в именах каналов сообщества: убрать или оставить
- [ ] Сценарии проверки A (News), B (по заявке), C (Issues), D (1-1), E (ссылки), Z (1-1 и контакты) — прогнать с пользователем
- [ ] Звук и системное уведомление Linux при входящих (источник не найден)

## Прочее

- [ ] RSS/Telegram-ленты: `fetch_feed` падает с «error sending request» (отложено пользователем)
- [ ] CoinGecko `wallet_fetchPrices` отвечает 401 (внешний ключ/прокси)
- [ ] ENS-регистрация: котировка проверена; сама регистрация не запускалась (спишет SNT на mainnet — только по явному подтверждению)
- [ ] Обход блокировок (сеть Status) — отдельная задача, не сейчас
- [ ] Смена пароля перед следующей сборкой AppImage (сказано пользователем: «не забыть»)
- [ ] Не коммитили: изменения в `src-tauri`, `src`, `docs` и новый `docs/BUILDING.md` — решить, когда коммитить

## Выполнено (для справки)

- [x] Шаг 1 (CSP и области capabilities), 2 (логи тел ответов), 3 (CI), 6 (локальная аутентификация status-backend), 9 (разбиение `lib.rs`: остался `run()`), 12, 13, 14, 19, 20
- [x] Шаг 7 (мёртвые команды): `greet` и `open_dapp_window` в коде отсутствуют
- [x] Ветка B.1: тип `Backend` (`Rpc` / `InProcess`) — `ens`, `swap`, `transfer`, `router` переведены
- [x] Документация сборки перенесена в `docs/BUILDING.md`
