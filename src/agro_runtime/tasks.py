"""Agent 持有的实际行为树任务会话，不自动恢复执行"""
import asyncio
import hashlib
import json
import xml.etree.ElementTree as ET
import os
import shutil
import signal
from pathlib import Path
from uuid import uuid4

from pydantic import Field, JsonValue, StrictInt, StrictStr

from .control import RobotMode
from .errors import ContractValidationError, fail, parse
from .models import ContractModel, Identifier, ParameterDescriptor
from .registry import _values, read_document
from .runtime import LocalProcessManager, SnapshotStore, load_system
from .task_records import TaskStore

ACTIVE = {'ACCEPTED', 'RUNNING', 'CANCELING'}


class TaskStart(ContractModel):
    task_ref: StrictStr = Field(min_length=1)
    config_ref: StrictStr | None = None
    request_id: Identifier
    parameters: dict[Identifier, JsonValue] = Field(default_factory=dict)


class AssetReference(ContractModel):
    path: StrictStr
    sha256: StrictStr = Field(pattern=r'^[0-9a-f]{64}$')


class TaskManifest(ContractModel):
    kind: StrictStr = Field(pattern=r'^general$', default='general')
    assets: dict[Identifier, AssetReference] = Field(default_factory=dict)
    parameters: dict[Identifier, ParameterDescriptor] = Field(default_factory=dict)
    timeout_ms: StrictInt = Field(ge=1000, le=3660000)


def _digest(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False,
                                     allow_nan=False, separators=(',', ':')).encode()).hexdigest()


def _source_identity(executable):
    root = Path(__file__).resolve().parents[2]
    digest = hashlib.sha256()
    for directory in ('src', 'adapters', 'task_engine'):
        for path in sorted((root / directory).rglob('*')):
            if path.is_file() and path.suffix in ('.py', '.cpp', '.hpp', '.yaml', '.txt'):
                digest.update(str(path.relative_to(root)).encode())
                digest.update(path.read_bytes())
    return {'source_sha256': digest.hexdigest(),
            'executor_sha256': hashlib.sha256(Path(executable).read_bytes()).hexdigest()}


