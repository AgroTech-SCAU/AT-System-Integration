"""检验前台启动器、Ctrl+C 收尾、旧版后台迁移、未知占用与互斥；不启动真机"""

import os
import signal
import socket
import subprocess
import sys
import tempfile
import uuid
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
ENV = os.environ.copy()
ENV["PYTHONPATH"] = os.pathsep.join(
    [str(ROOT / "src"), str(ROOT / "adapters"), ENV.get("PYTHONPATH", "")]
)
CONFIG = ROOT / "examples" / "tomato_picker" / "system.yaml"


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def temp_layout(root):
    ui, desktop, state, executable = (
        root / "gui",
        root / "desktop",
        root / "state",
        root / "agro-bt",
    )
    ui.mkdir()
    (ui / "index.html").write_text("<!doctype html><html>ready</html>")
    (desktop / "runtime").mkdir(parents=True)
    (desktop / "main.cjs").write_text("// fake desktop")
    (desktop / "preload.cjs").write_text("// fake preload")
    electron = desktop / "runtime" / "electron"
    electron.write_text("#!/bin/sh\nsleep 1\n")
    electron.chmod(0o755)
    executable.write_text("#!/bin/sh\nexit 0\n")
    executable.chmod(0o755)
    return ui, desktop, state, executable


def cmd(state, ui, desktop, executable, target_port, *extra):
    return [
        sys.executable,
        "-m",
        "agro_runtime.cli",
        "--endpoint",
        f"http://127.0.0.1:{target_port}",
        "gui",
        "open",
        "--config",
        str(CONFIG),
        "--state-dir",
        str(state),
        "--task-engine",
        str(executable),
        "--ui-dir",
        str(ui),
        "--desktop-dir",
        str(desktop),
        *extra,
    ]


def spawn(command):
    return subprocess.Popen(
        command,
        cwd=ROOT,
        env=ENV,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )


def reachable(port_number):
    try:
        return httpx.get(
            f"http://127.0.0.1:{port_number}/agent/identity",
            timeout=0.3,
            trust_env=False,
        ).status_code in (200, 401)
    except httpx.HTTPError:
        return False


def until(predicate, *, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.1)
    raise AssertionError("Timeout while waiting")


def halt(proc):
    if proc.poll() is None:
        proc.send_signal(signal.SIGINT)
    try:
        out, _ = proc.communicate(timeout=12)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, _ = proc.communicate(timeout=5)
        raise AssertionError(f"Leaked process: {out[-1200:]}")
    return out


