"""机器人业务层级状态机

与整机安全模式独立 事件在串行锁下转换 关联的动作由已发布的行为树执行
"""
import asyncio
import copy
import re
from uuid import uuid4

from .errors import fail

IDENT = re.compile(r'^[a-z][a-z0-9_]{0,63}$')
ACTIVE = {'ACCEPTED', 'RUNNING', 'CANCELING'}


def validate(spec, definitions=()):
    if not isinstance(spec, dict):
        fail('$.machine', 'invalid_machine', '状态机必须是对象')
    states = spec.get('states')
    edges = spec.get('transitions')
    if not isinstance(states, list) or not 1 <= len(states) <= 48 or not isinstance(edges, list) or len(edges) > 160:
        fail('$.states', 'invalid_structure', '需要 1 到 48 个状态和不超过 160 条转换')
    ids = set()
    refs = {d['id'] for d in definitions}
    for s in states:
        key = s.get('id') if isinstance(s, dict) else None
        if not isinstance(key, str) or not IDENT.fullmatch(key) or key in ids:
            fail('$.states', 'invalid_state', '状态标识应唯一并使用小写字母数字下划线')
        ids.add(key)
        for field in ('entry', 'do', 'exit'):
            if s.get(field) and s[field] not in refs:
                fail('$.states.'+key+'.'+field, 'unknown_tree', '必须选择当前机器人已发布的行为树')
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
    if not isinstance(variables, dict) or len(variables) > 64 or any(not IDENT.fullmatch(k) or type(v) not in (str,int,float,bool,type(None)) for k,v in variables.items()):
        fail('$.variables', 'invalid_variables', '变量必须是简单类型，变量名应使用小写标识')
    return copy.deepcopy(spec)


