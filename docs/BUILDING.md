# Building Stauri

This document describes building `libstatus.so` and `libsds.so` (desktop and
Android) and Stauri itself. `status-go` runs inside the application process;
there is no separate backend binary any more. Status as of 2026-11-22: the
desktop build compiles and runs, PIN sign-in, profile creation, network
switching without a restart, chats, contacts and messages have been verified;
Android builds, and sign-in, profile creation and network switching have been
verified on a device, the wallet is in progress; Windows has not been built.

## Prerequisites

- **Nix** (flakes), with the user added to `trusted-users` (`/etc/nix/nix.conf`).
  Without that Nix ignores the `nix-cache.status.im` cache from the flakes'
  `nixConfig`.
- **Rust** ≥ 1.85 (edition 2024), target `aarch64-linux-android` for Android.
- **Node.js** ≥ 20 + **pnpm**.
- **Tauri system packages on Linux**:
  `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf`.
- For Android: JDK 17, Android SDK (platform 35, build-tools 35.0.0),
  NDK **27.2.12479018**, `tauri-cli` 2.x.

## Important: environment variables

Before any build of `status-go` and `libsds`, remove the variables of local
experiments (vosk, whisper, portaudio, onnxruntime). They mix system libraries
into the build and cause a SIGSEGV when `nix develop` starts:

```bash
unset CGO_LDFLAGS CGO_CFLAGS LD_LIBRARY_PATH LIBRARY_PATH
# or, for a single command:
env -u CGO_LDFLAGS -u CGO_CFLAGS -u LD_LIBRARY_PATH -u LIBRARY_PATH <command>
```

## Stauri's patch to `status-go`

A strict Stauri build is **upstream + one commit**, not plain upstream.

- Pinned commit: `766535cf3` (tested, `develop`).
- Patch: `src-tauri/status-go/stauri-close-accounts.patch` (a `git format-patch`
  file, 2 files: `pkg/backend/geth_backend.go` and `mobile/status.go`).
- Fork with the `stauri/close-accounts` branch: `magnus-redkin/status-go`.

Why: `status-go` opens `accounts.sql` once per process (`OpenAccounts` returns
immediately after the first open), so switching networks inside the process
returns another profile list. The patch adds `CloseAccounts` — a method that
closes this database so the next `InitializeApplication` opens the right
directory. Without the patch, network switching degrades to "restart the
application" and the `switch_network` command answers with an error; the rest of
the scenarios work.

The patch **adds** one export, `CloseAccounts`; it changes and removes nothing.
A vanilla `libstatus.so` loads and works in Stauri as is.

`build/bin/statusgo-lib/main.go`, which is compiled into `libstatus`, is produced
by the generator `tools/generate-cbindings` from `mobile/status.go`, so there is
no third file in the patch — the export appears by itself.

## 1. Building `libstatus.so` in Nix (desktop)

```bash
git clone https://github.com/status-im/status-go.git ~/ETH/github.status-go
cd ~/ETH/github.status-go
git checkout 766535cf3   # tested commit
# Stauri patch (one commit):
git apply ~/ETH/stauri/stauri-app/src-tauri/status-go/stauri-close-accounts.patch

env -u CGO_LDFLAGS -u CGO_CFLAGS -u LD_LIBRARY_PATH -u LIBRARY_PATH \
  nix develop --extra-experimental-features 'nix-command flakes' --command make statusgo-shared-library
```

Result: `build/bin/libstatus.so` and `build/bin/libstatus.so.0` (SONAME).
Stauri takes `libstatus.so.0` and places it under the name `libstatus.so`.

Check that the patch made it into the build:

```bash
nm -D --defined-only build/bin/libstatus.so | grep -w CloseAccounts
# expect a line like "… T CloseAccounts"
```

The `make statusgo-library` target produces a static `libstatus.a` — Stauri does
not need it. The desktop build needs `statusgo-shared-library`.

## 2. `libsds.so` for the desktop

`libsds.so` comes from the Nix store — from the same environment as the library
(one glibc, one ABI). The path is visible in the build log
(`-L/nix/store/…-nim-sds-…/lib -lsds`):

```bash
env -u CGO_LDFLAGS -u CGO_CFLAGS -u LD_LIBRARY_PATH -u LIBRARY_PATH \
  nix develop --extra-experimental-features 'nix-command flakes' --command bash -c 'echo $LIBSDS'
```

