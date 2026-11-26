#!/usr/bin/env bash
# build-windows-native.sh — нативные библиотеки Windows, собранные на Linux.
#
#   ./scripts/build-windows-native.sh                    # в ~/ETH/stauri/winbuild
#   ./scripts/build-windows-native.sh --work /tmp/wb     # другое место
#   ./scripts/build-windows-native.sh --check            # только проверки инструментов
#
# Что собирается и откуда берётся:
#   nim-sds           — из тега (по умолчанию v0.3.4) → libsds.dll
#   nim-token-lists   — ровно на ревизии из status-go/scripts/tkl.version → libtkl.a
#   status-go         — из нашего форка, ветка stauri/close-accounts → libstatus.dll
#
# Результат копируется в src-tauri/binaries/: libstatus.dll и libsds.dll.
# libtkl вливается в libstatus.dll при линковке, отдельным файлом не нужен.
#
# Что нужно на машине: mingw-w64 (x86_64-w64-mingw32-gcc), Go, Nim 2.2.x, make,
# protoc и protoc-gen-go той же версии, что google.golang.org/protobuf в
# status-go/go.mod, git, curl, sha256sum.
#
# Почему не в Windows: status-go на Windows тянет Nim-библиотеки, а ни одна из них
# не публикует готовых артефактов. Кросс-сборка на Linux использует тот же Nim и
# тот же mingw, а в Windows остаётся только сборка приложения.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${WORK:-$HOME/ETH/stauri/winbuild}"
NIM="${NIM:-nim}"
CC="${CC:-x86_64-w64-mingw32-gcc}"
GO="${GO:-go}"
STATUS_GO_REPO="${STATUS_GO_REPO:-https://github.com/magnus-redkin/status-go.git}"
STATUS_GO_BRANCH="${STATUS_GO_BRANCH:-stauri/close-accounts}"
NIM_SDS_TAG="${NIM_SDS_TAG:-v0.3.4}"
NIM_SDS_REPO="${NIM_SDS_REPO:-https://github.com/waku-org/nim-sds.git}"
NIM_TKL_REPO="${NIM_TKL_REPO:-https://github.com/status-im/nim-token-lists.git}"
CHECK_ONLY=0

die()  { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "=== $*"; }
ok()   { echo "  ✓ $*"; }
warn() { echo "  ! $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --work) WORK="${2:?--work требует путь}"; shift ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
  shift
done

# ---------- Проверки инструментов ----------

step "Инструменты"
for tool in "$CC" "$NIM" "$GO" make protoc git curl sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "не найден: $tool"
  ok "$tool → $(command -v "$tool")"
done
command -v protoc-gen-go >/dev/null 2>&1 || die "protoc-gen-go не найден: go install google.golang.org/protobuf/cmd/protoc-gen-go@<версия из go.mod>"
ok "protoc-gen-go → $(protoc-gen-go --version 2>/dev/null | head -1)"

"$CC" -dumpmachine | grep -Eq '^x86_64-.*mingw' || die "$CC не MinGW для x86_64"
ok "компилятор: $("$CC" -dumpmachine)"

NIM_V="$("$NIM" --version 2>/dev/null | head -1)"
case "$NIM_V" in
  *"Version 2.2"*) ok "$NIM_V" ;;
  *) warn "$NIM_V — ожидалась 2.2.x; 1.9 и 2.0 не подойдут" ;;
esac

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  echo
  echo "Проверки пройдены (--check: ничего не собрано)."
  exit 0
fi

mkdir -p "$WORK"

# ---------- status-go ----------

step "status-go ($STATUS_GO_BRANCH)"
if [[ ! -d "$WORK/status-go/.git" ]]; then
  git clone --branch "$STATUS_GO_BRANCH" "$STATUS_GO_REPO" "$WORK/status-go"
else
  git -C "$WORK/status-go" fetch origin "$STATUS_GO_BRANCH"
  git -C "$WORK/status-go" checkout -q "$STATUS_GO_BRANCH"
  git -C "$WORK/status-go" pull --ff-only
fi
cd "$WORK/status-go"
ok "HEAD $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"

TKL_PIN="$(cat scripts/tkl.version)"
[[ "$TKL_PIN" =~ ^[0-9a-f]{40}$ ]] || die "scripts/tkl.version: ожидался 40-символьный хеш"
ok "пин nim-token-lists: ${TKL_PIN:0:12}"

