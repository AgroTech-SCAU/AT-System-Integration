"""Agent 持有的实际行为树任务会话，不自动恢复执行"""
import asyncio
import hashlib
import json
import math
import xml.etree.ElementTree as ET
import os
import shutil
import signal
from pathlib import Path
from uuid import uuid4

from pydantic import Field, JsonValue, StrictInt, StrictStr

from .control import RobotMode
from .errors import ContractValidationError, fail, parse
from .models import ContractModel, Identifier, ParameterDescriptor, PickResult, QualifiedName
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
    device_id: Identifier
    source_frame: QualifiedName
    target_frame: QualifiedName


class TaskManifest(ContractModel):
    kind: StrictStr = Field(pattern=r'^(general|tomato_picker|simulation_inspection)$')
    assets: dict[Identifier, AssetReference]
    parameters: dict[Identifier, ParameterDescriptor] = Field(default_factory=dict)
    max_targets: StrictInt = Field(ge=1, le=8)
    max_recovery_attempts: StrictInt = Field(ge=0, le=0)
    timeout_ms: StrictInt = Field(ge=1000, le=60000)


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
        self._stage_maps = {}
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
                self._restore_review(status)
                self.store.save(status['task_run_id'], status)
                self.store.event(status['task_run_id'], {'type': 'recovered_without_replay', 'state': 'UNKNOWN'})
                self._signal_saved(status)
        runtime.tasks = self

    def _restore_review(self, status):
        identity=status['task_run_id']
        self._collect(identity, None)
        operations=self._operations(identity)
        candidates=next((o['result']['output']['targets'] for o in operations if o['capability_id']=='perception.detect_targets' and o['state']=='SUCCEEDED'), [])
        existing={t['target_id'] for t in self.store.targets(identity)}
        for pose in candidates:
            if pose['target_id'] in existing:
                continue
            related=[o for o in operations if o['input'].get('target_id')==pose['target_id'] or o['input'].get('target',{}).get('target_id')==pose['target_id']]
            self.store.target(identity, {'target_id':pose['target_id'], 'outcome':'unknown',
                'reason':status['error']['reason'], 'observation':pose,
                'attempts':sum(self._stage(identity,o['node_id'])=='grip' for o in related),
                'operation_ids':[o['operation_id'] for o in related]})
        targets=self.store.targets(identity)
        status['business_result']={'outcome':'unknown','candidate_count':len(candidates),
            'picked_count':sum(t['outcome']=='picked' for t in targets),
            'skipped_count':sum(t['outcome']=='skipped' for t in targets)}

    def _signal_saved(self, status):
        record = status.get('process_identity')
        if record and record.get('identity'):
            current = LocalProcessManager._identity(record['pid'])
            if current and current['boot'] == record['identity']['boot'] and current['start'] == record['identity']['start'] and current['group'] == record['pid']:
                try:
                    os.killpg(record['pid'], signal.SIGTERM)
                except ProcessLookupError:
                    pass

    def _stage(self,identity,node_id):
        if identity not in self._stage_maps:
            definition=self.store.snapshot(identity).get('definition')
            self._stage_maps[identity]={n.get('operation_node_id'):n.get('stage') for n in definition['node_mapping']} if definition else self.store.snapshot(identity).get('stage_mapping',{})
        return self._stage_maps[identity].get(node_id,node_id)

    def _operations(self, identity):
        return self.runtime.records.task_operations(identity)

    def status(self, identity):
        status = self.store.status(identity)
        status['operations'] = self._operations(identity)
        status['targets'] = self.store.targets(identity)
        status['events'] = self.store.events(identity)
        status['snapshot'] = self.store.snapshot(identity)
        if status['snapshot'].get('definition'):
            for target in status['targets']:
                related=[o for o in status['operations'] if o['input'].get('target_id')==target['target_id'] or o['input'].get('target',{}).get('target_id')==target['target_id']]
                target['attempts']=sum(self._stage(identity,o['node_id'])=='grip' for o in related)
        return status

    def list(self):
        return self.store.list()

    def completed_targets(self, backend):
        completed=set()
        for status in self.store.list():
            snapshot=self.store.snapshot(status['task_run_id'])
            if snapshot.get('assets',{}).get('camera_to_arm',{}).get('content',{}).get('device_id')==backend:
                completed.update(t['target_id'] for t in self.store.targets(status['task_run_id']) if t['outcome']=='picked')
        return completed

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
        if request.capability_id == 'job.record_pick':
            self._check_result(request.task_run_id, request.input['result'])

    def _check_result(self, identity, result):
        result = parse(PickResult, result)
        matching = []
        for op in self._operations(identity):
            target = op['input'].get('target_id') or op['input'].get('target', {}).get('target_id')
            if target == result.target_id and op['state'] == 'SUCCEEDED':
                matching.append(op)
        definition=self.store.snapshot(identity).get('definition')
        stage_map={n.get('operation_node_id'):n.get('stage') for n in definition['node_mapping']} if definition else self.store.snapshot(identity).get('stage_mapping',{})
        by_node = {stage_map.get(op['node_id'],op['node_id']): op for op in matching}
        expected={'transform':'geometry.transform_pose','reachable':'manipulation.check_reachability','approach':'manipulation.move_to_pose','contact':'manipulation.move_to_pose','grip':'end_effector.grip','retract':'manipulation.move_to_pose','verify_pick':'perception.verify_pick','collection_pose':'manipulation.collection_pose','place':'manipulation.move_to_pose','release':'end_effector.grip','verify_place':'perception.verify_place'}
        if any(stage in by_node and by_node[stage]['capability_id']!=capability for stage,capability in expected.items()):
            fail('$.result','stage_capability_mismatch','阶段证据必须来自实际对应能力')
        if result.outcome == 'picked':
            stages = ('transform', 'reachable', 'approach', 'contact', 'grip', 'retract',
                      'verify_pick', 'collection_pose', 'place', 'release', 'verify_place')
            if any(node not in by_node for node in stages):
                fail('$.result', 'placement_not_verified', '采摘与放置步骤尚未全部成功')
            indexes = [matching.index(by_node[node]) for node in stages]
            if indexes != sorted(indexes) or not by_node['verify_pick']['result']['output']['picked'] or not by_node['verify_place']['result']['output']['placed'] or by_node['release']['parameters'].get('close', True):
                fail('$.result', 'placement_not_verified', '采摘验证、释放或正常放置尚未确认')
        elif result.outcome == 'skipped':
            if 'reachable' not in by_node or by_node['reachable']['result']['output']['reachable']:
                fail('$.result', 'skip_not_verified', '仅可达性检查确认不可达时允许跳过')
        else:
            fail('$.result', 'invalid_target_commit', '完成记账只接收已确认的成功或跳过结果')

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
                fail('$.roles.'+role,'missing_template_role','任务模板所需角色未绑定')
        definition=self.documents.frozen_definition(path) if self.documents else None
        inspection=manifest.kind=='simulation_inspection'
        stage_mapping={}
        if self.documents and not definition and not inspection:
            document=self.documents.parse_xml(xml)
            checked=self.documents.validate_tree(document,'tomato_picker',request.parameters,engine=False)
            if not checked['valid']:
                fail('$.task_ref','tree_policy_invalid',json.dumps(checked['diagnostics'],ensure_ascii=False))
            for tree_document in document['trees'].values():
                for node in tree_document['nodes'].values():
                    stage=checked['stage_by_editor'].get(node['editor_id'])
                    if stage and node['attributes'].get('node_id'):stage_mapping[node['attributes']['node_id']]=stage
        if manifest.kind in {'simulation_inspection','general'} and not definition:
            fail('$.task_ref','published_definition_required','自定义任务必须通过统一服务校验并发布')
        loops = list(tree.iter('ForEachTarget'))
        if manifest.kind=='tomato_picker' and (len(loops)!=1 or loops[0].get('max_targets')!=str(manifest.max_targets)):
            fail('$.max_targets', 'policy_tree_mismatch', 'XML 候选界限必须与冻结策略一致')
        if manifest.kind=='general':
            for loop in loops:
                try: limit=int(loop.get('max_targets', '0'))
                except (TypeError, ValueError): limit=0
                if not 1<=limit<=manifest.max_targets:
                    fail('$.max_targets', 'unsafe_target_limit', '自定义任务候选上限不符合已发布的安全约束')
        if manifest.kind=='tomato_picker' and any(node.tag in ('RetryUntilSuccessful', 'Repeat', 'KeepRunningUntilFailure') for node in tree.iter()):
            fail('$.task_ref', 'unsafe_retry_policy', '当前模板不允许自动恢复或重复执行物理动作')
        if request.config_ref:
            bound, registry = load_system(request.config_ref)
            candidate = {'system': bound.config.model_dump(mode='json'),
                         'packages': {k: v.model_dump(mode='json') for k, v in registry.packages.items()}}
            current = self.runtime.snapshot()
            if candidate['system'] != current['system'] or candidate['packages'] != current['packages']:
                fail('$.config_ref', 'snapshot_mismatch', '配置草稿与 Agent 当前冻结系统不一致')
        parameters = _values(request.parameters, manifest.parameters, '$.parameters', parameters=True)
        if definition and parameters!=_values(definition['parameters'], manifest.parameters, '$.definition.parameters', parameters=True):
            fail('$.parameters','published_parameters_mismatch','启动参数必须与不可变发布定义一致')
        assets = {}
        for name, reference in manifest.assets.items():
            asset_path = (path.parent / reference.path).resolve()
            try:
                raw = asset_path.read_bytes()
                value = json.loads(raw)
            except (OSError, ValueError) as exc:
                fail(f'$.assets.{name}', 'asset_unreadable', str(exc))
            if hashlib.sha256(raw).hexdigest() != reference.sha256:
                fail(f'$.assets.{name}', 'asset_checksum_mismatch', '标定资产内容摘要不匹配')
            if any(value.get(key) != getattr(reference, key) for key in ('device_id', 'source_frame', 'target_frame')) or reference.device_id not in self.runtime.bound.backends:
                fail(f'$.assets.{name}', 'asset_identity_mismatch', '标定设备或坐标系不匹配')
            for node in tree.iter():
                if node.tag not in ('Capability_geometry_transform_pose','Capability_manipulation_move_to_pose','Capability_perception_detect_targets'):
                    continue
                role=self.runtime.bound.roles.get(node.get('role'))
                backend=node.get('backend_instance') or (role.backend_instance if role else None)
                if backend!=reference.device_id:
                    fail(f'$.assets.{name}', 'asset_device_mismatch', '标定设备与实际观测、变换或机械臂角色绑定不匹配')
            if self.documents and value!=self.documents.assets.builtin['metadata']:
                fail(f'$.assets.{name}','asset_verification_unsupported','仅接受内置模拟标定的已知验证证据')
            if value.get('verified') is not True or not value.get('source') or not value.get('verification'):
                fail(f'$.assets.{name}', 'asset_unverified', '资产缺少来源与验证记录')
            translation = value.get('translation_m')
            if not isinstance(translation, list) or len(translation) != 3 or any(type(v) not in (int, float) or not math.isfinite(v) for v in translation) or translation[1:] != [0, 0] or value.get('orientation_xyzw') != [0, 0, 0, 1]:
                fail(f'$.assets.{name}', 'unsupported_mock_calibration', '模拟标定仅支持已验证的相机至基座 X 平移')
            if reference.source_frame != 'camera' or reference.target_frame != 'arm_base':
                fail(f'$.assets.{name}', 'asset_frame_mismatch', '当前模板需要 camera 至 arm_base 的标定')
            assets[name] = {'sha256': reference.sha256, 'content': value}
        if manifest.kind=='tomato_picker' and set(assets) != {'camera_to_arm'}:
            fail('$.assets', 'calibration_required', '模板必须提供相机至机械臂标定')
        blackboard = {k: {'type': manifest.parameters[k].type, 'unit': manifest.parameters[k].unit, 'value': v}
                      for k, v in parameters.items()}
        if manifest.kind=='tomato_picker':
            blackboard['calibration_offset_x'] = {'type': 'number', 'unit': 'm',
                'value': assets['camera_to_arm']['content']['translation_m'][0]}
        return {'task_ref': str(path), 'xml': xml, 'manifest': manifest.model_dump(mode='json'),
                'assets': assets, 'parameters': parameters, 'blackboard': blackboard,
                'system': self.runtime.snapshot(), 'software': _source_identity(self.executable),
                **({'definition':definition} if definition else {'stage_mapping':stage_mapping})}

    def preflight(self, request):
        return self._freeze(parse(TaskStart, request))

    async def start_task(self, request, owner):
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
            if not self.runtime.accepting or self.runtime.engine.control.mode != RobotMode.STANDBY:
                fail('$.system', 'task_not_ready', '任务启动需要系统就绪且处于待命模式')
            if any(s['state'] in ACTIVE or s['state']=='UNKNOWN' or not s['stop_confirmed'] for s in self.store.list()):
                fail('$.task', 'task_busy', '已有任务执行中、停止未确认或未知结果待核对')
            snapshot = self.preflight(request)
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
            if not self.runtime.accepting or self.runtime.engine.control.mode != RobotMode.STANDBY:
                fail('$.system', 'task_not_ready', '校验期间系统或控制状态已改变')
            snapshot_id, _ = SnapshotStore(self.directory / 'snapshots').save(snapshot)
            status = {'task_run_id': identity, 'request_id': request.request_id, 'snapshot_id': snapshot_id,
                      'system_snapshot_id': self.runtime.snapshot_id, 'state': 'ACCEPTED', 'tree_state': 'IDLE',
                      'stop_confirmed': True, 'cancel_requested': False, 'error': None, 'business_result': None,
                      'nodes': [], 'process_identity': None}
            self.store.reserve(request.request_id, identity, fingerprint, snapshot, status)
            token = None
            process = None
            try:
                token = self.runtime.take_control('AUTO', owner, lease_s=65.0)
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
                if stopped and token and self.runtime.engine.control._epoch == token.control_epoch:
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
                self.runtime.engine.cancel(operation['operation_id'])
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
        for op in operations:
            if op['capability_id'] == 'job.record_pick' and op['state'] == 'SUCCEEDED':
                result = op['result']['output']['result']
                target_id = result['target_id']
                related = [o for o in operations if o['input'].get('target_id') == target_id or o['input'].get('target', {}).get('target_id') == target_id]
                observation = next((p for o in operations if o['capability_id']=='perception.detect_targets' and o['result']
                                    for p in o['result']['output'].get('targets', []) if p['target_id']==target_id), None)
                self.store.target(identity, {**result, 'observation': observation,
                    'attempts': sum(self._stage(identity,o['node_id'])=='grip' for o in related),
                    'operation_ids': [o['operation_id'] for o in related] + [op['operation_id']]})
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
                        self.runtime.engine.cancel(op['operation_id'])
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
            else:
                status['state'] = 'FAILED'
                status['error'] = report.get('error') or next((o['error'] for o in reversed(operations) if o['error']), None) or {'code':'tree_failed','reason':'行为树业务条件未满足'}
            targets = self.store.targets(identity)
            candidates = next((o['result']['output']['targets'] for o in operations if o['capability_id']=='perception.detect_targets' and o['state']=='SUCCEEDED'), [])
            kind=self.store.snapshot(identity)['manifest']['kind']
            inspection=kind in {'simulation_inspection','general'}
            if status['state']=='SUCCEEDED' and not inspection and len(targets)!=len(candidates):
                status.update(state='FAILED', error={'code':'target_results_incomplete','reason':'任务缺少候选目标的确认结果'})
            status['business_result'] = {'outcome': ('completed' if kind=='general' else 'inspected' if inspection else 'empty_candidates' if not candidates else 'area_completed') if status['state']=='SUCCEEDED' else status['state'].lower(),
                'candidate_count':len(candidates), 'picked_count':sum(t['outcome']=='picked' for t in targets),
                'skipped_count':sum(t['outcome']=='skipped' for t in targets)}
            if status['state']!='SUCCEEDED':
                existing={t['target_id'] for t in targets}
                for pose in candidates:
                    if pose['target_id'] in existing:
                        continue
                    related=[o for o in operations if o['input'].get('target_id')==pose['target_id'] or o['input'].get('target',{}).get('target_id')==pose['target_id']]
                    self.store.target(identity, {'target_id':pose['target_id'], 'outcome':'unknown' if unknown else 'failed',
                        'reason':status['error']['reason'] if status['error'] else '任务中止', 'observation':pose,
                        'attempts':sum(self._stage(identity,o['node_id'])=='grip' for o in related), 'operation_ids':[o['operation_id'] for o in related]})
            self.store.save(identity, status)
            self.store.event(identity, {'type':'task_finished','state':status['state'],'business_result':status['business_result']})
            if stopped and self.runtime.engine.control.mode == RobotMode.AUTO and self.runtime.engine.control._epoch == epoch:
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
                    self.runtime.engine.cancel(op['operation_id'])

    async def close(self):
        if not self._closed:
            await self.stop_all()
            self.store.close()
            self._closed = True