Verified path: `/nix/store/gczmis7bgww5azpihnzlsyfz3yjgsbjc-nim-sds-d317821f/lib/libsds.so`.

## 3. Copy the artifacts into Stauri

```bash
cp ~/ETH/github.status-go/build/bin/libstatus.so.0 \
   ~/ETH/stauri/stauri-app/src-tauri/binaries/libstatus.so
cp /nix/store/gczmis7bgww5azpihnzlsyfz3yjgsbjc-nim-sds-d317821f/lib/libsds.so \
   ~/ETH/stauri/stauri-app/src-tauri/binaries/libsds.so
```

On `cargo build` (including `tauri dev`), `src-tauri/build.rs` copies both files
next to the executable (`target/debug` or `target/release`). The library is
looked up exactly there; the `STAURI_LIBSTATUS` variable sets a different path.

## 4. Verification

```bash
cd ~/ETH/stauri/stauri-app/src-tauri
cargo build
cmp target/debug/libstatus.so binaries/libstatus.so && echo "copied"
```

A full check is running the application: the log should contain the line
`start_backend called`, then `InitializeApplication ok`. If the library is
missing, `start_backend` returns `cannot load …/libstatus.so`.

## 5. Running Stauri (desktop)

```bash
cd ~/ETH/stauri/stauri-app
pnpm install
pnpm tauri dev
```

### Clean profile when checking a release

The profile (keys, databases, chats) lives in the application data directory.
Running the release build as is picks up your working profile and password, so
checking sign-in and profile creation on it is pointless. `scripts/clean-env.sh`
exists for that: it sets its own directories through `STAURI_DATA_DIR` and
`STAURI_CONFIG_DIR`, while the build itself stays real.

```bash
./scripts/clean-env.sh /tmp/upd-check/beta.AppImage
# or with a persistent directory (needed to check signing in again):
./scripts/clean-env.sh /tmp/upd-check/beta.AppImage --keep-dir /tmp/stauri-clean-1
```

Default directories: `/tmp/stauri-clean/<name>-<time>`. The working profile in
`~/.local/share/com.magnus.stauri-app/` is not touched.

Variables (see `src-tauri/src/appdirs.rs`):

| Variable | What it sets |
|---|---|
| `STAURI_DATA_DIR` | directory for the profile and logs (absolute path) |
| `STAURI_CONFIG_DIR` | configuration directory: `rpc-proxy.secret` and so on |
| `STAURI_DEBUG_TRACE=1` | verbose bridge trace (replies up to 4000 characters) |
| `STAURI_NETWORK` | network: `mainnet` (default), `sepolia`, `holesky` |
| `STAURI_CONFIG_PATH` | path to a JSON config instead of the variables |

A relative path in `STAURI_DATA_DIR` is ignored with a warning in the log: when
an AppImage is started, the current directory is not obvious.

## 6. Building the AppImage

```bash
cd ~/ETH/stauri/stauri-app
./scripts/release.sh 0.2.0
```

`release.sh` builds the AppImage natively (Ubuntu 24.04+), copies `libstatus.so`
into `AppDir/usr/bin/` (next to the executable), `libsds.so` into `AppDir/usr/lib/`,
sets `RPATH=$ORIGIN` and runs linuxdeploy. Requires
`TAURI_SIGNING_PRIVATE_KEY_PATH` (without the signing key the script stops — an
unsigned AppImage will not receive updates).

## 7. Android: `libsds.so` and `libstatus.so`

Android libraries are built separately from the desktop ones.

**libsds (arm64).** Through the `nim-sds` flake (not through `make` directly — a
direct `make` fails with `unlisted exception` in `sds_lifecycle_request.nim:41`):

```bash
cd ~/ETH/nim-sds   # local copy with submodules
env -u CGO_LDFLAGS -u CGO_CFLAGS -u LD_LIBRARY_PATH -u LIBRARY_PATH \
  nix build --no-accept-flake-config --no-link --print-out-paths \
  --option substituters '' \
  'git+file:///home/michael/ETH/nim-sds?submodules=1#libsds-android-arm64'
```

Result: `<out>/jni/libsds.so` (AArch64, bionic). `--option substituters ''` is
needed when `nix-cache.status.im` is unreachable (HTTP 522): without it Nix
waits for the cache.

**libstatus.so (arm64).** Requires Nim **2.2.10** (the Nix recipe for `libtkl`
uses it); the system 2.2.4 and the store builds of 2.2.4 fail at `libtkl.nim:148`
(`GC_fullCollect() can raise an unlisted exception`):