def exercise():
    with tempfile.TemporaryDirectory(prefix="agro-launch-smoke-") as directory:
        ui, desktop, state, exe = temp_layout(Path(directory))
        p = port()
        foreground = spawn(cmd(state, ui, desktop, exe, p, "--no-window"))
        try:
            until(lambda: reachable(p) and (state / "session.token").exists())
            assert foreground.poll() is None, "前台启动器不应立刻退出"
            second = spawn(cmd(state, ui, desktop, exe, p, "--no-window"))
            duplicate_output, _ = second.communicate(timeout=6)
            assert (
                second.returncode != 0
                and "launcher_already_running" in duplicate_output
            ), duplicate_output
            assert reachable(p)
            token = (state / "session.token").read_text().strip()
            with httpx.Client(
                base_url=f"http://127.0.0.1:{p}",
                headers={"Authorization": "Bearer " + token},
                timeout=3,
                trust_env=False,
            ) as client:
                accepted = client.post(
                    "/system/start", json={"request_id": "start_" + uuid.uuid4().hex}
                )
                assert accepted.status_code == 202, accepted.text

                def ready():
                    return client.get("/system/status").json()["state"] == "READY"

                until(ready)
                assert client.get("/system/status").json()["modules"]["robot"][
                    "process"
                ]
                print("PASS: live mock module READY before Ctrl+C", flush=True)
            print("PASS: foreground alive + duplicate launch rejected", flush=True)
        finally:
            out = halt(foreground)
        assert foreground.returncode == 0, out
        until(lambda: not reachable(p))
        print(
            "PASS: Ctrl+C safely stops running mock module and Agent, frees port",
            flush=True,
        )

        p = port()
        sigterm_front = spawn(cmd(state, ui, desktop, exe, p, "--no-window"))
        try:
            until(lambda: reachable(p))
            sigterm_front.send_signal(signal.SIGTERM)
            out, _ = sigterm_front.communicate(timeout=12)
            assert sigterm_front.returncode == 0, out
            until(lambda: not reachable(p))
            print("PASS: SIGTERM stops foreground Agent", flush=True)
        finally:
            halt(sigterm_front)

        p = port()
        frontend = spawn(cmd(state, ui, desktop, exe, p))
        out, _ = frontend.communicate(timeout=15)
        assert frontend.returncode == 0, out
        until(lambda: not reachable(p))
        print("PASS: closing desktop ends foreground Agent", flush=True)

        p = port()
        with (state / "agent.log").open("ab") as legacy_log:
            old = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "agro_runtime.cli",
                    "agent",
                    "serve",
                    "--config",
                    str(CONFIG),
                    "--state-dir",
                    str(state),
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(p),
                    "--task-engine",
                    str(exe),
                    "--ui-dir",
                    str(ui),
                ],
                cwd=ROOT,
                env=ENV,
                stdin=subprocess.DEVNULL,
                stdout=legacy_log,
                stderr=legacy_log,
                start_new_session=True,
            )
        try:
            until(lambda: reachable(p))
            (state / "session.token").unlink()
            fresh = spawn(cmd(state, ui, desktop, exe, p, "--no-window"))
            try:
                until(
                    lambda: fresh.poll() is None
                    and reachable(p)
                    and old.poll() is not None,
                    timeout=15,
                )
                print(
                    "PASS: securely identified legacy background safely stopped",
                    flush=True,
                )
            finally:
                out = halt(fresh)
                assert fresh.returncode == 0, out
        finally:
            if old.poll() is None:
                old.send_signal(signal.SIGINT)
            old.wait(timeout=8)
        until(lambda: not reachable(p))

        p = port()
        manual = spawn(
            [
                sys.executable,
                "-m",
                "agro_runtime.cli",
                "agent",
                "serve",
                "--config",
                str(CONFIG),
                "--state-dir",
                str(state),
                "--host",
                "127.0.0.1",
                "--port",
                str(p),
                "--task-engine",
                str(exe),
                "--ui-dir",
                str(ui),
            ]
        )
        try:
            until(lambda: reachable(p))
            rejected = spawn(cmd(state, ui, desktop, exe, p, "--no-window"))
            out, _ = rejected.communicate(timeout=5)
            assert rejected.returncode != 0 and "port_in_use" in out, out
            assert manual.poll() is None
            print("PASS: manually started Agent is never auto-stopped", flush=True)
        finally:
            halt(manual)
        until(lambda: not reachable(p))

        p = port()
        unrelated = spawn(
            [sys.executable, "-m", "http.server", str(p), "--bind", "127.0.0.1"]
        )
        try:

            def served():
                try:
                    return (
                        httpx.get(
                            f"http://127.0.0.1:{p}/", timeout=0.5, trust_env=False
                        ).status_code
                        == 200
                    )
                except httpx.HTTPError:
                    return False

            until(served)
            rejected = spawn(cmd(state, ui, desktop, exe, p, "--no-window"))
            out, _ = rejected.communicate(timeout=5)
            assert rejected.returncode != 0 and "port_in_use" in out, out
            assert unrelated.poll() is None
            print("PASS: unknown port owner is never terminated", flush=True)
        finally:
            unrelated.terminate()
            unrelated.communicate(timeout=5)


if __name__ == "__main__":
    exercise()
