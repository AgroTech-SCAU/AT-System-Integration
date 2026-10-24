"""机器人业务层级状态机

与整机安全模式独立 事件在串行锁下转换 状态行为使用冻结的任务与行为树执行
"""
import asyncio
import copy
import json
from collections import deque
import re
import threading
import time
from uuid import uuid4

from .errors import fail

IDENT = re.compile(r'^[a-z][a-z0-9_]{0,63}$')
ACTIVE = {'ACCEPTED', 'RUNNING', 'CANCELING'}


def validate(spec, definitions=(), ros_tasks=(), *, ready=True):
    if not isinstance(spec, dict):
        fail('$.machine', 'invalid_machine', '状态机必须是对象')
    states = spec.get('states')
    edges = spec.get('transitions')
    if not isinstance(states, list) or not 1 <= len(states) <= 48 or not isinstance(edges, list) or len(edges) > 160:
        fail('$.states', 'invalid_structure', '需要 1 到 48 个状态和不超过 160 条转换')
    ids = set()
    refs = {d['id'] for d in definitions}
    ros_refs = {'ros:' + item['id'] for item in ros_tasks}
    for s in states:
        key = s.get('id') if isinstance(s, dict) else None
        if not isinstance(key, str) or not IDENT.fullmatch(key) or key in ids:
            fail('$.states', 'invalid_state', '状态标识应唯一并使用小写字母数字下划线')
        ids.add(key)
        for field in ('entry', 'do', 'exit'):
            reference = s.get(field)
            if reference and (not isinstance(reference, str) or ready and reference not in refs | ros_refs):
                fail('$.states.'+key+'.'+field, 'unknown_task', '请选择工程内已保存的任务或行为树')
    by_id = {s['id']: s for s in states}
    roots = [s for s in states if not s.get('parent')]
    if len(roots) != 1:
        fail('$.states', 'root_count', '只能有一个根状态')
    for s in states:
        visited = {s['id']}
        p = s.get('parent')
        while p:
            if p not in by_id or p in visited:
                fail('$.states.'+s['id']+'.parent', 'hierarchy_invalid', '父状态不存在或存在循环引用')
            visited.add(p)
            p = by_id[p].get('parent')
        children = [n['id'] for n in states if n.get('parent') == s['id']]
        if ready and children and s.get('initial') not in children:
            fail('$.states.'+s['id']+'.initial', 'initial_required', '包含子状态时需要指定初始子状态')
        if not children and s.get('initial'):
            fail('$.states.'+s['id']+'.initial', 'invalid_initial', '叶状态不能指定初始子状态')
    if spec.get('initial') != roots[0]['id']:
        fail('$.initial', 'invalid_initial', '初始状态必须指向根状态')
    fallbacks = set()
    for edge in edges:
        if not isinstance(edge, dict) or edge.get('source') not in ids or edge.get('target') not in ids:
            fail('$.transitions', 'unknown_state', '转换源状态或目标状态不存在')
        event = edge.get('event')
        if not isinstance(event, str) or ready and not IDENT.fullmatch(event):
            fail('$.transitions', 'invalid_event', '事件标识应使用小写字母数字下划线')
        key = edge['source'], event
        guard = edge.get('guard') or {}
        if not isinstance(guard, dict) or guard.get('operator', 'always') not in ('always','otherwise','equals','not_equals','greater','less'):
            fail('$.transitions.guard', 'invalid_guard', 'Guard 操作不支持')
        fallback = guard.get('operator', 'always') in ('always', 'otherwise')
        if fallback:
            if ready and key in fallbacks:
                fail('$.transitions', 'ambiguous_fallback', '同一状态同一事件只能设置一个其他情况分支')
            fallbacks.add(key)
        if ready and not fallback and (not isinstance(guard.get('key'), str) or not IDENT.fullmatch(guard['key'])):
            fail('$.transitions.guard', 'invalid_guard', 'Guard 变量名称无效')
    variables = spec.get('variables', {})
    if not isinstance(variables, dict) or len(variables) > 64 or any(not IDENT.fullmatch(k) for k in variables):
        fail('$.variables', 'invalid_variables', '变量名应使用小写标识，最多声明 64 个变量')
    try:
        if len(json.dumps(variables, allow_nan=False)) > 262144: raise ValueError()
    except (ValueError, TypeError):
        fail('$.variables', 'invalid_variables', '变量必须为有限 JSON 数据且不超过 256 KiB')
    if ready:
        for edge in edges:
            guard = edge.get('guard') or {}
            operator = guard.get('operator', 'always')
            if operator in ('always', 'otherwise'):
                continue
            if guard.get('key') not in variables:
                fail('$.transitions.guard', 'unknown_variable', '转换条件需要选择已声明的变量')
            if operator in ('greater', 'less') and (type(variables[guard['key']]) not in (int, float) or type(guard.get('value')) not in (int, float)):
                fail('$.transitions.guard', 'invalid_comparison', '大小比较需要数值变量和数值比较值')
    for state in states:
        bindings = state.get('bindings', {})
        if not isinstance(bindings, dict) or set(bindings)-{'entry','do','exit'}:
            fail('$.bindings', 'invalid_bindings', '按进入、持续和退出行为配置变量绑定')
        for phase, slots in bindings.items():
            if not isinstance(slots, dict) or set(slots)-{'inputs','outputs'}:
                fail('$.bindings', 'invalid_bindings', '行为绑定仅支持输入和输出')
            for mapping in slots.values():
                if not isinstance(mapping, dict) or any(not isinstance(k,str) or not IDENT.fullmatch(k) or not isinstance(v,str) or ready and v not in variables for k,v in mapping.items()):
                    fail('$.bindings', 'invalid_bindings', '行为端口需要绑定已声明的状态机变量')
    return copy.deepcopy(spec)