```bash
cd ~/ETH/github.status-go
NDK=$HOME/Android/sdk/ndk/27.2.12479018
P=<out libsds from the previous step>   # path with jni/libsds.so
PATH=$HOME/.local/nim-2.2.10/bin:$PATH \
ANDROID_NDK_ROOT=$NDK NIM_SDS_LIB_DIR=$P/jni \
NIM_SDS_INC_DIR=/nix/store/gczmis7bgww5azpihnzlsyfz3yjgsbjc-nim-sds-d317821f/include \
ARCH=arm64 make -o build-libsds-android statusgo-android-library
```

`-o build-libsds-android` skips rebuilding `libsds` inside `make` (otherwise it
calls `nim-sds` through the NDK). Result: `build/bin/libstatus.so` (AArch64,
exports `CallRPC`, `InitializeApplication`, `CloseAccounts`, `LoginAccount`,
`CreateAccountAndLogin`, `Logout`, `SetSignalEventCallback`). The patch from §1
is applied the same way: a `github.status-go` repo with the branch, or
`git apply` before this command.

`$P` is **only** the result of the previous step (arm64, bionic). The desktop
`libsds` from the Nix store (`gczmis…/lib`) will not do here: the linker fails
with `libsds.so is incompatible with aarch64linux`. If `P` is lost, rebuild
`libsds` with the command above and take `<out>/jni`.

Copy into the project — into `src-tauri/binaries/android/`, **not** into `gen/`:

```bash
mkdir -p ~/ETH/stauri/stauri-app/src-tauri/binaries/android/arm64-v8a
cp -L <out>/jni/libsds.so      ~/ETH/stauri/stauri-app/src-tauri/binaries/android/arm64-v8a/libsds.so
cp -L build/bin/libstatus.so.0 ~/ETH/stauri/stauri-app/src-tauri/binaries/android/arm64-v8a/libstatus.so
```

Why not into `gen/android`: this directory is in `.gitignore`, `tauri android
init` recreates it entirely, and everything that was in `jniLibs` disappears.
That is exactly how a build once produced an APK without `libstatus.so` — the
application started, but the backend did not load and profile creation failed
with "the backend is not running".

`scripts/sync-android-native.sh` copies the files from
`src-tauri/binaries/android/<abi>/` into `gen/android/app/src/main/jniLibs/<abi>/`
on every build (it is called by `beforeBuildCommand`), and if
`arm64-v8a/libstatus.so` is missing, it stops the build with an error instead of
producing a broken APK. `src-tauri/binaries/*` is ignored by git (see
`.gitignore`), so the libraries themselves do not end up in the repository: they
have to be obtained following the instructions above on each machine.

## 8. Android: APK

Once: `cargo tauri android init` (creates `src-tauri/gen/android`, the directory
is ignored by git). Then:

```bash
cd ~/ETH/stauri/stauri-app
export ANDROID_HOME=$HOME/Android/sdk NDK_HOME=$HOME/Android/sdk/ndk/27.2.12479018
cargo tauri android build --debug --apk --target aarch64
```

APK: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.

Notes:
- The first Rust build for Android compiles ~305 crates and takes a noticeable
  amount of time; afterwards it is incremental.
- Do not run two builds at once: the second `gradlew` waits for the lock
  (`Blocking waiting for file lock on Android`). An idle daemon can be stopped:
  `cd src-tauri/gen/android && ./gradlew --stop`.
- `src-tauri/tauri.android.conf.json` clears `resources` for Android: on a phone
  `libsds.so` is placed through `jniLibs`, not as a bundle resource.

Installing on a phone (USB, debugging enabled, "Install via USB" allowed on MIUI):

```bash
export PATH="$HOME/Android/sdk/platform-tools:$PATH"
adb devices         # the device must be in the "device" state
adb install -r "$APK"
adb shell am start -n com.magnus.stauri_app/.MainActivity
```

Logs:

```bash
adb logcat -s stauri:V     # Rust (logcat logger, tag stauri)
adb logcat -d | grep -i "libstatus\|UnsatisfiedLink\|FATAL\|AndroidRuntime"
```

Bridge trace (a test feature, not disabled before release). The file
`bridge-trace.log` lives in the application data directory and is written on
every `status_call` (`call`, `ok`, `err`) and on frontend notes (`note`).
`run-as` works only in a debug build:

```bash
adb shell run-as com.magnus.stauri_app tail -n 50 bridge-trace.log
adb shell run-as com.magnus.stauri_app rm -f bridge-trace.log   # before a new run
```

