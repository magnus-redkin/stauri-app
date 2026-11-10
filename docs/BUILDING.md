# Сборка Stauri

Документ описывает сборку `status-backend` (десктоп), `libsds.so`, `libstatus.so`
(Android) и самого Stauri. Состояние на 2026-11-10: десктоп собирается и
запускается; Android собирается, вход на телефоне в работе; Windows не собран.
Открытые задачи — в [`TODO.md`](TODO.md), план — в [`PLAN.md`](PLAN.md).

## Пререквизиты

- **Nix** (flakes), пользователь добавлен в `trusted-users` (`/etc/nix/nix.conf`).
  Без этого Nix игнорирует кэш `nix-cache.status.im` из `nixConfig` флейков.
- **Rust** ≥ 1.85 (edition 2024), цель `aarch64-linux-android` для Android.
- **Node.js** ≥ 20 + **pnpm**.
- **Системные пакеты Tauri на Linux**:
  `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf`.
- Для Android: JDK 17, Android SDK (platform 35, build-tools 35.0.0),
  NDK **27.2.12479018**, `tauri-cli` 2.x.

## Важно: переменные окружения

Перед любой сборкой `status-go` и `libsds` убери переменные локальных
экспериментов (vosk, whisper, portaudio, onnxruntime). Они подмешивают
системные библиотеки и дают SIGSEGV при запуске `nix develop`:

```bash
unset CGO_LDFLAGS CGO_CFLAGS LD_LIBRARY_PATH LIBRARY_PATH
# или, для одной команды:
env -u CGO_LDFLAGS -u CGO_CFLAGS -u LD_LIBRARY_PATH -u LIBRARY_PATH <команда>
```

## 1. Сборка `status-backend` в Nix (десктоп)

```bash
git clone https://github.com/status-im/status-go.git ~/ETH/github.status-go
cd ~/ETH/github.status-go
git checkout 766535cf3   # протестированный коммит

env -u CGO_LDFLAGS -u CGO_CFLAGS -u LD_LIBRARY_PATH -u LIBRARY_PATH \
  nix develop --extra-experimental-features 'nix-command flakes' --command make status-backend
```

Результат: `build/bin/status-backend` (≈113 МБ). Проверено: сборка даёт бинарник
побайтно равный тому, что лежит в `src-tauri/binaries/`.

## 2. `libsds.so` для десктопа

`libsds.so` берётся из Nix store — из того же окружения, что и бинарник
(одна glibc, один ABI). Путь виден в логе сборки (`-L/nix/store/…-nim-sds-…/lib -lsds`):

```bash
env -u CGO_LDFLAGS -u CGO_CFLAGS -u LD_LIBRARY_PATH -u LIBRARY_PATH \
  nix develop --extra-experimental-features 'nix-command flakes' --command bash -c 'echo $LIBSDS'
```

Проверенный путь: `/nix/store/gczmis7bgww5azpihnzlsyfz3yjgsbjc-nim-sds-d317821f/lib/libsds.so`.

## 3. Скопировать артефакты в Stauri

```bash
TRIPLE=x86_64-unknown-linux-gnu
cp ~/ETH/github.status-go/build/bin/status-backend \
   ~/ETH/stauri/stauri-app/src-tauri/binaries/status-backend-$TRIPLE
cp /nix/store/gczmis7bgww5azpihnzlsyfz3yjgsbjc-nim-sds-d317821f/lib/libsds.so \
   ~/ETH/stauri/stauri-app/src-tauri/binaries/libsds.so
```

## 4. Проверка

```bash
cd ~/ETH/stauri/stauri-app/src-tauri
LD_LIBRARY_PATH=./binaries ./binaries/status-backend-x86_64-unknown-linux-gnu --help
```

Должно вывести `Usage of …status-backend` (а не segmentation fault).

## 5. Запуск Stauri (десктоп)

```bash
cd ~/ETH/stauri/stauri-app
pnpm install
pnpm tauri dev
```

## 6. Сборка AppImage

```bash
cd ~/ETH/stauri/stauri-app
./scripts/release.sh 0.2.0
```

`release.sh` собирает AppImage нативно (Ubuntu 24.04+), копирует `libsds.so`
рядом с `status-backend` в `AppDir/usr/bin/`, использует `RPATH=$ORIGIN` и
запускает linuxdeploy. Требует `TAURI_SIGNING_PRIVATE_KEY_PATH` (без ключа
подписи скрипт останавливается — AppImage без подписи не получит обновлений).

## 7. Android: `libsds.so` и `libstatus.so`

Android-библиотеки собираются отдельно от десктопных.

**libsds (arm64).** Через флейк `nim-sds` (не через `make` напрямую — прямой
`make` падает на `unlisted exception` в `sds_lifecycle_request.nim:41`):

```bash
cd ~/ETH/nim-sds   # локальная копия с submodules
env -u CGO_LDFLAGS -u CGO_CFLAGS -u LD_LIBRARY_PATH -u LIBRARY_PATH \
  nix build --no-accept-flake-config --no-link --print-out-paths \
  --option substituters '' \
  'git+file:///home/michael/ETH/nim-sds?submodules=1#libsds-android-arm64'
```

Результат: `<out>/jni/libsds.so` (AArch64, bionic). `--option substituters ''`
нужен, если `nix-cache.status.im` недоступен (HTTP 522): без него Nix ждёт кэш.

