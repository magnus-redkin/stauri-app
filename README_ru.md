# Stauri — клиент Status на Tauri

Stauri — альтернативный неофициальный клиент для экосистемы [Status](https://status.im): защищённый
мессенджер и криптокошелёк в одном приложении. Написан на **Tauri (Rust)** и
**Svelte 5**, использует тот же бэкенд, что и официальный `status-desktop`
(`status-go`), но подключает его иначе — как **библиотеку внутри своего процесса**.
Один и тот же Rust-код работает в десктопной сборке и на Android: нет дочернего
процесса, нет локального порта и нет отдельного бэкенда, который надо держать
живым.

## Две вещи, которые стоит знать до того, как доверять бинарнику

**1. `status-go` — это upstream плюс один маленький патч.** Сборка берёт
закреплённый коммит `766535cf3` и
[`src-tauri/status-go/stauri-close-accounts.patch`](src-tauri/status-go/stauri-close-accounts.patch)
(2 файла, 39 добавленных строк) — больше ничего. Патч добавляет один экспорт,
`CloseAccounts`: он позволяет приложению заново открыть базу аккаунтов при смене
каталога данных, и именно поэтому сеть переключается мгновенно, а не через
перезапуск. Весь дифф целиком — в форке:
[`magnus-redkin/status-go:stauri/close-accounts`](https://github.com/status-im/status-go/compare/766535cf336416a11a92f46faf4df5ac6af4a0b8...magnus-redkin:status-go:stauri/close-accounts).
Он не трогает криптографию, транспорт и формат хранения; закрывается
**незашифрованная** `accounts.sql` с метаданными профилей. Непропатченная
библиотека тоже работает — только смена сети тогда честно сообщает, что нужна
пересборка. Зачем, как проверить и что с upstream — в
[`src-tauri/status-go/README.md`](src-tauri/status-go/README.md).

**2. Ключевой материал лежит в отдельной папке.** [`src-tauri/src/core/`](src-tauri/src/core/)
— конверт PIN (Argon2id + AES-GCM), seed-фраза, пейринг, RPC-форвардер и все
вызовы status-go через FFI. Всё остальное — чаты, экраны кошелька, маркет, dApp —
бизнес-логика вне её. Папка — маркер, а не замок компилятора: границу держат
`.github/CODEOWNERS` (любое изменение там требует ревью) и
`core/surface.rs` — тест, который падает, если состав ядра или поверхность
команд молча изменились. Подробно: [`docs/ru/architecture.md`](docs/ru/architecture.md) §1.2.

## Документация

на русском в [`docs/ru/`](docs/ru/). Английская версия README — [`README.md`](README.md).

- [`docs/ru/web3im.md`](docs/ru/web3im.md) — если впервые слышите про Web3,
  seed-фразу и распределённые мессенджеры: без терминов, с аналогиями.
- [`docs/ru/comparison.md`](docs/ru/comparison.md) — Stauri и Status: что
  именно сравниваем, архитектурные отличия, преимущества и недостатки,
  перспективы Logos.
- [`docs/ru/architecture.md`](docs/ru/architecture.md) — устройство: слои,
  поток данных, подсистемы, инварианты.
- [`docs/ru/networks_and_balances.md`](docs/ru/networks_and_balances.md) — путь
  от баланса до экрана: кэши `status-go`, локальный RPC-форвардер.
- [`docs/ru/providers_and_dapps.md`](docs/ru/providers_and_dapps.md) — внешние
  источники данных и dApp: модель доверия, изоляция, что уже работает.
- [`docs/ru/akk_scheme.md`](docs/ru/akk_scheme.md) — схема «Автор → Канал →
  Комментарии» поверх возможностей `status-go` без форка.
- [`docs/ru/status_outdated_architecture.md`](docs/ru/status_outdated_architecture.md) —
  почему `status-go` устроен сложно (историческая справка).
- [`docs/ru/tests.md`](docs/ru/tests.md) — уровни тестов, что покрыто и что
  проверяется руками.
- [`README.md`](README.md) — английская версия: сборка, ограничения, что уже
  работает.


## Особенности

- **Кошелёк:** активы по сетям, отправка ETH и ERC-20, приём с QR, обмен
  токенов, общий баланс по mainnet-сетям.
- **Имя ENS:** регистрация `имя.stateofus.eth` прямо из профиля, с проверкой
  занятости и цены до подписи.
- **Чаты:** каналы, личные переписки, сообщества, контакты, комментарии к
  записям канала.
- **dApp в отдельном окне:** изоляция от главного окна через capabilities,
  а не соглашением в коде.
- **Внешние ленты:** RSS/Atom и Telegram-каналы через RSS-мост, в общем списке
  чатов, с указанием источника у каждой строки.
- **Market:** курсы с CoinGecko, напрямую из Rust, без зависимости от
  `status-go`.
- **Оформление:** четыре темы, размер шрифта, четыре языка (en / ru / zh / es).

## Преимущества

- **Защищённый локальный контур.** Не осталось ни порта, ни процесса, к
  которому может подключиться другой пользователь машины: `status-go` живёт в
  том же процессе, а Tauri-команды — единственный вход. Внешние адреса
  проверяются на каждом редиректе, секреты вычищаются в логах, CSP действует в
  собранном приложении (`script-src 'self'`, без `unsafe-inline`).
- **Подпись не покидает Rust.** Наружу торчит намерение («переведи 3 USDT»),
  а не последовательность «собрать → подписать → отправить». Пароль и хэши
  не попадают в webview.
- **Явные границы слоёв.** `status/wallet.ts` и `status/messaging.ts` —
  настоящая граница, а не пожелание: при смене бэкенда правится один файл.
- **Решения документированы там, где живут.** Почему ключ цены через дефис,
  почему обмен идёт в два раунда, почему имя запрашивается дважды в разных
  формах — записано рядом с кодом.
- **Быстрая итерация.** Svelte 5 + Rust дают короткий цикл правки.

## Недостатки

- **Функциональное покрытие несопоставимо с `status-desktop`:** нет истории
  транзакций, NFT, bridge, keycard, push-уведомлений.
- **Обмен работает только в Ethereum mainnet:** у провайдеров нет ликвидности
  в тестовых сетях.
- **Покупка крипты за фиат — заглушка.**
- **Поиска по ENS-именам нет:** имя работает как адрес получателя, но не как
  способ найти собеседника.
- **Кошельковая логика в Rust завязана на `status-go`:** около 1 900 строк,
  которые при переходе на Logos придётся переписать, а не подменить обёрткой.
- **Библиотека, а не процесс.** Падение или необработанная паника внутри
  `status-go` теперь роняет всё приложение, а бэкенд нельзя обновить отдельно
  от UI. Это осознанный размен: одна сборочная цепочка вместо двух и общий
  Rust-код на десктопе, Android и Windows.
- **Один разработчик.** Нет второго читателя и ревью — главный риск проекта.

Подробный разбор преимуществ и недостатков, включая сравнение с
`status-desktop` и последствия перехода на Logos, — в
[`docs/ru/comparison.md`](docs/ru/comparison.md).


## Сборка

Stauri требует заранее собранных `libstatus.so` и `libsds.so` — **из одного
Nix-окружения** (иначе приложение падает с `SIGSEGV` при загрузке `libsds.so`)
и **из upstream плюс патч Stauri**.

```bash
# 1. Собрать библиотеку в Nix: закреплённый upstream + один патч
git clone https://github.com/status-im/status-go.git ~/ETH/github.status-go
cd ~/ETH/github.status-go
git checkout 766535cf3
git apply ~/ETH/stauri/stauri-app/src-tauri/status-go/stauri-close-accounts.patch

env -u CGO_LDFLAGS -u CGO_CFLAGS -u LD_LIBRARY_PATH -u LIBRARY_PATH \
  nix develop --extra-experimental-features 'nix-command flakes' \
  --command make statusgo-shared-library

# 2. Положить библиотеки в Stauri
cp build/bin/libstatus.so.0 \
   ~/ETH/stauri/stauri-app/src-tauri/binaries/libstatus.so
find /nix/store -name "libsds.so"   # взять тот, что был в -L при линковке
cp /nix/store/<hash>-nim-sds-.../lib/libsds.so \
   ~/ETH/stauri/stauri-app/src-tauri/binaries/libsds.so

# 3. Запустить
cd ~/ETH/stauri/stauri-app
pnpm install
pnpm tauri dev

# 4. Собрать AppImage
./scripts/release.sh 0.5.0
```

Проверить, что патч попал в библиотеку:

```bash
nm -D --defined-only build/bin/libstatus.so | grep -w CloseAccounts
```

Подробности о сборке, `patchelf` и Nix-интерпретаторе — в
[`docs/BUILDING.md`](docs/BUILDING.md).

## Тесты

```bash
pnpm test        # frontend: 400 тестов в 39 файлах
pnpm test:rust   # backend: 160 тестов
pnpm test:e2e    # Playwright, запускает реальное приложение
./tests/integration/contact.sh   # ноды на libstatus, нужна сеть
```

## Что дальше

Ближайшие задачи, в порядке: убрать явные недоделки, собрать бинарник для
Android (затем Windows).

## Лицензия

См. [`LICENSE.md`](LICENSE.md) в корне репозитория.