The trace does not contain the password: only its length and the first 16
characters of SHA-256. The `CallRPC` reply is a JSON-RPC envelope
(`{"jsonrpc","id","result"}`); the settings fields are inside `result`.

## 9. Windows

The verified path: **the application is built on Windows, the native libraries
on Linux**. Windows needs only VS Build Tools (C++ workload), Rust MSVC, Node
and pnpm. Everything related to Nim is done on the Linux host.

### 9.1 Native libraries (on Linux)

```
./scripts/build-windows-native.sh --check          # what is available on the machine
./scripts/build-windows-native.sh                  # build into ~/ETH/stauri/winbuild
./scripts/build-windows-native.sh --work /tmp/wb   # another location
```

The script clones three repositories into the work directory (not into the
Stauri repository) and puts the result into `src-tauri/binaries/libstatus.dll`
and `libsds.dll`.

What exactly it does and why:

| Step | Reason |
|---|---|
| `nim-token-lists` at the revision from `status-go/scripts/tkl.version` | `go.mod` refers to this commit; at another revision `tkl.h` does not contain `tkl_load_stored`, and the build fails in cgo |
| `scripts/build_lib.sh` with `EXTRA_NIMFLAGS`, not `make lib` | `make` in this repository does not pass `NIM_PARAMS`, and the archive comes out as ELF instead of COFF |
| `isolate_lib.sh` + `libtkl.target` | Nim runtime symbols are made local so they do not collide with the `libsds` runtime; `tkl.target` tells status-go which platform the archive is for |
| `--skipUserCfg:on` for `nim-sds` | `~/.config/nim/nim.cfg` with `legacy:laxEffects` enables strict effects, and the build fails at `sds_lifecycle_request.nim` with `Exception can raise an unlisted exception` |
| `--passL:"-static-libgcc"` (Nim) and `-static-libgcc` in `CGO_LDFLAGS` | otherwise both DLLs depend on `libgcc_s_seh-1.dll`, which does not exist on Windows; `LoadLibrary` fails and the application reports "the backend is not running" |
| `-tags gowaku_no_rln` | the RLN package is built for Linux (`-ldl`, `.llvmbc`); it is not needed on Windows and is disabled by default in the status-go Makefile |
| Generators (`protoc`, `go-bindata`, mocks, `messenger_handlers.go`, `go:embed` files) | these files are not in Git; without them `go build` cannot see the `*/migrations` packages and the `Messenger` methods |

Checking the result:

```
x86_64-w64-mingw32-objdump -p src-tauri/binaries/libstatus.dll | grep CloseAccounts
```

`CloseAccounts` must be among the exports — that is our patch.

### 9.2 Building the application (Windows)

```
pnpm install
pnpm tauri build --no-bundle                     # check: the exe next to the two DLLs
powershell -ExecutionPolicy Bypass -File scripts\release-windows.ps1 -Version <version>
```

`src-tauri/tauri.windows.conf.json` is merged over the main config: NSIS target,
`libsds.dll` resource instead of `libsds.so`. `build.rs` copies the `.dll` next
to the exe the same way it copies the `.so` on Linux.

If the application crashes at startup with "the backend is not running", first
check that `libsds.dll` is next to the exe — the loader looks for it in the
process directory, not in PATH.

### 9.3 What to check on Windows

Profile creation and sign-in, a chat with a Linux peer in both directions,
network switching without a restart (the reason for the patch), the wallet and
balances, the `.eth` name, a Telegram feed, auto-update. The update key and the
shared `latest.json` stay on the Linux host: the installer and `.sig` are moved
there and `scripts/release-windows-assets.sh` signs the installer when needed,
merges `windows-x86_64` into the manifest and uploads all three. The platform
key in the manifest is `windows-x86_64`.

## Known issues

- **`nix develop` crashes with SIGSEGV (code 139)** — almost always because of
  `LD_LIBRARY_PATH`/`CGO_*` from local experiments. The fix is `env -u …` (see
  above).
- **Nix does not use the `nix-cache.status.im` cache** — the user is not in
  `trusted-users`, or the server is unreachable (HTTP 522). Fixes:
  `trusted-users` or `--option substituters ''` (local build, slower).
- **`libsds` d317821 does not build with the system Nim 2.2.4** (`unlisted
  exception` in `sds_lifecycle_request.nim:41`). It builds through the `nim-sds`
  flake (Nix path).
