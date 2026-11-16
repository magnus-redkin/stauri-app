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

Signals are not forwarded: the tests poll the RPC instead of waiting for them.
"""

import ctypes
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Lifecycle endpoints exported by mobile/status.go. Each takes a JSON string and
# returns a JSON string allocated by cgo, which the caller must free.
ENDPOINTS = (
    "CallRPC",
    "InitializeApplication",
    "CreateAccountAndLogin",
    "LoginAccount",
)
# `Logout(void)` takes no argument and ignores any body.
NO_ARG_ENDPOINTS = ("Logout",)

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_LIB = os.path.join(REPO, "src-tauri", "binaries", "libstatus.so")


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


def make_handler(lib):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):  # noqa: N802 -- name required by BaseHTTPRequestHandler
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8") if length else ""
            path = self.path.split("?", 1)[0]
            prefix = "/statusgo/"
            name = path[len(prefix):] if path.startswith(prefix) else ""

            if name not in ENDPOINTS and name not in NO_ARG_ENDPOINTS:
                self.reply(404, f'{{"error":"unknown endpoint {name}"}}')
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
    server = ThreadingHTTPServer((host, int(port)), make_handler(lib))
    log(f"listening on {address}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
