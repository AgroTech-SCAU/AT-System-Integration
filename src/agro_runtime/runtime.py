"""单机运行管理、唯一进程管理者与配置快照"""
import asyncio
import fcntl
import hashlib
import json
import os
import signal
import sys
from pathlib import Path
from uuid import uuid4

from .control import RobotMode
from .errors import ContractValidationError, fail, parse
from .execution import ExecutionEngine, TERMINAL
from .models import ExecutionRequest, OperationState, StopState, SystemConfig
from .records import OperationLedger
from .registry import Registry, bind_system, load_package, read_document


def load_system(path):
    path = Path(path).resolve()
    config = parse(SystemConfig, read_document(path))
    registry = Registry()
    for reference in config.packages:
        registry.register(load_package(path.parent / reference))
    bound = bind_system(config, registry)
    runtime_plan(bound, registry)
    return bound, registry


def _dependency_order(modules):
    visiting, visited, result = set(), set(), []
    def visit(name):
        if name not in modules:
            fail('$.runtime.dependencies', 'missing_module', f'依赖模块 {name} 不存在')
        if name in visiting:
            fail('$.runtime.dependencies', 'dependency_cycle', f'模块 {name} 存在依赖环')
        if name in visited:
            return
        visiting.add(name)
        for dependency in modules[name].dependencies:
            visit(dependency)
        visiting.remove(name)
        visited.add(name)
        result.append(name)
    for name in modules:
        visit(name)
    return result


def runtime_plan(bound, registry):
    modules = {name: (backend.runtime or registry.packages[backend.package_id].runtime)
                    for name, backend in bound.backends.items()}
    order = _dependency_order(modules)
    owners = set()
    for name, descriptor in modules.items():
        # 同一目标不能同时声明 systemd 与 Agent 管理
        if descriptor.target in owners:
            fail(f'$.modules.{name}.target', 'duplicate_process_owner', '运行目标只能有一个管理者')
        owners.add(descriptor.target)
        if descriptor.manager == 'systemd' and descriptor.argv:
            fail(f'$.modules.{name}.argv', 'duplicate_process_owner', 'systemd 目标不得另配本地启动命令')
    return modules, order


class SnapshotStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def save(self, payload):
        encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
        identity = hashlib.sha256(encoded.encode()).hexdigest()
        path = self.directory / f'{identity}.json'
        try:
            with path.open('x', encoding='utf-8') as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            path.chmod(0o400)
        except FileExistsError:
            if path.read_text(encoding='utf-8') != encoded:
                fail('$.snapshot', 'snapshot_corrupt', '已存储快照与内容摘要不符')
        return identity, encoded