- **`libtkl.nim:148` does not build with Nim 2.2.4** — Nim 2.2.10 is required.
- **The managed copy of `nim-token-lists` is protected from edits**
  (`scripts/tkl_native.sh` checks `git diff`). A local patch does not work there
  — an upstream change or a decision to drop the check is needed.
- **patchelf assertion `splitIndex != -1`** on some binaries. Workaround:
  `--remove-rpath` + `--set-rpath`, or do not patch RPATH (`libsds.so` next to
  it, `RPATH=$ORIGIN`).
- **ldd segfaults on the library** during linuxdeploy. Workaround: a
  `/tmp/bin/ldd` wrapper that answers "statically linked" for `libstatus.so`.
- **`dApp` windows and `open_dapp` on Android** are not supported (stub).
- **`wakuext_*` is unavailable in `libstatus.so`** (`method does not exist`):
  after sign-in, `wakuext_chats`, `wakuext_communities`, `wakuext_contacts` do
  not answer. Chats and channels on the phone do not work yet.

## Integration tests (separate, not in CI)

The tests live in `tests/integration/` and exercise the client on two or three
nodes. Each node is a separate process of `tests/integration/libstatus_node.py`:
a small HTTP facade over `libstatus.so` (through `ctypes`), the same code the
application loads. Requires `src-tauri/binaries/libstatus.so` and `libsds.so`
(see steps 1–3 above) and a network.

Before the first send, a node waits `WARMUP` seconds (60 by default): a message
sent before connecting to relay peers is lost without an error.

```bash
./tests/integration/contact.sh   # contact invitation (pnpm test:integration)
./tests/integration/chat.sh      # direct chat: message and reply
./tests/integration/channel.sh   # news / request / issues channels
./tests/integration/wallet.sh    # transfer between nodes on a local chain
```

The shared harness is `tests/integration/lib.sh`: starting a node, creating a
profile, signing in, `CallRPC` calls. Variables: `BASE_PORT` (node ports, 34500
and 34501 by default), `TIMEOUT` (delivery through Waku, 120 s by default),
`PASSWORD`, `KEEP=1` (do not delete the directory with node logs after the run).

**Channels** (`channel.sh`). The order of the steps matters: first the
participant joins, then the author writes posts. This build has no catching-up
history request (`wakuext_requestCommunityInfoFromMailserver` is absent), so
posts sent before joining are not seen by the participant. Types: `news` —
auto-accept; `request` and `issues` — by request (`MANUAL_ACCEPT`), the owner
accepts it by calling `wakuext_acceptRequestToJoinCommunity`. The "only the
author writes posts" right lives in the interface (`channelRights.ts`):
status-go does not distinguish it, so it is not enforced at the API level.

**Wallet** (`wallet.sh`). A local `anvil` chain with a Sepolia-compatible
`chain-id 11155111` and a substituted RPC provider
(`networks_setChainUserRpcProviders`, `type: "user"`) is used, so the real
network and real funds are not involved. The transfer path is the same as in
`src-tauri/src/transfer.rs`: `wallet_buildTransaction` → `wallet_signMessage` →
`wallet_sendTransactionWithSignature` (the signature comes back with `0x`, the
prefix has to be stripped). Verification happens in the chain itself
(`cast balance`, `cast receipt status=1`). The balance cache in the node is not
updated on a local chain: the node fills it with its built-in network provider,
so the "balance in the node" step is informational.

For mainnet (`CHAIN_ID=1`) the path does not work: the node only talks to its
built-in providers (Infura/Grove) and returns 401 — it does not use the
substituted URL for mainnet.

**Delivery and exit code.** Everything that goes through Waku may not finish
within `TIMEOUT` — that is the network, not a format error. That is why the
tests are in neither `pnpm test` nor CI: run them as a separate command.

**What these tests do not check.** The interface. Errors like "the chat stays
pending after Accept", message order, hidden system events — that is the Svelte
level, served by `vitest` and manual runs through `tests/scenarios/`.

## Build checks (CI)

CI (`.github/workflows/ci.yml`) currently runs: `pnpm check`, `pnpm lint`,
`pnpm test`, `pnpm build`, AppStream validation, `cargo fmt --check`,
`cargo clippy -D warnings`, `cargo test`. The Nix artifacts (`libstatus.so`,
`libsds.so`) are **not built** in CI: empty stub files are put there so that
`tauri-build` passes. The Android build is not configured in CI yet.
