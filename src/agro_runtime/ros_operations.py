"""ROS 能力操作沿用控制代次、资源隔离和冻结任务依赖"""
import asyncio
import copy
import hashlib
import json
from pathlib import Path
import threading
from uuid import uuid4

from .errors import ContractValidationError, fail, parse
from .models import ResourceRequirement, StopState, TypeDescriptor
from .control import RobotMode
from .registry import _values
from .ros_tasks import prepared_task

ACTIVE = {'ACCEPTED', 'RUNNING', 'CANCELING'}


class RosOperations:
    def __init__(self, context, store, tasks, ros_tasks):
        self.context, self.store, self.tasks, self.ros_tasks = context, store, tasks, ros_tasks
        self.workers = {}
        self.stops = {}
        self._requests = {}
        self._closed = False
        for record in store.list('ros_operation'):
            self._requests[record['request_id']] = record['id']
            snapshot = record['snapshot']
            if snapshot['state'] in ACTIVE:
                snapshot.update(state='UNKNOWN', stop_state='UNCONFIRMED',
                                error={'code':'restart_requires_review', 'reason':'后台重新启动，需要核对 ROS 设备停止状态', 'retryable':False})
                store.put('ros_operation', record['id'], record)
            if snapshot['stop_state'] == 'UNCONFIRMED':
                context.engine.control.resources.restore([(record['id'],record['definition'].get('resources', []))])

    def snapshot(self, identity):
        record=self.store.get('ros_operation', identity)
        return {**copy.deepcopy(record['snapshot']), 'previous_session':record.get('executor_session') != self.ros_tasks.environments.session_id}

    def operations(self, task_id):
        return [{**self.snapshot(r['id']), 'task_run_id':task_id, 'node_id':r['node_id'],
                 'capability_id':'ros.'+r['ros_task_id'], 'input':r['input'], 'parameters':{}}
                for r in self.store.list('ros_operation') if r['task_run_id']==task_id]

    def _update(self, identity, **changes):
        record = self.store.get('ros_operation', identity)
        record['snapshot'].update(changes)
        self.store.put('ros_operation', identity, record)
        return record['snapshot']

    async def submit(self, request):
        task_id = request['task_run_id']
        task = self.tasks.store.status(task_id)
        if task['state'] != 'RUNNING':
            fail('$.task_run_id','task_dispatch_stopped','任务已停止派发')
        frozen = self.tasks.store.snapshot(task_id).get('definition', {})
        mapping = next((n for n in frozen.get('node_mapping', []) if n.get('operation_node_id') == request['node_id']), None)
        node = next((t['nodes'][mapping['editor_id']] for t in frozen.get('document',{}).get('trees',{}).values()
                     if mapping and mapping['editor_id'] in t['nodes']), None)
        definition = next((t for t in frozen.get('ros_tasks',[]) if t['id']==request['ros_task_id']), None)
        if not definition or not node or node['registration_id']!='RosTask_'+request['ros_task_id']:
            fail('$.node_id','published_node_mismatch','ROS 操作与冻结节点不一致')
        if request['capability_id'] != 'ros.'+definition['id'] or request['backend_instance'] != definition['id'] or request.get('parameters'):
            fail('$.ros_task_id','published_node_mismatch','ROS 操作与冻结能力不一致')
        return await self.start(definition, request['input'], request['control'],
                                task_id=task_id, node_id=request['node_id'], request_id=request['request_id'])

    async def start(self, definition, inputs, token, *, task_id, node_id, request_id):
        if self._closed:fail('$.ros','executor_closed','ROS 执行器已关闭')
        fingerprint = hashlib.sha256(json.dumps([definition,inputs,token,task_id,node_id],sort_keys=True).encode()).hexdigest()
        previous = self._requests.get(request_id)
        if previous:
            record = self.store.get('ros_operation', previous)
            if record['fingerprint'] != fingerprint:
                fail('$.request_id','request_id_conflict','同一请求标识不能对应不同操作')
            return self.snapshot(previous)
        resources = [parse(ResourceRequirement, r) for r in definition.get('resources', [])]
        control = self.context.engine.control
        control.validate_control(token, resources)
        _values(inputs, {name:parse(TypeDescriptor,spec) for name,spec in definition.get('inputs',{}).items()}, '$.inputs',
                now=control.clock.now(),clock_domain=control.clock.clock_domain)
        prepared_task(definition, inputs)
        identity = 'rosop_'+uuid4().hex
        control.resources.try_acquire(identity, resources)
        record = {'id':identity,'executor_session':self.ros_tasks.environments.session_id,'request_id':request_id,'fingerprint':fingerprint,'task_run_id':task_id,
                  'node_id':node_id,'ros_task_id':definition['id'],'definition':copy.deepcopy(definition),'input':copy.deepcopy(inputs),
                  'snapshot':{'operation_id':identity,'state':'ACCEPTED','stop_state':'UNCONFIRMED',
                              'cancel_requested':False,'cancel_accepted':False,'feedback':{},'result':None,'error':None}}
        try:
            self.store.put('ros_operation', identity, record)
        except Exception:
            control.resources.settle(identity, resources, StopState.NOT_APPLICABLE)
            raise
        self._requests[request_id] = identity
        stop = self.stops[identity] = threading.Event()
        self.workers[identity] = asyncio.create_task(self._run(identity,definition,inputs,token,control,resources,stop))
        return self.snapshot(identity)

    async def _run(self, identity, definition, inputs, token, control, resources, stop):
        loop = asyncio.get_running_loop()
        def feedback(value):
            def update():
                if self.snapshot(identity)['state'] in ACTIVE:
                    self._update(identity, feedback={'data':value})
            loop.call_soon_threadsafe(update)
        self._update(identity, state='RUNNING')
        execution = None
        dispatched = False
        try:
            control.validate_control(token,resources)
            if stop.is_set():
                self._update(identity,state='CANCELED',stop_state='NOT_APPLICABLE')
                return
            dispatched = True
            execution = asyncio.create_task(self.ros_tasks.run(definition['id'],stop,feedback,definition={**definition,'_operation_id':identity},inputs=inputs))
            while not execution.done():
                try:
                    control.validate_control(token,resources)
                except Exception:
                    stop.set()
                await asyncio.wait({execution}, timeout=.05)
            result = await execution
            state = result['state']
            stopped = result.get('stop_confirmed', state != 'UNKNOWN')
            if not stopped: state = 'UNKNOWN'
            self._update(identity, state=state, stop_state='CONFIRMED' if stopped else 'UNCONFIRMED',
                         terminal_received=result.get('terminal_received',False),
                         result={'output':result.get('output',{}),'extensions':{'response':result.get('response',{})}} if result.get('response') is not None else None,
                         error=result.get('error') or {'code':'ros_task_failed','reason':'ROS 能力未成功完成','retryable':False} if state in ('FAILED','UNKNOWN') else None)
        except Exception as exc:
            stop.set()
            dispatched = dispatched and not isinstance(exc, ContractValidationError)
            self._update(identity,state='UNKNOWN' if dispatched else 'FAILED',
                         stop_state='UNCONFIRMED' if dispatched else 'NOT_APPLICABLE',
                         error={'code':'ros_outcome_unknown' if dispatched else 'control_denied','reason':str(exc),'retryable':False})
        finally:
            snapshot = self.snapshot(identity)
            control.resources.settle(identity,resources,StopState(snapshot['stop_state']))
            self.stops.pop(identity,None)
            self.workers.pop(identity,None)

    def cancel(self, identity):
        snapshot = self.snapshot(identity)
        if snapshot['state'] in ACTIVE:
            if identity in self.stops:
                self.stops[identity].set()
            return self._update(identity,state='CANCELING',cancel_requested=True,cancel_accepted=True)
        return snapshot

    async def confirm_stop(self, identity, evidence=None):
        record = self.store.get('ros_operation', identity)
        definition = record['definition']
        if definition.get('robot_system_id') != self.ros_tasks._robot():
            fail('$.operation','ownership','操作不属于当前机器人')
        if record['snapshot']['state'] in ACTIVE or record['snapshot']['stop_state'] != 'UNCONFIRMED':
            fail('$.operation','invalid_state','仅可核对停止未确认的操作')
        evidence = evidence or {}
        previous_session = record.get('executor_session') != self.ros_tasks.environments.session_id
        service = definition.get('stop_recovery_service')
        if previous_session:
            if evidence.get('previous_executor_stopped') is not True or not isinstance(evidence.get('note'),str) or not 4 <= len(evidence['note'].strip()) <= 1000:
                fail('$.evidence','review_required','请核对旧执行进程与设备，并填写核对依据')
            stopped = self.ros_tasks.environments.previous_worker_stopped(identity)
            if stopped is False:
                fail('$.operation','previous_executor_alive','旧通信进程组仍然存活，请先停止旧执行进程')
            from .runtime import LocalProcessManager
            task_ids=[record['task_run_id']]
            if record['task_run_id'].startswith('session_'):
                session=self.store.get('hsm_session',record['task_run_id'])
                task_ids=[v.get('task_run_id') for v in session.get('behaviors',[]) if v.get('task_run_id')]
            for task_id in task_ids:
                saved=self.tasks.store.status(task_id).get('process_identity') or {}
                process=saved.get('identity') or {}
                if process.get('boot')==Path('/proc/sys/kernel/random/boot_id').read_text().strip() and LocalProcessManager._group_alive(process.get('group',saved.get('pid',0))):
                    fail('$.operation','previous_executor_alive','旧行为树进程组仍然存活，请先停止旧执行进程')
            service = evidence.get('service') or service
            if not isinstance(service,str) or not __import__('re').fullmatch(r'/[A-Za-z_][A-Za-z0-9_/]*',service):
                fail('$.service','recovery_service_required','跨会话恢复需要能确认没有活动目标且设备已停止的核对服务')
        observation = definition.get('stop_observation')
        if not service and not observation:
            fail('$.operation','missing_recovery_service','任务未配置设备停止确认服务')
        if any(v['snapshot']['state'] in ACTIVE and v['definition'].get('robot_system_id') == definition.get('robot_system_id') for v in self.store.list('ros_operation')):
            fail('$.operation','operation_active','请先停止当前机器人的其他任务')
        with self.ros_tasks.environments.lock:
            if any(p.poll() is None and value[0] == definition.get('robot_system_id') and value[1]!='data_context' for p,value in self.ros_tasks.environments.processes.items()):
                fail('$.operation','pending_goal','通信进程仍在等待目标结束，暂不能解除资源占用')
        config = definition.get('_execution_environment') or self.ros_tasks.environments.snapshot(definition)
        task = {'kind':'service','interface':service,'ros_type':'std_srvs/srv/Trigger','payload':{},'timeout_s':5,
                '_ros_domain':definition.get('_ros_domain',self.ros_tasks.connection()['domain_id'])}
        if observation and not previous_session:
            if not record['snapshot'].get('terminal_received'):
                fail('$.operation','terminal_unconfirmed','尚未收到动作终态，仅有静止反馈不能证明目标已经结束')
            result=await asyncio.to_thread(self.ros_tasks.environments.compute,config,{'operation':'wait_stationary','payload':observation,'timeout_s':observation.get('timeout_s',5),'_ros_domain':task['_ros_domain']},threading.Event())
        else:
            result = await asyncio.to_thread(self.ros_tasks.environments.call,config,{'op':'run','task':task},threading.Event())
        if result.get('state') != 'SUCCEEDED' or (previous_session or not observation) and result.get('response',{}).get('success') is not True:
            fail('$.operation','stop_unconfirmed',result.get('response',{}).get('message') or '设备尚未确认停止，资源占用继续保留')
        snapshot = self._update(identity,state='FAILED',stop_state='CONFIRMED',recovery={'previous_session':previous_session,'note':evidence.get('note',''),'service':service,'response':result.get('response',{})},error={'code':'stop_recovered','reason':'设备已确认停止，可重新发起任务','retryable':False})
        resources = [parse(ResourceRequirement,r) for r in definition.get('resources',[])]
        self.context.engine.control.resources.settle(identity,resources,StopState.CONFIRMED)
        task_id = record['task_run_id']
        if task_id.startswith('session_'):
            self._settle_recovered_sessions(task_id, definition['robot_system_id'])
            return snapshot
        status = self.tasks.store.status(task_id)
        process = self.tasks.processes.get(task_id)
        operations = self.tasks._operations(task_id)
        if (status['state'] == 'UNKNOWN' and operations and (process is None or process.returncode is not None)
                and all(o['state'] not in ACTIVE and o['stop_state'] in ('CONFIRMED','NOT_APPLICABLE') for o in operations)
                and ((status.get('error') or {}).get('code') not in ('restart_requires_review','task_monitor_failed') or previous_session)):
            status.update(state='FAILED', stop_confirmed=True, error={'code':'stop_recovered','reason':'设备已确认停止，原任务未成功完成'})
            if status.get('business_result'):
                status['business_result']['outcome']='failed'
            self.tasks.store.save(task_id,status)
            self.tasks.store.event(task_id,{'type':'device_stop_confirmed','operation_id':identity,'state':'FAILED'})
            control = self.context.engine.control
            if (not self.tasks.store.snapshot(task_id).get('shared_control') and control.mode == RobotMode.AUTO
                    and not control.resources.unavailable and not any(item['state'] in ACTIVE for item in self.tasks.store.list())):
                control.set_mode(RobotMode.STANDBY)
        self._settle_recovered_sessions(task_id, definition['robot_system_id'])
        return snapshot

    def _settle_recovered_sessions(self, task_id, robot):
        for session in self.store.list('hsm_session'):
            if session.get('robot_system_id',robot)!=robot or session['status']!='UNKNOWN':continue
            behaviors=session.get('behaviors',[])
            if session['id']!=task_id and not any(v.get('task_run_id')==task_id for v in behaviors):continue
            operations=self.operations(session['id'])
            if any(o['state'] in ACTIVE|{'UNKNOWN'} or o['stop_state'] not in ('CONFIRMED','NOT_APPLICABLE') for o in operations):continue
            ready=True
            for behavior in behaviors:
                child=behavior.get('task_run_id')
                if child:
                    status=self.tasks.store.status(child)
                    if status['state'] in ACTIVE|{'UNKNOWN'} or not status.get('stop_confirmed'):ready=False
                elif behavior.get('operation_id'):
                    status=self.snapshot(behavior['operation_id'])
                    if status['state'] in ACTIVE|{'UNKNOWN'} or status['stop_state'] not in ('CONFIRMED','NOT_APPLICABLE'):ready=False
                elif behavior.get('status') in ACTIVE|{'UNKNOWN'}:ready=False
            if ready:
                self.store.put('hsm_session',session['id'],{**session,'status':'FAILED','error':'已核对设备停止，原流程未完成','attention':[]})

    async def close(self):
        self._closed = True
        for identity in list(self.stops):
            self.cancel(identity)
        if self.workers:
            await asyncio.gather(*list(self.workers.values()),return_exceptions=True)
