"""Workflow dependency planning and isolated module lifecycle using the runtime process manager."""
import asyncio
import copy
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
from uuid import uuid4

from .configuration import encoded
from .errors import fail
from .models import RuntimeDescriptor
from .management import timestamp
from .runtime import LocalProcessManager


class Deployment:
    def __init__(self, store, robots, ros_tasks, documents, hsm):
        self.store, self.robots, self.ros, self.documents, self.hsm = store, robots, ros_tasks, documents, hsm
        self.root = store.root / 'deployment'
        self.root.mkdir(exist_ok=True)
        self.manager = LocalProcessManager(state_directory=self.root / 'processes', config_identity='robot-profile',
                                           stop_signal=signal.SIGINT)
        self.lock = asyncio.Lock()
        self.stopping = False
        self.monitor = None
        self.state = 'STOPPED'
        self.reason = ''
        self.robot_system_id = None
        self.progress = None

    def _progress(self, phase, *, reset=False, **changes):
        now = timestamp()
        if reset or not self.progress:
            self.progress = {'started_at':now, 'robot_system_id':self.robot_system_id,
                             'current':None, 'completed':0, 'total':0, 'deadline_at':None, 'health':None}
        self.progress.update(phase=phase, updated_at=now, **changes)

    @staticmethod
    def _deadline(seconds):
        return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

    def has_processes(self):
        return bool(self.manager.identities)

    def modules(self):
        return [v for v in self.store.list('subsystem_module') if v['robot_system_id'] == self.ros._robot()]

    def save(self, raw, *, catalog=None, persist=True):
        self.robots.require_stopped()
        value = copy.deepcopy(raw)
        value['id'] = value.get('id') or 'module_' + uuid4().hex
        from .configuration import identifier
        identifier(value['id'])
        value['robot_system_id'] = self.ros._robot()
        if any(v['id']==value['id'] and v['robot_system_id']!=value['robot_system_id'] for v in self.store.list('subsystem_module')):
            fail('$.id','ownership','启动模块不属于当前机器人')
        from .interface_sources import InterfaceWorkspaces
        InterfaceWorkspaces(self.store, self.ros._robot()).get(value.get('workspace_id',''))
        if value.get('kind') not in ('node', 'component', 'launch', 'process'):
            fail('$.kind','invalid_module','请选择节点、组件、程序或已有 launch')
        if not isinstance(value.get('name'),str) or not value['name'].strip():
            fail('$.name','name_required','请填写启动模块名称')
        for name in ('package','executable'):
            if value['kind'] not in ('process','component') and (not isinstance(value.get(name),str) or not re.fullmatch(r'[\w.\-]+',value[name])):
                fail('$.'+name,'invalid_module','请选择有效的包和可执行入口')
        if value['kind']=='component' and not re.fullmatch(r'[\w:]+',value.get('plugin','')):
            fail('$.plugin','plugin_required','请指定已注册的组件类名')
        for name in ('arguments','argv','dependencies','module_ids','parameter_files','remappings','provides'):
            if name in value and (not isinstance(value[name],list) or len(value[name])>128):
                fail('$.'+name,'invalid_module','启动配置列表无效')
        if value['kind']=='process' and (not value.get('argv') or any(not isinstance(v,str) or '\0' in v for v in value['argv'])):
            fail('$.argv','argv_required','请逐项填写程序及参数')
        if not isinstance(value.get('parameters',{}),dict): fail('$.parameters','invalid_module','参数应为对象')
        if not isinstance(value.get('launch_arguments',{}),dict):
            fail('$.launch_arguments','invalid_module','launch 启动参数应为对象')
        for endpoint in value.get('provides',[]):
            if not isinstance(endpoint,dict) or endpoint.get('role','publisher') not in ('publisher','subscriber') or endpoint.get('kind') not in ('action','service','topic') or not re.fullmatch(r'/[\w/]+',endpoint.get('name','')):
                fail('$.provides','invalid_endpoint','请填写模块提供的通信接口')
        if not isinstance(value.get('path_fields',[]),list) or any(not isinstance(p,str) or not re.fullmatch(r'(?:parameters|launch_arguments|arguments|argv)(?:\.(?:[A-Za-z_]\w*|[0-9]+))+',p) for p in value.get('path_fields',[])):
            fail('$.path_fields','invalid_paths','文件字段需要明确指向参数或程序参数中的路径')
        from .module_health import validate_checks
        try: validate_checks(value.get('health_checks', []))
        except (ValueError, TypeError, AttributeError) as error: fail('$.health_checks', 'invalid_health_check', str(error))
        value.setdefault('health_interval_s', 5)
        if type(value['health_interval_s']) not in (int,float) or not 1<=value['health_interval_s']<=60:
            fail('$.health_interval_s','invalid_interval','健康检查间隔应在 1 至 60 秒')
        value.setdefault('dependencies',[]); value.setdefault('provides',[])
        value.setdefault('startup_timeout_s',60); value.setdefault('stop_timeout_s',15)
        if any(type(value[k]) not in (int,float) or not 1<=value[k]<=300 for k in ('startup_timeout_s','stop_timeout_s')):
            fail('$.timeout','invalid_timeout','启动和停止等待需在 1 至 300 秒之间')
        proposed = dict(catalog) if catalog is not None else {v['id']:v for v in self.modules()}
        proposed[value['id']]=value
        self.order([value['id']],proposed)
        encoded(value)
        return self.store.put('subsystem_module',value['id'],value) if persist else value

    def manifest(self, workspace_id, content=None):
        from .interface_sources import InterfaceWorkspaces
        workspace=InterfaceWorkspaces(self.store,self.ros._robot()).get(workspace_id)
        root=Path(workspace.get('path') or '.')
        from .profile_references import references
        if content is None:
            rows=copy.deepcopy([v for v in self.modules() if v['workspace_id']==workspace_id])
            for row in rows:
                row.pop('robot_system_id',None);row.pop('workspace_id',None)
            for container,key,_,_ in references({'subsystem_module':rows}):
                path=Path(container[key])
                if path.is_absolute() and path.is_relative_to(root):container[key]='workspace-path:'+str(path.relative_to(root))
            return {'format':'atil.subsystem','modules':rows}
        self.robots.require_stopped()
        if not isinstance(content,dict) or content.get('format')!='atil.subsystem' or not isinstance(content.get('modules'),list) or len(content['modules'])>128:
            fail('$.manifest','invalid_manifest','接入声明需要 atil.subsystem 格式和 modules 列表')
        rows=copy.deepcopy(content['modules']);identities={}
        from .configuration import identifier
        for row in rows:
            if not isinstance(row,dict):fail('$.modules','invalid_module','启动模块应为对象')
            identifier(row.get('id'))
            if not isinstance(row.get('dependencies',[]),list) or any(not isinstance(v,str) for v in row.get('dependencies',[])):
                fail('$.dependencies','invalid_dependencies','模块依赖应为标识列表')
            if row['id'] in identities:fail('$.modules','duplicate_id','接入声明包含重复模块标识')
            identities[row['id']]='module_'+hashlib.sha256((workspace_id+':'+row['id']).encode()).hexdigest()[:24]
        existing={v['id']:v for v in self.modules()}
        # Reimport the same declaration updates its entries; local IDs remain stable
        for row in rows:
            source=row['id']; row['id']=next((v['id'] for v in existing.values() if v.get('workspace_id')==workspace_id and v.get('manifest_key')==source), source if existing.get(source,{}).get('workspace_id')==workspace_id else identities[source])
            identities[source]=row['id'];row['manifest_key']=source;row['workspace_id']=workspace_id
        for row in rows:row['dependencies']=[identities.get(key,key) for key in row.get('dependencies',[])]
        for container,key,_,_ in references({'subsystem_module':rows}):
            value=container[key]
            if value.startswith('workspace-path:'):
                path=(root/value[15:]).resolve()
                if not path.is_relative_to(root.resolve()):fail('$.paths','invalid_path','工作区资源不能越出所选工作区')
                container[key]=str(path)
        proposed={**existing,**{v['id']:v for v in rows}}
        prepared=[self.save(row,catalog=proposed,persist=False) for row in rows]
        with self.store.db:
            self.store.db.executemany('INSERT OR REPLACE INTO documents VALUES (?,?,?)', [('subsystem_module',v['id'],encoded(v)) for v in prepared])
        try:
            from .robot_profiles import RobotProfiles
            RobotProfiles(self.store).flush(self.ros._robot())
        except BaseException:
            with self.store.db:
                for value in prepared:
                    if value['id'] in existing:
                        self.store.db.execute('INSERT OR REPLACE INTO documents VALUES (?,?,?)',('subsystem_module',value['id'],encoded(existing[value['id']])))
                    else:
                        self.store.db.execute('DELETE FROM documents WHERE kind=? AND id=?',('subsystem_module',value['id']))
            raise
        return {'modules':prepared}

    @staticmethod
    def order(seeds, modules):
        result, visiting = [], set()
        def visit(key):
            if key in result: return
            if key in visiting: fail('$.dependencies','dependency_cycle','模块启动依赖形成环')
            if key not in modules: fail('$.dependencies','missing_module','启动模块不存在：'+key)
            visiting.add(key)
            for dep in modules[key].get('dependencies',[]): visit(dep)
            visiting.remove(key); result.append(key)
        for key in seeds: visit(key)
        return result

    def tasks_for(self, kind, reference):
        tasks, visited = [], set()
        def task(identity):
            if identity in visited:return
            visited.add(identity)
            value = self.ros.get(identity); tasks.append(value)
            for dep in value.get('task_dependencies',[]): task(dep)
        def tree(reference):
            category = 'tree_draft' if reference.startswith('draft_') else 'tree_definition'
            record = self.store.get(category, reference); self.documents._check_ownership(record)
            frozen = {v['id']:v for v in record.get('ros_tasks',[])}
            for subtree in record['document']['trees'].values():
                for node in subtree['nodes'].values():
                    registration = node['registration_id']
                    if registration.startswith('RosTask_'):
                        identity = registration[8:]
                        if identity in frozen and identity not in visited:
                            visited.add(identity); tasks.append(frozen[identity])
                        else: task(identity)
        if kind == 'task': task(reference)
        elif kind == 'tree': tree(reference)
        elif kind == 'flow':
            machine = self.hsm.get(reference)
            for state in machine['document']['states']:
                for phase in ('entry','do','exit'):
                    value = state.get(phase)
                    if value:
                        if value.startswith('ros:'): task(value[4:])
                        else: tree(value)
        else: fail('$.kind','invalid_workflow','请选择状态流程、行为树或任务')
        return tasks

    def plan(self, kind, reference):
        tasks = self.tasks_for(kind, reference)
        return {'kind':kind,'reference':reference,**self.plan_tasks(tasks)}

    def readiness(self, kind, reference, inputs=None):
        """Explain saved configuration gaps without loading environments or starting devices."""
        from .errors import ContractValidationError
        design, execution, notes = [], [], []
        target = ({'page':'editor','machineId':reference} if kind=='flow' else
                  {'page':'editor','treeId':reference} if kind=='tree' else
                  {'page':'system','taskId':reference,'section':'message'})

        def task_location(identity, path, code=''):
            field=path.removeprefix('$.')
            section='message'
            if field=='interface' or code in ('missing_endpoint','missing_binding'):
                section,field='communication','interface'
            elif field.split('.')[0] in ('workspace_ids','ros_type','schema_id','kind','name'):
                section='interfaces'
            elif field.split('.')[0] in ('execution_workspace_id','module_ids','startup_policy'):
                section='provider'
            elif field.split('.')[0] in ('inputs','outputs','input_bindings','output_bindings'):
                section='ports'
            return {'page':'system','taskId':identity,'section':section,'field':field}

        def errors(error, destination, location):
            if isinstance(error, ContractValidationError):
                for issue in error.issues:
                    parts=issue.path.split('.')
                    specific=dict(location)
                    if location.get('machineId') and len(parts)>2 and parts[1]=='states':
                        specific.update(stateId=parts[2],field='.'.join(parts[3:]))
                    elif location.get('taskId'):
                        specific=task_location(location['taskId'],issue.path,issue.code)
                    elif location.get('treeId'):
                        specific['section']='diagnostics'
                    elif location.get('section')=='environment' and issue.path in ('$.setup','$.python'):
                        specific['field']=parts[1]
                    destination.append({'code':issue.code,'reason':issue.reason,'path':issue.path,'target':specific})
            else:
                destination.append({'code':'configuration_unavailable','reason':str(error),'target':location})

        try:
            if kind=='flow':
                checked=self.hsm.check(reference)
                for item in checked.get('diagnostics',[]):
                    specific=(task_location(item['task_id'],item.get('path') or '') if item.get('task_id') else
                              {**target,'stateId':item.get('state_id'),'field':'.'.join(filter(None,[item.get('phase'),item.get('path')]))})
                    design.append({'code':'workflow_not_ready','reason':item.get('message') or item.get('reason'),
                                   'path':item.get('path'), 'target':specific})
                if checked['valid']:self.preflight(kind,reference,inputs,flow_check=checked)
            else:
                self.preflight(kind,reference,inputs)
        except (ContractValidationError, OSError, ValueError) as error:
            errors(error,design,target)
        plan={'tasks':[],'modules':[],'issues':[]}
        tasks=[]
        try:
            tasks=self.tasks_for(kind,reference)
            plan=self.plan_tasks(tasks)
        except (ContractValidationError, OSError, ValueError) as error:
            errors(error,execution,target)
        for item in plan['issues']:
            execution.append({**item,'target':{'page':'system','taskId':item['task_id'],'section':'provider'}})
        required={module['workspace_id'] for module in plan['modules']}
        for task in tasks:
            try:required.add(self.ros.environments.workspace_for(task))
            except (ContractValidationError, OSError, ValueError) as error:
                errors(error,execution,{'page':'system','taskId':task['id'],'section':'provider'})
        unresolved=[record for record in self.store.list('ros_operation')
                    if record.get('definition',{}).get('robot_system_id')==self.ros._robot()
                    and record.get('snapshot',{}).get('state') not in ('ACCEPTED','RUNNING','CANCELING')
                    and (record.get('snapshot',{}).get('state')=='UNKNOWN' or record.get('snapshot',{}).get('stop_state')=='UNCONFIRMED')]
        for run in sorted({record['task_run_id'] for record in unresolved}):
            execution.append({'code':'stop_unconfirmed','reason':'仍有操作结果或设备停止状态需要核对，请在运行台完成停止核对',
                              'target':{'page':'runtime','section':'recovery','runId':run}})
        environments=[]
        for workspace in sorted(required):
            location={'page':'overview','workspaceId':workspace,'section':'environment'}
            try:
                state=self.ros.environments.status(workspace)
                loaded=state['loaded']
                saved=state.get('active') or {}
                config=(self.ros.environments.snapshot(workspace_id=workspace) if loaded else
                        self.ros.environments._configuration(workspace,saved.get('python',''),saved.get('setup','')))
                environments.append({'workspace_id':workspace,'name':config.get('name',workspace),
                                     'configured':True,'loaded':loaded})
                if not loaded:
                    if self.has_processes():
                        execution.append({'code':'environment_busy','reason':'执行环境需要重新加载，请先停止子系统',
                                          'target':location})
                    else:
                        notes.append({'reason':'开始运行时将检查并加载执行环境','name':config.get('name',workspace),'target':location})
            except (ContractValidationError, OSError, ValueError) as error:
                environments.append({'workspace_id':workspace,'configured':False})
                errors(error,execution,location)
        return {'kind':kind,'reference':reference,'offline_ready':not design,
                'prepare_ready':not design and not execution,'design_issues':design,'execution_issues':execution,
                'execution_notes':notes,'environments':environments,'tasks':plan['tasks'],'modules':plan['modules']}

    def preflight(self, kind, reference, inputs=None, *, flow_check=None):
        """Validate the requested workflow and supplied inputs before starting modules."""
        from .errors import ContractValidationError, ValidationIssue
        references = set()
        if kind == 'task':
            from .ros_tasks import prepared_task
            if inputs is not None and not isinstance(inputs, dict):
                fail('$.inputs', 'invalid_inputs', '任务输入应为对象')
            task = self.ros.freeze(reference)
            prepared_task(task, inputs, self.ros.validate_structure(task))
        elif kind == 'flow':
            checked = flow_check if flow_check is not None else self.hsm.check(reference)
            if not checked['valid']:
                raise ContractValidationError([ValidationIssue(
                    path='$.states.' + item.get('state_id', '') + '.' + item.get('phase', '') + '.' + item.get('path', ''),
                    code='workflow_not_ready', reason=item['message']) for item in checked['diagnostics']])
            for state in self.hsm.get(reference)['document']['states']:
                references.update(value for phase in ('entry', 'do', 'exit')
                                  if (value := state.get(phase)) and not value.startswith('ros:'))
        elif kind == 'tree':
            references.add(reference)
        else:
            fail('$.kind', 'invalid_workflow', '请选择状态流程、行为树或任务')
        for identity in sorted(references):
            draft = identity.startswith('draft_')
            record = self.store.get('tree_draft' if draft else 'tree_definition', identity)
            self.documents._check_ownership(record)
            if record.get('archived'):
                fail('$.behavior', 'behavior_deleted', '行为树已删除')
            if self.documents.requires_system(record['document']):
                snapshot = record.get('base_snapshot_id' if draft else 'system_snapshot_id')
                if snapshot != self.documents.context.snapshot_id:
                    fail('$.behavior', 'snapshot_conflict', '系统配置已改变，请重新检查行为中的能力绑定')
            frozen = record.get('ros_tasks')
            with self.documents.frozen_ros(frozen) if frozen is not None else nullcontext():
                checked = self.documents.validate_tree(record['document'],
                    record.get('manifest', {}).get('kind', record.get('policy', 'general')),
                    record.get('parameters'), engine=True)
            if not checked['valid']:
                raise ContractValidationError([ValidationIssue(
                    path='$.behavior.' + identity + '.' + str(item.get('port') or ''),
                    code=item.get('code', 'behavior_incomplete'), reason=item['reason'])
                    for item in checked['diagnostics'] if item.get('severity', 'error') == 'error'])
        return references

    def plan_tasks(self, tasks):
        self.ros.validate_task_workspaces(tasks)
        modules = {v['id']:v for v in self.modules()}
        seeds, issues = [], []
        for task in tasks:
            selected = [] if task.get('startup_policy')=='external' else list(task.get('module_ids',[]))
            if task.get('kind') == 'compute':
                seeds.extend(selected); continue
            if not selected and task.get('startup_policy')!='external':
                endpoint_kind=task['kind'] if task['kind'] in ('action','service') else 'topic'
                providers = [m for m in modules.values() if m['workspace_id'] in task.get('workspace_ids',[]) and
                             any(e['name']==task.get('interface') and e['kind']==endpoint_kind and
                                 (endpoint_kind!='topic' or e.get('role','publisher')==('publisher' if task['kind']=='subscribe_wait' else 'subscriber')) and
                                 (not e.get('type') or e['type']==task.get('ros_type')) for e in m.get('provides',[]))]
                if len(providers)==1: selected=[providers[0]['id']]
                else:
                    issues.append({'task_id':task['id'],'reason':'请为任务选择启动模块或明确使用外部已启动的接口：'+task['name']})
            seeds.extend(selected)
        order = self.order(seeds,modules)
        return {'tasks':[{'id':v['id'],'name':v['name']} for v in tasks],
                'modules':[modules[k] for k in order], 'issues':issues,'ready':not issues}

    async def status(self):
        selected = self.robots.selected_id()
        current = self.robot_system_id in (None, selected)
        rows = []
        for record in self.store.list('deployment_module'):
            if record.get('robot_system_id') != selected:continue
            if record['id'] not in self.manager.identities and (not current or self.state=='STOPPED'):continue
            measured = await self.manager.status(record['id'],RuntimeDescriptor(**record['descriptor']))
            rows.append({**record,'process':measured})
        return {'state':self.state if current else 'STOPPED','reason':self.reason if current else '',
                'robot_system_id':selected,'progress':copy.deepcopy(self.progress) if current else None,'modules':rows}

    async def require_ready(self, kind, reference):
        tasks=self.tasks_for(kind,reference)
        await self.require_tasks_ready(tasks)
        for module in self.plan_tasks(tasks)['modules']:
            if module.get('oneshot'):continue
            health=await self.probe(module)
            if not health['ready']:fail('$.modules','module_unhealthy',module['name']+' · '+'、'.join(health['missing']))

    async def require_tasks_ready(self, tasks):
        if self.stopping:fail('$.modules','deployment_stopping','子系统正在停止，请重新准备后再运行')
        plan=self.plan_tasks(tasks)
        if plan['issues']:fail('$.modules','module_binding_required',plan['issues'][0]['reason'])
        for module in plan['modules']:
            record=next((v for v in self.store.list('deployment_module') if v['id']==module['id']),None)
            if not record or record.get('robot_system_id')!=self.ros._robot() or record.get('state')!='READY' or self.state!='READY' or self.robot_system_id!=self.ros._robot():
                fail('$.modules','modules_not_prepared','请先在运行台准备当前流程所需子系统')
            if not module.get('oneshot') and not (await self.manager.status(module['id'],RuntimeDescriptor(**record['descriptor'])))['running']:
                fail('$.modules','module_not_running','启动模块已退出：'+module['name'])


    def descriptor(self, module, config):
        directory = self.root / self.ros._robot(); directory.mkdir(exist_ok=True)
        path = directory / (module['id']+'.json')
        path.write_text(encoded({**module,'python':config['python']}))
        worker = Path(__file__).with_name('module_worker.py')
        # A clean subprocess owns this workspace's overlay, interpreter and ROS domain
        env_keys = ['AMENT_PREFIX_PATH','CMAKE_PREFIX_PATH','COLCON_PREFIX_PATH','PYTHONPATH','PYTHONHOME','VIRTUAL_ENV','LD_LIBRARY_PATH']
        argv = ['env', *['-u'+v for v in env_keys], 'ROS_LOG_DIR='+str(self.root/'ros_logs'), 'bash','--noprofile','--norc','-c',
                'source "$1" >/dev/null && export ROS_DOMAIN_ID="$2" && exec "$3" -u "$4" "$5"',
                'atil-module',config['setup'],str(self.ros.connection()['domain_id']),config['python'],str(worker),str(path)]
        return RuntimeDescriptor(manager='local_process',target=module['id'],argv=argv,health_check='ros_graph',
                                 dependencies=module.get('dependencies',[]),start_timeout_s=module['startup_timeout_s'],stop_timeout_s=module['stop_timeout_s'])

    async def prepare(self, kind, reference, confirmed, *, inputs=None):
        if not confirmed: fail('$.safety','confirmation_required','请确认设备环境后启动所需子系统')
        async with self.lock:
            if self.hsm.running() or any(v['state'] in ('ACCEPTED','RUNNING','CANCELING','UNKNOWN') or not v['stop_confirmed'] for v in self.robots.context.tasks.list()):
                fail('$.workflow','workflow_busy','请先停止正在运行的流程并确认停止结果')
            self.state='PREPARING'; self.reason=''
            self.robot_system_id=self.ros._robot()
            self._progress('checking',reset=True,kind=kind,reference=reference)
            started=[]
            try:
                references = self.preflight(kind, reference, inputs)
                plan = self.plan(kind,reference)
                if plan['issues']: fail('$.modules','module_binding_required',plan['issues'][0]['reason'])
                configs={}
                # Check every environment and module before starting the first process
                task_values=self.tasks_for(kind,reference)
                workspaces={m['workspace_id'] for m in plan['modules']}
                for task in task_values:
                    workspaces.add(self.ros.environments.workspace_for(task))
                environments={identity:self.ros.environments.status(identity) for identity in sorted(workspaces)}
                if self.has_processes() and any(not state['loaded'] for state in environments.values()):
                    fail('$.environment','environment_busy','执行环境需要重新加载，请先停止子系统')
                for index, identity in enumerate(sorted(workspaces)):
                    if self.stopping:raise RuntimeError('启动已取消')
                    saved=environments[identity].get('active') or {}
                    workspace_name=self.store.get('interface_workspace',identity)['name']
                    self._progress('environment',current={'id':identity,'name':workspace_name,'kind':'workspace'},
                                   completed=index,total=len(workspaces),deadline_at=None,health=None)
                    if not environments[identity]['loaded']:
                        result=await asyncio.to_thread(self.ros.environments.manage,self.ros._robot(),'load',identity,
                                                      saved.get('python',''),saved.get('setup',''))
                        if not result['loaded']:fail('$.environment','environment_not_ready',result['report']['reason'])
                    configs[identity]=self.ros.environments.snapshot(workspace_id=identity)
                    if self.stopping:raise RuntimeError('启动已取消')
                    self._progress('environment',completed=index+1)
                for index, module in enumerate(plan['modules']):
                    if self.stopping:raise RuntimeError('启动已取消')
                    self._progress('probing',current={'id':module['id'],'name':module['name'],'kind':'module'},
                                   completed=index,total=len(plan['modules']),deadline_at=None,health=None)
                    await asyncio.to_thread(self.ros.environments.call,configs[module['workspace_id']],{'op':'module_probe','module':module})
                    if self.stopping:raise RuntimeError('启动已取消')
                    self._progress('probing',completed=index+1)
                for index, task in enumerate(task_values):
                    if self.stopping:raise RuntimeError('启动已取消')
                    self._progress('checking',current={'id':task['id'],'name':task['name'],'kind':'task'},
                                   completed=index,total=len(task_values),deadline_at=None,health=None)
                    self.ros.verify_support(task)
                    self._progress('checking',completed=index+1)
                for index, identity in enumerate(sorted(references)):
                    if self.stopping:raise RuntimeError('启动已取消')
                    if not identity.startswith('draft_'):
                        self._progress('checking',current={'id':identity,'name':identity,'kind':'tree'},
                                       completed=index,total=len(references),deadline_at=None,health=None)
                        self.documents.definition_request(identity, 'deployment_preflight')
                        self._progress('checking',completed=index+1)
                for task in task_values:
                    if self.stopping:raise RuntimeError('启动已取消')
                    if task.get('kind')=='compute' or task.get('stop_observation'):
                        config=self.ros.environments.snapshot(task)
                        self._progress('environment',current={'id':config['workspace_id'],
                                       'name':config.get('name',task['name']),'kind':'workspace'},
                                       completed=0,total=1,deadline_at=None,health=None)
                        await asyncio.to_thread(self.ros.environments.computer,config,self.ros.connection()['domain_id'])
                        if self.stopping:raise RuntimeError('启动已取消')
                        self._progress('environment',completed=1)
                if self.stopping:raise RuntimeError('启动已取消')
                self.state='STARTING'
                for index, module in enumerate(plan['modules']):
                    if self.stopping: raise RuntimeError('启动已取消')
                    identity=module['id']; config=configs[module['workspace_id']]
                    current={'id':identity,'name':module['name'],'kind':'module'}
                    deadline_at=self._deadline(module['startup_timeout_s'])
                    self._progress('start',current=current,completed=index,total=len(plan['modules']),deadline_at=deadline_at,health=None)
                    records={v['id']:v for v in self.store.list('deployment_module')}
                    dependencies={key:records[key].get('token') for key in module.get('dependencies',[])}
                    fingerprint=hashlib.sha256(encoded({'module':module,'environment':config,'dependencies':dependencies}).encode()).hexdigest()
                    previous=records.get(identity)
                    if previous and previous.get('state')=='READY' and previous.get('fingerprint')==fingerprint:
                        if module.get('oneshot') or (await self.manager.status(identity,RuntimeDescriptor(**previous['descriptor'])))['running']:
                            self._progress('start',completed=index+1,deadline_at=None,health=previous.get('health'))
                            continue
                    if identity in self.manager.identities:
                        fail('$.modules','module_config_changed','已启动模块的配置或依赖发生变化，请先停止子系统：'+module['name'])
                    descriptor=self.descriptor(module,config)
                    prior=identity in self.manager.identities
                    started_at=timestamp()
                    await self.manager.start(identity,descriptor)
                    deadline_at=self._deadline(module['startup_timeout_s'])
                    self._progress('wait',deadline_at=deadline_at)
                    if not prior: started.append(identity)
                    self.store.put('deployment_module',identity,{'id':identity,'name':module['name'],'robot_system_id':self.ros._robot(),'descriptor':descriptor.model_dump(mode='json'),'state':'STARTING','fingerprint':fingerprint,'token':uuid4().hex,
                        'started_at':started_at,'updated_at':timestamp(),'ready_at':None,'stopped_at':None,'deadline_at':deadline_at})
                    deadline=asyncio.get_running_loop().time()+module['startup_timeout_s']
                    while True:
                        if self.stopping: raise RuntimeError('启动已取消')
                        measured=await self.manager.status(identity,descriptor)
                        if not measured['running']:
                            process=self.manager.processes.get(identity)
                            if module.get('oneshot') and process and process.returncode==0:
                                await self.manager.stop(identity,descriptor); ready={'ready':True,'missing':[],'level':'oneshot'}; break
                            raise RuntimeError(module['name']+' 已退出，请查看启动日志')
                        ready=await self.probe(module, config)
                        row=self.store.get('deployment_module',identity)
                        self.store.put('deployment_module',identity,{**row,'health':ready,'updated_at':timestamp()})
                        self._progress('wait',health=ready)
                        if ready['ready']:break
                        if asyncio.get_running_loop().time()>=deadline:raise RuntimeError(module['name']+' 等待接口就绪超时')
                        await asyncio.sleep(.2)
                    row=self.store.get('deployment_module',identity);self.store.put('deployment_module',identity,{**row,'state':'READY','health':ready,'updated_at':timestamp(),'ready_at':timestamp(),'deadline_at':None})
                    self._progress('start',completed=index+1,deadline_at=None,health=ready)
                self.state='READY'
                self._progress('ready',current=None,completed=len(plan['modules']),total=len(plan['modules']),deadline_at=None,health=None)
                if self.monitor is None or self.monitor.done():self.monitor=asyncio.create_task(self.watch())
                return {**plan,**await self.status()}
            except BaseException as error:
                self.state='STOPPING' if self.stopping else 'FAILED';self.reason=str(error)
                self._progress('cancel' if self.stopping else 'failed',deadline_at=None,health={'ready':False,'reason':str(error)})
                for identity in reversed(started):
                    try:
                        row=self.store.get('deployment_module',identity)
                        await self.manager.stop(identity,RuntimeDescriptor(**row['descriptor']))
                        self.store.put('deployment_module',identity,{**row,'state':'STOPPED','updated_at':timestamp(),'stopped_at':timestamp(),'deadline_at':None})
                    except Exception: self.reason+='；部分进程停止未确认'
                if not self.has_processes():await asyncio.to_thread(self.ros.environments.close_computers)
                raise

    async def probe(self, module, config=None):
        if not module.get('provides') and not module.get('health_checks'):
            return {'ready':not module.get('oneshot'), 'missing':[], 'level':'process'}
        config = config or self.ros.environments.snapshot(workspace_id=module['workspace_id'])
        return await asyncio.to_thread(self.ros.environments.call, config, {'op':'ready',
            'endpoints':module.get('provides',[]), 'health_checks':module.get('health_checks',[]),
            'domain_id':self.ros.connection()['domain_id']})

    async def watch(self):
        deadlines = {}
        while self.state=='READY' and not self.stopping:
            modules = {v['id']:v for v in self.modules()}
            for record in self.store.list('deployment_module'):
                identity = record['id']
                if identity not in self.manager.identities or identity not in modules:continue
                try:
                    if not (await self.manager.status(identity,RuntimeDescriptor(**record['descriptor'])))['running']:
                        raise RuntimeError('模块进程已退出')
                    now=asyncio.get_running_loop().time()
                    if now < deadlines.get(identity,0):continue
                    module=modules[identity]
                    health=await self.probe(module)
                    if self.stopping or self.state!='READY':return
                    deadlines[identity]=now+module.get('health_interval_s',5)
                    self.store.put('deployment_module',identity,{**record,'health':health,'updated_at':timestamp()})
                    if not health['ready']:raise RuntimeError('健康条件失效：'+'、'.join(health['missing']))
                except Exception as error:
                    self.state='FAILED';self.reason=record['name']+' · '+str(error)
                    self._progress('failed',current={'id':identity,'name':record['name'],'kind':'module'},
                                   deadline_at=None,health={'ready':False,'reason':str(error)})
                    self.store.put('deployment_module',identity,{**record,'state':'FAILED','updated_at':timestamp(),'health':{'ready':False,'reason':str(error)}})
                    if self.hsm.running():self.hsm.request_stop()
                    await self.robots.context.tasks.stop_all()
                    return
            await asyncio.sleep(.5)

    async def stop(self):
        self.stopping=True
        self.robot_system_id=self.robots.selected_id()
        self.state='STOPPING';self.reason=''
        previous=self.progress or {}
        self._progress('cancel',reset=True,kind=previous.get('kind'),reference=previous.get('reference'))
        async with self.lock:
            try:
                if self.hsm.running():
                    session=self.hsm.status()
                    self._progress('cancel',current={'id':session['id'],'name':session.get('definition',{}).get('name') or session.get('machine_id',session['id']),'kind':'flow'},
                                   deadline_at=None)
                    await self.hsm.stop()
                self._progress('confirm_stop',current=None,deadline_at=None)
                await self.robots.context.tasks.stop_all()
                if any(v.get('definition',{}).get('robot_system_id',self.robot_system_id)==self.robot_system_id and v['snapshot'].get('stop_state')=='UNCONFIRMED'
                       for v in self.store.list('ros_operation')):
                    fail('$.modules','stop_unconfirmed','动作停止未确认，保留通信模块以继续确认停止')
            except BaseException as error:
                self.state='UNKNOWN';self.reason=str(error)
                self._progress('confirm_stop',deadline_at=None,health={'ready':False,'reason':str(error)})
                raise
            errors=[]
            records=[record for record in reversed(self.store.list('deployment_module'))
                     if record.get('robot_system_id')==self.robot_system_id and
                     (record['id'] in self.manager.identities or record.get('state')!='STOPPED')]
            completed=0
            for record in records:
                deadline_at=self._deadline(record['descriptor'].get('stop_timeout_s',15))
                self._progress('stop',current={'id':record['id'],'name':record['name'],'kind':'module'},
                               completed=completed,total=len(records),deadline_at=deadline_at,health=None)
                self.store.put('deployment_module',record['id'],{**record,'state':'STOPPING','updated_at':timestamp(),'deadline_at':deadline_at})
                try:
                    if record['id'] in self.manager.identities:
                        await self.manager.stop(record['id'],RuntimeDescriptor(**record['descriptor']))
                    self.store.put('deployment_module',record['id'],{**record,'state':'STOPPED','updated_at':timestamp(),'stopped_at':timestamp(),'deadline_at':None})
                    completed+=1
                    self._progress('stop',completed=completed,deadline_at=None)
                except Exception as error:
                    errors.append(str(error))
                    self.store.put('deployment_module',record['id'],{**record,'state':'UNKNOWN','updated_at':timestamp(),
                        'deadline_at':None,'health':{'ready':False,'reason':str(error)}})
            self.state='UNKNOWN' if errors else 'STOPPED';self.reason='；'.join(errors)
            self._progress('confirm_stop' if errors else 'stopped',current=None,deadline_at=None,
                           health={'ready':False,'reason':self.reason} if errors else None)
            if errors:fail('$.modules','stop_unconfirmed',self.reason)
            await asyncio.to_thread(self.ros.environments.close_computers)
            return await self.status()

    def logs(self, identity):
        if identity not in {v['id'] for v in self.modules()}:fail('$.module','unknown_module','模块不存在')
        path=self.root/'processes'/(identity+'.log')
        if not path.exists():return {'text':''}
        with path.open('rb') as stream:
            stream.seek(max(0,path.stat().st_size-65536));data=stream.read()
        return {'text':data.decode(errors='replace')}
