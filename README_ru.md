# Stauri — клиент Status на Tauri

Stauri — настольный клиент для экосистемы [Status](https://status.im): защищённый
мессенджер и криптокошелёк в одном приложении. Написан на **Tauri (Rust)** и
**Svelte 5**, использует тот же бэкенд, что и официальный `status-desktop`
(`status-go`), но подключает его иначе — как отдельный процесс.

Документация — на русском, в [`docs/ru/`](docs/ru/). Английская версия README —
[`README.md`](README.md).

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
- **Оформление:** три темы, размер шрифта, четыре языка (en / ru / zh / es).

## Преимущества

- **Защищённый локальный контур.** Единственный клиент этой экосистемы, где
  бэкенд закрыт аутентификацией с токеном, внешние адреса проверяются на
  каждом редиректе, секреты вычищаются в логах, а CSP действует в собранном
  приложении (`script-src 'self'`, без `unsafe-inline`).
- **Подпись не покидает Rust.** Наружу торчит намерение («переведи 3 USDT»),
  а не последовательность «собрать → подписать → отправить». Пароль и хэши
  не попадают в webview.
- **Явные границы слоёв.** `status/wallet.ts` и `status/messaging.ts` —
  настоящая граница, а не пожелание: при смене бэкенда правится один файл.
- **Решения документированы там, где живут.** Почему ключ цены через дефис,
  почему обмен идёт в два раунда, почему имя запрашивается дважды в разных
  формах — записано рядом с кодом.
- **Быстрая итерация.** Svelte 5 + Rust дают короткий цикл правки.

## Недостатки — честно

- **Функциональное покрытие несопоставимо с `status-desktop`:** нет истории
  транзакций, NFT, bridge, keycard, push-уведомлений.
- **Обмен работает только в Ethereum mainnet:** у провайдеров нет ликвидности
  в тестовых сетях.
- **Покупка крипты за фиат — заглушка.**
- **Поиска по ENS-именам нет:** имя работает как адрес получателя, но не как
  способ найти собеседника.
- **Кошельковая логика в Rust завязана на `status-go`:** около 1 900 строк,
  которые при переходе на Logos придётся переписать, а не подменить обёрткой.
- **Один разработчик.** Нет второго читателя и ревью — главный риск проекта.

Подробный разбор преимуществ и недостатков, включая сравнение с
`status-desktop` и последствия перехода на Logos, — в
[`docs/ru/comparison.md`](docs/ru/comparison.md).

## Документация

- [`docs/ru/web3im.md`](docs/ru/web3im.md) — если впервые слышите про Web3,
  seed-фразу и распределённые мессенджеры: без терминов, с аналогиями.
- [`docs/ru/comparison.md`](docs/ru/comparison.md) — Stauri и Status: что
  именно сравниваем, архитектурные отличия, преимущества и недостатки,
  перспективы Logos.
- [`docs/ru/architecture.md`](docs/ru/architecture.md) — устройство: слои,
  поток данных, подсистемы, инварианты.
- [`docs/ru/networks_and_balances.md`](docs/ru/networks_and_balances.md) — путь
  от баланса до экрана: кэши `status-go`, локальный RPC-форвардер.
- [`docs/ru/wallet_plan.md`](docs/ru/wallet_plan.md) — что осталось по кошельку,
  главный план проверки реальными деньгами, известные риски.
- [`docs/ru/providers_and_dapps.md`](docs/ru/providers_and_dapps.md) — внешние
  источники данных и dApp: модель доверия, изоляция, что уже работает.
- [`docs/ru/akk_scheme.md`](docs/ru/akk_scheme.md) — схема «Автор → Канал →
  Комментарии» поверх возможностей `status-go` без форка.
- [`docs/ru/status_outdated_architecture.md`](docs/ru/status_outdated_architecture.md) —
  почему `status-go` устроен сложно (историческая справка).
- [`docs/ru/tests.md`](docs/ru/tests.md) — уровни тестов, что покрыто и что
  проверяется руками.
- [`docs/PLAN.md`](docs/PLAN.md) — план работ, разбор внешнего аудита,
  ближайшие большие задачи.

## Сборка

Stauri требует заранее собранных `status-backend` и `libsds.so` — **из одного
Nix-окружения**, иначе бэкенд падает с `SIGSEGV` при загрузке `libsds.so`.

```bash
# 1. Собрать status-backend в Nix
cd ~/ETH/github.status-go
nix develop --extra-experimental-features 'nix-command flakes'
unset CGO_LDFLAGS CGO_CFLAGS
make status-backend

# 2. Положить бинарники в Stauri
cp build/bin/status-backend \
   ~/ETH/stauri/stauri-app/src-tauri/binaries/status-backend-x86_64-unknown-linux-gnu
find /nix/store -name "libsds.so"   # взять тот, что был в -L при линковке
cp /nix/store/<hash>-nim-sds-.../lib/libsds.so \
   ~/ETH/stauri/stauri-app/src-tauri/binaries/libsds.so

# 3. Запустить
cd ~/ETH/stauri/stauri-app
pnpm install
pnpm tauri dev

# 4. Собрать AppImage
./scripts/release.sh 0.2.0
```

Подробности о сборке бэкенда, `patchelf` и Nix-интерпретаторе — в
[`README.md`](README.md).

## Тесты

```bash
pnpm test        # frontend: 241 тест в 23 файлах
pnpm test:rust   # backend: 113 тестов
pnpm test:e2e    # Playwright, запускает реальное приложение
```

## Что дальше

Ближайшие задачи, в порядке: убрать явные недоделки, собрать бинарник для
Android (затем Windows), показать Stauri команде Status и получить одобрение
усилий. Подробности — в [`docs/PLAN.md`](docs/PLAN.md), этап 5.

## Лицензия

См. [`LICENSE.md`](LICENSE.md) в корне репозитория.
