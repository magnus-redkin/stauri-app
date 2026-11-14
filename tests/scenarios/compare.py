#!/usr/bin/env python3
"""Сравнивает трассировку прогона с ожидаемым результатом из сценария.

Вызывается из run.sh (команда `compare`). Сам ничего не меняет.

Как понимает, что сравнивать:
  1. В логе SD ищет последнюю метку `[test] START <имя>` (её пишет run.sh start).
  2. Имя из метки — это имя файла сценария: tests/scenarios/<имя>.md.
  3. Окно прогона — от START до END с тем же именем (или до текущего момента).
  4. Переменные `vars:` из сценария подставляются в ожидаемые строки: {SIM_NAME} и т. д.

Формат сценария (разделы `## expect sd` и `## expect sa`):
  - строка `- <текст>`  — текст должен встретиться в логе этой стороны,
                          строго после предыдущего ожидания (порядок важен);
  - строка `- not: <текст>` — текст не должен встретиться в окне;
  - `А | Б` внутри строки — достаточно любого из вариантов.

Источники:
  sd — лог фронтенда SD: ~/.local/share/com.magnus.stauri-app/logs/stauri.*.log
  sa — трасса моста телефона (adb run-as ... bridge-trace.log), строки
       с unix-временем внутри окна прогона.

Код выхода: 0 — все ожидания выполнены, 1 — есть расхождения, 2 — ошибка запуска.
"""

from __future__ import annotations

import datetime as dt
import glob
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOG_DIR = Path.home() / ".local/share/com.magnus.stauri-app/logs"
APP_ID = "com.magnus.stauri_app"
ADB = os.environ.get("ADB", str(Path.home() / "Android/sdk/platform-tools/adb"))

START_RE = re.compile(r"\[test\] START (\S+)")
END_RE = re.compile(r"\[test\] END (\S+)")
ISO_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z")


def parse_iso(line: str) -> dt.datetime | None:
    m = ISO_RE.match(line)
    if not m:
        return None
    return dt.datetime.fromisoformat(m.group(1)).replace(tzinfo=dt.timezone.utc)


def latest_desktop_log() -> Path | None:
    files = sorted(glob.glob(str(LOG_DIR / "stauri.*.log")))
    return Path(files[-1]) if files else None


def read_scenario(name: str) -> tuple[dict[str, str], dict[str, list[str]]]:
    """Возвращает (vars, {'sd': [...], 'sa': [...]}) из tests/scenarios/<name>.md."""
    path = HERE / f"{name}.md"
    if not path.exists():
        raise SystemExit(f"нет сценария: {path}")
    variables: dict[str, str] = {}
    expect: dict[str, list[str]] = {"sd": [], "sa": []}
    section: str | None = None
    in_vars = False
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.rstrip()
        if line.startswith("## expect "):
            section = line.split()[-1]
            in_vars = False
            continue
        if line.startswith("## "):
            section = None
            in_vars = False
            continue
        if line.strip() == "vars:":
            in_vars = True
            continue
        if in_vars and line.startswith("  ") and ":" in line:
            key, _, value = line.strip().partition(":")
            variables[key.strip()] = value.strip().strip('"')
            continue
        if section in expect and line.startswith("- "):
            expect[section].append(line[2:].strip())
    return variables, expect


def substitute(text: str, variables: dict[str, str]) -> str:
    for key, value in variables.items():
        text = text.replace("{" + key + "}", value)
    return text


def window_from_log(log: Path) -> tuple[str, dt.datetime, dt.datetime, list[str]]:
    lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
    starts = [(i, m.group(1)) for i, l in enumerate(lines) if (m := START_RE.search(l))]
    if not starts:
        raise SystemExit("в логе SD нет метки START — сначала: run.sh start <сценарий>")
    start_idx, name = starts[-1]
    end_idx = None
    for i in range(start_idx + 1, len(lines)):
        m = END_RE.search(lines[i])
        if m and m.group(1) == name:
            end_idx = i
            break
    t0 = parse_iso(lines[start_idx])
    t1 = parse_iso(lines[end_idx]) if end_idx is not None else dt.datetime.now(dt.timezone.utc)
    if t0 is None or t1 is None:
        raise SystemExit("не удалось прочитать время меток в логе")
    body = lines[start_idx:(end_idx + 1 if end_idx is not None else len(lines))]
    return name, t0, t1, body


def sd_lines(body: list[str], t0: dt.datetime, t1: dt.datetime) -> list[str]:
    out = []
    for l in body:
        ts = parse_iso(l)
        if ts is None or t0 <= ts <= t1:
            out.append(l)
    return out


def sa_lines(t0: dt.datetime, t1: dt.datetime) -> list[str]:
    """Строки трассы телефона внутри окна (unix-время в начале строки)."""
    try:
        raw = subprocess.run(
            [ADB, "shell", "run-as", APP_ID, "cat", "bridge-trace.log"],
            capture_output=True, text=True, timeout=60,
        ).stdout
    except (OSError, subprocess.SubprocessError) as e:
        print(f"  (трасса телефона недоступна: {e})")
        return []
    lo, hi = t0.timestamp(), t1.timestamp()
    out = []
    for l in raw.splitlines():
        head = l.split(" ", 1)[0]
        if head.isdigit() and lo - 1 <= int(head) <= hi + 1:
            out.append(l)
    return out


def check(side: str, expects: list[str], lines: list[str], variables: dict[str, str]) -> bool:
    ok = True
    pos = 0
    print(f"\n-- {side}: {len(lines)} строк в окне")
    for raw in expects:
        forbid = raw.startswith("not:")
        text = substitute(raw[4:].strip() if forbid else raw, variables)
        if forbid:
            hit = next((i for i, l in enumerate(lines) if text in l), None)
            mark = "✗" if hit is not None else "✓"
            print(f"  {mark} не должно быть: {text}")
            ok &= hit is None
            continue
        # `A | B` — достаточно любого из вариантов (сигнал или опрос).
        options = [o.strip() for o in text.split(" | ")]
        hit = next(
            (i for i in range(pos, len(lines)) if any(o in lines[i] for o in options)),
            None,
        )
        if hit is None:
            print(f"  ✗ нет (по порядку): {text}")
            ok = False
        else:
            pos = hit + 1
            print(f"  ✓ {text}")
    return ok


def main() -> int:
    log = latest_desktop_log()
    if log is None:
        print("нет лога SD (запустите Stauri Desktop хотя бы один раз)", file=sys.stderr)
        return 2
    name, t0, t1, body = window_from_log(log)
    print(f"Сценарий из лога: {name}   окно: {t0.isoformat()} — {t1.isoformat()}")
    variables, expect = read_scenario(name)
    if not expect["sd"] and not expect["sa"]:
        print("в сценарии нет разделов `## expect sd` / `## expect sa`", file=sys.stderr)
        return 2

    ok = True
    if expect["sd"]:
        ok &= check("SD", expect["sd"], sd_lines(body, t0, t1), variables)
    if expect["sa"]:
        ok &= check("SA", expect["sa"], sa_lines(t0, t1), variables)

    print("\nИТОГ:", "ПРОЙДЕН" if ok else "РАСХОЖДЕНИЯ")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
