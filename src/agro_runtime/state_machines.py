"""机器人业务层级状态机

与整机安全模式独立 事件在串行锁下转换 关联的动作由已发布的行为树执行
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


def validate(spec, definitions=(), ros_tasks=()):
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
            if reference and (not isinstance(reference, str) or reference not in refs | ros_refs):
                fail('$.states.'+key+'.'+field, 'unknown_task', '请选择当前机器人已保存的 ROS 2 任务或已发布行为树')
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
        if children and s.get('initial') not in children:
            fail('$.states.'+s['id']+'.initial', 'initial_required', '包含子状态时需要指定初始子状态')
        if not children and s.get('initial'):
            fail('$.states.'+s['id']+'.initial', 'invalid_initial', '叶状态不能指定初始子状态')
    if spec.get('initial') != roots[0]['id']:
        fail('$.initial', 'invalid_initial', '初始状态必须指向根状态')
    signatures = set()
    for edge in edges:
        if not isinstance(edge, dict) or edge.get('source') not in ids or edge.get('target') not in ids:
            fail('$.transitions', 'unknown_state', '转换源状态或目标状态不存在')
        event = edge.get('event')
        if not isinstance(event, str) or not IDENT.fullmatch(event):
            fail('$.transitions', 'invalid_event', '事件标识应使用小写字母数字下划线')
        key = edge['source'], event
        if key in signatures:
            fail('$.transitions', 'ambiguous_event', '同一状态下的相同事件只能有一条转换')
        signatures.add(key)
        guard = edge.get('guard') or {}
        if not isinstance(guard, dict) or guard.get('operator', 'always') not in ('always','equals','not_equals','greater','less'):
            fail('$.transitions.guard', 'invalid_guard', 'Guard 操作不支持')
        if guard.get('operator', 'always') != 'always' and (not isinstance(guard.get('key'), str) or not IDENT.fullmatch(guard['key'])):
            fail('$.transitions.guard', 'invalid_guard', 'Guard 变量名称无效')
    variables = spec.get('variables', {})
    if not isinstance(variables, dict) or len(variables) > 64 or any(not IDENT.fullmatch(k) for k in variables):
        fail('$.variables', 'invalid_variables', '变量名应使用小写标识，最多声明 64 个变量')
    try:
        if len(json.dumps(variables, allow_nan=False)) > 262144: raise ValueError()
    except (ValueError, TypeError):
        fail('$.variables', 'invalid_variables', '变量必须为有限 JSON 数据且不超过 256 KiB')
    for state in states:
        bindings = state.get('bindings', {})
        if not isinstance(bindings, dict) or set(bindings)-{'entry','do','exit'}:
            fail('$.bindings', 'invalid_bindings', '按进入、持续和退出行为配置变量绑定')
        for phase, slots in bindings.items():
            if not isinstance(slots, dict) or set(slots)-{'inputs','outputs'}:
                fail('$.bindings', 'invalid_bindings', '行为绑定仅支持输入和输出')
            for mapping in slots.values():
                if not isinstance(mapping, dict) or any(not isinstance(k,str) or not IDENT.fullmatch(k) or v not in variables for k,v in mapping.items()):
                    fail('$.bindings', 'invalid_bindings', '行为端口需要绑定已声明的状态机变量')
    return copy.deepcopy(spec)


class StateMachines:
    def __init__(self, context, store, robot_systems, documents, tasks, ros_tasks=None):
        self.context, self.store = context, store
        self.robots, self.documents, self.tasks = robot_systems, documents, tasks
        self.ros_tasks = ros_tasks
        self._lock = asyncio.Lock()
        self._runner = None
        self._watcher = None
        self._current_task = None
        self._current_ros = None
        self._ros_stop = None
        self._session = None
        self._pending_event = None
        self._events = deque()
        self._activation = 0
        self._do_generation = 0
        self._spec = None
        self._dependencies = {}
        self._ros_operation = None
        self._stop_requested = False
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
        key = self._robot()
        return [d for d in self.store.list('tree_definition') if d.get('robot_system_id') == key]

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
        spec = validate(value.get('document'),self.definitions(),self.ros_definitions())
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
        if operator == 'always': return True
        left, right = values.get(guard.get('key')), guard.get('value')
        if operator == 'equals': return left == right
        if operator == 'not_equals': return left != right
        if type(left) not in (int,float) or type(right) not in (int,float): return False
        return left > right if operator == 'greater' else left < right

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

    def _result_current(self, session_id, generation, stage):
        return self._session and self._session['id']==session_id and not self._stop_requested and generation==(self._do_generation if stage=='do' else self._activation)

    async def _tree(self, definition_id, stage, state_id=None):
        session_id=self._session['id']
        generation=self._do_generation if stage=='do' else self._activation
        if self._stop_requested:return 'CANCELED'
        if not definition_id: return 'SUCCEEDED'
        if definition_id.startswith('ros:'):
            if self._session and self._session.get('execution_mode')=='ROS_ONLY':
                if self.context.state != 'STOPPED':
                    fail('$.system','mode_changed','独立 ROS 2 运行期间传统执行器状态发生变化，请停止并核对')
            elif self.context.state != 'READY':
                fail('$.system','system_not_ready','系统未就绪，不能执行状态动作')
            return await self._run_ros(definition_id[4:], stage, state_id)
        standalone=self._session.get('execution_mode')=='ROS_ONLY'
        if self.context.state != ('STOPPED' if standalone else 'READY'):
            fail('$.system','system_not_ready','运行环境已改变，不能执行状态动作')
        frozen = self._dependencies[definition_id]
        parameters = self._inputs(frozen.get('manifest',{}).get('parameters',{}),state_id,stage,frozen.get('parameters',{}))
        request = self.documents.definition_request(definition_id,'hsm_'+uuid4().hex, parameters=parameters)
        async with self.context.transition:
            task = await self.tasks.start_task(request,'hsm',standalone=standalone)
        task_id=task['task_run_id']
        self._current_task=task_id
        self._persist(action=stage,task_run_id=task_id)
        while True:
            if self._stop_requested and self.tasks.status(task_id)['state'] in ACTIVE:
                self.tasks.cancel_task(task_id,reason='hsm_stop')
            state=self.tasks.status(task_id)
            if state['state'] not in ACTIVE:
                if not state.get('stop_confirmed') or state['state']=='UNKNOWN':
                    fail('$.task','stop_unconfirmed','行为树结束但设备停止未确认，停止状态机并人工核对')
                self._current_task=None
                if state['state']=='SUCCEEDED' and self._result_current(session_id,generation,stage):
                    for operation in state.get('operations',[]):
                        if operation['state']=='SUCCEEDED' and operation.get('result'):
                            self._outputs(operation['result'].get('output',{}),state_id,stage)
                self._persist(task_run_id=None,action=None)
                return state['state']
            await asyncio.sleep(.12)

    async def _run_ros(self, task_id, stage, state_id):
        if self._stop_requested:
            return 'CANCELED'
        stop = threading.Event()
        self._ros_stop = stop
        self._current_ros = asyncio.current_task()
        session_id = self._session['id']
        generation=self._do_generation if stage=='do' else self._activation
        loop = asyncio.get_running_loop()
        last_feedback = [0.0]
        def feedback(data):
            now = time.monotonic()
            if now - last_feedback[0] < .35:
                return
            last_feedback[0] = now
            if len(str(data)) > 8000:
                data = {'detail':'ROS 2 Feedback 过长，已省略显示'}
            def update():
                if self._session and self._session['id'] == session_id and self._session.get('ros_task_id') == task_id:
                    self._persist(ros_feedback=data)
            try:
                loop.call_soon_threadsafe(update)
            except RuntimeError:
                pass
        self._persist(action=stage, ros_task_id=task_id, ros_feedback=None)
        control = self.context.engine.control
        definition = self._dependencies['ros:'+task_id]
        inputs = self._inputs(definition.get('inputs',{}),state_id,stage)
        token = None
        operation = None
        try:
            token = control.begin_task('hsm',ready=True,lease_s=definition.get('timeout_s',15)+15)
            operation = await self.documents.ros_operations.start(definition,inputs,token.model_dump(mode='json'),
                task_id=session_id,node_id=state_id+'_'+stage,request_id='hsm_'+uuid4().hex)
            self._ros_operation = operation['operation_id']
            while operation['state'] in ACTIVE:
                if stop.is_set() or self._stop_requested:
                    self.documents.ros_operations.cancel(operation['operation_id'])
                operation = self.documents.ros_operations.snapshot(operation['operation_id'])
                if operation.get('feedback',{}).get('data'):
                    feedback(operation['feedback']['data'])
                await asyncio.sleep(.05)
            if operation['stop_state']=='UNCONFIRMED' or operation['state']=='UNKNOWN':
                fail('$.task','stop_unconfirmed','ROS 能力停止状态未确认')
            if operation['state']=='SUCCEEDED' and self._result_current(session_id,generation,stage):
                self._outputs(operation['result']['output'],state_id,stage)
            return operation['state']
        finally:
            if token and (operation is None or operation.get('stop_state')!='UNCONFIRMED') and control._epoch==token.control_epoch:
                control.set_mode('STANDBY')
            self._ros_operation = None
            self._current_ros = None
            self._ros_stop = None
            self._persist(action=None, ros_task_id=None, ros_feedback=None)

    async def _cancel_tree(self):
        if self._ros_stop and self._current_ros:
            self._ros_stop.set()
            try:
                await asyncio.wait_for(asyncio.shield(self._current_ros),timeout=12)
            except asyncio.TimeoutError:
                fail('$.task','stop_unconfirmed','ROS 2 任务没有确认停止，拒绝执行新动作')
            except Exception as exc:
                fail('$.task','stop_unconfirmed','ROS 2 任务停止状态不确定: '+str(exc))
            if self._session and self._session.get('status') == 'UNKNOWN':
                fail('$.task','stop_unconfirmed','ROS 2 任务报告停止状态不确定，拒绝继续状态转换')
        identity=self._current_task
        if not identity:return
        if self.tasks.status(identity)['state'] in ACTIVE:
            self.tasks.cancel_task(identity,reason='hsm_transition')
        deadline=asyncio.get_running_loop().time()+30
        while asyncio.get_running_loop().time()<deadline:
            result=self.tasks.status(identity)
            if result['state'] not in ACTIVE:
                if result.get('stop_confirmed') and result['state'] != 'UNKNOWN':
                    self._current_task=None
                    self._persist(task_run_id=None,action=None)
                    return
                break
            await asyncio.sleep(.15)
        fail('$.task','stop_unconfirmed','行为树停止未确认，拒绝执行新的状态动作')

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
            if not self._stop_requested:self._persist(status='UNKNOWN',error=str(exc))

    async def _launch_do(self,by_id):
        if not self._session or self._session['status']!='RUNNING':return
        leaf=self._session['active']
        self._do_generation+=1
        generation=self._do_generation
        session_id=self._session['id']
        owner=next((k for k in reversed(self._session['path']) if by_id[k].get('do')),None)
        definition_id=by_id[owner].get('do') if owner else None
        if not definition_id:return
        async def watch():
            try:
                result=await self._tree(definition_id,'do',owner)
                if result=='SUCCEEDED':event='completed'
                elif result=='CANCELED':return
                else:event='failed'
                if self._session and self._session['id']==session_id and self._do_generation==generation and self._session['status']=='RUNNING' and owner in self._session['path']:
                    path=self._session['path']
                    if any(edge['event']==event and edge['source'] in path for edge in self._spec['transitions']):
                        await self.event(event,{},activation=self._activation)
            except asyncio.CancelledError:
                return
            except Exception as exc:
                self._persist(status='UNKNOWN',error=str(exc))
        self._watcher=asyncio.create_task(watch())

    async def start(self,identity,mode='auto',confirm_safety=False):
        async with self._lock:
            if self.running():fail('$.machine','running','已有状态机正在运行')
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
            for state in spec['states']:
                path=self._path(state['id'],by_id)
                if any(by_id[k].get('do') for k in path[:-1]) and (state.get('entry') or state.get('exit')):
                    fail('$.states.'+state['id'],'concurrent_do_unavailable','父状态持续行为运行期间不能执行子状态进入或退出任务，请合并到同一行为树')
                if sum(bool(by_id[k].get('do')) for k in path)>1:
                    fail('$.states.'+state['id']+'.do','concurrent_do_unavailable','当前执行器只允许活动路径上一个持续行为，请将并行工作放入同一行为树')
            dependencies={}
            for state in spec['states']:
                for phase in ('entry','do','exit'):
                    ref=state.get(phase)
                    if not ref or ref in dependencies:continue
                    if ref.startswith('ros:'):
                        dependencies[ref]=copy.deepcopy(self.ros_tasks.get(ref[4:]))
                    else:
                        self.documents.definition_request(ref,'hsm_preflight')
                        dependencies[ref]=copy.deepcopy(self.store.get('tree_definition',ref))
                        if mode=='ros_only' and self.documents.requires_system(dependencies[ref]['document']):
                            fail('$.tree','system_required','此行为树包含需要已就绪系统的能力，请先应用机器人配置')
            self._spec=copy.deepcopy(spec)
            self._dependencies=dependencies
            self._events.clear()
            self._activation+=1
            sid='session_'+uuid4().hex
            self._stop_requested=False
            self._session={'id':sid,'machine_id':identity,'robot_system_id':self._robot(),'execution_mode':'ROS_ONLY' if mode=='ros_only' else 'MANAGED','status':'ENTERING', 'active':None,'path':[], 'events':[], 'variables':spec.get('variables',{}),'task_run_id':None, 'ros_task_id':None,'ros_feedback':None, 'action':None, 'error':None,'sequence':len(self.store.list('hsm_session'))+1,'pending_events':0,'definition':copy.deepcopy(machine),'dependencies':dependencies,'do_policy':'single_active_behavior'}
            self._persist()
            self._runner=asyncio.create_task(self._enter(spec))
            return self.status()

    async def event(self,name,values,*,activation=None):
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
        self._events.append((self._session['id'],name,copy.deepcopy(values),activation))
        self._persist(pending_events=len(self._events))
        if not self._pending_event or self._pending_event.done():
            self._pending_event=asyncio.create_task(self._drain_events())
        return {'accepted':True,'queued':len(self._events),'session':self.status()}

    async def _drain_events(self):
        while self._events and self.running() and not self._stop_requested:
            if self._session['status']=='ENTERING':
                await asyncio.sleep(.02)
                continue
            session_id,name,values,activation=self._events.popleft()
            self._persist(pending_events=len(self._events))
            if session_id!=self._session['id'] or activation is not None and activation!=self._activation:
                continue
            try:
                await self._process_event(name,values)
            except Exception as exc:
                if self._session and self._session['status']=='RUNNING':
                    self._persist(error=str(exc))
        self._events.clear()
        self._persist(pending_events=0)

    async def _process_event(self,name,values):
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
            matching=next((e for key in reversed(path) for e in spec['transitions'] if e['source']==key and e['event']==name and self._guard(e,updated)),None)
            if not matching:
                fail('$.event','no_transition','当前状态无满足 Guard 的事件转换')
            current=self._session['active']; destination=self._leaf(matching['target'],by_id)
            target_path=self._path(destination,by_id)
            common=0
            while common<min(len(path),len(target_path)) and path[common]==target_path[common]:common+=1
            common=min(common,path.index(matching['source']))
            previous_owner=next((k for k in reversed(path) if by_id[k].get('do')),None)
            next_owner=next((k for k in reversed(target_path) if by_id[k].get('do')),None)
            retained=previous_owner and previous_owner==next_owner and previous_owner in path[:common]
            self._activation+=1
            if not retained:self._do_generation+=1
            self._persist(status='TRANSITIONING',variables=updated,error=None)
            try:
                if not retained:await self._cancel_tree()
                if self._stop_requested:return self.status()
                for state in reversed(path[common:]):
                    result=await self._tree(by_id[state].get('exit'),'exit',state)
                    if self._stop_requested:return self.status()
                    if result!='SUCCEEDED':raise RuntimeError('退出动作未成功')
                for state in target_path[common:]:
                    result=await self._tree(by_id[state].get('entry'),'entry',state)
                    if self._stop_requested:return self.status()
                    if result!='SUCCEEDED':raise RuntimeError('进入动作未成功')
                events=self._session['events'][-49:]+[{'event':name,'source':current,'target':destination}]
                self._persist(status='RUNNING',active=destination,path=target_path,events=events,action=None)
                if not retained:await self._launch_do(by_id)
                return self.status()
            except Exception as exc:
                if not self._stop_requested:self._persist(status='UNKNOWN',error=str(exc))
                raise

    def request_stop(self):
        self._stop_requested = True
        self._activation += 1
        self._events.clear()
        if self._ros_stop:
            self._ros_stop.set()
        if self._current_task:
            try:
                if self.tasks.status(self._current_task)['state'] in ACTIVE:
                    self.tasks.cancel_task(self._current_task,reason='hsm_stop')
            except Exception:
                pass
        asyncio.create_task(self.stop())
        return {'accepted':True,'session':self.status()}

    async def stop(self):
        self._stop_requested=True
        async with self._lock:
            if not self.running():return self.status()
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
        if self._watcher and not self._watcher.done():
            self._watcher.cancel()
            await asyncio.gather(self._watcher,return_exceptions=True)
        if self._pending_event and not self._pending_event.done():
            self._pending_event.cancel()
            await asyncio.gather(self._pending_event,return_exceptions=True)
