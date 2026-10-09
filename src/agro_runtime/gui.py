"""本机 GUI 前台启动器：Agent 生命周期与调用终端绑定"""

import errno
import fcntl
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx

from .api import gui_directory
from .configuration import active_config
from .errors import fail


def _endpoint(value):
    try:
        endpoint = urlparse(value)
        port = endpoint.port
    except ValueError:
        fail("$.endpoint", "loopback_required", "GUI 入口端口或地址格式无效")
    if (
        endpoint.scheme != "http"
        or endpoint.hostname not in ("127.0.0.1", "::1", "localhost")
        or endpoint.username
        or endpoint.password
        or endpoint.query
        or endpoint.fragment
        or endpoint.path not in ("", "/")
        or not port
        or endpoint.params
    ):
        fail(
            "$.endpoint",
            "loopback_required",
            "GUI 入口必须是带明确端口的本地回环 HTTP 地址",
        )
    return endpoint


def _refused(exc):
    while exc is not None:
        if isinstance(exc, OSError) and exc.errno == errno.ECONNREFUSED:
            return True
        exc = exc.__cause__ or exc.__context__
    return False


def _identity(client, session_file, expected):
    if not session_file.is_file():
        fail("$.session_file", "local_session_required", "本机会话文件不存在")
    if session_file.stat().st_mode & 0o077:
        fail("$.session_file", "invalid_session_file", "会话文件必须仅允许当前用户访问")
    secret = session_file.read_text(encoding="utf-8").strip()
    if not secret:
        fail("$.session_file", "invalid_session_file", "本机会话文件为空")
    try:
        response = client.get(
            "/agent/identity", headers={"Authorization": "Bearer " + secret}
        )
    except httpx.HTTPError:
        fail("$.endpoint", "agent_unreachable", "Agent 身份查询未正常响应")
    try:
        identity = response.json()
    except ValueError:
        identity = {}
    if (
        response.status_code != 200
        or not isinstance(identity, dict)
        or any(identity.get(key) != value for key, value in expected.items())
    ):
        fail(
            "$.endpoint",
            "agent_identity_mismatch",
            "Agent 身份、项目、配置或状态目录不匹配，拒绝连接",
        )
    return identity


def _legacy_processes(endpoint, config, state, source_root):
    """只识别本用户、当前项目、相同端口与配置的旧版独立 Agent，绝不依赖 PID 猜测"""
    proc = Path("/proc")
    if not proc.is_dir():
        return []
    matches = []
    for item in proc.iterdir():
        if not item.name.isdecimal():
            continue
        try:
            if item.stat().st_uid != os.getuid():
                continue
            argv = (
                (item / "cmdline")
                .read_bytes()
                .rstrip(b"\x00")
                .decode("utf-8")
                .split("\x00")
            )
            at = argv.index("-m")
            if argv[at + 1 : at + 4] != ["agro_runtime.cli", "agent", "serve"]:
                continue

            def argument(name):
                index = argv.index(name)
                return argv[index + 1]

            if (
                Path(os.readlink(item / "cwd")).resolve() != source_root
                or Path(argument("--state-dir")).resolve() != state
                or Path(argument("--config")).resolve() != config
                or int(argument("--port")) != endpoint.port
                or argument("--host") != endpoint.hostname
                or os.getsid(int(item.name)) != int(item.name)
                or os.readlink(item / "fd/0") != "/dev/null"
                or Path(os.readlink(item / "fd/1")).resolve() != state / "agent.log"
                or Path(os.readlink(item / "fd/2")).resolve() != state / "agent.log"
            ):
                continue
            # 额外核对旧版“独立会话 + agent.log 日志重定向”的进程形态，
            # 不会误停用户在另一终端手工执行的 agent serve
            matches.append(int(item.name))
        except (OSError, ValueError, IndexError, UnicodeError):
            continue
    return matches


def _port_occupied(client):
    try:
        client.get("/agent/identity")
        return True
    except httpx.ConnectError as exc:
        if _refused(exc):
            return False
        fail("$.endpoint", "agent_unreachable", "端口状态不明确，不启动第二个 Agent")
    except httpx.HTTPError:
        # 不能把已占用且无响应的端口误判成空闲
        fail("$.endpoint", "port_in_use", "端口已有不响应的服务，请先确认并停止该服务")


