# SPDX-License-Identifier: MIT
# Derived from https://github.com/can1357/oh-my-pi/blob/v18.0.10/packages/coding-agent/src/eval/py/runner.py
#
# MIT License
#
# Copyright (c) 2025 Mario Zechner
# Copyright (c) 2025-2026 Can Bölük
# Copyright (c) 2026 Stencil Labs, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""Yachiyo's isolated CPython runner.

The host and runner exchange strict NDJSON over private file descriptors. User
Python, native extensions, and inherited subprocesses never share that channel.
The process is stateful for its lifetime and executes one cell at a time.
"""

from __future__ import annotations

import ast
import asyncio
import base64
import builtins
import concurrent.futures
import contextvars
import ctypes
import inspect
import io
import importlib
import json
import math
import os
import secrets
import shlex
import signal
import subprocess
import sys
import threading
import time
import tokenize
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterable, NoReturn

_PROTOCOL_VERSION = 1
_MINIMUM_PYTHON_VERSION = (3, 11)
_MAX_PROTOCOL_LINE_BYTES = 64 * 1024 * 1024
_MAX_BRIDGE_RESPONSE_BYTES = 64 * 1024 * 1024
_THREAD_TASK_CLEANUP_SECONDS = 0.5
_SYNTHETIC_FILENAME = "<yachiyo-py-repl>"
_TRANSPORT_KEYS = (
    "YACHIYO_PY_REPL_PARENT_PID",
    "YACHIYO_PY_REPL_BRIDGE_URL",
    "YACHIYO_PY_REPL_BRIDGE_TOKEN",
    "YACHIYO_PY_REPL_UV_PATH",
)
_SAFE_INTEGER_MAX = 9_007_199_254_740_991
_MISSING = object()
_OUT_LOCK = threading.Lock()
_BRIDGE_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _open_private_protocol_files() -> tuple[io.BufferedReader, io.TextIOWrapper, io.TextIOWrapper, int]:
    """Duplicate host control/protocol/fatal streams and null public fds."""
    try:
        control_fd = os.dup(0)
        protocol_fd = os.dup(1)
        fatal_fd = os.dup(2)
        null_fd = os.open(os.devnull, os.O_RDWR)
        os.dup2(null_fd, 0)
        os.dup2(null_fd, 1)
        os.dup2(null_fd, 2)
        control = os.fdopen(control_fd, "rb", buffering=0)
        protocol = os.fdopen(
            protocol_fd,
            "w",
            encoding="utf-8",
            errors="strict",
            buffering=1,
        )
        fatal = os.fdopen(
            fatal_fd,
            "w",
            encoding="utf-8",
            errors="backslashreplace",
            buffering=1,
        )
        return control, protocol, fatal, null_fd
    except (AttributeError, OSError, ValueError, io.UnsupportedOperation) as error:
        raise RuntimeError(f"could not protect runner file descriptors: {error}") from error


_CONTROL, _PROTOCOL, _FATAL, _NULL_FD = _open_private_protocol_files()


def _fatal(message: str) -> None:
    with _OUT_LOCK:
        _FATAL.write(message.rstrip() + "\n")
        _FATAL.flush()


def _emit(frame: dict[str, Any]) -> None:
    line = json.dumps(
        frame,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )
    with _OUT_LOCK:
        _PROTOCOL.write(line)
        _PROTOCOL.write("\n")
        _PROTOCOL.flush()


def _read_transport() -> tuple[int, str, str, str, dict[str, str]]:
    values: dict[str, str] = {}
    for key in _TRANSPORT_KEYS:
        value = os.environ.pop(key, None)
        if not isinstance(value, str) or not value:
            raise RuntimeError(f"missing required transport setting {key}")
        values[key] = value

    try:
        parent_pid = int(values["YACHIYO_PY_REPL_PARENT_PID"])
    except ValueError as error:
        raise RuntimeError("invalid YACHIYO_PY_REPL_PARENT_PID") from error
    if parent_pid <= 0:
        raise RuntimeError("invalid YACHIYO_PY_REPL_PARENT_PID")

    bridge_url = values["YACHIYO_PY_REPL_BRIDGE_URL"]
    parsed_url = urllib.parse.urlsplit(bridge_url)
    if (
        parsed_url.scheme != "http"
        or parsed_url.username is not None
        or parsed_url.password is not None
        or parsed_url.hostname != "127.0.0.1"
        or parsed_url.port is None
        or parsed_url.path != "/tool"
        or parsed_url.query
        or parsed_url.fragment
    ):
        raise RuntimeError("invalid YACHIYO_PY_REPL_BRIDGE_URL")

    bridge_token = values["YACHIYO_PY_REPL_BRIDGE_TOKEN"]
    if (
        len(bridge_token) != 64
        or bridge_token.lower() != bridge_token
        or any(character not in "0123456789abcdef" for character in bridge_token)
    ):
        raise RuntimeError("invalid YACHIYO_PY_REPL_BRIDGE_TOKEN")

    uv_path = values["YACHIYO_PY_REPL_UV_PATH"]
    if not os.path.isabs(uv_path) or os.path.islink(uv_path) or not os.path.isfile(uv_path):
        raise RuntimeError("invalid YACHIYO_PY_REPL_UV_PATH")

    package_environment = dict(os.environ)
    return parent_pid, bridge_url, bridge_token, uv_path, package_environment


_PARENT_PID, _BRIDGE_URL, _BRIDGE_TOKEN, _UV_PATH, _PACKAGE_ENVIRONMENT = _read_transport()
_SELECTED_PYTHON = os.path.abspath(sys.executable)
_PYTHON_VERSION = (
    f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
)
if (
    sys.implementation.name != "cpython"
    or sys.version_info.major != 3
    or sys.version_info[:2] < _MINIMUM_PYTHON_VERSION
):
    raise RuntimeError(
        f"expected CPython 3.11 or newer, got {sys.implementation.name} {_PYTHON_VERSION}"
    )


class _RunnerOwnedPath(str):
    pass


_CURRENT_CELL_ID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "yachiyo_py_repl_cell_id", default=None
)
_CURRENT_CWD: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "yachiyo_py_repl_cwd", default=None
)
_CURRENT_TOOLS: contextvars.ContextVar[frozenset[str]] = contextvars.ContextVar(
    "yachiyo_py_repl_tools", default=frozenset()
)
_CURRENT_DISPLAYED_FIGURES: contextvars.ContextVar[set[int] | None] = contextvars.ContextVar(
    "yachiyo_py_repl_displayed_figures", default=None
)
_RUNNER_PATH_ENTRY: _RunnerOwnedPath | None = None


def _terminate_own_tree() -> None:
    if os.name == "nt":
        system_root = _PACKAGE_ENVIRONMENT.get("SYSTEMROOT") or _PACKAGE_ENVIRONMENT.get("WINDIR")
        taskkill = os.path.join(system_root or "", "System32", "taskkill.exe")
        try:
            subprocess.run(
                [taskkill, "/PID", str(os.getpid()), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=dict(_PACKAGE_ENVIRONMENT),
                check=False,
            )
        finally:
            os._exit(0)
    try:
        os.killpg(os.getpgrp(), signal.SIGKILL)
    finally:
        os._exit(0)


def _arm_parent_watchdog() -> None:
    if os.name == "nt":
        system_root = _PACKAGE_ENVIRONMENT.get("SYSTEMROOT") or _PACKAGE_ENVIRONMENT.get("WINDIR")
        if not system_root or not os.path.isabs(system_root):
            raise RuntimeError("could not locate the absolute Windows system root")
        taskkill = os.path.join(system_root, "System32", "taskkill.exe")
        if not os.path.isfile(taskkill):
            raise RuntimeError("could not locate Windows taskkill.exe")
        synchronize = 0x00100000
        infinite = 0xFFFFFFFF
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        handle = kernel32.OpenProcess(synchronize, False, _PARENT_PID)
        if not handle:
            raise RuntimeError("could not watch the Yachiyo parent process")

        def watch_windows_parent() -> None:
            try:
                kernel32.WaitForSingleObject(handle, infinite)
            finally:
                kernel32.CloseHandle(handle)
            _terminate_own_tree()

        threading.Thread(
            target=watch_windows_parent,
            name="yachiyo-parent-watchdog",
            daemon=True,
        ).start()
        return

    if os.getppid() != _PARENT_PID:
        raise RuntimeError("Yachiyo parent process changed before runner startup")
    if os.getpgrp() != os.getpid():
        raise RuntimeError("Python runner does not own its POSIX process group")

    def watch_posix_parent() -> None:
        while True:
            time.sleep(1)
            if os.getppid() != _PARENT_PID:
                _terminate_own_tree()

    threading.Thread(
        target=watch_posix_parent,
        name="yachiyo-parent-watchdog",
        daemon=True,
    ).start()


class _CellCapture:
    """Capture Python and native fd output for exactly one cell."""

    def __init__(self, cell_id: str) -> None:
        self._cell_id = cell_id
        self._barriers: list[bytes] = []
        self._writers: list[int] = []
        self._done: list[threading.Event] = []
        self._streams: list[io.TextIOWrapper] = []

    def _start_stream(self, fd: int, frame_type: str) -> io.TextIOWrapper:
        read_fd, write_fd = os.pipe()
        barrier = b"\x00YACHIYO-BARRIER-" + secrets.token_bytes(32) + b"\x00"
        done = threading.Event()
        os.dup2(write_fd, fd)
        stream = os.fdopen(
            os.dup(write_fd),
            "w",
            encoding="utf-8",
            errors="backslashreplace",
            buffering=1,
        )
        self._barriers.append(barrier)
        self._writers.append(write_fd)
        self._done.append(done)
        self._streams.append(stream)
        threading.Thread(
            target=self._drain,
            args=(read_fd, barrier, done, frame_type),
            name=f"yachiyo-{frame_type}-drain",
            daemon=True,
        ).start()
        return stream

    def start(self) -> None:
        sys.stdout = self._start_stream(1, "stdout")
        sys.stderr = self._start_stream(2, "stderr")

    def _drain(
        self,
        read_fd: int,
        barrier: bytes,
        done: threading.Event,
        frame_type: str,
    ) -> None:
        decoder = __import__("codecs").getincrementaldecoder("utf-8")("replace")
        pending = b""
        try:
            while True:
                chunk = os.read(read_fd, 65_536)
                if not chunk:
                    text = decoder.decode(pending, final=True)
                    if text:
                        _emit({"type": frame_type, "id": self._cell_id, "data": text})
                    return
                pending += chunk
                barrier_at = pending.find(barrier)
                if barrier_at >= 0:
                    text = decoder.decode(pending[:barrier_at], final=True)
                    if text:
                        _emit({"type": frame_type, "id": self._cell_id, "data": text})
                    return
                safe_length = max(0, len(pending) - len(barrier) + 1)
                if safe_length:
                    text = decoder.decode(pending[:safe_length], final=False)
                    pending = pending[safe_length:]
                    if text:
                        _emit({"type": frame_type, "id": self._cell_id, "data": text})
        except OSError:
            return
        finally:
            try:
                os.close(read_fd)
            except OSError:
                pass
            done.set()

    def stop(self) -> bool:
        for stream in self._streams:
            try:
                stream.flush()
            except (OSError, ValueError):
                pass
        os.dup2(_NULL_FD, 1)
        os.dup2(_NULL_FD, 2)
        for stream in self._streams:
            try:
                stream.close()
            except (OSError, ValueError):
                pass
        sys.stdout = os.fdopen(
            os.dup(_NULL_FD), "w", encoding="utf-8", errors="ignore", buffering=1
        )
        sys.stderr = os.fdopen(
            os.dup(_NULL_FD), "w", encoding="utf-8", errors="ignore", buffering=1
        )
        barriers_written = True
        for writer, barrier in zip(self._writers, self._barriers, strict=True):
            try:
                os.write(writer, barrier)
            except OSError:
                barriers_written = False
            finally:
                try:
                    os.close(writer)
                except OSError:
                    pass
        deadline = time.monotonic() + _THREAD_TASK_CLEANUP_SECONDS
        for done in self._done:
            done.wait(max(0.0, deadline - time.monotonic()))
        return barriers_written and all(done.is_set() for done in self._done)


def _safe_plain_text(value: Any) -> str:
    try:
        return repr(value)
    except BaseException:
        return f"<unrepr {type(value).__name__}>"


def _json_tree(value: Any, *, tuples: bool = False) -> Any:
    if value is None or type(value) in (str, bool):
        return value
    if type(value) is int:
        if abs(value) > _SAFE_INTEGER_MAX:
            raise ValueError("integer is outside JavaScript's safe range")
        return value
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError("number is not finite")
        return value
    if type(value) is list or (tuples and type(value) is tuple):
        return [_json_tree(item, tuples=tuples) for item in value]
    if type(value) is dict:
        if not all(type(key) is str for key in value):
            raise TypeError("JSON object keys must be strings")
        return {key: _json_tree(item, tuples=tuples) for key, item in value.items()}
    raise TypeError(f"{type(value).__name__} is not an exact JSON value")


def _normalized_image(value: Any) -> str | None:
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if type(value) is not str:
        return None
    compact = "".join(value.split())
    try:
        decoded = base64.b64decode(compact, validate=True)
    except (ValueError, TypeError):
        return None
    return base64.b64encode(decoded).decode("ascii")


def _is_matplotlib_figure(value: Any) -> bool:
    figure_module = sys.modules.get("matplotlib.figure")
    figure_type = getattr(figure_module, "Figure", None)
    if isinstance(figure_type, type) and isinstance(value, figure_type):
        return True
    value_type = type(value)
    return value_type.__module__ == "matplotlib.figure" and value_type.__name__ == "Figure"


def _matplotlib_png(value: Any) -> str | None:
    if not _is_matplotlib_figure(value):
        return None
    try:
        buffer = io.BytesIO()
        value.savefig(buffer, format="png", bbox_inches="tight")
    except BaseException:
        return None
    displayed = _CURRENT_DISPLAYED_FIGURES.get()
    if displayed is not None:
        displayed.add(id(value))
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _mime_bundle(value: Any) -> dict[str, Any]:
    bundle: dict[str, Any] = {"text/plain": _safe_plain_text(value)}
    matplotlib_png = _matplotlib_png(value)
    if matplotlib_png is not None:
        bundle["image/png"] = matplotlib_png

    candidates: dict[str, Any] = {}
    try:
        mime_hook = getattr(value, "_repr_mimebundle_", None)
        if callable(mime_hook):
            hooked = mime_hook()
            if type(hooked) is tuple:
                hooked = hooked[0]
            if type(hooked) is dict:
                candidates.update(hooked)
    except BaseException:
        pass

    for attribute, mime_type in (
        ("_repr_markdown_", "text/markdown"),
        ("_repr_latex_", "text/latex"),
        ("_repr_json_", "application/json"),
        ("_repr_png_", "image/png"),
        ("_repr_jpeg_", "image/jpeg"),
    ):
        if mime_type in candidates or mime_type in bundle:
            continue
        try:
            hook = getattr(value, attribute, None)
            if not callable(hook):
                continue
            hooked = hook()
        except BaseException:
            continue
        if hooked is not None:
            candidates[mime_type] = hooked

    for mime_type in ("text/plain", "text/markdown", "text/latex"):
        candidate = candidates.get(mime_type)
        if type(candidate) is str:
            bundle[mime_type] = candidate
    if "application/json" in candidates:
        try:
            bundle["application/json"] = _json_tree(candidates["application/json"], tuples=True)
        except (TypeError, ValueError, RecursionError):
            pass
    elif type(value) in (dict, list, tuple):
        try:
            bundle["application/json"] = _json_tree(value, tuples=True)
        except (TypeError, ValueError, RecursionError):
            pass
    for mime_type in ("image/png", "image/jpeg"):
        if mime_type in bundle:
            continue
        image = _normalized_image(candidates.get(mime_type))
        if image is not None:
            bundle[mime_type] = image
    return bundle


def _emit_bundle(value: Any, frame_type: str = "display") -> None:
    cell_id = _CURRENT_CELL_ID.get()
    if cell_id is None:
        raise RuntimeError("display() is only available during a pyRepl cell")
    _emit({"type": frame_type, "id": cell_id, "bundle": _mime_bundle(value)})


def display(value: Any) -> None:
    _emit_bundle(value)


def _flush_matplotlib_figures() -> None:
    pyplot = sys.modules.get("matplotlib.pyplot")
    if pyplot is None:
        return
    try:
        figure_numbers = list(pyplot.get_fignums())
    except BaseException:
        return
    displayed = _CURRENT_DISPLAYED_FIGURES.get() or set()
    for number in figure_numbers:
        figure: Any | None = None
        try:
            figure = pyplot.figure(number)
            if id(figure) in displayed:
                continue
            buffer = io.BytesIO()
            figure.savefig(buffer, format="png", bbox_inches="tight")
            _emit(
                {
                    "type": "display",
                    "id": _CURRENT_CELL_ID.get(),
                    "bundle": {
                        "image/png": base64.b64encode(buffer.getvalue()).decode("ascii"),
                        "text/plain": f"<Figure {number}>",
                    },
                }
            )
        except BaseException:
            continue
        finally:
            if figure is not None:
                try:
                    pyplot.close(figure)
                except BaseException:
                    pass


def _unsupported_magic(kind: str) -> SyntaxError:
    return SyntaxError(
        f"{kind} is unsupported in pyRepl. Use the enabled tool.bash host tool for shell work."
    )


def _transform_cell(source: str) -> str:
    if "%" not in source and "!" not in source:
        return source
    lines = source.splitlines(keepends=True)
    meaningful: dict[int, list[tokenize.TokenInfo]] = {}
    try:
        tokens = tokenize.generate_tokens(io.StringIO(source).readline)
        for token_info in tokens:
            if token_info.type in {
                tokenize.ENCODING,
                tokenize.ENDMARKER,
                tokenize.INDENT,
                tokenize.DEDENT,
                tokenize.NEWLINE,
                tokenize.NL,
                tokenize.COMMENT,
            }:
                continue
            meaningful.setdefault(token_info.start[0], []).append(token_info)
    except (IndentationError, tokenize.TokenError):
        return source

    for line_number, row_tokens in meaningful.items():
        for token_info in row_tokens:
            if token_info.type == tokenize.ERRORTOKEN and token_info.string == "!":
                raise _unsupported_magic("Shell escape")
        first = row_tokens[0]
        if first.string != "%" or first.start[1] != 0:
            continue
        if len(row_tokens) >= 2 and row_tokens[1].string == "%":
            raise _unsupported_magic("Cell magic")
        if len(row_tokens) < 2 or row_tokens[1].type != tokenize.NAME:
            raise _unsupported_magic("Magic")
        name = row_tokens[1].string
        if name != "pip":
            raise _unsupported_magic(f"%{name}")
        line = lines[line_number - 1]
        ending = "\n" if line.endswith("\n") else ""
        content = line[:-1] if ending else line
        if content.endswith("\r"):
            content = content[:-1]
            ending = "\r\n" if ending else "\r"
        arguments = content[row_tokens[1].end[1] :].strip()
        lines[line_number - 1] = f"__yachiyo_pip({json.dumps(arguments, ensure_ascii=False)}){ending}"
    return "".join(lines)


_ALLOWED_PIP_SUBCOMMANDS = frozenset(
    {"install", "uninstall", "list", "show", "freeze", "tree", "check"}
)
_FORBIDDEN_PIP_LONG_OPTIONS = frozenset(
    {
        "--python",
        "--system",
        "--target",
        "--prefix",
        "--path",
        "--root",
        "--user",
        "--python-version",
        "--python-platform",
        "--python-implementation",
        "--python-preference",
        "--python-fetch",
        "--python-downloads",
        "--python-install-dir",
        "--break-system-packages",
        "--managed-python",
        "--no-managed-python",
        "--allow-python-downloads",
        "--cache-dir",
        "--directory",
        "--project",
        "--config-file",
    }
)


def _run_pip(arguments: str) -> None:
    argv = shlex.split(arguments)
    if not argv:
        print("Usage: %pip {install|uninstall|list|show|freeze|tree|check} [arguments]")
        return
    subcommand = argv[0]
    if subcommand not in _ALLOWED_PIP_SUBCOMMANDS:
        raise ValueError(f"Unsupported %pip subcommand: {subcommand}")
    for argument in argv[1:]:
        if argument.startswith("--"):
            option_name = argument.split("=", 1)[0]
            if option_name in _FORBIDDEN_PIP_LONG_OPTIONS:
                raise ValueError(f"%pip option is not allowed: {option_name}")
        elif argument.startswith("-") and argument != "-":
            if "p" in argument[1:] or "t" in argument[1:]:
                raise ValueError(f"%pip option is not allowed: {argument}")
    command = [
        _UV_PATH,
        "--no-config",
        "--no-progress",
        "--no-python-downloads",
        "pip",
        subcommand,
        "--python",
        _SELECTED_PYTHON,
        *argv[1:],
    ]
    completed = subprocess.run(
        command,
        cwd=os.getcwd(),
        env=dict(_PACKAGE_ENVIRONMENT),
        stdin=subprocess.DEVNULL,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"pip exited with status {completed.returncode}.")
    if subcommand in {"install", "uninstall"}:
        importlib.invalidate_caches()


def _reject_json_constant(value: str) -> NoReturn:
    raise ValueError(f"invalid JSON constant: {value}")


def _validate_bridge_input(value: Any) -> dict[str, Any]:
    if type(value) is not dict:
        raise TypeError("tool.<name>(args) expects exactly one JSON object")
    normalized = _json_tree(value)
    assert isinstance(normalized, dict)
    return normalized


def _bridge_call(tool_name: str, value: Any) -> Any:
    cell_id = _CURRENT_CELL_ID.get()
    if cell_id is None:
        raise RuntimeError("host tools are only available during a pyRepl cell")
    if tool_name not in _CURRENT_TOOLS.get():
        raise RuntimeError(f'Host tool "{tool_name}" is not enabled for this pyRepl cell')
    body = json.dumps(
        {
            "cellId": cell_id,
            "tool": tool_name,
            "input": _validate_bridge_input(value),
        },
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")
    request = urllib.request.Request(
        _BRIDGE_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {_BRIDGE_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    content_type = ""
    try:
        with _BRIDGE_OPENER.open(request) as response:
            content_type = response.headers.get_content_type()
            payload = response.read(_MAX_BRIDGE_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        content_type = error.headers.get_content_type()
        payload = error.read(_MAX_BRIDGE_RESPONSE_BYTES + 1)
    except urllib.error.URLError as error:
        raise RuntimeError(f"host tool bridge failed: {error.reason}") from error
    if content_type != "application/json":
        raise RuntimeError("host tool bridge returned an invalid Content-Type")
    if len(payload) > _MAX_BRIDGE_RESPONSE_BYTES:
        raise RuntimeError("host tool bridge response exceeded 64 MiB")
    try:
        decoded = json.loads(
            payload.decode("utf-8"),
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise RuntimeError("host tool bridge returned invalid JSON") from error
    if (
        not isinstance(decoded, dict)
        or set(decoded) not in ({"ok", "value"}, {"ok", "error"})
        or not isinstance(decoded.get("ok"), bool)
    ):
        raise RuntimeError("host tool bridge returned an invalid response")
    if decoded["ok"] is True:
        if set(decoded) != {"ok", "value"}:
            raise RuntimeError("host tool bridge returned an invalid response")
        return _json_tree(decoded["value"])
    if set(decoded) != {"ok", "error"} or not isinstance(decoded["error"], str):
        raise RuntimeError("host tool bridge returned an invalid response")
    raise RuntimeError(decoded["error"])


class _ToolProxy:
    def __getattr__(self, name: str) -> Callable[[dict[str, Any]], Any]:
        if name.startswith("_"):
            raise AttributeError(name)

        def invoke(arguments: dict[str, Any]) -> Any:
            return _bridge_call(name, arguments)

        return invoke


class _ParallelResults(list[Any]):
    def __await__(self):
        async def completed() -> _ParallelResults:
            return self

        return completed().__await__()


def parallel(callables: Iterable[Callable[[], Any]]) -> _ParallelResults:
    try:
        items = list(callables)
    except TypeError as error:
        raise TypeError("parallel() expects an iterable of zero-argument callables") from error
    if any(not callable(item) for item in items):
        raise TypeError("parallel() expects an iterable of zero-argument callables")
    if not items:
        return _ParallelResults()

    def run_one(item: Callable[[], Any], context: contextvars.Context) -> Any:
        result = context.run(item)
        if inspect.isawaitable(result):
            close = getattr(result, "close", None)
            if callable(close):
                close()
            raise TypeError("parallel() callables must return synchronous values")
        return result

    contexts = [contextvars.copy_context() for _ in items]
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(32, len(items))) as executor:
        futures = [
            executor.submit(run_one, item, contexts[index]) for index, item in enumerate(items)
        ]
        concurrent.futures.wait(futures)
    errors: list[BaseException | None] = []
    values: list[Any] = []
    for future in futures:
        try:
            values.append(future.result())
            errors.append(None)
        except BaseException as error:
            values.append(None)
            errors.append(error)
    for error in errors:
        if error is not None:
            raise error
    return _ParallelResults(values)


def read(path: str, offset: int = 1, limit: int | None = None) -> str:
    if "read" not in _CURRENT_TOOLS.get():
        raise RuntimeError('Host tool "read" is not enabled for this pyRepl cell')
    if not isinstance(path, str):
        raise TypeError("read() path must be a string")
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 1:
        raise TypeError("read() offset must be a positive integer")
    if limit is not None and (
        isinstance(limit, bool) or not isinstance(limit, int) or limit < 0
    ):
        raise TypeError("read() limit must be a non-negative integer")
    cwd = _CURRENT_CWD.get()
    if cwd is None:
        raise RuntimeError("read() is only available during a pyRepl cell")
    resolved = path if os.path.isabs(path) else os.path.join(cwd, path)
    content = Path(resolved).read_text(encoding="utf-8", errors="replace")
    if offset == 1 and limit is None:
        return content
    lines = content.split("\n")
    end = None if limit is None else offset - 1 + limit
    return "\n".join(lines[offset - 1 : end])


def write(path: str, content: str) -> str:
    if not isinstance(path, str) or not isinstance(content, str):
        raise TypeError("write() expects a string path and string content")
    result = _bridge_call("write", {"path": path, "content": content})
    if isinstance(result, str):
        return result
    if isinstance(result, dict) and isinstance(result.get("text"), str):
        return result["text"]
    raise RuntimeError("write() received an invalid host tool result")


def _unsupported_input(*_args: Any, **_kwargs: Any) -> str:
    raise RuntimeError("interactive stdin is unsupported in pyRepl")


builtins.input = _unsupported_input
os.environ["MPLBACKEND"] = "Agg"
_USER_NAMESPACE: dict[str, Any] = {
    "__name__": "__main__",
    "__doc__": None,
    "__file__": _SYNTHETIC_FILENAME,
    "__builtins__": builtins,
    "display": display,
    "parallel": parallel,
    "tool": _ToolProxy(),
    "__yachiyo_pip": _run_pip,
}


def _set_cell_environment(cwd: str, available_tools: list[str]) -> None:
    global _RUNNER_PATH_ENTRY
    os.chdir(cwd)
    if _RUNNER_PATH_ENTRY is not None:
        for index, entry in enumerate(sys.path):
            if entry is _RUNNER_PATH_ENTRY:
                del sys.path[index]
                break
    _RUNNER_PATH_ENTRY = _RunnerOwnedPath(cwd)
    sys.path.insert(0, _RUNNER_PATH_ENTRY)
    tool_names = frozenset(available_tools)
    if "read" in tool_names:
        _USER_NAMESPACE["read"] = read
    else:
        _USER_NAMESPACE.pop("read", None)
    if "write" in tool_names:
        _USER_NAMESPACE["write"] = write
    else:
        _USER_NAMESPACE.pop("write", None)


_TLA_FLAG = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT


async def _run_compiled(code: Any, *, expression: bool) -> Any:
    if code.co_flags & inspect.CO_COROUTINE:
        return await eval(code, _USER_NAMESPACE)
    if expression:
        return eval(code, _USER_NAMESPACE)
    exec(code, _USER_NAMESPACE)
    return None


async def _execute_source(source: str) -> Any:
    transformed = _transform_cell(source)
    module = ast.parse(transformed, filename=_SYNTHETIC_FILENAME, mode="exec")
    final_expression: ast.Expr | None = None
    body = module.body
    if body and isinstance(body[-1], ast.Expr):
        final_expression = body[-1]
        body = body[:-1]

    compiled_statements: Any | None = None
    compiled_expression: Any | None = None
    if body:
        statements = ast.Module(body=body, type_ignores=module.type_ignores)
        ast.fix_missing_locations(statements)
        compiled_statements = compile(
            statements,
            _SYNTHETIC_FILENAME,
            "exec",
            flags=_TLA_FLAG,
            dont_inherit=True,
        )
    if final_expression is not None:
        expression = ast.Expression(final_expression.value)
        ast.fix_missing_locations(expression)
        compiled_expression = compile(
            expression,
            _SYNTHETIC_FILENAME,
            "eval",
            flags=_TLA_FLAG,
            dont_inherit=True,
        )

    if compiled_statements is not None:
        await _run_compiled(compiled_statements, expression=False)
    if compiled_expression is None:
        return _MISSING
    return await _run_compiled(compiled_expression, expression=True)


def _strip_runner_frames(exception: BaseException) -> traceback.TracebackException:
    rendered = traceback.TracebackException.from_exception(exception, compact=True)

    def strip(current: traceback.TracebackException | None) -> None:
        if current is None:
            return
        current.stack[:] = [frame for frame in current.stack if frame.filename != __file__]
        strip(current.__cause__)
        strip(current.__context__)
        for child in current.exceptions or ():
            strip(child)

    strip(rendered)
    return rendered


def _safe_exception_value(exception: BaseException) -> str:
    try:
        return str(exception)
    except BaseException:
        return _safe_plain_text(exception)


def _error_frame(exception: BaseException, cell_id: str) -> dict[str, Any]:
    value = _safe_exception_value(exception)
    try:
        rendered = _strip_runner_frames(exception)
        lines = list(rendered.format(chain=True))
    except BaseException:
        lines = [f"{type(exception).__name__}: {value}\n"]
    return {
        "type": "error",
        "id": cell_id,
        "ename": type(exception).__name__,
        "evalue": value,
        "traceback": lines,
    }


async def _cleanup_cell_work(
    tasks_before: set[asyncio.Task[Any]],
    tracked_tasks: set[asyncio.Task[Any]],
    threads_before: set[threading.Thread],
) -> str | None:
    deadline = time.monotonic() + _THREAD_TASK_CLEANUP_SECONDS
    current = asyncio.current_task()
    while True:
        created_tasks = {
            task
            for task in tracked_tasks | asyncio.all_tasks()
            if task not in tasks_before and task is not current
        }
        for task in created_tasks:
            if not task.done():
                task.cancel()
        pending = {task for task in created_tasks if not task.done()}
        if pending:
            _, pending = await asyncio.wait(
                pending,
                timeout=max(0.0, deadline - time.monotonic()),
            )
        for task in created_tasks - pending:
            try:
                task.exception()
            except BaseException:
                pass
        if pending:
            return "Python asyncio tasks remained active after cancellation"
        await asyncio.sleep(0)
        for task in tracked_tasks:
            if task in tasks_before or task is current or not task.done():
                continue
            try:
                task.exception()
            except BaseException:
                pass
        new_tasks = {
            task
            for task in tracked_tasks | asyncio.all_tasks()
            if task not in tasks_before and task is not current and not task.done()
        }
        if not new_tasks:
            break
        if time.monotonic() >= deadline:
            return "Python asyncio tasks remained active after cancellation"

    while True:
        created_threads = {
            thread
            for thread in threading.enumerate()
            if thread not in threads_before and thread is not threading.current_thread()
        }
        if not created_threads:
            return None
        for thread in created_threads:
            thread.join(max(0.0, deadline - time.monotonic()))
        if any(thread.is_alive() for thread in created_threads):
            return "Python threads remained active after cleanup"
        if time.monotonic() >= deadline:
            return (
                None
                if all(
                    thread in threads_before or thread is threading.current_thread()
                    for thread in threading.enumerate()
                )
                else "Python threads remained active after cleanup"
            )


def _strict_execute_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "type",
        "id",
        "code",
        "cwd",
        "availableTools",
    }:
        raise ValueError("invalid execute request shape")
    if value["type"] != "execute":
        raise ValueError("invalid execute request type")
    if not isinstance(value["id"], str) or not value["id"]:
        raise ValueError("invalid execute request id")
    if not isinstance(value["code"], str):
        raise ValueError("invalid execute request code")
    if (
        not isinstance(value["cwd"], str)
        or not os.path.isabs(value["cwd"])
        or not os.path.isdir(value["cwd"])
    ):
        raise ValueError("invalid execute request cwd")
    tools = value["availableTools"]
    if (
        not isinstance(tools, list)
        or any(not isinstance(tool_name, str) or not tool_name for tool_name in tools)
        or len(set(tools)) != len(tools)
    ):
        raise ValueError("invalid execute request availableTools")
    return value


async def _execute_cell(request: dict[str, Any]) -> bool:
    cell_id = request["id"]
    _set_cell_environment(request["cwd"], request["availableTools"])
    cell_token = _CURRENT_CELL_ID.set(cell_id)
    cwd_token = _CURRENT_CWD.set(request["cwd"])
    tools_token = _CURRENT_TOOLS.set(frozenset(request["availableTools"]))
    figures_token = _CURRENT_DISPLAYED_FIGURES.set(set())
    capture = _CellCapture(cell_id)
    capture.start()
    loop = asyncio.get_running_loop()
    previous_task_factory = loop.get_task_factory()
    tracked_tasks: set[asyncio.Task[Any]] = set()

    def track_task(
        task_loop: asyncio.AbstractEventLoop,
        coroutine: Any,
        context: contextvars.Context | None = None,
    ) -> asyncio.Task[Any]:
        if previous_task_factory is None:
            task = asyncio.Task(coroutine, loop=task_loop, context=context)
        elif context is None:
            task = previous_task_factory(task_loop, coroutine)
        else:
            task = previous_task_factory(task_loop, coroutine, context=context)
        tracked_tasks.add(task)
        return task

    loop.set_task_factory(track_task)
    tasks_before = set(asyncio.all_tasks())
    threads_before = set(threading.enumerate())
    result: Any = _MISSING
    error: BaseException | None = None
    cancelled = False
    reset_reason: str | None = None
    result_bundle: dict[str, Any] | None = None
    cleanup_error: str | None = None
    _emit({"type": "started", "id": cell_id})
    try:
        try:
            result = await _execute_source(request["code"])
        except KeyboardInterrupt as caught:
            error = caught
            cancelled = True
        except BaseException as caught:
            error = caught
        if error is None and result is not _MISSING and result is not None:
            result_bundle = _mime_bundle(result)
        _flush_matplotlib_figures()
        cleanup_error = await _cleanup_cell_work(
            tasks_before,
            tracked_tasks,
            threads_before,
        )
    except BaseException as caught:
        if error is None:
            error = caught
        reset_reason = "Python cell cleanup failed"
    finally:
        loop.set_task_factory(previous_task_factory)
    capture_complete = capture.stop()
    if cleanup_error is not None:
        reset_reason = cleanup_error
    elif not capture_complete:
        reset_reason = "Python output drains did not finish safely"
    if reset_reason is not None and error is None:
        error = RuntimeError(reset_reason)
        result = _MISSING

    if error is not None:
        _emit(_error_frame(error, cell_id))
        status = "error"
    else:
        if result_bundle is not None:
            _emit({"type": "result", "id": cell_id, "bundle": result_bundle})
        status = "ok"
    done: dict[str, Any] = {
        "type": "done",
        "id": cell_id,
        "status": status,
        "cancelled": cancelled,
        "resetRequired": reset_reason is not None,
        "resetReason": reset_reason,
    }
    _emit(done)
    _CURRENT_DISPLAYED_FIGURES.reset(figures_token)
    _CURRENT_TOOLS.reset(tools_token)
    _CURRENT_CWD.reset(cwd_token)
    _CURRENT_CELL_ID.reset(cell_token)
    return reset_reason is not None


def _read_request_line() -> dict[str, Any] | None:
    raw = _CONTROL.readline(_MAX_PROTOCOL_LINE_BYTES + 1)
    if not raw:
        return None
    if len(raw) > _MAX_PROTOCOL_LINE_BYTES or not raw.endswith(b"\n"):
        raise ValueError("host request exceeded the 64 MiB protocol-line limit")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("host request was not valid UTF-8 JSON") from error
    if isinstance(value, dict) and set(value) == {"type"} and value["type"] == "exit":
        return value
    return _strict_execute_request(value)


def _set_idle_sigint() -> None:
    if os.name != "nt":
        signal.signal(signal.SIGINT, signal.SIG_IGN)


def _set_active_sigint() -> None:
    if os.name != "nt":
        signal.signal(signal.SIGINT, signal.default_int_handler)


def main() -> None:
    _arm_parent_watchdog()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _set_idle_sigint()
    _emit(
        {
            "type": "ready",
            "protocolVersion": _PROTOCOL_VERSION,
            "pythonVersion": _PYTHON_VERSION,
        }
    )
    try:
        while True:
            request = _read_request_line()
            if request is None or request.get("type") == "exit":
                return
            _set_active_sigint()
            reset_required = loop.run_until_complete(_execute_cell(request))
            _set_idle_sigint()
            if reset_required:
                os._exit(1)
    finally:
        try:
            loop.run_until_complete(loop.shutdown_asyncgens())
        finally:
            loop.close()


if __name__ == "__main__":
    try:
        main()
    except BaseException as fatal_error:
        _fatal(f"pyRepl runner failed: {type(fatal_error).__name__}: {fatal_error}")
        raise