PROTOBUF_VER="$(grep -m1 'google.golang.org/protobuf ' go.mod | awk '{print $2}')"
ok "google.golang.org/protobuf $PROTOBUF_VER"

# ---------- nim-token-lists (libtkl) ----------

step "libtkl ($TKL_PIN)"
if [[ ! -d "$WORK/nim-token-lists/.git" ]]; then
  git clone "$NIM_TKL_REPO" "$WORK/nim-token-lists"
fi
cd "$WORK/nim-token-lists"
git fetch --all --quiet
git checkout -q "$TKL_PIN"
git submodule update --init --recursive --quiet
ok "HEAD $(git rev-parse --short HEAD)"

# Внимание: `make lib` этого репозитория вызывает scripts/build_lib.sh и не передаёт
# NIM_PARAMS, поэтому кросс-флаги идут через EXTRA_NIMFLAGS.
rm -rf build/win
env NIM="$NIM" OUT=build/win \
  EXTRA_NIMFLAGS="--os:windows --cpu:amd64 -d:mingw --cc:gcc --gcc.exe:$CC --gcc.linkerexe:$CC" \
  bash scripts/build_lib.sh >/dev/null
[ -f build/win/libtkl.a ] || die "libtkl.a не собрался"
"$CC" -dumpmachine >/dev/null
if x86_64-w64-mingw32-objdump -f build/win/libtkl.a 2>/dev/null | grep -q 'elf64'; then
  die "libtkl.a собрался в ELF: EXTRA_NIMFLAGS не подхватились"
fi
ok "libtkl.a: COFF $(du -h build/win/libtkl.a | cut -f1)"

OUT=build/win TKL_LD=x86_64-w64-mingw32-ld bash scripts/isolate_lib.sh >/dev/null
mkdir -p build/win/link
cp build/win/libtkl_isolated.a build/win/link/libtkl.a
printf 'windows/amd64' > build/win/link/libtkl.target
ok "изолированный архив и libtkl.target готовы"

# ---------- nim-sds (libsds) ----------

step "libsds ($NIM_SDS_TAG)"
if [[ ! -d "$WORK/nim-sds/.git" ]]; then
  git clone --recurse-submodules --branch "$NIM_SDS_TAG" "$NIM_SDS_REPO" "$WORK/nim-sds"
fi
cd "$WORK/nim-sds"
git fetch --tags --quiet
git checkout -q "$NIM_SDS_TAG"
git submodule update --init --recursive --quiet
rm -f sds.nims   # симлинк от прошлых запусков make ломает nix и повторные сборки
ok "HEAD $(git rev-parse --short HEAD)"

# Список вендорных путей готовит сам проект; make может вернуть ошибку, файл при этом
# уже создан — поэтому «|| true» и проверка файла.
make nimbus-build-system-paths >/dev/null 2>&1 || true
[ -f nimbus-build-system.paths ] || die "nimbus-build-system.paths не создан"
sed 's/--path:"\(.*\)"/--path:\1/' nimbus-build-system.paths > "$WORK/sds-paths.txt"

# --skipUserCfg:on обязателен: ~/.config/nim/nim.cfg (legacy:laxEffects) включает
# строгие эффекты и компиляция падает на sds_lifecycle_request.nim.
mapfile -t SDS_PATHS < "$WORK/sds-paths.txt"
mkdir -p build
"$NIM" c "${SDS_PATHS[@]}" --skipUserCfg:on -d:disableMarchNative \
  --out:build/libsds.dll --threads:on --app:lib --opt:size --noMain --mm:refc \
  --header --nimMainPrefix:libsds --warning:Deprecated:off \
  --os:windows --cpu:amd64 -d:mingw --cc:gcc \
  --gcc.exe:"$CC" --gcc.linkerexe:"$CC" \
  --passL:"-static-libgcc" \
  -d:git_version="\"$NIM_SDS_TAG\"" library/libsds.nim >/dev/null
[ -f build/libsds.dll ] || die "libsds.dll не собрался"
ok "libsds.dll: $(du -h build/libsds.dll | cut -f1)"

# ---------- генераторы status-go ----------

step "Генерация кода status-go"
cd "$WORK/status-go"

# Файлы для go:embed; в Git их нет, Makefile создаёт их генераторами.
git rev-parse --short HEAD > pkg/version/GIT_COMMIT
git describe --tags > pkg/version/VERSION 2>/dev/null || printf 'stauri' > pkg/version/VERSION
printf 'stauri' > pkg/sentry/SENTRY_CONTEXT_NAME
printf 'stauri' > pkg/sentry/SENTRY_CONTEXT_VERSION
printf 'false' > pkg/sentry/SENTRY_PRODUCTION
ok "version и sentry"