def _retire_legacy(client, endpoint, config, state, source_root):
    """迁移旧版遗留后台 Agent；只发 SIGINT，让 Agent 自己确认模块停止；绝不强杀"""
    if not _port_occupied(client):
        return
    candidates = _legacy_processes(endpoint, config, state, source_root)
    if len(candidates) != 1:
        fail(
            "$.endpoint",
            "port_in_use",
            f"端口 {endpoint.port} 已占用且未能确认是本项目的旧版后台 Agent"
            f'请执行 ss -ltnp "sport = :{endpoint.port}" 查看占用者，核对后手动停止；不会自动结束未知进程',
        )
    pid = candidates[0]
    print(
        f"检测到当前项目遗留的后台 Agent（PID {pid}），请求安全停止后改为前台运行…",
        flush=True,
    )
    # 前一次安装产生的进程不属于本次子进程，只发送与旧版服务器一致的安全退出信号
    # pidfd 防止检查与发信号之间 PID 被回收后误触其他进程（内核支持时使用）
    fd = None
    try:
        if hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"):
            fd = os.pidfd_open(pid)
        if pid not in _legacy_processes(endpoint, config, state, source_root):
            fail("$.agent", "legacy_identity_changed", "旧进程身份已变化，拒绝自动停止")
        if fd is not None:
            signal.pidfd_send_signal(fd, signal.SIGINT)
        else:
            os.kill(pid, signal.SIGINT)
    except ProcessLookupError:
        pass  # 正好在检查时退出，后续仍需确认端口已释放
    finally:
        if fd is not None:
            os.close(fd)
    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        if not _port_occupied(client):
            print("旧版 Agent 已安全退出", flush=True)
            return
        time.sleep(0.15)
    fail(
        "$.agent",
        "legacy_shutdown_unconfirmed",
        f"旧版 Agent（PID {pid}）尚未退出，可能有未确认的停止动作；拒绝强制结束"
        "请先确认设备状态及运行任务，不要用 kill -9",
    )


def _stop_owned_agent(process):
    """前台脚本结束时停止自己启动的 Agent，不强杀停止未确认的网关"""
    if process is None or process.poll() is not None:
        return True
    print("正在停止本次 Agent 与系统模块…", flush=True)
    try:
        process.send_signal(signal.SIGINT)
        process.wait(timeout=20)
        return True
    except subprocess.TimeoutExpired:
        print(
            "警告：Agent 未确认完成安全停止，网关仍保留诊断；不会强制杀死进程",
            file=sys.stderr,
            flush=True,
        )
        return False
    except ProcessLookupError:
        return True


def _stop_desktop(process):
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        # Electron 只是 UI 外壳，不承担机器人安全停止；可以结束自己的窗口进程
        process.kill()
        process.wait(timeout=3)
    except ProcessLookupError:
        pass


