# Тестирование Stauri

Документ описывает, что и как тестируется, почему выбраны именно эти
инструменты и где проходят границы между уровнями тестов.

Актуальные числа на 2026-11-08: **107 Rust-тестов**, **241 frontend-тест в
23 файлах**, 1 E2E-сценарий.

## 1. Уровни

| Уровень | Инструмент | Что проверяет |
|---|---|---|
| Rust unit | `cargo test` | Конфигурация сети, форвардер, оба прокси, подпись и маршруты, парсеры лент, вычищение секретов |
| Frontend unit | Vitest + happy-dom | Сторы, утилиты, обёртки `statusFetch`, разбор ошибок |
| Frontend component | Vitest + `@testing-library/svelte` | Svelte-компоненты (формы, списки) |
| E2E | Playwright | Запуск Tauri, старт `status-backend`, отрисовка и ввод пароля |

Граница: **unit-тесты не запускают `status-backend`**. Всё, что требует
реального бэкенда, — либо мокается, либо уходит в E2E, либо проверяется руками
(§5).

## 2. Rust unit-тесты

Живут в `#[cfg(test)]`-модулях рядом с кодом, а не отдельными файлами: тест на
`split_signature` лежит в `router.rs`, тест на `validate_username` — в `ens.rs`.

```bash
cd src-tauri
cargo test
```

Покрытие по модулям:

| Модуль | Тестов | Что проверяет |
|---|---|---|
| `transfer.rs` | 17 | Сборка `sendTxArgs`, кодирование ERC-20 `transfer`, точность суммы, снятие `0x` только с подписи, одинаковость аргументов для оценки комиссии и отправки |
| `logging.rs` | 11 | Вычищение ключей из URL, JSON-полей, `user:pass@`, разрывов между `write` |
| `swap.rs` | 10 | Список сетей, `min_amount_out` при проскальзывании, отказ тестовым сетям, `tokenKey` |
| `router.rs` | 9 | Разбор 65-байтной подписи, нормализация `v` 27/28 → 0/1, извлечение хэшей из обоих сигналов |
| `providers.rs` | 9 | SSRF-фильтр (loopback, частные, link-local), разбор RSS/Atom и HTML Telegram, лимит записей |
| `ens.rs` | 9 | Валидация имени, разные формы имени для `ens_ownerOf` и `ens_expireAt`, `tokenKey`, параметры маршрута |
| `auth_proxy.rs` | 9 | Токен, отказ без токена и с чужим, снятие заголовка перед пересылкой, сравнение без префикса |
| `opener.rs` | 8 | Схемы `http(s)`/`mailto`, диплинк `t.me` для поста, отсутствие диплинка для похожего хоста |
| `config.rs` | 8 | Сети, `data_dir_suffix`, fallback RPC URL |
| `rpc_proxy.rs` | 6 | Проксирование JSON-RPC, 503 без upstream, 502 от мёртвого, секрет в пути, смена upstream без рестарта |
| `invite.rs` | 5 | Разбор ссылок SIM, varint через границу байта, мусорный payload |
| `error.rs` | 3 | Виды ошибок, сериализация |
| `dapp.rs` | 2 | Метка окна: стабильна и безопасна |
| `updater.rs` | 1 | camelCase в `UpdateInfo` |

Чего не покрыто (и почему):

    Реальная работа status-backend — это E2E или ручная проверка.

    Сетевые вызовы Router (сборка маршрута, подпись, отправка) — нужен
    живой бэкенд с балансом; проверяется руками по §5.4.

    `reqwest` к upstream — только через мок-сервер в тестах `rpc_proxy`.

## 3. Frontend unit-тесты (Vitest)

Конфигурация — в `vitest`-секции `vite.config.js`: среда `happy-dom`,
`setupFiles: ['./src/test-setup.ts']` (мок `$lib/i18n`, возвращающий ключ
вместо перевода).

```bash
pnpm test          # один прогон
pnpm test:watch    # наблюдение
pnpm test:e2e      # Playwright
pnpm tests         # frontend + rust подряд
```

### 3.1. Что мокается

| Мок | Зачем |
|---|---|
| `@tauri-apps/api/core` (`invoke`) | Не запускать Rust-команды |
| `@tauri-apps/plugin-http` (`fetch`) | Не ходить в сеть |
| `@tauri-apps/plugin-websocket` | Не открывать `/signals` |
| `$lib/status/api` / `$lib/status/wallet` | Изолировать стор от status-go |
| `$lib/status/messaging` | Изолировать список чатов от бэкенда |
| `$lib/utils/user` | Подменить определение «своё сообщение» |
| `./statusStore.svelte` | Изолировать стор от глобального состояния |
| `$lib/i18n` | Вернуть ключ вместо перевода |

`walletStore.test.ts` мокает **`$lib/status/wallet`**, а не `$lib/status/api`:
обёртки кошелька переехали в `wallet.ts`, и мок `api` их больше не перехватывал
— вызовы уходили в настоящий `statusFetch`. Эта ошибка уже была и стоила
зелёных тестов, которые ничего не проверяли.

### 3.2. Что покрыто по файлам