for dir in internal/protocol/protobuf pkg/messaging/layers/encryption \
           pkg/messaging/layers/segmentation/protobuf pkg/messaging/layers/reliability/protobuf; do
  ( cd "$dir" && protoc -I. --go_out=. --go_opt=paths=source_relative ./*.proto ) \
    || die "protoc: $dir"
done
ok "protobuf"

go generate ./internal/db/... ./pkg/messaging/... ./internal/protocol/... \
  ./pkg/services/newsfeed/... ./pkg/services/connector/chainutils/... >/dev/null
ok "миграции и моки"

( cd tools/generate-handlers && go run main.go >/dev/null ) || die "generate-handlers"
ok "messenger_handlers.go"

mkdir -p build/bin/statusgo-lib
go run ./tools/generate-cbindings > build/bin/statusgo-lib/main.go || die "generate-cbindings"
grep -q CloseAccounts build/bin/statusgo-lib/main.go \
  || die "в биндингах нет CloseAccounts: собрана не та ветка"
ok "cbindings с CloseAccounts"

# ---------- libstatus.dll ----------

step "libstatus.dll (кросс-сборка)"
export GOOS=windows GOARCH=amd64 CGO_ENABLED=1 CC="$CC"
export CGO_CFLAGS="-I$WORK/nim-sds/library"
# -static-libgcc: без него и libstatus.dll, и libsds.dll тянут libgcc_s_seh-1.dll,
# которой в Windows нет, и LoadLibrary падает с «the backend is not running».
export CGO_LDFLAGS="-L$WORK/nim-sds/build -lsds -static-libgcc"
export TKL_BASE_CGO_CFLAGS="$CGO_CFLAGS"
export TKL_BASE_CGO_LDFLAGS="$CGO_LDFLAGS"
export NIM_TKL_INC_DIR="$WORK/nim-token-lists/abi"
export NIM_TKL_LIB_DIR="$WORK/nim-token-lists/build/win/link"

# gowaku_no_rln обязателен: RLN-пакет собран для Linux (-ldl) и в Windows-сборке
# не нужен. В Makefile status-go этот тег тоже входит в BUILD_TAGS по умолчанию.
bash scripts/tkl_env.sh go build -tags gowaku_no_rln \
  -buildmode=c-shared -o build/bin/libstatus.dll ./build/bin/statusgo-lib

[ -f build/bin/libstatus.dll ] || die "libstatus.dll не собрался"
x86_64-w64-mingw32-objdump -p build/bin/libstatus.dll | grep -q CloseAccounts \
  || die "CloseAccounts отсутствует в экспортах libstatus.dll"
ok "libstatus.dll: $(du -h build/bin/libstatus.dll | cut -f1), CloseAccounts на месте"

# Обе DLL должны обходиться без mingw-рантайма: libgcc_s_seh-1.dll в Windows нет,
# и её отсутствие видно только при запуске, как «the backend is not running».
for dll in build/bin/libstatus.dll "$WORK/nim-sds/build/libsds.dll"; do
  if x86_64-w64-mingw32-objdump -p "$dll" | grep -q 'libgcc_s'; then
    die "$(basename "$dll") зависит от libgcc_s — проверьте -static-libgcc"
  fi
done
ok "внешних зависимостей mingw нет"

# ---------- В src-tauri/binaries ----------

step "Копирование в src-tauri/binaries"
mkdir -p "$ROOT/src-tauri/binaries"
cp "$WORK/status-go/build/bin/libstatus.dll" "$ROOT/src-tauri/binaries/libstatus.dll"
cp "$WORK/nim-sds/build/libsds.dll" "$ROOT/src-tauri/binaries/libsds.dll"
ls -lh "$ROOT/src-tauri/binaries/libstatus.dll" "$ROOT/src-tauri/binaries/libsds.dll" | awk '{print "  "$9" "$5}'

cat <<EOF

Готово. Дальше в Windows:
  pnpm install
  pnpm tauri build --no-bundle      # проверка: exe рядом с двумя DLL
  powershell -File scripts\\release-windows.ps1 -Version <версия>

Если приложение падает при старте с "the backend is not running", проверьте, что
libsds.dll лежит рядом с exe (и в каталоге установки).
EOF
