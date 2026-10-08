"""GUI 本机启动握手，复用同一 Agent 与会话"""
import errno
import hashlib
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx

from .api import gui_directory
from .errors import fail


def _endpoint(value):
    try:
        endpoint = urlparse(value)
        port = endpoint.port
    except ValueError:
        fail('$.endpoint', 'loopback_required', 'GUI 入口端口或地址格式无效')
    if (endpoint.scheme != 'http' or endpoint.hostname not in ('127.0.0.1', '::1', 'localhost')
            or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
            or endpoint.path not in ('', '/') or not port or endpoint.params):
        fail('$.endpoint', 'loopback_required', 'GUI 入口必须是带明确端口的本地回环 HTTP 地址')
    return endpoint


def _refused(exc):
    while exc is not None:
        if isinstance(exc, OSError) and exc.errno == errno.ECONNREFUSED:
            return True
        exc = exc.__cause__ or exc.__context__
    return False


def _identity(client, session_file, expected):
    secret = session_file.read_text(encoding='utf-8').strip()
    if not secret or session_file.stat().st_mode & 0o077:
        fail('$.session_file', 'invalid_session_file', '会话文件必须非空且仅允许当前用户访问')
    try:
        response = client.get('/agent/identity', headers={'Authorization': 'Bearer ' + secret})
    except httpx.ConnectError:
        raise
    except httpx.HTTPError:
        fail('$.endpoint', 'agent_unreachable', '目标 Agent 身份查询未正常响应')
    try:
        identity = response.json()
    except ValueError:
        identity = {}
    if response.status_code != 200 or not isinstance(identity, dict) or any(identity.get(key) != value for key, value in expected.items()):
        fail('$.endpoint', 'agent_identity_mismatch', '目标服务身份、项目、会话、配置或状态目录不匹配，拒绝连接')
    return identity


def open_gui(args):
    endpoint = _endpoint(args.endpoint)
    config = args.config.resolve()
    state = args.state_dir.resolve()
    session_file = (args.session_file or state / 'session.token').resolve()
    directory = gui_directory(args.ui_dir)
    if not (directory / 'index.html').is_file():
        fail('$.ui_dir', 'gui_build_required',
             '缺少 GUI 构建资源，请执行 npm --prefix gui ci 和 npm --prefix gui run build，或指定 --ui-dir')
    no_window = getattr(args, 'no_window', getattr(args, 'no_browser', False))
    desktop = (getattr(args, 'desktop_dir', None) or directory.parent / 'desktop').resolve()
    electron = desktop / 'runtime' / 'electron'
    entry = desktop / 'main.cjs'
    if not no_window and (not electron.is_file() or not os.access(electron, os.X_OK)
                          or not entry.is_file() or not (desktop / 'preload.cjs').is_file()):
        fail('$.desktop_dir', 'desktop_install_required', '缺少 Electron 桌面环境，请重新执行 ./install.sh')
    expected = {'application': 'AT-System-Integration',
                'source_root': str(Path(__file__).resolve().parents[2]),
                'config_path': str(config), 'config_sha256': hashlib.sha256(config.read_bytes()).hexdigest(),
                'state_directory': str(state)}
    process = None
    with httpx.Client(base_url=args.endpoint.rstrip('/'), timeout=2.0, trust_env=False,
                      follow_redirects=False) as client:
        try:
            client.get('/agent/identity')
        except httpx.ConnectError as exc:
            if not _refused(exc):
                fail('$.endpoint', 'agent_unreachable', '无法确定目标端口是否空闲，拒绝启动第二个 Agent')
            if session_file != state / 'session.token':
                fail('$.session_file', 'session_path_mismatch', '启动 Agent 时会话文件必须位于指定状态目录')
            executable = args.task_engine or shutil.which('agro-bt')
            if not executable or not Path(executable).is_file() or not os.access(executable, os.X_OK):
                fail('$.task_engine', 'task_engine_required', '未找到可执行的 agro-bt，请先构建 task_engine 并指定 --task-engine')
            state.mkdir(parents=True, exist_ok=True)
            command = [sys.executable, '-m', 'agro_runtime.cli', 'agent', 'serve',
                       '--config', str(config), '--state-dir', str(state),
                       '--host', endpoint.hostname, '--port', str(endpoint.port),
                       '--task-engine', str(Path(executable).resolve()), '--ui-dir', str(directory)]
            with (state / 'agent.log').open('ab') as log:
                process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                           start_new_session=True)
            deadline = time.monotonic() + 15.0
            while True:
                if process.poll() is not None:
                    fail('$.agent', 'agent_start_failed', 'Agent 启动失败，请检查状态目录中的 agent.log')
                try:
                    if session_file.is_file():
                        identity = _identity(client, session_file, expected)
                        break
                except httpx.ConnectError:
                    pass
                if time.monotonic() >= deadline:
                    # 未确认进程状态时保留诊断，不盲目杀死可能持有任务的 Agent
                    fail('$.agent', 'agent_start_timeout', 'Agent 启动未确认，请检查 agent.log，重试会重新核对已有 Agent')
                time.sleep(0.1)
        except httpx.HTTPError:
            fail('$.endpoint', 'agent_unreachable', '目标入口未正常响应，拒绝启动第二个 Agent')
        else:
            if not session_file.is_file():
                fail('$.session_file', 'local_session_required', '目标端口已有服务，请指定对应本机会话文件后核对身份')
            try:
                identity = _identity(client, session_file, expected)
            except httpx.ConnectError:
                fail('$.endpoint', 'agent_unreachable', '已有 Agent 连接中断，请重新核对入口')
        try:
            response = client.get('/ui/')
        except httpx.HTTPError:
            fail('$.endpoint', 'agent_unreachable', '目标 GUI 未正常响应')
        if response.status_code != 200 or 'text/html' not in response.headers.get('content-type', ''):
            fail('$.ui_dir', 'gui_unavailable', 'Agent 未提供 GUI，请检查该 Agent 的 --ui-dir 或构建资源')
    url = args.endpoint.rstrip('/') + '/ui/'
    desktop_process = None
    if not no_window:
        environment = os.environ.copy()
        environment.pop('ELECTRON_RUN_AS_NODE', None)
        with (state / 'desktop.log').open('ab') as log:
            desktop_process = subprocess.Popen(
                [str(electron), str(entry), '--url', url, '--data-dir', str(state / 'desktop')],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=environment,
                start_new_session=True)
        # 第二次打开正常退出并聚焦已有窗口，非零退出保留桌面诊断
        try:
            if desktop_process.wait(timeout=2) != 0:
                fail('$.desktop', 'desktop_start_failed', '桌面启动失败，请检查状态目录中的 desktop.log')
        except subprocess.TimeoutExpired:
            pass
    return {'url': url, 'agent_pid': identity['pid'], 'started_agent': process is not None,
            'desktop_opened': desktop_process is not None,
            'desktop_pid': desktop_process.pid if desktop_process else None,
            'session_file': str(session_file),
            'connection': '在应用窗口选择本机会话文件或输入凭据，刷新后需重新连接'}
