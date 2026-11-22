# Nix + QML vs Tauri + Svelte

Comparing Nix + QML with Tauri + Svelte is comparing two fundamentally different
philosophies of building desktop applications.

The first is a native, hardware-accelerated and strictly deterministic approach (leaning
towards Linux and heavy business logic). The second is a modern cross-platform web approach
(leaning towards lightness, development speed and one UI on every OS).

## 1. Nix (build/dependencies) + QML (UI) + C++/Python (backend)

Here Nix acts as an ideal dependency and build system, QML as the declarative UI framework
from Qt, and the backend is usually written in C++ or Python (PySide/PyQt).

Advantages:

- **Absolute reproducibility (Nix).** Nix guarantees that a build on your machine, on CI and
  on another developer's machine is identical. No "works on my machine".
- **Native UI performance (QML).** QML renders directly through OpenGL/Vulkan: perfectly
  smooth animation (60/120 FPS), HiDPI and complex graphics without a browser's overhead.
- **The power of the Qt ecosystem.** A huge library: native file dialogs, networking,
  threads, Bluetooth, system trays — already implemented and polished.
- **Declarative on both ends.** Nix and QML both describe *what* you want, not *how*.
- **Excellent Linux integration.** For Linux users, Nix + Qt is the gold standard.

Drawbacks:

- **A very high entry threshold.** Nix has an idiosyncratic functional language that at
  first looks broken; QML requires understanding signals/slots and the Qt architecture.
- **Cross-platform trouble (Nix).** Nix was made for Linux. On macOS it works through
  workarounds; on Windows support is still experimental and painful.
- **Distribution for end users.** Building a `.deb` or `.rpm` with Nix is possible; shipping
  a polished `.msi` or `.dmg` with auto-updates is a separate pain.
- **Qt licensing.** A proprietary commercial product requires either a commercial Qt licence
  or careful LGPL compliance (dynamic linking, the user's ability to rebuild Qt).

## 2. Tauri (backend/shell) + Svelte (UI)

Tauri uses the system WebView (the OS browser engine) to render the UI, and Svelte compiles
to plain JS. The backend and system calls are written in Rust.

Advantages:

- **Tiny size and low RAM use.** Tauri does not ship Chromium (unlike Electron): WebView2 on
  Windows, WebKit on macOS, WebKitGTK on Linux. A resulting `.exe` is 3–10 MB rather than
  150 MB.
- **Development speed and the web ecosystem.** If you know HTML/CSS/JS you already know how
  to build UI. Svelte is one of the most pleasant and lightweight frontend frameworks, with
  a huge number of ready libraries.
- **Safety and backend speed (Rust).** Rust rules out memory leaks and data races; Tauri
  provides a safe IPC bridge between JS and Rust.
- **Excellent cross-platform support.** Tauri builds native installers for Windows
  (`.msi`, `.exe`), macOS (`.dmg`) and Linux (`.AppImage`, `.deb`).
- **Tauri v2.** Not only desktop but also mobile (iOS/Android) from one code base.

Drawbacks:

- **Dependence on the system WebView.** The UI is rendered by the OS browser, so 100 %
  identical rendering is not guaranteed: CSS animation may differ between an old WebKitGTK
  and a modern WebView2.
- **IPC overhead.** Every call from the UI (Svelte) to the backend (Rust) serialises data,
  usually JSON. For an application processing gigabytes in real time (a video editor) this
  becomes a bottleneck.
- **The Rust entry threshold.** Complex system logic means learning Rust, with a learning
  curve no gentler than C++ or Nix.
- **A less "native" feel.** Web technology on the desktop, even in a light Tauri app,
  sometimes feels different from native controls, especially around the clipboard, native
  menus and trackpad gestures.

## Direct comparison by category

| Characteristic | Nix + QML (Qt) | Tauri + Svelte |
|---|---|---|
| UI rendering | Native (OpenGL/Vulkan), maximum smoothness | System WebView (HTML/CSS): good, but OS-dependent |
| RAM use | Medium/high (Qt is heavy) | Very low (one of the lightest options) |
| Binary size | Large (with statically linked Qt) | Minimal (3–15 MB) |
| Cross-platform | The UI looks different on each OS | Identical UI everywhere, because it is web |
| Build and packaging | Nix is ideal for Linux, awful for Win/Mac | Tauri has ready commands for installers on every OS |
| Backend language | C++ (hard) or Python (slow) | Rust (hard, but safe and fast) |
| UI ecosystem | Ready native widgets, graphs, 3D | Any web library (React/Vue/Svelte components, CSS frameworks) |

## What to choose, and when

Choose Nix + QML if:

- you are building a professional tool for Linux (an IDE, a CAD system, an audio/video
  editor, system monitoring);
- you need complex custom graphics, GPU work, shaders or 3D (QML has a built-in scene graph);
- you work in a team where environment reproducibility is critical;
- you are ready to invest months in learning Nix and Qt for an "eternal", performant
  product.

Choose Tauri + Svelte if:

- you are building a cross-platform application (Windows, macOS, Linux) that must look and
  behave the same everywhere;
- your team consists of web developers, for whom Svelte + Tauri is painless;
- distribution size and RAM use matter (a widget, a messenger, a crypto wallet, a note
  utility);
- you want installers for every OS without complicated CI/CD (Tauri does it out of the box).

## Summary

Nix + QML is the choice of systems engineers and Linux enthusiasts building heavy,
high-performance native tools.

Tauri + Svelte is the modern standard for startups and independent developers who need to
deliver a light cross-platform application quickly, beautifully and cheaply.
