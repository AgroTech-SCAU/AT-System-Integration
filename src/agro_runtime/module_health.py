"""Workspace-side health probes, never executing a device command."""
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


def probe(request):
    import rclpy
    from rclpy.qos import qos_profile_sensor_data
    from rosidl_runtime_py.utilities import get_message
    try:
        from .ros_transport import _matches
    except ImportError:
        from ros_transport import _matches
    checks=request.get('health_checks',[])
    validate_checks(checks)
    context=rclpy.context.Context();rclpy.init(context=context,domain_id=request.get('domain_id') or 0)
    node=rclpy.create_node('atil_health_'+uuid4().hex[:8],context=context)
    samples={};clients={};subscriptions=[]
    try:
        for index,check in enumerate(checks):
            if check['kind']=='topic':
                def receive(message,index=index,check=check):
                    if _matches(message,check.get('condition',{})): samples[index]=time.monotonic()
                subscriptions.append(node.create_subscription(get_message(check['type']),check['name'],receive,qos_profile_sensor_data))
            elif check['kind']=='lifecycle':
                from lifecycle_msgs.srv import GetState
                clients[index]=(node.create_client(GetState,check['name'].rstrip('/')+'/get_state'),None)
        deadline=time.monotonic()+request.get('probe_timeout_s',2)
        missing=[]
        while time.monotonic()<deadline:
            rclpy.spin_once(node,timeout_sec=.1)
            services=dict(node.get_service_names_and_types())
            topics=dict(node.get_topic_names_and_types())
            names={('/'+namespace.strip('/')+'/'+name).replace('//','/') for name,namespace in node.get_node_names_and_namespaces()}
            missing=[]
            for endpoint in request.get('endpoints',[]):
                kind,name=endpoint['kind'],endpoint['name'];wanted=endpoint.get('type')
                actual=topics.get(name,[]) if kind=='topic' else services.get(name+'/_action/send_goal' if kind=='action' else name,[])
                if kind=='action' and wanted:wanted+='_SendGoal'
                present=bool(actual) and (not wanted or wanted in actual)
                if present and kind=='topic':
                    entries=node.get_subscriptions_info_by_topic(name) if endpoint.get('role')=='subscriber' else node.get_publishers_info_by_topic(name)
                    present=any((not wanted or entry.topic_type==wanted) and (entry.node_name,entry.node_namespace)!=(node.get_name(),node.get_namespace()) for entry in entries)
                if not present:missing.append(name)
            for index,check in enumerate(checks):
                kind,name=check['kind'],check['name'];ok=False
                if kind=='node':ok=name in names
                elif kind=='topic':ok=index in samples and time.monotonic()-samples[index]<=check.get('max_age_s',2)
                elif kind in ('service','action'):
                    actual=services.get(name+'/_action/send_goal' if kind=='action' else name,[])
                    expected=check.get('type','')+('_SendGoal' if kind=='action' and check.get('type') else '')
                    ok=bool(actual) and (not expected or expected in actual)
                elif kind=='lifecycle':
                    client,future=clients[index]
                    if future is None and client.service_is_ready():
                        from lifecycle_msgs.srv import GetState
                        future=client.call_async(GetState.Request());clients[index]=(client,future)
                    ok=future is not None and future.done() and not future.exception() and future.result().current_state.id==3
                if not ok:missing.append(kind+' '+name)
            if not missing:return {'ready':True,'missing':[],'level':'healthy' if checks else 'interfaces'}
        return {'ready':False,'missing':missing,'level':'healthy' if checks else 'interfaces'}
    finally:
        node.destroy_node();rclpy.shutdown(context=context)