class LocalProcessManager:
    """管理根进程组，持久身份避免 Agent 重启后重复启动"""
    def __init__(self, *, state_directory=None, config_identity=None):
        self.processes = {}
        self.identities = {}
        self.locks = {}
        self.config_identity = config_identity
        self.directory = Path(state_directory) if state_directory else None
        if self.directory:
            self.directory.mkdir(parents=True, exist_ok=True)
            for path in self.directory.glob('*.json'):
                try:
                    record = json.loads(path.read_text(encoding='utf-8'))
                    if not isinstance(record['pid'], int) or record['pid'] <= 1:
                        raise ValueError('invalid pid')
                    self.identities[path.stem] = record
                except (ValueError, KeyError, TypeError):
                    fail('$.processes', 'process_record_invalid', '本地进程身份记录损坏，需要核对')

    @staticmethod
    def _identity(pid):
        try:
            fields = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
            boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            return {'boot': boot, 'start': fields[19], 'state': fields[0], 'group': int(fields[2])}
        except (OSError, IndexError, ValueError):
            return None

    @staticmethod
    def _group_alive(pid):
        try:
            os.killpg(pid, 0)
            return True
        except ProcessLookupError:
            return False

    def _root_matches(self, record, current=None):
        current = current or self._identity(record['pid'])
        expected = record['identity']
        return (current is not None and expected is not None and current['boot'] == expected['boot']
                and current['start'] == expected['start'] and current['group'] == record['pid'])

    def _save(self, name, record):
        self.identities[name] = record
        if self.directory:
            temporary = self.directory / f'{name}.tmp'
            with temporary.open('w', encoding='utf-8') as stream:
                json.dump(record, stream)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(self.directory / f'{name}.json')

    def _forget(self, name):
        self.identities.pop(name, None)
        lock = self.locks.pop(name, None)
        if lock:
            lock.close()
        if self.directory:
            (self.directory / f'{name}.json').unlink(missing_ok=True)

    def _claim(self, name):
        if not self.directory or name in self.locks:
            return
        lock = (self.directory / f'{name}.lock').open('a')
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            fail(f'$.modules.{name}', 'process_owner_unconfirmed', '旧进程仍持有管理权，不能重复启动')
        self.locks[name] = lock

    async def start(self, name, descriptor):
        record = self.identities.get(name)
        if record and self._root_matches(record):
            if (record['target'] != descriptor.target or record.get('config_identity') != self.config_identity
                    or record.get('argv') != descriptor.argv):
                fail(f'$.modules.{name}', 'process_config_mismatch', '遗留进程绑定另一份配置，必须先停止并核对')
            return
        if record and self._group_alive(record['pid']):
            fail(f'$.modules.{name}', 'process_owner_unconfirmed', '进程组根身份不符或仍有子进程，不能重复启动')
        self._forget(name)
        self._claim(name)
        argv = descriptor.argv
        mock_worker = not argv and descriptor.manager == 'local_process' and descriptor.target == 'tomato_simulator'
        if not argv:
            if not mock_worker:
                fail(f'$.modules.{name}.argv', 'module_command_missing', '本地模块必须声明 argv')
            argv = [sys.executable, '-m', 'agro_mock.worker']
        lock = self.locks.get(name)
        try:
            process = await asyncio.create_subprocess_exec(
                *argv, start_new_session=True, pass_fds=(lock.fileno(),) if lock else (),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE if mock_worker else asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL)
        except BaseException:
            self._forget(name)
            raise
        self.processes[name] = process
        self._save(name, {'pid': process.pid, 'identity': self._identity(process.pid),
                          'target': descriptor.target, 'argv': descriptor.argv,
                          'config_identity': self.config_identity})
        if mock_worker and await process.stdout.readline() != b'READY\n':
            fail(f'$.modules.{name}', 'module_start_failed', '模拟进程未确认接口就绪')

    async def status(self, name, descriptor):
        record = self.identities.get(name)
        current = self._identity(record['pid']) if record else None
        running = bool(record and current and self._root_matches(record, current)
                       and current['state'] != 'Z')
        return {'running': running, 'pid': record['pid'] if record else None}

    async def stop(self, name, descriptor):
        record = self.identities.get(name)
        if record is None:
            self._claim(name)
            self._forget(name)
            return
        current = self._identity(record['pid'])
        if current and not self._root_matches(record):
            fail(f'$.modules.{name}', 'process_owner_unconfirmed', 'PID 身份已变化，不向未知进程发送信号')
        if current is None and record['identity'] and record['identity']['boot'] != Path('/proc/sys/kernel/random/boot_id').read_text().strip():
            self._forget(name)
            return
        try:
            os.killpg(record['pid'], signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = asyncio.get_running_loop().time() + descriptor.stop_timeout_s
        while self._group_alive(record['pid']):
            if asyncio.get_running_loop().time() >= deadline:
                fail(f'$.modules.{name}', 'module_stop_unconfirmed', '进程组未在停止期限内退出')
            await asyncio.sleep(.01)
        self._forget(name)


class SystemdManager:
    """可替换服务管理器，仅请求 systemd 管理目标 unit"""
    async def _call(self, *args):
        process = await asyncio.create_subprocess_exec(
            'systemctl', '--user', *args, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await process.communicate()
        except asyncio.CancelledError:
            process.kill()
            await process.wait()
            raise
        return process.returncode, stdout.decode().strip(), stderr.decode().strip()

    async def start(self, name, descriptor):
        code, _, reason = await self._call('start', '--', descriptor.target)
        if code:
            fail(f'$.modules.{name}', 'module_start_failed', reason or 'systemd 启动失败')

    async def status(self, name, descriptor):
        code, state, _ = await self._call('is-active', '--', descriptor.target)
        return {'running': code == 0 and state == 'active', 'pid': None}

    async def stop(self, name, descriptor):
        code, _, reason = await self._call('stop', '--', descriptor.target)
        if code:
            fail(f'$.modules.{name}', 'module_stop_unconfirmed', reason or 'systemd 停止失败')
        if (await self.status(name, descriptor))['running']:
            fail(f'$.modules.{name}', 'module_stop_unconfirmed', 'systemd 目标仍在运行')


class Runtime:
    def __init__(self, config_path, state_directory, *, managers=None, readiness_probe=None,
                 native_validators=None, native_appliers=None, allowed_entrypoints=None, adapter_options=None,
                 cancel_timeout_s=2.0, owner_lock=None):
        self.config_path = Path(config_path).resolve()
        self.replacement_options = dict(managers=managers, readiness_probe=readiness_probe,
            native_validators=native_validators, native_appliers=native_appliers,
            allowed_entrypoints=allowed_entrypoints, adapter_options=adapter_options,
            cancel_timeout_s=cancel_timeout_s)
        self.bound, self.registry = load_system(self.config_path)
        self.modules, self.order = runtime_plan(self.bound, self.registry)
        native = {}
        for name, backend in self.bound.backends.items():
            if backend.native_config is None:
                continue
            validator = (native_validators or {}).get(backend.package_id)
            if validator is None:
                fail(f'$.backends.{name}.native_config', 'native_validator_required', '原生配置必须由对应后端校验')
            path = (self.config_path.parent / backend.native_config).resolve()
            content = read_document(path)
            try:
                valid = validator(content)
            except ContractValidationError:
                raise
            except Exception as exc:
                fail(f'$.backends.{name}.native_config', 'native_config_invalid', str(exc))
            if valid is False:
                fail(f'$.backends.{name}.native_config', 'native_config_invalid', '原生配置未通过后端校验')
            native[name] = {'path': str(path), 'content': content}
        self.state_directory = Path(state_directory)
        self.state_directory.mkdir(parents=True, exist_ok=True)
        self._owner = owner_lock or (self.state_directory / 'agent.lock').open('a')
        try:
            fcntl.flock(self._owner.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._owner.close()
            fail('$.state_directory', 'agent_already_running', '该状态目录已由另一个 Agent 管理')
        try:
            self.snapshot_id, self._snapshot = SnapshotStore(self.state_directory / 'snapshots').save({
                'system': self.bound.config.model_dump(mode='json'),
                'packages': {name: value.model_dump(mode='json') for name, value in self.registry.packages.items()},
                'native_config': native})
            self.records = OperationLedger(self.state_directory / 'operations.db')
            self.engine = ExecutionEngine(self.bound, self.registry, records=self.records,
                                          cancel_timeout_s=cancel_timeout_s, authorize=self._authorize)
            self.native_files = {}
            native_store = SnapshotStore(self.state_directory / 'snapshots' / 'native')
            for name, reference in native.items():
                identity, _ = native_store.save(reference['content'])
                self.native_files[name] = native_store.directory / f'{identity}.json'
        except BaseException:
            if owner_lock is None:
                self._owner.close()
            raise
        local = LocalProcessManager(state_directory=self.state_directory / 'processes',
                                    config_identity=self.snapshot_id)
        self.managers = {'local_process': local, 'ros_launch': local, 'systemd': SystemdManager()}
        self.managers.update(managers or {})
        self.probe = readiness_probe
        self.allowed_entrypoints = (frozenset({'agro_mock:create_adapter'}) if allowed_entrypoints is None
                                    else frozenset(allowed_entrypoints))
        self.adapter_options = adapter_options or {}
        self.native_appliers = native_appliers or {}
        self._loaded_backends = set()
        previous = self.records.metadata('runtime_run')
        previous = json.loads(previous) if previous else {}
        uncertain = any(item.stop_state == StopState.UNCONFIRMED for item in self.records.list_operations())
        self.state = 'RECOVERING' if uncertain or previous.get('state') not in (None, 'STOPPED') else 'STOPPED'
        self.system_run_id = previous.get('system_run_id')
        self.accepting = False
        self.stop_requested = False
        self.module_status = {name: {'state': 'STOPPED', 'pid': None, 'process': False,
                                    'interface': False, 'reason': None} for name in self.modules}
        self._lifecycle = asyncio.Lock()
        self._monitor_task = None
        self._closed = False
        self.tasks = None

    def snapshot(self):
        return json.loads(self._snapshot)

    def _enable_adapter(self, name):
        options = {} if name in self._loaded_backends else dict(self.adapter_options.get(name, {}))
        if name not in self._loaded_backends and self.tasks and self.registry.packages[self.bound.backends[name].package_id].adapter_entrypoint == 'agro_mock:create_adapter':
            options['completed_targets'] = self.tasks.completed_targets(name)
        self.engine.enable_adapter(name, allowed_entrypoints=self.allowed_entrypoints, **options)
        self._loaded_backends.add(name)

    def _apply_native(self, name):
        if name not in self.native_files:
            return
        backend = self.bound.backends[name]
        descriptor = self.modules[name]
        frozen = str(self.native_files[name].resolve())
        reference = self.snapshot()['native_config'][name]
        if descriptor.manager in ('local_process', 'ros_launch'):
            if (not any('{native_config}' in arg for arg in descriptor.argv)
                    and not any(frozen in arg for arg in descriptor.argv)):
                fail(f'$.modules.{name}.argv', 'native_apply_required', '原生配置启动参数必须引用 {native_config} 冻结文件')
            self.modules[name] = descriptor.model_copy(update={
                'argv': [arg.replace('{native_config}', frozen) for arg in descriptor.argv]})
        else:
            applier = self.native_appliers.get(backend.package_id)
            if applier is None:
                fail(f'$.modules.{name}', 'native_apply_required', '服务管理后端必须提供冻结原生配置应用器')
            try:
                applied = applier(name, frozen, reference['content'])
            except ContractValidationError:
                raise
            except Exception as exc:
                fail(f'$.modules.{name}', 'native_apply_failed', str(exc))
            if applied is not True:
                fail(f'$.modules.{name}', 'native_apply_failed', '后端未确认冻结配置已应用')

    def enable_package(self, package_id):
        if package_id not in self.registry.packages:
            fail('$.package_id', 'unknown_package', '接入包不存在')
        for name, backend in self.bound.backends.items():
            if backend.package_id == package_id:
                self._enable_adapter(name)
        return self.registry.is_enabled(package_id)

    def status(self):
        return {'system_id': self.bound.config.system_id, 'system_run_id': self.system_run_id,
                'snapshot_id': self.snapshot_id, 'state': self.state, 'accepting_operations': self.accepting,
                'mode': self.engine.control.mode.value, 'estop': self.engine.control.estop,
                'modules': json.loads(json.dumps(self.module_status)),
                'operations': [item.model_dump(mode='json') for item in self.records.list_operations()]}

    def _checks(self, name, capability=None, phase=None):
        module = self.module_status[name]
        checks = {'process': {'ready': module['process'], 'reason': module['reason']},
                  'interface': {'ready': module['interface'], 'reason': module['reason']},
                  'data': {'ready': True, 'reason': None},
                  'authorization': {'ready': True, 'reason': None}}
        if self.probe:
            measured = self.probe(name, capability, phase)
            for dimension in ('interface', 'data'):
                if dimension in measured:
                    checks[dimension] = measured[dimension]
        elif capability and capability.preconditions:
            checks['data'] = {'ready': False, 'reason': {'code': 'data_check_required',
                              'reason': '能力前置条件需要后端提供按阶段的数据检查'}}
        return checks

    def readiness(self, backend_instance, capability_id, *, phase='dispatch', control=None):
        capability = self.bound.capabilities.get((backend_instance, capability_id))
        if capability is None:
            fail('$.capability_id', 'unknown_capability', '后端能力不存在')
        checks = self._checks(backend_instance, capability, phase)
        try:
            if not self.accepting:
                fail('$.system', 'system_not_ready', '系统尚未就绪或正在停止')
            if control is None:
                fail('$.control', 'control_required', '尚未提供动作授权')
            self.engine.control.validate_control(control, capability.resources)
        except ContractValidationError as exc:
            checks['authorization'] = {'ready': False, 'reason': exc.issues[0].model_dump()}
        return {'backend_instance': backend_instance, 'capability_id': capability_id,
                'phase': phase, 'checks': checks, 'ready': all(item['ready'] for item in checks.values())}

    def _authorize(self, request, resources):
        if self.tasks:
            self.tasks.guard(request)
        result = self.readiness(request.backend_instance, request.capability_id, control=request.control)
        for dimension, check in result['checks'].items():
            if not check['ready']:
                reason = check['reason'] or {'code': 'module_not_ready', 'reason': f'{dimension} 尚未就绪'}
                fail(f'$.readiness.{dimension}', reason['code'], reason['reason'])
        return True

    async def start(self):
        async with self._lifecycle:
            if self._closed:
                fail('$.system', 'runtime_closed', 'Agent 已关闭')
            if self.state != 'STOPPED':
                return self.status()
            self.system_run_id = 'system_' + uuid4().hex
            self.state = 'STARTING'
            self.records.set_metadata('runtime_run', json.dumps({'system_run_id': self.system_run_id,
                                      'snapshot_id': self.snapshot_id, 'state': self.state}))
            try:
                for name in self.order:
                    if self.stop_requested:
                        fail('$.system','stop_requested','启动期间已接受停止请求')
                    self._apply_native(name)
                    descriptor = self.modules[name]
                    manager = self.managers[descriptor.manager]
                    module = self.module_status[name]
                    module['state'] = 'STARTING'
                    deadline = asyncio.get_running_loop().time() + descriptor.start_timeout_s
                    await asyncio.wait_for(manager.start(name, descriptor), descriptor.start_timeout_s)
                    while True:
                        if self.stop_requested:
                            fail('$.system','stop_requested','启动期间已接受停止请求')
                        remaining = deadline - asyncio.get_running_loop().time()
                        if remaining <= 0:
                            raise asyncio.TimeoutError()
                        process = await asyncio.wait_for(manager.status(name, descriptor), remaining)
                        module.update(process=process['running'], pid=process.get('pid'))
                        if process['running']:
                            self._enable_adapter(name)
                            module['interface'] = (descriptor.health_check == 'mock_status'
                                                   and self.registry.packages[self.bound.backends[name].package_id].adapter_entrypoint
                                                   == 'agro_mock:create_adapter')
                            interface = self._checks(name)['interface']
                            module['interface'] = bool(interface['ready'])
                            if module['interface']:
                                module['state'] = 'READY'
                                break
                        await asyncio.sleep(min(.02, max(remaining, 0)))
                self.state = 'READY'
                self.accepting = not self.stop_requested
                self._monitor_task = asyncio.create_task(self._monitor())
            except (OSError, ContractValidationError, asyncio.TimeoutError) as exc:
                reason = (exc.issues[0].model_dump() if isinstance(exc, ContractValidationError) else
                          {'code': 'module_start_timeout' if isinstance(exc, asyncio.TimeoutError) else 'module_start_failed',
                           'reason': str(exc) or '模块未在启动期限内就绪'})
                self.module_status[name].update(state='FAILED', reason=reason)
                self.state = 'FAILED'
                self.accepting = False
            return self.status()

    async def _monitor(self):
        while self.state == 'READY':
            for name in self.order:
                descriptor = self.modules[name]
                try:
                    process = await asyncio.wait_for(self.managers[descriptor.manager].status(name, descriptor),
                                                     descriptor.start_timeout_s)
                except (OSError, ContractValidationError, asyncio.TimeoutError):
                    process = {'running': False, 'pid': None}
                if not process['running']:
                    self.module_status[name].update(state='FAILED', process=False, interface=False,
                        reason={'code': 'module_crashed', 'reason': '运行模块退出，操作不会自动重放'})
                    self.accepting = False
                    self.state = 'FAILED'
                    self.engine.control.set_mode(RobotMode.FAULT)
                    return
            await asyncio.sleep(.05)

    def take_control(self, mode, owner, *, lease_s=30.0):
        if not self.accepting:
            fail('$.system', 'system_not_ready', '系统尚未就绪或正在停止')
        try:
            mode = RobotMode(mode)
        except (ValueError, TypeError):
            fail('$.mode', 'invalid_mode', '整机模式未定义')
        if mode == RobotMode.AUTO and self.engine.control.mode == RobotMode.STANDBY:
            return self.engine.control.begin_task(owner, lease_s=lease_s)
        token = self.engine.control.take_control(mode, owner, lease_s=lease_s)
        if self.tasks:
            self.tasks.takeover()
        return token

    async def submit(self, request):
        if not self.accepting:
            fail('$.system', 'system_not_ready', '系统不再接受新操作')
        return await self.engine.submit(request)

    async def stop(self):
        if self.state == 'BLOCKED':
            return self.status()
        if self.tasks:
            await self.tasks.stop_all()
        async with self._lifecycle:
            if self.state == 'STOPPED':
                unresolved = any(item.stop_state == StopState.UNCONFIRMED for item in self.records.list_operations())
                running = False
                for name, descriptor in self.modules.items():
                    current = await asyncio.wait_for(self.managers[descriptor.manager].status(name, descriptor),
                                                     descriptor.start_timeout_s)
                    running = running or current['running']
                if not unresolved and not running:
                    return self.status()
            self.accepting = False
            self.state = 'STOPPING'
            if self._monitor_task:
                self._monitor_task.cancel()
                await asyncio.gather(self._monitor_task, return_exceptions=True)
                self._monitor_task = None
            self.engine.control.set_mode(RobotMode.FAULT)
            for snapshot in self.records.list_operations():
                if snapshot.state not in TERMINAL:
                    try:
                        self.engine.cancel(snapshot.operation_id)
                    except ContractValidationError:
                        pass
            deadline = asyncio.get_running_loop().time() + self.engine.cancel_timeout_s + .1
            while any(item.state not in TERMINAL for item in self.records.list_operations()):
                if asyncio.get_running_loop().time() >= deadline:
                    break
                await asyncio.sleep(.01)
            unresolved = [item for item in self.records.list_operations()
                          if item.state not in TERMINAL or item.stop_state == StopState.UNCONFIRMED]
            if unresolved:
                self.state = 'STOP_UNCONFIRMED'
                return self.status()
            for name in reversed(self.order):
                descriptor = self.modules[name]
                try:
                    await asyncio.wait_for(self.managers[descriptor.manager].stop(name, descriptor),
                                           descriptor.stop_timeout_s)
                except (OSError, ContractValidationError, asyncio.TimeoutError) as exc:
                    reason = (exc.issues[0].model_dump() if isinstance(exc, ContractValidationError) else
                              {'code': 'module_stop_unconfirmed', 'reason': str(exc) or '模块停止超时'})
                    self.module_status[name]['reason'] = reason
                    self.state = 'STOP_UNCONFIRMED'
                    return self.status()
                self.module_status[name].update(state='STOPPED', process=False, interface=False, pid=None, reason=None)
            self.state = 'STOPPED'
            self.records.set_metadata('runtime_run', json.dumps({'system_run_id': self.system_run_id,
                                      'snapshot_id': self.snapshot_id, 'state': self.state}))
            if not self.engine.control.estop:
                self.engine.control.clear_fault()
            return self.status()

    async def aclose(self, *, release_owner=True):
        if self.state == 'BLOCKED':
            if self.tasks:
                self.tasks.store.close()
            self.records.close()
            if release_owner:
                self._owner.close()
            return
        if self._closed:
            return
        result = await self.stop()
        if result['state'] == 'STOP_UNCONFIRMED':
            fail('$.system', 'stop_unconfirmed', '停止未确认，Agent 必须继续保留控制网关和诊断')
        if self.tasks:
            await self.tasks.close()
        await self.engine.aclose()
        self.records.close()
        if release_owner:
            self._owner.close()
        self._closed = True