class StateMachines:
    def __init__(self, context, store, robot_systems, documents, tasks):
        self.context, self.store = context, store
        self.robots, self.documents, self.tasks = robot_systems, documents, tasks
        self._lock = asyncio.Lock()
        self._runner = None
        self._watcher = None
        self._current_task = None
        self._session = None
        self._pending_event = None
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

    def save(self, value):
        key = self._robot()
        identity = value.get('id') or 'machine_'+uuid4().hex
        if not IDENT.fullmatch(identity):
            fail('$.id','invalid_id','状态机标识无效')
        previous = next((m for m in self.list() if m['id'] == identity),None)
        if previous and previous['robot_system_id'] != key:
            fail('$.robot', 'ownership', '状态机不属于当前机器人')
        if previous and self.running() and self._session['machine_id'] == identity:
            fail('$.machine','running','当前状态机正在运行，不能覆盖定义')
        spec = validate(value.get('document'),self.definitions())
        return self.store.put('state_machine',identity,{'id':identity,'robot_system_id':key,'name':(str(value.get('name') or '未命名状态机'))[:80], 'revision':(previous['revision']+1 if previous else 1),'document':spec})

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

    async def _tree(self, definition_id, stage):
        if not definition_id: return 'SUCCEEDED'
        if self.context.state != 'READY':
            fail('$.system','system_not_ready','系统未就绪，不能执行状态动作')
        request = self.documents.definition_request(definition_id,'hsm_'+uuid4().hex)
        async with self.context.transition:
            task = await self.tasks.start_task(request,'hsm')
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
                self._persist(task_run_id=None,action=None)
                return state['state']
            await asyncio.sleep(.12)

    async def _cancel_tree(self):
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
        by_id={s['id']:s for s in spec['states']}
        path=self._path(self._leaf(spec['initial'],by_id),by_id)
        try:
            for name in path:
                result=await self._tree(by_id[name].get('entry'),'entry')
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
        definition_id=next((by_id[k].get('do') for k in reversed(self._session['path']) if by_id[k].get('do')),None)
        if not definition_id:return
        async def watch():
            try:
                result=await self._tree(definition_id,'do')
                if result=='SUCCEEDED':event='completed'
                elif result=='CANCELED':return
                else:event='failed'
                if self._session and self._session['status']=='RUNNING' and self._session['active']==leaf:
                    machine=self.get(self._session['machine_id'])
                    path=self._session['path']
                    if any(edge['event']==event and edge['source'] in path for edge in machine['document']['transitions']):
                        await self.event(event,{})
            except asyncio.CancelledError:
                return
            except Exception as exc:
                self._persist(status='UNKNOWN',error=str(exc))
        self._watcher=asyncio.create_task(watch())

    async def start(self,identity):
        async with self._lock:
            if self.running():fail('$.machine','running','已有状态机正在运行')
            machine=self.get(identity)
            spec=validate(machine['document'],self.definitions())
            if not self.robots.active() or self.context.state != 'READY' or self.context.engine.control.mode.value != 'STANDBY':
                fail('$.system','not_ready','需先应用机器人配置并启动系统，保持待命模式')
            if any(t['state'] in ACTIVE or t['state']=='UNKNOWN' or not t['stop_confirmed'] for t in self.tasks.list()):
                fail('$.task','task_busy','仍有任务在执行或停止结果未确认，不能开始新的状态机')
            sid='session_'+uuid4().hex
            self._stop_requested=False
            self._session={'id':sid,'machine_id':identity,'robot_system_id':self._robot(),'status':'ENTERING', 'active':None,'path':[], 'events':[], 'variables':spec.get('variables',{}),'task_run_id':None, 'action':None, 'error':None,'sequence':len(self.store.list('hsm_session'))+1}
            self._persist()
            self._runner=asyncio.create_task(self._enter(spec))
            return self.status()

    async def event(self,name,values):
        if self._pending_event and not self._pending_event.done():
            fail('$.event','event_busy','上一个状态事件仍在处理，请等待完成')
        if not self.running() or self._session['status'] != 'RUNNING':
            fail('$.machine','not_running','当前状态机不可接收事件')
        # Return receipt before lengthy action cancellation, entry and exit trees
        async def run():
            try:
                await self._process_event(name,values)
            except Exception as exc:
                if self._session and self._session['status'] == 'RUNNING':
                    self._persist(error=str(exc))
        self._pending_event = asyncio.create_task(run())
        return {'accepted':True,'session':self.status()}

    async def _process_event(self,name,values):
        if not isinstance(name,str) or not IDENT.fullmatch(name):
            fail('$.event','invalid_event','事件名称无效')
        async with self._lock:
            if self._stop_requested or not self.running() or self._session['status']!='RUNNING':
                fail('$.machine','not_running','当前没有可接收事件的状态机')
            machine=self.get(self._session['machine_id'])
            spec=machine['document']; by_id={s['id']:s for s in spec['states']}
            updated={**self._session['variables']}
            for k,v in values.items():
                if k not in updated or type(v) not in (str,int,float,bool,type(None)):
                    fail('$.variables','invalid_variable','只能更新状态机已声明的简单变量')
                updated[k]=v
            path=self._session['path']
            matching=next((e for key in reversed(path) for e in spec['transitions'] if e['source']==key and e['event']==name and self._guard(e,updated)),None)
            if not matching:
                fail('$.event','no_transition','当前状态无满足 Guard 的事件转换')
            current=self._session['active']; destination=self._leaf(matching['target'],by_id)
            target_path=self._path(destination,by_id)
            common=0
            while common<min(len(path),len(target_path)) and path[common]==target_path[common]:common+=1
            if common==len(path)==len(target_path):common-=1
            self._persist(status='TRANSITIONING',variables=updated)
            try:
                await self._cancel_tree()
                if self._stop_requested:return self.status()
                for state in reversed(path[common:]):
                    result=await self._tree(by_id[state].get('exit'),'exit')
                    if self._stop_requested:return self.status()
                    if result!='SUCCEEDED':raise RuntimeError('退出动作未成功')
                for state in target_path[common:]:
                    result=await self._tree(by_id[state].get('entry'),'entry')
                    if self._stop_requested:return self.status()
                    if result!='SUCCEEDED':raise RuntimeError('进入动作未成功')
                events=self._session['events'][-49:]+[{'event':name,'source':current,'target':destination}]
                self._persist(status='RUNNING',active=destination,path=target_path,events=events,action=None)
                await self._launch_do(by_id)
                return self.status()
            except Exception as exc:
                if not self._stop_requested:self._persist(status='UNKNOWN',error=str(exc))
                raise

    def request_stop(self):
        self._stop_requested = True
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
