#!/usr/bin/env python3
"""A minimal HTTP facade over libstatus, for the integration tests.

The application runs status-go in-process, so the tests should exercise the same
library rather than the old `status-backend` sidecar. This script loads the
library with `ctypes`, calls its C exports, and exposes the two shapes the tests
already use:

    POST /statusgo/CallRPC       -> CallRPC(json-rpc request)
    POST /statusgo/<Endpoint>    -> <Endpoint>(body)

The replies are returned verbatim: `CallRPC` answers with a JSON-RPC envelope,
the lifecycle endpoints (`InitializeApplication`, `CreateAccountAndLogin`,
`LoginAccount`, `Logout`) answer with their whole body.

Usage:

    python3 libstatus_node.py 127.0.0.1:34500

The library path comes from `STAURI_LIBSTATUS`, defaulting to
`src-tauri/binaries/libstatus.so` next to this repository. `libsds.so` is a
runtime dependency, so the caller sets `LD_LIBRARY_PATH` (see `lib.sh`).

Signals are captured through `SetSignalEventCallback` and served from
`POST /statusgo/_signals` (body `{"since": N}`), so a test can assert that an
event arrived as a signal instead of inferring it from a later RPC read. The
application itself gets the same signals through the same C callback; see
`src-tauri/src/lib.rs`.
"""

import ctypes
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Lifecycle endpoints exported by mobile/status.go. Each takes a JSON string and
# returns a JSON string allocated by cgo, which the caller must free.
ENDPOINTS = (
    "CallRPC",
    "InitializeApplication",
    "CreateAccountAndLogin",
    "LoginAccount",
    "RestoreAccountAndLogin",
    # Profile management, used by the recovery screen: the phrase identifies the
    # profile, and a profile whose password is forgotten can be dropped and rebuilt.
    "ValidateMnemonicV2",
    "DeleteMultiaccount",
    "ChangeDatabasePasswordV2",
)
# `Logout(void)` takes no argument and ignores any body.
NO_ARG_ENDPOINTS = ("Logout",)
# Local extension of this facade: the captured signals, not a status-go endpoint.
LOCAL_ENDPOINTS = ("_signals",)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_LIB = os.path.join(REPO, "src-tauri", "binaries", "libstatus.so")

# Signals are appended by Go threads and read by the HTTP thread.
_SIGNALS = []
_SIGNALS_LOCK = threading.Lock()


def install_signal_capture(lib) -> None:
    """Registers a C callback that keeps every signal status-go emits.

    The signature is `void (*)(const char*)`, see `internal/signal/signals.c`.
    The reference to the callback object is kept at module level: ctypes does
    not own the trampoline, and a collected one would crash the process on the
    next signal.
    """
    setter = lib.SetSignalEventCallback
    setter.argtypes = [ctypes.c_void_p]
    setter.restype = None

    global _CALLBACK
    _CALLBACK = ctypes.CFUNCTYPE(None, ctypes.c_char_p)(_on_signal)
    setter(ctypes.cast(_CALLBACK, ctypes.c_void_p))


def _on_signal(raw: bytes) -> None:
    """Callback body: parse and store one signal. Never raises into Go code."""
    try:
        text = raw.decode("utf-8", "replace") if raw else ""
        if text:
            with _SIGNALS_LOCK:
                _SIGNALS.append(text)
    except Exception:  # a raising callback would abort the Go side
        pass



def load_library(path: str) -> ctypes.CDLL:
    """Loads the library and declares the exported signatures."""
    lib = ctypes.CDLL(path)
    for name in ENDPOINTS:
        fn = getattr(lib, name)
        fn.argtypes = [ctypes.c_char_p]
        fn.restype = ctypes.c_void_p
    for name in NO_ARG_ENDPOINTS:
        fn = getattr(lib, name)
        fn.argtypes = []
        fn.restype = ctypes.c_void_p
    return lib


# cgo allocates the reply with C.CString; `free` is the matching release.
_LIBC = ctypes.CDLL(None)
_LIBC.free.argtypes = [ctypes.c_void_p]


def call_string(fn, payload: str) -> str:
    """Calls one export and copies the reply before freeing it."""
    ptr = fn() if fn.argtypes == [] else fn(payload.encode("utf-8"))
    if not ptr:
        return ""
    try:
        raw = ctypes.string_at(ptr)
    finally:
        _LIBC.free(ptr)
    return raw.decode("utf-8", "replace")


def signals_since(body: str) -> list:
    """Signals captured after a given index.

    @param body - JSON `{"since": N}`; the index a caller already saw. Missing or
      malformed bodies mean "everything".
    @returns The signal payloads, already parsed, from index `since` onwards.
    """
    try:
        since = int(json.loads(body or "{}").get("since") or 0)
    except (ValueError, AttributeError, TypeError):
        since = 0
    with _SIGNALS_LOCK:
        chunk = _SIGNALS[since:]
    parsed = []
    for text in chunk:
        try:
            parsed.append(json.loads(text))
        except ValueError:
            continue
    return parsed


def make_handler(lib):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):  # noqa: N802 -- name required by BaseHTTPRequestHandler
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8") if length else ""
            path = self.path.split("?", 1)[0]
            prefix = "/statusgo/"
            name = path[len(prefix):] if path.startswith(prefix) else ""

            if name not in ENDPOINTS and name not in NO_ARG_ENDPOINTS and name not in LOCAL_ENDPOINTS:
                self.reply(404, f'{{"error":"unknown endpoint {name}"}}')
                return

            if name == "_signals":
                self.reply(200, json.dumps(signals_since(body), ensure_ascii=False))
                return

            started = time.monotonic()
            try:
                text = call_string(getattr(lib, name), body)
            except Exception as exc:  # the library must not take the server down
                log(f"error {name}: {exc!r}")
                self.reply(500, json.dumps({"error": str(exc)}))
                return

            took = int((time.monotonic() - started) * 1000)
            label = name
            if name == "CallRPC":
                try:
                    label = json.loads(body).get("method") or name
                except ValueError:
                    pass
            log(f"{label} {took}ms")
            self.reply(200, text)

        def reply(self, code: int, text: str):
            data = text.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, fmt, *args):
            # Default access logging is noise: one line per polled method already
            # goes through `log`.
            return

    return Handler


def log(message: str):
    """One line on stderr; `lib.sh` redirects it to `node.out`."""
    print(f"[libstatus] {message}", file=sys.stderr, flush=True)


def main() -> int:
    if len(sys.argv) != 2 or ":" not in sys.argv[1]:
        print("usage: libstatus_node.py <host:port>", file=sys.stderr)
        return 2

    address = sys.argv[1]
    host, port = address.rsplit(":", 1)
    path = os.environ.get("STAURI_LIBSTATUS") or DEFAULT_LIB
    if not os.path.exists(path):
        print(f"libstatus not found: {path}", file=sys.stderr)
        return 1

    lib = load_library(path)
    log(f"loaded {path}")
    # Before the server answers: signals start arriving as soon as a profile logs in,
    # and a callback registered later would miss the first ones.
    install_signal_capture(lib)
    server = ThreadingHTTPServer((host, int(port)), make_handler(lib))
    log(f"listening on {address}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