| Файл | Тестов |
|---|---|
| `stores/chatsStore.test.ts` | 39 |
| `utils/amount.test.ts` | 19 |
| `utils/assetGroups.test.ts` | 18 |
| `utils/totalBalance.test.ts` | 16 |
| `stores/feedsStore.test.ts` | 16 |
| `utils/tokens.test.ts` | 14 |
| `stores/connectionStore.test.ts` | 13 |
| `stores/navStore.test.ts` | 12 |
| `status/api.test.ts` | 11 |
| `stores/statusStore.test.ts` | 10 |
| `stores/walletStore.test.ts` | 10 |
| `utils/explorer.test.ts` | 8 |
| `utils/format.test.ts` | 8 |
| `sections/auth/PasswordInput.test.ts` | 7 |
| `status/http.test.ts` | 6 |
| `stores/sendStore.test.ts` | 6 |
| `sections/auth/NetworkPicker.test.ts` | 5 |
| `stores/contactsStore.test.ts` | 5 |
| `sections/auth/MainEntryScreen.test.ts` | 4 |
| `sections/chat/ChatLeft.test.ts` | 4 |
| `sections/profile/NetworkInfo.test.ts` | 4 |
| `sections/auth/ProfileLoginBlock.test.ts` | 3 |
| `sections/contacts/ContactsLeft.test.ts` | 3 |

Что именно важно в покрытом:

    walletStore — адреса из accounts_getAccounts (!chat), метаданные из
    getTokensForActiveNetworksMode, нулевые балансы не отбрасываются,
    три состояния rpcError, сброс, ключи цен.

    connectionStore — порядок запуска, wroteProviders, перезапуск ноды,
    createAccount с keyUid и без.

    totalBalance — mainnet-сети, цена без токена и токен без цены,
    точность bigint, разделитель ключа.

    sendStore — классификация отказов: шесть различимых текстов вместо
    «Failed».

    statusStore — processSignal (node.login, node.stopped, messages.new),
    resetState, setNetworkInfo.

    http — успех, пустой ответ, HTTP-ошибка, невалидный JSON,
    error строкой и объектом.

### 3.3. Правила написания

    Один тест — одно утверждение (или одна логическая группа).

    Моки в beforeEach, vi.clearAllMocks() — чтобы тесты не влияли
    друг на друга.

    Не тестировать внутренности, только публичное поведение стора.

    Если тест требует status-backend — это не unit, это E2E или ручная
    проверка.

    Сортировки — только с компаратором: `.sort()` без него сортирует
    лексикографически, и `[1, 10, 56]` остаётся в том же порядке, отчего
    тест «проходит», ничего не проверяя. Уже случалось дважды.

## 4. E2E-тест (Playwright)

Конфигурация — `playwright.config.ts`. Запускает `pnpm tauri dev`, ждёт
`http://localhost:1420`, работает с окном.

```bash
pnpm test:e2e
pnpm test:e2e:ui
```

Покрыт один сценарий (`tests/e2e/app-flow.spec.ts`): приложение поднимается,
появляется заголовок «Stauri», виден ввод пароля, пароль вводится, кнопка
действия доступна.

Чего не покрыто (и почему):

    Полный логин с реальным status-backend — долго и нестабильно:
    первый вход перезапускает ноду.

    Кошелёк, отправка, ENS, Swap — требуют профиля и денег.

## 5. Ручные проверки

Некоторые вещи нельзя проверить автоматически без реального
`status-backend` и сети. Их проверяют руками.

### 5.1. Чистый профиль

    Удалить ~/.local/share/com.magnus.stauri-app/mainnet.

    pnpm tauri dev, создать аккаунт, залогиниться.

    В логах искать [restart], node.stopped, configureWalletRpc.

    Открыть Wallet: балансы должны быть без hasError.

### 5.2. Повторный вход

    Не удаляя dataDir, перезапустить приложение.

    В логах не должно быть перезапуска ноды (провайдер уже в БД,
    wroteProviders === false).

    Балансы должны загрузиться сразу.

### 5.3. Форвардер

```bash
S=$(cat ~/.config/com.magnus.stauri-app/rpc-proxy.secret)
curl -s --noproxy '*' -X POST "http://127.0.0.1:43057/$S/1" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

Должен вернуть `{"result":"0x..."}`. Без секрета в пути — `404`, и это
правильное поведение.

### 5.4. Денежные операции

Проверяются только реальными деньгами, по шагам из `wallet_plan.md` §1:
перевод ETH → перевод ERC-20 (`decimals ≠ 18`) → обмен → регистрация имени.

Автоматизировать их нельзя: результат зависит от сети, а цена ошибки —
реальные средства. Поэтому путь проверяется сначала на минимальной сумме.

## 6. Чего не хватает (TODO)

    Интеграционный тест на порядок запуска с реальным status-backend
    (сейчас — только моки).

    Тест на `waitForNodeStopped` по таймауту: функция не бросает, но
    теста на это нет.

    Тест на `swapStore` и `ensStore`: сейчас они покрыты только через
    Rust-тесты и ручную проверку.

    Покрытие `rpc_proxy` на реальном upstream (сейчас — на мок-сервере).

    E2E-сценарий входа целиком, хотя бы на тестовой сети.

## 7. Инварианты

    Unit-тесты не запускают status-backend.

    E2E не проверяют бизнес-логику — только отрисовку и базовый ввод.

    Всё, что зависит от сети и кэшей status-go, проверяется руками.

    Моки — только на границах (`api.ts`, `wallet.ts`, `http.ts`, `invoke`),
    не внутри стора.

    Тест, который проходит при сломанном коде, хуже отсутствующего:
    перед правкой теста надо проверить, что он падает на старой версии.