class StateMachines:
    def __init__(self, context, store, robot_systems, documents, tasks, ros_tasks=None):
        self.context, self.store = context, store
        self.robots, self.documents, self.tasks = robot_systems, documents, tasks
        self.ros_tasks = ros_tasks
        self._lock = asyncio.Lock()
        self._runner = None
        self._session = None
        self._pending_event = None
        self._events = deque()
        self._activation = 0
        self._spec = None
        self._dependencies = {}
        self._stop_requested = False
        self._behaviors = {}
        self._do_watchers = {}
        self._control_token = None
        for item in store.list('hsm_session'):
            if item.get('status') in ('RUNNING', 'ENTERING', 'TRANSITIONING', 'STOPPING'):
                store.put('hsm_session', item['id'], {**item,'status':'UNKNOWN', 'error':'后台重新启动，不能自动恢复动作，请人工核对设备停止状态'})

    def _robot(self):
        key = self.robots.selected_id()
        if not key:
            fail('$.robot', 'no_robot', '请先选择机器人')
        return key

    def list(self):
        key = self._robot()
        return [s for s in self.store.list('state_machine') if s.get('robot_system_id') == key]

    def definitions(self):
        self._robot()
        return self.documents.behaviors()

    def ros_definitions(self):
        return self.ros_tasks.list() if self.ros_tasks else []

    def save(self, value):
        key = self._robot()
        identity = value.get('id') or 'machine_'+uuid4().hex
        if not IDENT.fullmatch(identity):
            fail('$.id','invalid_id','状态机标识无效')
        previous = next((m for m in self.list() if m['id'] == identity),None)
        if previous and previous['robot_system_id'] != key:
            fail('$.robot', 'ownership', '状态机不属于当前机器人')
        spec = validate(value.get('document'),self.definitions(),self.ros_definitions(),ready=False)
        layout = value.get('layout') or {}
        positions = layout.get('positions', {}) if isinstance(layout, dict) else None
        valid_ids = {state['id'] for state in spec['states']}
        if not isinstance(positions, dict) or len(positions) > 48 or any(
            key not in valid_ids or not isinstance(point, list) or len(point) != 2 or
            any(type(x) not in (int, float) or not 0 <= x <= 12000 for x in point)
            for key, point in positions.items()
        ):
            fail('$.layout.positions', 'invalid_layout', '状态画布坐标无效')
        return self.store.put('state_machine',identity,{'id':identity,'robot_system_id':key,'name':(str(value.get('name') or '未命名状态机'))[:80], 'revision':(previous['revision']+1 if previous else 1),'document':spec, 'layout':{'positions':copy.deepcopy(positions)}})

    def delete(self, identity):
        machine = self.get(identity)
        if self.running() and self._session['machine_id'] == identity:
            fail('$.machine','running','当前状态机正在运行')
        self.store.db.execute("DELETE FROM documents WHERE kind='state_machine' AND id=?",(identity,))
        self.store.db.commit()
        return {'deleted':True}

    def get(self, identity):
        machine = self.store.get('state_machine',identity)
        if machine.get('robot_system_id') != self._robot():
            fail('$.machine','ownership','状态机不属于当前机器人')
        return machine

    def check(self, identity):
        machine = self.get(identity)
        definitions = self.definitions()
        spec = validate(machine['document'], definitions, self.ros_definitions())
        trees = {item['id']: item for item in definitions}
        tasks, checked, task_origins = [], set(), {}
        for state in spec['states']:
            for phase in ('entry', 'do', 'exit'):
                reference = state.get(phase)
                if not reference or reference in checked:
                    continue
                checked.add(reference)
                start = len(tasks)
                if reference.startswith('ros:'):
                    tasks.append(reference[4:])
                    task_origins[reference[4:]] = {'state_id': state['id'], 'phase': phase}
                    continue
                tree = trees[reference]
                frozen = tree.get('ros_tasks')
                if frozen is not None:
                    tasks.extend(frozen)
                    with self.documents.frozen_ros(frozen):
                        result = self.documents.validate_tree(tree['document'], tree.get('policy', 'general'), tree.get('parameters'), engine=False)
                else:
                    result = self.documents.validate_tree(tree['document'], tree.get('policy', 'general'), tree.get('parameters'), engine=False)
                    tasks.extend(node['registration_id'][8:] for subtree in tree['document']['trees'].values()
                                 for node in subtree['nodes'].values() if node['registration_id'].startswith('RosTask_'))
                if not result['valid']:
                    reasons = ' · '.join(item['reason'] for item in result.get('diagnostics', []) if item.get('severity') == 'error')
                    fail('$.states.' + state['id'] + '.' + phase, 'behavior_incomplete', reasons or '状态行为尚未配置完整')
                for task in tasks[start:]:
                    task_origins[task['id'] if isinstance(task, dict) else task] = {'state_id': state['id'], 'phase': phase}
        if self.ros_tasks:
            self.ros_tasks.validate_task_workspaces(tasks)
        diagnostics = []
        if self.ros_tasks:
            from .ros_tasks import validate_task, validate_task_schema
            from .errors import ContractValidationError
            for value in tasks:
                task = self.ros_tasks.get(value.removeprefix('ros:')) if isinstance(value, str) else value
                try:
                    validate_task(task)
                    validate_task_schema(task, self.ros_tasks.describe(task['kind'], task['ros_type'], task.get('schema_id')))
                    if not task.get('interface', '').strip():
                        fail('$.interface', 'missing_binding', '通信名称待配置')
                except ContractValidationError as exc:
                    diagnostics.extend({'message': task.get('name', '') + ' · ' + issue.reason,
                                        'task_id': task.get('id'), 'path': issue.path,
                                        **task_origins.get(task.get('id'), {})} for issue in exc.issues)
        return {'valid': not diagnostics, 'diagnostics': diagnostics, 'behaviors': len(checked),
                'message': '离线配置检查通过，在线通信与执行状态尚未确认' if not diagnostics else '运行前需补充配置'}

    def running(self):
        return self._session is not None and self._session.get('status') in ('RUNNING','ENTERING','TRANSITIONING','STOPPING')

    def status(self):
        key = self.robots.selected_id()
        if self._session and self._session['robot_system_id'] == key:
            return copy.deepcopy(self._session)
        previous = [s for s in self.store.list('hsm_session') if s.get('robot_system_id') == key]
        return sorted(previous,key=lambda s:s.get('sequence',0))[-1] if previous else None

    def _persist(self, **changes):
        if not self._session:
            return
        self._session.update(changes)
        self.store.put('hsm_session',self._session['id'],self._session)

    @staticmethod
    def _path(leaf, by_id):
        route=[]
        while leaf:
            route.insert(0,leaf)
            leaf=by_id[leaf].get('parent')
        return route

    @staticmethod
    def _leaf(key, by_id):
        seen=set()
        while by_id[key].get('initial'):
            if key in seen:
                raise ValueError('invalid hierarchy')
            seen.add(key)
            key=by_id[key]['initial']
        return key

    def _guard(self, edge, values):
        guard = edge.get('guard') or {}
        operator = guard.get('operator','always')
        if operator in ('always', 'otherwise'): return True
        left, right = values.get(guard.get('key')), guard.get('value')
        if operator == 'equals': return left == right
        if operator == 'not_equals': return left != right
        if type(left) not in (int,float) or type(right) not in (int,float): return False
        return left > right if operator == 'greater' else left < right

    def _matching_transition(self, name, path, values):
        # Conditions retain document order within one event group; its fallback
        # consumes the event before it can bubble to the next ancestor
        for owner in reversed(path):
            candidates = [edge for edge in self._spec['transitions'] if edge['source'] == owner and edge['event'] == name]
            fallback = None
            for edge in candidates:
                if (edge.get('guard') or {}).get('operator', 'always') in ('always', 'otherwise'):
                    fallback = edge
                elif self._guard(edge, values):
                    return edge
            if fallback:
                return fallback
        return None

    def _bindings(self, state_id, phase):
        state = next((s for s in self._spec['states'] if s['id']==state_id), {})
        return state.get('bindings', {}).get(phase, {})

    def _inputs(self, names, state_id, phase, defaults=None):
        values = self._session['variables']
        mapping = self._bindings(state_id,phase).get('inputs', {})
        result = copy.deepcopy(defaults or {})
        for name in names:
            key = mapping.get(name,name)
            if key in values: result[name] = copy.deepcopy(values[key])
        return result

    def _outputs(self, output, state_id, phase):
        values = copy.deepcopy(self._session['variables'])
        mapping = self._bindings(state_id,phase).get('outputs', {})
        for name,value in output.items():
            key = mapping.get(name,name)
            if key in values: values[key] = copy.deepcopy(value)
        self._persist(variables=values)

    def _behavior_status(self):
        fields = ('id', 'state_id', 'phase', 'reference', 'status', 'task_run_id', 'operation_id', 'feedback', 'error')
        records = {item['id']: item for item in self._session.get('behaviors', [])}
        for instance in self._behaviors.values():
            records[instance['id']] = {name: value for name, value in instance.items() if name in fields}
        active = [item for item in records.values() if item['status'] in ACTIVE]
        completed = [item for item in records.values() if item['status'] not in ACTIVE]
        self._persist(behaviors=completed[-256:] + active)

    def _current_instance(self, instance):
        return (self._session and instance['session_id'] == self._session['id'] and
                self._behaviors.get((instance['state_id'], instance['phase'])) is instance and
                not instance['stop'].is_set() and not self._stop_requested)

    def _acquire_control(self, duration):
        control = self.context.engine.control
        if self._control_token:
            control.validate_control(self._control_token, [])
            if self._control_token.expires_at - control.clock.now() < duration:
                fail('$.control', 'lease_too_short', '当前行为组控制租期不足，请等待其停止后重新执行')
            return self._control_token
        durations = [item.get('timeout_s', item.get('manifest', {}).get('timeout_ms', 30000) / 1000)
                     for item in self._dependencies.values()]
        lease = max([65, duration + 15] + [value + 15 for value in durations])
        self._control_token = control.begin_task(self._session['id'], ready=True, lease_s=lease)
        return self._control_token

    def _release_control(self):
        if not self._control_token or any(instance['status'] in ACTIVE | {'UNKNOWN'} for instance in self._behaviors.values()):
            return
        control = self.context.engine.control
        if control._epoch == self._control_token.control_epoch and not control.resources.unavailable:
            control.set_mode('STANDBY')
            self._control_token = None

    async def _tree(self, definition_id, stage, state_id=None):
        if self._stop_requested:
            return 'CANCELED'
        if not definition_id:
            return 'SUCCEEDED'
        instance = {'id': 'behavior_' + uuid4().hex, 'session_id': self._session['id'],
                    'state_id': state_id, 'phase': stage, 'reference': definition_id,
                    'status': 'RUNNING', 'stop': threading.Event(), 'worker': asyncio.current_task(),
                    'task_run_id': None, 'operation_id': None, 'feedback': None}
        self._behaviors[(state_id, stage)] = instance
        self._behavior_status()
        try:
            standalone = self._session.get('execution_mode') == 'ROS_ONLY'
            if self.context.state != ('STOPPED' if standalone else 'READY'):
                fail('$.system', 'system_not_ready', '运行环境已改变，不能执行状态行为')
            frozen = self._dependencies[definition_id]
            if definition_id.startswith('ros:'):
                result = await self._run_ros(frozen, instance)
            else:
                parameters = self._inputs(frozen.get('manifest', {}).get('parameters', {}), state_id, stage, frozen.get('parameters', {}))
                request = self.documents.definition_request(frozen['id'], 'hsm_' + uuid4().hex, parameters=parameters)
                token = self._acquire_control(frozen.get('manifest', {}).get('timeout_ms', 30000) / 1000)
                async with self.context.transition:
                    task = await self.tasks.start_task(request, self._session['id'], standalone=standalone, control_token=token)
                identity = task['task_run_id']
                instance['task_run_id'] = identity
                self._behavior_status()
                while True:
                    state = self.tasks.status(identity)
                    if state['state'] not in ACTIVE:
                        if state.get('error'):
                            instance['error'] = state['error'].get('reason', str(state['error'])) if isinstance(state['error'], dict) else str(state['error'])
                        if not state.get('stop_confirmed') or state['state'] == 'UNKNOWN':
                            fail('$.task', 'stop_unconfirmed', '行为结束但设备停止未确认，请核对设备状态')
                        if state['state'] == 'SUCCEEDED' and self._current_instance(instance):
                            for operation in state.get('operations', []):
                                if operation['state'] == 'SUCCEEDED' and operation.get('result'):
                                    self._outputs(operation['result'].get('output', {}), state_id, stage)
                        result = state['state']
                        break
                    if instance['stop'].is_set() or self._stop_requested:
                        self.tasks.cancel_task(identity, reason='hsm_transition')
                    await asyncio.sleep(.08)
            instance['status'] = result
            return result
        except asyncio.CancelledError:
            instance.update(status='UNKNOWN', error='行为执行被中断，需确认设备停止状态')
            instance['stop'].set()
            if instance['task_run_id']:
                self.tasks.cancel_task(instance['task_run_id'], reason='hsm_interrupted')
            if instance['operation_id']:
                self.documents.ros_operations.cancel(instance['operation_id'])
            raise
        except Exception as exc:
            instance.update(status='UNKNOWN', error=str(exc))
            raise
        finally:
            self._behavior_status()
            self._release_control()

    async def _run_ros(self, definition, instance):
        token = self._acquire_control(definition.get('timeout_s', 15))
        inputs = self._inputs(definition.get('inputs', {}), instance['state_id'], instance['phase'])
        operation = await self.documents.ros_operations.start(definition, inputs, token.model_dump(mode='json'),
            task_id=self._session['id'], node_id=instance['state_id'] + '_' + instance['phase'],
            request_id=instance['id'])
        instance['operation_id'] = operation['operation_id']
        self._behavior_status()
        last_feedback = 0
        while operation['state'] in ACTIVE:
            if instance['stop'].is_set() or self._stop_requested:
                self.documents.ros_operations.cancel(operation['operation_id'])
            operation = self.documents.ros_operations.snapshot(operation['operation_id'])
            if operation.get('feedback') and time.monotonic() - last_feedback > .35:
                last_feedback = time.monotonic()
                instance['feedback'] = operation['feedback']
                self._behavior_status()
            await asyncio.sleep(.05)
        if operation['stop_state'] == 'UNCONFIRMED' or operation['state'] == 'UNKNOWN':
            fail('$.task', 'stop_unconfirmed', 'ROS 行为停止状态未确认')
        if operation.get('error'):
            instance['error'] = operation['error'].get('reason', str(operation['error']))
        if operation['state'] == 'SUCCEEDED' and self._current_instance(instance):
            self._outputs(operation['result']['output'], instance['state_id'], instance['phase'])
        return operation['state']

    async def _cancel_tree(self, states=None):
        selected = [instance for instance in self._behaviors.values()
                    if instance['status'] in ACTIVE and (states is None or instance['state_id'] in states)]
        for instance in selected:
            instance['stop'].set()
            if instance['task_run_id']:
                self.tasks.cancel_task(instance['task_run_id'], reason='hsm_transition')
            if instance['operation_id']:
                self.documents.ros_operations.cancel(instance['operation_id'])
        workers = {instance['worker'] for instance in selected if instance['worker'] is not asyncio.current_task()}
        if workers:
            done, pending = await asyncio.wait(workers, timeout=30)
            if pending:
                fail('$.task', 'stop_unconfirmed', '状态行为没有在期限内确认停止')
            for worker in done:
                if not worker.cancelled() and worker.exception():
                    fail('$.task', 'stop_unconfirmed', '状态行为停止结果需要核对')
        if any(instance['status'] == 'UNKNOWN' for instance in selected):
            fail('$.task', 'stop_unconfirmed', '状态行为停止结果需要核对')
        self._release_control()

    async def _abort(self, error):
        if self._stop_requested:
            return
        self._stop_requested = True
        self._events.clear()
        self._persist(status='UNKNOWN', error=str(error), pending_events=0)
        try:
            await self._cancel_tree()
        except Exception as stop_error:
            self._persist(error=str(error) + '；' + str(stop_error))

    async def _enter(self, spec):
        async with self._lock:
            await self._enter_locked(spec)

    async def _enter_locked(self, spec):
        by_id={s['id']:s for s in spec['states']}
        path=self._path(self._leaf(spec['initial'],by_id),by_id)
        try:
            for name in path:
                result=await self._tree(by_id[name].get('entry'),'entry',name)
                if self._stop_requested or self._session['status']!='ENTERING':return
                if result!='SUCCEEDED': raise RuntimeError('进入动作未成功')
            if self._stop_requested or self._session['status']!='ENTERING':return
            self._persist(status='RUNNING',active=path[-1],path=path,action=None)
            await self._launch_do(by_id)
        except Exception as exc:
            await self._abort(exc)

    async def _launch_do(self, by_id):
        if not self._session or self._session['status'] != 'RUNNING':
            return
        async def watch(owner, reference):
            try:
                result = await self._tree(reference, 'do', owner)
                instance = self._behaviors.get((owner, 'do'))
                if not instance or not self._current_instance(instance):
                    return
                name = 'completed' if result == 'SUCCEEDED' else 'failed'
                if result == 'CANCELED':
                    return
                route = self._path(owner, by_id)
                if any(edge['event'] == name and edge['source'] in route for edge in self._spec['transitions']):
                    await self.event(name, {}, source=owner, instance_id=instance['id'])
                elif name == 'failed':
                    self._unhandled_failure(owner)
            except asyncio.CancelledError:
                return
            except Exception as exc:
                await self._abort(exc)
        for owner in reversed(self._session['path']):
            reference = by_id[owner].get('do')
            if reference and (owner, 'do') not in self._behaviors:
                self._do_watchers[owner] = asyncio.create_task(watch(owner, reference))
        await asyncio.sleep(0)

    def _unhandled_failure(self, owner):
        instance = self._behaviors.get((owner, 'do'), {})
        pending = [item for item in self._session.get('attention', []) if item['state_id'] != owner]
        pending.append({'state_id': owner, 'instance_id': instance.get('id'),
                        'reference': instance.get('reference'), 'event': 'failed',
                        'reason': instance.get('error') or '状态期间行为失败，当前没有可处理的失败转换'})
        self._persist(attention=pending)

    async def start(self,identity,mode='auto',confirm_safety=False):
        async with self._lock:
            if self.running():fail('$.machine','running','已有状态机正在运行')
            self.check(identity)
            machine=self.get(identity)
            spec=validate(machine['document'],self.definitions(),self.ros_definitions())
            robot=self.robots.selected()
            if mode=='auto':
                mode='managed' if self.robots.active() and self.context.state=='READY' else 'ros_only'
            if mode == 'ros_only':
                if not confirm_safety:
                    fail('$.safety','confirmation_required','启动独立 ROS 2 任务前需确认实体急停与通信失联保护')
                if not robot or robot.get('configured') or self.context.state!='STOPPED':
                    fail('$.system','ros_only_unavailable','独立 ROS 2 模式仅供空白机器人在传统运行核心停止时使用')
            elif not self.robots.active() or self.context.state != 'READY' or self.context.engine.control.mode.value != 'STANDBY':
                fail('$.system','not_ready','需先应用机器人配置并启动系统，保持待命模式，或为空白机器人选择独立 ROS 2 模式')
            if any(t['state'] in ACTIVE or t['state']=='UNKNOWN' or not t['stop_confirmed'] for t in self.tasks.list()):
                fail('$.task','task_busy','仍有任务在执行或停止结果未确认，不能开始新的状态机')
            if any(r['snapshot']['state']=='UNKNOWN' or r['snapshot']['stop_state']=='UNCONFIRMED' for r in self.store.list('ros_operation')):
                fail('$.task','task_busy','ROS 能力仍在执行或停止结果未确认')
            by_id={s['id']:s for s in spec['states']}
            dependencies={}
            for state in spec['states']:
                for phase in ('entry','do','exit'):
                    ref=state.get(phase)
                    if not ref or ref in dependencies:continue
                    if ref.startswith('ros:'):
                        dependencies[ref]=self.ros_tasks.freeze(ref[4:])
                    else:
                        dependencies[ref]=self.documents.prepare_behavior(ref)
                        if mode=='ros_only' and self.documents.requires_system(dependencies[ref]['document']):
                            fail('$.tree','system_required','此行为树包含需要已就绪系统的能力，请先应用机器人配置')
            if self.ros_tasks:
                task_set = []
                for ref, dependency in dependencies.items():
                    task_set.extend([dependency] if ref.startswith('ros:') else dependency.get('ros_tasks', []))
                self.ros_tasks.validate_task_workspaces(task_set)
            self._behaviors.clear()
            self._do_watchers.clear()
            self._control_token = None
            self._spec=copy.deepcopy(spec)
            self._dependencies=dependencies
            self._events.clear()
            self._activation+=1
            sid='session_'+uuid4().hex
            self._stop_requested=False
            self._session={'id':sid,'machine_id':identity,'robot_system_id':self._robot(),'execution_mode':'ROS_ONLY' if mode=='ros_only' else 'MANAGED','status':'ENTERING', 'active':None,'path':[], 'events':[], 'variables':spec.get('variables',{}),'task_run_id':None, 'ros_task_id':None,'ros_feedback':None, 'action':None, 'error':None,'sequence':len(self.store.list('hsm_session'))+1,'pending_events':0,'definition':copy.deepcopy(machine),'dependencies':dependencies,'do_policy':'active_path','behaviors':[]}
            self._persist(attention=[])
            self._runner=asyncio.create_task(self._enter(spec))
            return self.status()

    async def event(self,name,values,*,activation=None,source=None,instance_id=None):
        if not isinstance(name,str) or not IDENT.fullmatch(name):
            fail('$.event','invalid_event','事件名称无效')
        if not self.running() or self._stop_requested:
            fail('$.machine','not_running','当前状态机不可接收事件')
        if not isinstance(values,dict) or any(k not in self._session['variables'] for k in values):
            fail('$.variables','invalid_variable','只能更新已声明的状态机变量')
        try:
            if len(json.dumps(values,allow_nan=False))>262144:raise ValueError()
        except (ValueError,TypeError):
            fail('$.variables','invalid_variable','变量必须为有限 JSON 数据')
        if len(self._events)>=128:
            fail('$.event','event_queue_full','事件队列已满，请等待当前转换完成')
        self._events.append((self._session['id'],name,copy.deepcopy(values),activation,source,instance_id))
        self._persist(pending_events=len(self._events))
        if not self._pending_event or self._pending_event.done():
            self._pending_event=asyncio.create_task(self._drain_events())
        return {'accepted':True,'queued':len(self._events),'session':self.status()}

    async def _drain_events(self):
        while self._events and self.running() and not self._stop_requested:
            if self._session['status'] in ('ENTERING', 'TRANSITIONING'):
                await asyncio.sleep(.02)
                continue
            session_id,name,values,activation,source,instance_id=self._events.popleft()
            self._persist(pending_events=len(self._events))
            if session_id!=self._session['id'] or activation is not None and activation!=self._activation:
                continue
            try:
                if source and (source not in self._session['path'] or self._behaviors.get((source, 'do'), {}).get('id') != instance_id):
                    continue
                await self._process_event(name,values,source)
            except Exception as exc:
                if self._session and self._session['status']=='RUNNING':
                    self._persist(error=str(exc))
        self._events.clear()
        self._persist(pending_events=0)

    async def _process_event(self,name,values,source=None):
        if not isinstance(name,str) or not IDENT.fullmatch(name):
            fail('$.event','invalid_event','事件名称无效')
        async with self._lock:
            if self._stop_requested or not self.running() or self._session['status']!='RUNNING':
                fail('$.machine','not_running','当前没有可接收事件的状态机')
            spec=self._spec; by_id={s['id']:s for s in spec['states']}
            updated={**self._session['variables']}
            for k,v in values.items():
                if k not in updated:
                    fail('$.variables','invalid_variable','只能更新状态机已声明的变量')
                updated[k]=v
            path=self._session['path']
            event_path = self._path(source, by_id) if source else path
            matching=self._matching_transition(name,event_path,updated)
            if not matching:
                if source and name == 'failed':
                    self._unhandled_failure(source)
                    return self.status()
                fail('$.event','no_transition','当前状态无满足 Guard 的事件转换')
            current=self._session['active']
            if matching['source'] == matching['target']:
                self._persist(variables=updated, attention=[item for item in self._session.get('attention', []) if item['state_id'] != source], events=self._session['events'][-49:] + [{'event':name,'source':current,'target':current,'origin':source}])
                return self.status()
            destination=self._leaf(matching['target'],by_id)
            target_path=self._path(destination,by_id)
            common=0
            while common<min(len(path),len(target_path)) and path[common]==target_path[common]:common+=1
            self._activation+=1
            self._persist(status='TRANSITIONING',variables=updated,error=None)
            try:
                await self._cancel_tree(set(path[common:]))
                for state_id in path[common:]:
                    self._behaviors.pop((state_id, 'do'), None)
                    self._do_watchers.pop(state_id, None)
                if self._stop_requested:return self.status()
                for state in reversed(path[common:]):
                    result=await self._tree(by_id[state].get('exit'),'exit',state)
                    if self._stop_requested:return self.status()
                    if result!='SUCCEEDED':raise RuntimeError('退出动作未成功')
                for state in target_path[common:]:
                    result=await self._tree(by_id[state].get('entry'),'entry',state)
                    if self._stop_requested:return self.status()
                    if result!='SUCCEEDED':raise RuntimeError('进入动作未成功')
                events=self._session['events'][-49:]+[{'event':name,'source':current,'target':destination,
                    'origin':source,'handled_by':matching['source'],'exited':list(reversed(path[common:])),
                    'retained':path[:common],'entered':target_path[common:]}]
                self._persist(status='RUNNING',active=destination,path=target_path,events=events,action=None,
                              attention=[item for item in self._session.get('attention', []) if item['state_id'] in path[:common] and item['state_id'] != source])
                await self._launch_do(by_id)
                return self.status()
            except Exception as exc:
                await self._abort(exc)
                raise

    def request_stop(self):
        self._stop_requested = True
        self._activation += 1
        self._events.clear()
        for instance in self._behaviors.values():
            instance['stop'].set()
            if instance.get('task_run_id') and instance['status'] in ACTIVE:
                self.tasks.cancel_task(instance['task_run_id'], reason='hsm_stop')
            if instance.get('operation_id') and instance['status'] in ACTIVE:
                self.documents.ros_operations.cancel(instance['operation_id'])
        asyncio.create_task(self.stop())
        return {'accepted': True, 'session': self.status()}

    async def stop(self):
        self._stop_requested=True
        async with self._lock:
            if not self.running() and not any(instance['status'] in ACTIVE for instance in self._behaviors.values()):return self.status()
            self._persist(status='STOPPING')
            try:
                await self._cancel_tree()
                self._persist(status='STOPPED',action=None)
            except Exception as exc:
                self._persist(status='UNKNOWN',error=str(exc))
                raise
            return self.status()

    async def close(self):
        if self.running():
            try:await self.stop()
            except Exception:pass
        if self._runner and not self._runner.done():
            self._runner.cancel()
            await asyncio.gather(self._runner,return_exceptions=True)
        for watcher in self._do_watchers.values():
            if not watcher.done():
                watcher.cancel()
        if self._do_watchers:
            await asyncio.gather(*self._do_watchers.values(), return_exceptions=True)
        if self._pending_event and not self._pending_event.done():
            self._pending_event.cancel()
            await asyncio.gather(self._pending_event,return_exceptions=True)