def open_gui(args):
    endpoint = _endpoint(args.endpoint)
    state = args.state_dir.resolve()
    config = active_config(args.config, state)
    session_file = (args.session_file or state / "session.token").resolve()
    if session_file != state / "session.token":
        fail(
            "$.session_file",
            "session_path_mismatch",
            "前台模式会话文件必须位于对应状态目录",
        )
    directory = gui_directory(args.ui_dir)
    if not (directory / "index.html").is_file():
        fail(
            "$.ui_dir", "gui_build_required", "缺少 GUI 构建资源，请先执行 ./install.sh"
        )
    no_window = getattr(args, "no_window", getattr(args, "no_browser", False))
    desktop = (
        getattr(args, "desktop_dir", None) or directory.parent / "desktop"
    ).resolve()
    electron = desktop / "runtime" / "electron"
    entry = desktop / "main.cjs"
    if not no_window and (
        not electron.is_file()
        or not os.access(electron, os.X_OK)
        or not entry.is_file()
        or not (desktop / "preload.cjs").is_file()
    ):
        fail(
            "$.desktop_dir",
            "desktop_install_required",
            "缺少 Electron 桌面环境，请重新执行 ./install.sh",
        )
    executable = args.task_engine or shutil.which("agro-bt")
    if (
        not executable
        or not Path(executable).is_file()
        or not os.access(executable, os.X_OK)
    ):
        fail(
            "$.task_engine",
            "task_engine_required",
            "未找到可执行的 agro-bt，请先执行 ./install.sh",
        )
    expected = {
        "application": "AT-System-Integration",
        "source_root": str(Path(__file__).resolve().parents[2]),
        "config_path": str(config),
        "config_sha256": hashlib.sha256(config.read_bytes()).hexdigest(),
        "state_directory": str(state),
    }
    state.mkdir(parents=True, exist_ok=True)
    # 保持互斥锁直到关闭：用户不会在另一个终端不小心创建第二个前台启动器
    with (state / "launcher.lock").open("a+b") as launcher_lock:
        os.chmod(state / "launcher.lock", 0o600)
        try:
            fcntl.flock(launcher_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail(
                "$.launcher",
                "launcher_already_running",
                "当前状态目录已有启动中的终端，请先在原终端按 Ctrl+C 或关闭窗口",
            )
        process = None
        desktop_process = None
        shutdown_ok = True
        old_sigterm = signal.getsignal(signal.SIGTERM)
        old_sighup = signal.getsignal(signal.SIGHUP)

        def request_shutdown(_signum, _frame):
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, request_shutdown)
        signal.signal(signal.SIGHUP, request_shutdown)
        window_code = 0
        try:
            with httpx.Client(
                base_url=args.endpoint.rstrip("/"),
                timeout=2.0,
                trust_env=False,
                follow_redirects=False,
            ) as client:
                _retire_legacy(
                    client, endpoint, config, state, Path(expected["source_root"])
                )
                command = [
                    sys.executable,
                    "-m",
                    "agro_runtime.cli",
                    "agent",
                    "serve",
                    "--config",
                    str(config),
                    "--state-dir",
                    str(state),
                    "--host",
                    endpoint.hostname,
                    "--port",
                    str(endpoint.port),
                    "--task-engine",
                    str(Path(executable).resolve()),
                    "--ui-dir",
                    str(directory),
                ]
                # stdout/stderr 继承终端，且不脱离终端对应的 launcher 生命周期
                # 独立进程组防止 Ctrl+C 同时打断 Agent 的异步安全停止逻辑
                process = subprocess.Popen(
                    command, stdin=subprocess.DEVNULL, start_new_session=True
                )
                deadline = time.monotonic() + 15.0
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        fail(
                            "$.agent",
                            "agent_start_failed",
                            "Agent 启动失败，具体错误已打印在上方终端日志",
                        )
                    try:
                        if _port_occupied(client) and session_file.is_file():
                            identity = _identity(
                                client, session_file, {**expected, "pid": process.pid}
                            )
                            response = client.get("/ui/")
                            if (
                                response.status_code != 200
                                or "text/html"
                                not in response.headers.get("content-type", "")
                            ):
                                fail("$.ui_dir", "gui_unavailable", "Agent 未提供 GUI")
                            break
                    except httpx.ConnectError:
                        pass
                    time.sleep(0.1)
                else:
                    fail(
                        "$.agent",
                        "agent_start_timeout",
                        "Agent 未在 15 秒内进入就绪状态；已请求安全停止",
                    )
            url = args.endpoint.rstrip("/") + "/ui/"
            print(f"工作台: {url}", flush=True)
            print(
                "Agent 在当前终端运行；关闭 GUI 窗口或按 Ctrl+C 将请求停止系统并退出",
                flush=True,
            )
            if not no_window:
                environment = os.environ.copy()
                environment.pop("ELECTRON_RUN_AS_NODE", None)
                desktop_process = subprocess.Popen(
                    [
                        str(electron),
                        str(entry),
                        "--url",
                        url,
                        "--data-dir",
                        str(state / "desktop"),
                        "--session-file",
                        str(session_file),
                        "--identity",
                        json.dumps(
                            {
                                key: identity[key]
                                for key in (
                                    "application",
                                    "source_root",
                                    "state_directory",
                                    "pid",
                                )
                            }
                        ),
                    ],
                    stdin=subprocess.DEVNULL,
                    env=environment,
                    start_new_session=True,
                )
            while True:
                if process.poll() is not None:
                    print("Agent 意外退出，正在关闭工作台", file=sys.stderr, flush=True)
                    window_code = 1
                    break
                if desktop_process is not None and desktop_process.poll() is not None:
                    window_code = desktop_process.returncode or 0
                    if window_code:
                        print(
                            "GUI 窗口异常退出，请查看上方桌面日志",
                            file=sys.stderr,
                            flush=True,
                        )
                    break
                time.sleep(0.15)
        except KeyboardInterrupt:
            print("\n收到 Ctrl+C，正在安全关闭工作台…", flush=True)
        finally:
            # 用户连续按 Ctrl+C 或会话收到 SIGHUP 时，不得打断已发起的安全停止
            old_sigint = signal.getsignal(signal.SIGINT)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGHUP, signal.SIG_IGN)
            try:
                _stop_desktop(desktop_process)
                shutdown_ok = _stop_owned_agent(process)
            finally:
                signal.signal(signal.SIGINT, old_sigint)
                signal.signal(signal.SIGTERM, old_sigterm)
                signal.signal(signal.SIGHUP, old_sighup)
        if not shutdown_ok:
            fail(
                "$.agent",
                "stop_unconfirmed",
                "Agent 安全停止未确认，不能断言已退出；请检查机器人及运行任务，然后手动处理遗留进程",
            )
        return {
            "valid": window_code == 0,
            "mode": "foreground",
            "agent_stopped": True,
            "desktop_exit_code": window_code,
        }