class TaskManager:
    def __init__(self, runtime, *, executable=None, endpoint=None, session_secret=None, documents=None):
        self.runtime = runtime
        self.documents = documents
        self.executable = str(executable or shutil.which('agro-bt') or '')
        self.endpoint = endpoint
        self.session_secret = session_secret
        self.store = TaskStore(runtime.state_directory / 'tasks.db')
        self.directory = runtime.state_directory / 'tasks'
        self.directory.mkdir(exist_ok=True)
        self.processes = {}
        self.jobs = {}
        self._lock = asyncio.Lock()
        self._closed = False
        for status in self.store.list():
            if status['state'] in ACTIVE:
                status.update(state='UNKNOWN', error={'code': 'restart_requires_review',
                    'reason': 'Agent 重启，任务不会重放，需要核对操作与设备'}, stop_confirmed=False)
                self.store.save(status['task_run_id'], status)
                self.store.event(status['task_run_id'], {'type': 'recovered_without_replay', 'state': 'UNKNOWN'})
                self._signal_saved(status)
        runtime.tasks = self

    def _signal_saved(self, status):
        record = status.get('process_identity')
        if record and record.get('identity'):
            current = LocalProcessManager._identity(record['pid'])
            if current and current['boot'] == record['identity']['boot'] and current['start'] == record['identity']['start'] and current['group'] == record['pid']:
                try:
                    os.killpg(record['pid'], signal.SIGTERM)
                except ProcessLookupError:
                    pass

    @property
    def ros_operations(self):
        return getattr(self.documents, 'ros_operations', None) if self.documents else None

    def _operations(self, identity):
        operations = self.runtime.records.task_operations(identity)
        return operations + (self.ros_operations.operations(identity) if self.ros_operations else [])

    def _cancel_operation(self, identity):
        if identity.startswith('rosop_') and self.ros_operations:
            return self.ros_operations.cancel(identity)
        return self.runtime.engine.cancel(identity)

    def status(self, identity):
        status = self.store.status(identity)
        status['operations'] = self._operations(identity)
        status['events'] = self.store.events(identity)
        status['snapshot'] = self.store.snapshot(identity)
        return status

    def list(self):
        return self.store.list()

    def guard(self, request):
        try:
            status = self.store.status(request.task_run_id)
        except ContractValidationError as exc:
            if exc.issues[0].code == 'unknown_task':
                return
            raise
        if status['state'] != 'RUNNING':
            fail('$.task_run_id', 'task_dispatch_stopped', '任务不再接受新操作')
        definition=self.store.snapshot(request.task_run_id).get('definition')
        if definition:
            mapping=next((n for n in definition['node_mapping'] if n.get('operation_node_id')==request.node_id),None)
            if not mapping:
                fail('$.node_id','unpublished_node','操作节点不属于冻结发布定义')
            node=next((t['nodes'][mapping['editor_id']] for t in definition['document']['trees'].values() if mapping['editor_id'] in t['nodes']),None)
            registration='Capability_'+request.capability_id.replace('.','_')
            role=self.runtime.bound.roles.get(node['attributes'].get('role')) if node else None
            expected_backend=node['attributes'].get('backend_instance') or (role.backend_instance if role else None) if node else None
            if not node or node['registration_id']!=registration or request.backend_instance!=expected_backend:
                fail('$.node_id','published_node_mismatch','操作能力与冻结节点绑定不符')
    def _freeze(self, request):
        path = Path(request.task_ref).resolve()
        try:
            xml = path.read_text(encoding='utf-8')
            manifest = parse(TaskManifest, read_document(path.with_suffix('.task.json')))
        except OSError as exc:
            fail('$.task_ref', 'task_unreadable', str(exc))
        try:
            tree = ET.fromstring(xml)
        except ET.ParseError as exc:
            fail('$.task_ref', 'invalid_xml', str(exc))
        for node in tree.iter():
            role=node.get('role')
            if role and role not in self.runtime.bound.roles:
                fail('$.roles.'+role,'missing_task_role','任务所需角色未绑定')
        definition=self.documents.frozen_definition(path) if self.documents else None
        if not definition:
            fail('$.task_ref','published_definition_required','任务必须通过统一服务校验并发布')
        if request.config_ref:
            bound, registry = load_system(request.config_ref)
            candidate = {'system': bound.config.model_dump(mode='json'),
                         'packages': {k: v.model_dump(mode='json') for k, v in registry.packages.items()}}
            current = self.runtime.snapshot()
            if candidate['system'] != current['system'] or candidate['packages'] != current['packages']:
                fail('$.config_ref', 'snapshot_mismatch', '配置草稿与 Agent 当前冻结系统不一致')
        parameters = _values(request.parameters, manifest.parameters, '$.parameters', parameters=True)
        assets = {}
        for name, reference in manifest.assets.items():
            asset_path = (path.parent / reference.path).resolve()
            try:
                raw = asset_path.read_bytes()
                value = json.loads(raw)
            except (OSError, ValueError) as exc:
                fail(f'$.assets.{name}', 'asset_unreadable', str(exc))
            if hashlib.sha256(raw).hexdigest() != reference.sha256:
                fail(f'$.assets.{name}', 'asset_checksum_mismatch', '资产内容摘要不匹配')
            assets[name] = {'sha256': reference.sha256, 'content': value}
        blackboard = {k: {**manifest.parameters[k].model_dump(mode='json',exclude_none=True), 'value': v}
                      for k, v in parameters.items()}
        return {'task_ref': str(path), 'xml': xml, 'manifest': manifest.model_dump(mode='json'),
                'assets': assets, 'parameters': parameters, 'blackboard': blackboard,
                'system': {**self.runtime.snapshot(), **({'ros_tasks':definition.get('ros_tasks', [])} if definition else {})}, 'software': _source_identity(self.executable),
                'definition':definition}

    def preflight(self, request):
        return self._freeze(parse(TaskStart, request))

    async def start_task(self, request, owner, *, standalone=False, control_token=None):
        request = parse(TaskStart, request)
        fingerprint = _digest(request.model_dump(mode='json'))
        async with self._lock:
            previous = self.store.by_request(request.request_id)
            if previous:
                if previous['fingerprint'] != fingerprint:
                    fail('$.request_id', 'request_id_conflict', '同一任务请求标识不能对应不同载荷')
                return self.status(previous['task_run_id'])
            if not self.executable or not Path(self.executable).is_file() or not os.access(self.executable, os.X_OK) or not self.endpoint or not self.session_secret:
                fail('$.task_engine', 'task_engine_unavailable', 'Agent 未配置可用的 C++ 执行器与本机会话入口')
            ready=self.runtime.state=='STOPPED' if standalone else self.runtime.accepting
            expected_mode = RobotMode.AUTO if control_token else RobotMode.STANDBY
            if control_token:
                self.runtime.engine.control.validate_control(control_token, [])
            if not ready or self.runtime.engine.control.mode != expected_mode:
                fail('$.system', 'task_not_ready', '任务启动需要可用的执行环境且处于待命模式')
            if any(status['state']=='UNKNOWN' or not status['stop_confirmed'] and status['state'] not in ACTIVE or
                   status['state'] in ACTIVE and (not control_token or status.get('control_group') != control_token.owner)
                   for status in self.store.list()):
                fail('$.task', 'task_busy', '已有任务执行中、停止未确认或未知结果待核对')
            snapshot = self.preflight(request)
            if standalone and any(node.tag.startswith('Capability_') for node in ET.fromstring(snapshot['xml']).iter()):
                fail('$.tree','system_required','此行为树包含需要已就绪系统的能力')
            snapshot['standalone_ros']=standalone
            snapshot['shared_control'] = control_token is not None
            identity = 'task_' + uuid4().hex
            directory = self.directory / identity
            directory.mkdir()
            xml_path = directory / 'tree.xml'
            xml_path.write_text(snapshot['xml'], encoding='utf-8')
            xml_path.chmod(0o400)
            registry_path = directory / 'registry.json'
            registry_path.write_text(json.dumps(snapshot['system']))
            blackboard_path = directory / 'blackboard.json'
            blackboard_path.write_text(json.dumps(snapshot['blackboard']))
            for path in (registry_path, blackboard_path):
                path.chmod(0o400)
            validation = await asyncio.create_subprocess_exec(self.executable, '--validate-only',
                *(['--instance-ids'] if snapshot.get('definition') else []), '--xml', str(xml_path), '--registry', str(registry_path), '--blackboard', str(blackboard_path),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                stdout, stderr = await asyncio.wait_for(validation.communicate(), 5)
            except asyncio.TimeoutError:
                validation.kill()
                await validation.wait()
                fail('$.task_ref', 'tree_validation_timeout', '行为树静态校验超时')
            if validation.returncode:
                fail('$.task_ref', 'tree_validation_failed', stdout.decode(errors='replace')[:4000])
            ready=self.runtime.state=='STOPPED' if standalone else self.runtime.accepting
            if control_token:
                self.runtime.engine.control.validate_control(control_token, [])
            if not ready or self.runtime.engine.control.mode != expected_mode:
                fail('$.system', 'task_not_ready', '校验期间系统或控制状态已改变')
            snapshot_id, _ = SnapshotStore(self.directory / 'snapshots').save(snapshot)
            status = {'task_run_id': identity, 'request_id': request.request_id, 'snapshot_id': snapshot_id,
                      'system_snapshot_id': self.runtime.snapshot_id, 'state': 'ACCEPTED', 'tree_state': 'IDLE',
                      'stop_confirmed': True, 'cancel_requested': False, 'error': None,
                      'nodes': [], 'process_identity': None}
            if control_token:
                status['control_group'] = control_token.owner
            self.store.reserve(request.request_id, identity, fingerprint, snapshot, status)
            token = None
            process = None
            try:
                token = control_token or (self.runtime.engine.control.begin_task(owner,lease_s=max(65.0,snapshot['manifest']['timeout_ms']/1000+15)) if standalone else self.runtime.take_control('AUTO', owner, lease_s=max(65.0,snapshot['manifest']['timeout_ms']/1000+15)))
                token_path = directory / 'control.json'
                token_path.write_text(token.model_dump_json())
                token_path.chmod(0o600)
                session_path = directory / 'session.token'
                session_path.write_text(self.session_secret)
                session_path.chmod(0o600)
                log = (directory / 'executor.log').open('wb')
                try:
                    process = await asyncio.create_subprocess_exec(self.executable,
                        *(['--instance-ids'] if snapshot.get('definition') else []), '--xml', str(xml_path), '--blackboard', str(blackboard_path), '--registry', str(registry_path),
                        '--endpoint', self.endpoint, '--session-file', str(session_path), '--control-file', str(token_path),
                        '--task-run-id', identity, '--state-file', str(directory / 'state.json'),
                        '--timeout-ms', str(snapshot['manifest']['timeout_ms']),
                        stdout=log, stderr=log, start_new_session=True)
                finally:
                    log.close()
                self.processes[identity] = process
                status = self.store.status(identity)
                status.update(state='CANCELING' if status['cancel_requested'] else 'RUNNING', stop_confirmed=False,
                              process_identity={'pid': process.pid, 'identity': LocalProcessManager._identity(process.pid)})
                self.store.save(identity, status)
                self.store.event(identity, {'type': 'task_started', 'state': status['state']})
                if status['cancel_requested'] and process.returncode is None:
                    process.send_signal(signal.SIGTERM)
                self.jobs[identity] = asyncio.create_task(self._watch(identity, token.control_epoch))
                return self.status(identity)
            except (OSError, ContractValidationError) as exc:
                if process is not None:
                    process.send_signal(signal.SIGTERM)
                    state, stopped = 'UNKNOWN', False
                else:
                    state, stopped = 'FAILED', True
                error = exc.issues[0].model_dump() if isinstance(exc, ContractValidationError) else {'code':'executor_start_failed','reason':str(exc)}
                status.update(state=state, stop_confirmed=stopped, error=error)
                self.store.save(identity, status)
                self.store.event(identity, {'type':'task_start_failed','state':state,'error':error})
                if stopped and token and not control_token and self.runtime.engine.control._epoch == token.control_epoch:
                    self.runtime.engine.control.set_mode(RobotMode.STANDBY)
                for name in ('control.json','session.token'):
                    (directory/name).unlink(missing_ok=True)
                raise

    def cancel_task(self, identity, *, reason='user_cancel'):
        status = self.store.status(identity)
        if status['state'] not in ACTIVE:
            return self.status(identity)
        status.update(state='CANCELING', cancel_requested=True,
                      error={'code': reason, 'reason': '任务已停止派发并追踪在途动作停止'})
        self.store.save(identity, status)
        self.store.event(identity, {'type': 'cancel_requested', 'code': reason})
        process = self.processes.get(identity)
        if process and process.returncode is None:
            try:
                process.send_signal(signal.SIGTERM)
            except ProcessLookupError:
                pass
        for operation in self._operations(identity):
            if operation['state'] not in ('SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN'):
                self._cancel_operation(operation['operation_id'])
        return self.status(identity)

    def takeover(self):
        for status in self.store.list():
            if status['state'] in ACTIVE:
                self.cancel_task(status['task_run_id'], reason='control_taken_over')

    async def stop_all(self):
        async with self._lock:
            for status in self.store.list():
                if status['state'] in ACTIVE:
                    self.cancel_task(status['task_run_id'], reason='system_stop')
        if self.jobs:
            await asyncio.gather(*self.jobs.values())

    def _collect(self, identity, previous):
        operations = self._operations(identity)
        signature = [(op['operation_id'], op['state'], op['stop_state'], op['feedback']) for op in operations]
        if signature != previous:
            self.store.event(identity, {'type': 'operations_changed', 'operations': operations})
        return signature

    async def _watch(self, identity, epoch):
        process = self.processes[identity]
        previous = None
        last_report = None
        try:
            while process.returncode is None:
                if self.runtime.engine.control._epoch != epoch and self.store.status(identity)['state'] == 'RUNNING':
                    self.cancel_task(identity, reason='control_taken_over')
                previous = self._collect(identity, previous)
                path = self.directory / identity / 'state.json'
                if path.exists():
                    try:
                        report = json.loads(path.read_text())
                    except (OSError, ValueError):
                        report = None
                    if report and report != last_report:
                        last_report = report
                        status = self.store.status(identity)
                        status.update(tree_state=report.get('tree_state', 'IDLE'), nodes=report.get('nodes', []), node_events=report.get('node_events',[]),event_sequence=report.get('event_sequence',0))
                        self.store.save(identity, status)
                        self.store.event(identity, {'type': 'tree_changed', 'report': report})
                await asyncio.sleep(.02)
            await process.wait()
            self._collect(identity, previous)
            report_path = self.directory / identity / 'state.json'
            report = json.loads(report_path.read_text()) if report_path.exists() else {}
            status = self.store.status(identity)
            abnormal = process.returncode < 0 or ('max_tick_ms' not in report and 'error' not in report)
            if abnormal:
                status.update(state='CANCELING', error={'code':'executor_lost','reason':'行为树执行器异常退出，任务结果需要核对'})
                self.store.save(identity, status)
                self.store.event(identity, {'type':'executor_lost','returncode':process.returncode})
                for op in self._operations(identity):
                    if op['state'] in ('ACCEPTED','RUNNING','CANCELING'):
                        self._cancel_operation(op['operation_id'])
                deadline=asyncio.get_running_loop().time()+self.runtime.engine.cancel_timeout_s+.1
                while any(op['state'] in ('ACCEPTED','RUNNING','CANCELING') for op in self._operations(identity)) and asyncio.get_running_loop().time()<deadline:
                    await asyncio.sleep(.01)
            operations = self._operations(identity)
            unknown = abnormal or any(o['state']=='UNKNOWN' for o in operations) or any(o['snapshot']['state']=='UNKNOWN' for o in report.get('operations', []))
            stopped = all(o['stop_state']!='UNCONFIRMED' and o['state'] not in ('ACCEPTED','RUNNING','CANCELING') for o in operations)
            stopped = stopped and (abnormal or report.get('stop_confirmed', False))
            status.update(tree_state=report.get('tree_state', 'IDLE'), nodes=report.get('nodes', []), node_events=report.get('node_events',[]),event_sequence=report.get('event_sequence',0),stop_confirmed=stopped)
            if unknown or not stopped:
                status['state'] = 'UNKNOWN'
                status['error'] = next((o['error'] for o in operations if o['state']=='UNKNOWN'), None) or report.get('error') or status['error'] or {'code':'task_outcome_unknown','reason':'任务或设备结果需要核对'}
            elif status['cancel_requested']:
                status['state'] = 'CANCELED'
            elif process.returncode == 0 and report.get('tree_state') == 'SUCCESS':
                status['state'] = 'SUCCEEDED'
                status['output'] = report.get('output', {})
            else:
                status['state'] = 'FAILED'
                status['error'] = report.get('error') or next((o['error'] for o in reversed(operations) if o['error']), None) or {'code':'tree_failed','reason':'行为树条件未满足'}
            self.store.save(identity, status)
            self.store.event(identity, {'type':'task_finished','state':status['state'],'output':status.get('output',{})})
            if stopped and not self.store.snapshot(identity).get('shared_control') and self.runtime.engine.control.mode == RobotMode.AUTO and self.runtime.engine.control._epoch == epoch:
                self.runtime.engine.control.set_mode(RobotMode.STANDBY)
            for name in ('control.json', 'session.token'):
                (self.directory / identity / name).unlink(missing_ok=True)
        except Exception as exc:
            status = self.store.status(identity)
            status.update(state='UNKNOWN', stop_confirmed=False, error={'code':'task_monitor_failed','reason':str(exc)})
            self.store.save(identity, status)
            self.store.event(identity, {'type':'monitor_failed','reason':str(exc)})
            if process.returncode is None:
                process.send_signal(signal.SIGTERM)
            for op in self._operations(identity):
                if op['state'] in ('ACCEPTED','RUNNING','CANCELING'):
                    self._cancel_operation(op['operation_id'])

    async def close(self):
        if not self._closed:
            await self.stop_all()
            self.store.close()
            self._closed = True
