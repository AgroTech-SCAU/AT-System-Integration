"""Workspace-side health observers, never executing a device command."""
import threading
import time
from uuid import uuid4


def validate_checks(checks):
    import re
    if not isinstance(checks, list) or len(checks)>32: raise ValueError('健康检查最多 32 项')
    for check in checks:
        if not isinstance(check,dict) or check.get('kind') not in ('node','topic','service','action','lifecycle'): raise ValueError('健康检查类型无效')
        if not isinstance(check.get('name'),str) or not re.fullmatch(r'/[\w/]+',check['name']): raise ValueError('健康检查需要完整 ROS 名称')
        if check['kind']=='topic' and not check.get('type'): raise ValueError('消息健康检查需要消息类型')
        if check.get('role','publisher') not in ('publisher','subscriber'): raise ValueError('话题角色无效')
        if type(check.get('max_age_s',2)) not in (int,float) or not .1<=check.get('max_age_s',2)<=30: raise ValueError('消息有效期应在 0.1 至 30 秒')
        if not isinstance(check.get('condition',{}),dict):raise ValueError('消息健康条件应为对象')
        if check.get('condition',{}).get('operator','any') not in ('any','equals','not_equals','greater','less'): raise ValueError('消息健康条件无效')


class HealthProbe:
    """Keep DDS discovery and live subscriptions across readiness requests."""

    def __init__(self, domain_id=0):
        import rclpy
        from rclpy.executors import SingleThreadedExecutor
        self.domain_id=domain_id
        self._condition=threading.Condition()
        self._requests=threading.Lock()
        self._closed=threading.Event()
        self._spin_error=None
        self._topics={}
        self._clients={}
        self.context=rclpy.context.Context()
        rclpy.init(context=self.context,domain_id=domain_id)
        try:
            self.node=rclpy.create_node('atil_health_'+uuid4().hex[:8],context=self.context)
            self.executor=SingleThreadedExecutor(context=self.context)
            self.executor.add_node(self.node)
        except BaseException:
            if getattr(self,'node',None) is not None:self.node.destroy_node()
            rclpy.shutdown(context=self.context)
            raise
        self._thread=threading.Thread(target=self._spin,name='atil-health-observer',daemon=True)
        self._thread.start()

    def _spin(self):
        try:
            while not self._closed.is_set() and self.context.ok():
                self.executor.spin_once(timeout_sec=.05)
        except Exception as error:
            if not self._closed.is_set():
                with self._condition:
                    self._spin_error=str(error)
                    self._condition.notify_all()

    def _subscribe(self, check):
        from rclpy.qos import qos_profile_sensor_data
        from rosidl_runtime_py.utilities import get_message
        key=(check['name'],check['type'])
        if key not in self._topics:
            sample={'message':None,'received_at':None,'sequence':0}
            def receive(message):
                with self._condition:
                    sample.update(message=message,received_at=time.monotonic(),sequence=sample['sequence']+1)
                    self._condition.notify_all()
            sample['subscription']=self.node.create_subscription(get_message(check['type']),check['name'],receive,qos_profile_sensor_data)
            self._topics[key]=sample

    def _observe(self, request, lifecycle):
        try:
            from .ros_transport import _matches
        except ImportError:
            from ros_transport import _matches
        checks=request.get('health_checks',[])
        services=dict(self.node.get_service_names_and_types())
        topics=dict(self.node.get_topic_names_and_types())
        names={('/'+namespace.strip('/')+'/'+name).replace('//','/') for name,namespace in self.node.get_node_names_and_namespaces()}
        missing=[]
        for endpoint in request.get('endpoints',[]):
            kind,name=endpoint['kind'],endpoint['name'];wanted=endpoint.get('type')
            actual=topics.get(name,[]) if kind=='topic' else services.get(name+'/_action/send_goal' if kind=='action' else name,[])
            if kind=='action' and wanted:wanted+='_SendGoal'
            present=bool(actual) and (not wanted or wanted in actual)
            if present and kind=='topic':
                entries=self.node.get_subscriptions_info_by_topic(name) if endpoint.get('role')=='subscriber' else self.node.get_publishers_info_by_topic(name)
                present=any((not wanted or entry.topic_type==wanted) and (entry.node_name,entry.node_namespace)!=(self.node.get_name(),self.node.get_namespace()) for entry in entries)
            if not present:missing.append(name)
        details=[]
        for index,check in enumerate(checks):
            kind,name=check['kind'],check['name'];ok=False
            if kind=='node':ok=name in names
            elif kind=='topic':
                with self._condition:sample=dict(self._topics[(name,check['type'])])
                age=None if sample['received_at'] is None else max(0.,time.monotonic()-sample['received_at'])
                matches=sample['message'] is not None and _matches(sample['message'],check.get('condition',{}))
                limit=check.get('max_age_s',2)
                ok=age is not None and age<=limit and matches
                details.append({'kind':kind,'name':name,'type':check['type'],'sample_age_s':age,
                                'max_age_s':limit,'sample_count':sample['sequence'],'condition_met':matches})
            elif kind in ('service','action'):
                actual=services.get(name+'/_action/send_goal' if kind=='action' else name,[])
                expected=check.get('type','')+('_SendGoal' if kind=='action' and check.get('type') else '')
                ok=bool(actual) and (not expected or expected in actual)
            elif kind=='lifecycle':
                client,future=lifecycle[index]
                if future is None and client.service_is_ready():
                    from lifecycle_msgs.srv import GetState
                    future=client.call_async(GetState.Request());lifecycle[index]=(client,future)
                ok=future is not None and future.done() and not future.exception() and future.result().current_state.id==3
            if not ok:missing.append(kind+' '+name)
        return {'ready':not missing,'missing':missing,'level':'healthy' if checks else 'interfaces','details':details}

    def probe(self, request):
        checks=request.get('health_checks',[])
        validate_checks(checks)
        if (request.get('domain_id') or 0)!=self.domain_id:raise ValueError('健康观测的 ROS 域与执行环境不同')
        with self._requests:
            lifecycle={}
            for index,check in enumerate(checks):
                if check['kind']=='topic':self._subscribe(check)
                elif check['kind']=='lifecycle':
                    from lifecycle_msgs.srv import GetState
                    name=check['name'].rstrip('/')+'/get_state'
                    if name not in self._clients:self._clients[name]=self.node.create_client(GetState,name)
                    # Ask again on every probe; an old ACTIVE response is not live health
                    lifecycle[index]=(self._clients[name],None)
            deadline=time.monotonic()+request.get('probe_timeout_s',2)
            try:
                while True:
                    if self._closed.is_set():raise RuntimeError('健康观测已关闭')
                    if self._spin_error is not None:raise RuntimeError('健康观测失败：'+self._spin_error)
                    result=self._observe(request,lifecycle)
                    remaining=deadline-time.monotonic()
                    if result['ready'] or remaining<=0:return result
                    with self._condition:self._condition.wait(timeout=min(.05,remaining))
            finally:
                for client,future in lifecycle.values():
                    if future is not None and not future.done():client.remove_pending_request(future)

    def close(self):
        if self._closed.is_set():return
        self._closed.set()
        with self._condition:self._condition.notify_all()
        self.executor.wake()
        self._thread.join()
        with self._requests:
            self.executor.shutdown()
            self.node.destroy_node()
        import rclpy
        if self.context.ok():rclpy.shutdown(context=self.context)


def probe(request):
    observer=HealthProbe(request.get('domain_id') or 0)
    try:return observer.probe(request)
    finally:observer.close()