**libstatus.so (arm64).** Нужен Nim **2.2.10** (его использует Nix-рецепт `libtkl`);
системный 2.2.4 и store-сборки 2.2.4 падают на `libtkl.nim:148`
(`GC_fullCollect() can raise an unlisted exception`):

```bash
cd ~/ETH/github.status-go
NDK=$HOME/Android/sdk/ndk/27.2.12479018
P=<out libsds из предыдущего шага>      # путь с jni/libsds.so
PATH=$HOME/.local/nim-2.2.10/bin:$PATH \
ANDROID_NDK_ROOT=$NDK NIM_SDS_LIB_DIR=$P/jni \
NIM_SDS_INC_DIR=/nix/store/gczmis7bgww5azpihnzlsyfz3yjgsbjc-nim-sds-d317821f/include \
ARCH=arm64 make -o build-libsds-android statusgo-android-library
```

`-o build-libsds-android` пропускает пересборку `libsds` внутри `make`
(иначе он вызывает `nim-sds` через NDK). Результат: `build/bin/libstatus.so` (AArch64,
экспорт `CallRPC`, `InitializeApplication`, `LoginAccount`, `CreateAccountAndLogin`,
`Logout`, `SetSignalEventCallback`).

Копирование в проект (копии, не ссылки):

```bash
cp -L <out>/jni/libsds.so    ~/ETH/stauri/stauri-app/src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libsds.so
cp -L build/bin/libstatus.so.0 ~/ETH/stauri/stauri-app/src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libstatus.so
```

## 8. Android: APK

Один раз: `cargo tauri android init` (создаёт `src-tauri/gen/android`, каталог
игнорируется git). Далее:

```bash
cd ~/ETH/stauri/stauri-app
export ANDROID_HOME=$HOME/Android/sdk NDK_HOME=$HOME/Android/sdk/ndk/27.2.12479018
cargo tauri android build --debug --apk --target aarch64
```

APK: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.

Замечания:
- Первая сборка Rust под Android компилирует ~305 крейтов и занимает заметное
  время; дальше инкрементальная.
- Не запускай две сборки одновременно: второй `gradlew` ждёт блокировку
  (`Blocking waiting for file lock on Android`). Простаивающий демон можно
  остановить: `cd src-tauri/gen/android && ./gradlew --stop`.
- `src-tauri/tauri.android.conf.json` очищает `externalBin` и `resources`
  для Android (sidecar на телефоне не используется).

Установка на телефон (USB, отладка включена, «Установка через USB» разрешена на MIUI):

```bash
export PATH="$HOME/Android/sdk/platform-tools:$PATH"
adb devices         # устройство должно быть в статусе "device"
adb install -r "$APK"
adb shell am start -n com.magnus.stauri_app/.MainActivity
```

Логи:

```bash
adb logcat -s stauri:V     # Rust (logcat-логгер, тег stauri)
adb logcat -d | grep -i "libstatus\|UnsatisfiedLink\|FATAL\|AndroidRuntime"
```

## 9. Windows

Не собран. Что известно: `libsds.dll` через `nim c --os:windows` с MinGW не
находит `chronos`; флейк `nim-sds` для `packages.x86_64-windows` падает на
`buildInputs` (см. `PLAN.md`, раздел B.3). Сборка запланирована на Windows 11
(KVM), см. `TODO.md`.

## Известные проблемы

- **`nix develop` падает с SIGSEGV (код 139)** — почти всегда из-за
  `LD_LIBRARY_PATH`/`CGO_*` от локальных экспериментов. Решение — `env -u …` (см. выше).
- **Nix не использует кэш `nix-cache.status.im`** — пользователь не в `trusted-users`,
  либо сервер недоступен (HTTP 522). Решения: `trusted-users` или
  `--option substituters ''` (локальная сборка, дольше).
- **`libsds` d317821 не собирается с системным Nim 2.2.4** (`unlisted exception`
  в `sds_lifecycle_request.nim:41`). Собирается через флейк `nim-sds` (Nix-путь).
- **`libtkl.nim:148` не собирается с Nim 2.2.4** — нужен Nim 2.2.10.
- **Управляемая копия `nim-token-lists` защищена от правок** (`scripts/tkl_native.sh`
  проверяет `git diff`). Локальный патч там не работает — нужна правка upstream или
  решение о снятии проверки.
- **patchelf assertion `splitIndex != -1`** на некоторых бинарниках. Обход:
  `--remove-rpath` + `--set-rpath`, либо не патчить RPATH (`libsds.so` рядом, `RPATH=$ORIGIN`).
- **ldd segfault на `status-backend`** при linuxdeploy. Обход: обёртка `/tmp/bin/ldd`,
  которая для `status-backend` отвечает «statically linked».
- **`dApp`-окна и `open_dapp` на Android** не поддерживаются (заглушка).

## Проверка сборки (CI)

В CI (`.github/workflows/ci.yml`) сейчас: `pnpm check`, `pnpm lint`, `pnpm test`,
`pnpm build`, AppStream-валидация, `cargo fmt --check`, `cargo clippy -D warnings`,
`cargo test`. Артефакты Nix (`status-backend`, `libsds.so`) в CI **не собираются**:
туда кладутся пустые файлы-заглушки, чтобы `tauri-build` проходил. Android-сборка в CI
пока не настроена.
