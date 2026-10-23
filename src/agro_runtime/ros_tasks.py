"""按机器人隔离的 ROS 2 通信任务与原生 rclpy 执行器

编辑任务无需启动 ROS 2，执行时才延迟加载 rclpy
"""
import asyncio
import copy
import json
import os
import re
import threading
import time
from uuid import uuid4

from .errors import ContractValidationError, fail, parse
from .models import TypeDescriptor, ResourceRequirement
from .registry import _values

IDENT = re.compile(r'^[a-z][a-z0-9_]{0,63}$')
KINDS = {'service', 'action', 'publish_once', 'publish_periodic', 'subscribe_wait'}
WAIT_MODES = {'response', 'result', 'message', 'sent', 'until_stopped'}


def validate_task(raw):
    if not isinstance(raw, dict):
        fail('$.task', 'invalid_task', 'ROS 2 任务必须是对象')
    data = copy.deepcopy(raw)
    kind = data.get('kind')
    if not isinstance(kind, str) or kind not in KINDS:
        fail('$.kind', 'invalid_kind', '选择话题发布、话题订阅、服务或动作')
    name = data.get('name', '')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
        fail('$.name', 'invalid_name', '填写任务名称')
    interface = data.get('interface', '')
    if not isinstance(interface, str) or interface and (not interface.startswith('/') or len(interface) > 240 or ' ' in interface):
        fail('$.interface', 'invalid_interface', '填写以 / 开头的 ROS 2 接口名称')
    ros_type = data.get('ros_type', '')
    if not isinstance(ros_type, str) or ros_type and not re.fullmatch(r'[A-Za-z][\w]*/(msg|srv|action)/[A-Za-z]\w*', ros_type):
        fail('$.ros_type', 'invalid_type', '填写完整消息类型，如 std_msgs/msg/String')
    expected = 'srv' if kind == 'service' else 'action' if kind == 'action' else 'msg'
    if ros_type and ros_type.split('/')[1] != expected:
        fail('$.ros_type', 'kind_mismatch', '接口类型与通信方式不匹配')
    data['ros_type'] = ros_type
    payload = data.get('payload', {})
    if not isinstance(payload, dict):
        fail('$.payload', 'invalid_payload', '请求内容必须是 JSON 对象')
    if len(json.dumps(payload, ensure_ascii=False)) > 65536:
        fail('$.payload', 'payload_too_large', '任务消息不可超过 64 KiB')
    timeout = data.get('timeout_s', 15)
    if type(timeout) not in (int, float) or not 0.2 <= timeout <= 3600:
        fail('$.timeout_s', 'invalid_timeout', '超时范围为 0.2 至 3600 秒')
    if kind == 'publish_periodic':
        hz = data.get('rate_hz', 5)
        if type(hz) not in (int, float) or not 0.2 <= hz <= 100:
            fail('$.rate_hz', 'invalid_rate', '发布频率必须在 0.2 至 100 Hz 内')
        if not isinstance(data.get('stop_payload'), dict) or not data['stop_payload']:
            fail('$.stop_payload', 'stop_message_required', '持续发布必须填写具体的安全停止消息字段')
    if kind == 'subscribe_wait':
        condition = data.get('condition', {})
        if not isinstance(condition, dict) or condition.get('operator', 'any') not in ('any', 'equals', 'not_equals', 'greater', 'less'):
            fail('$.condition', 'invalid_condition', '订阅条件不正确')
        if condition.get('operator', 'any') != 'any' and not isinstance(condition.get('field'), str):
            fail('$.condition.field', 'field_required', '选择消息字段后才能比较')
    condition=data.get('success_condition', {})
    if not isinstance(condition,dict) or condition.get('operator','any') not in ('any','equals','not_equals','greater','less'):
        fail('$.success_condition','invalid_condition','完成条件无效')
    if condition.get('operator','any')!='any' and (not isinstance(condition.get('field'),str) or not condition['field']):
        fail('$.success_condition.field','field_required','完成条件需要结果字段')
    if data.get('qos_reliability', 'reliable') not in ('reliable', 'best_effort'):
        fail('$.qos_reliability', 'invalid_qos', '选择可靠传输或尽力传输')
    for field in ('inputs', 'outputs'):
        contracts = data.setdefault(field, {})
        if not isinstance(contracts, dict) or len(contracts) > 64:
            fail('$.'+field, 'invalid_ports', '任务端口必须是最多 64 项的对象')
        for name, contract in contracts.items():
            if not isinstance(name, str) or not IDENT.fullmatch(name) or name in {'node_id', 'role', 'backend_instance'} or name.startswith('out_'):
                fail('$.'+field, 'invalid_port_name', '端口名称无效或与保留端口冲突')
            contracts[name] = parse(TypeDescriptor, contract).model_dump(mode='json', exclude_none=True)
    for field, names in (('input_bindings', data['inputs']), ('output_bindings', data['outputs'])):
        mapping = data.setdefault(field, {})
        if not isinstance(mapping, dict):
            fail('$.'+field, 'invalid_bindings', '字段映射必须是对象')
        for key, value in mapping.items():
            path, port_name = (key, value) if field == 'input_bindings' else (value, key)
            if not isinstance(path, str) or path!='$' and not re.fullmatch(r'[A-Za-z_]\w*(?:\.(?:[A-Za-z_]\w*|[0-9]+))*', path) or port_name not in names:
                fail('$.'+field, 'invalid_binding', '字段路径或端口名称无效')
        if field == 'output_bindings' and set(mapping) != set(names):
            fail('$.'+field, 'missing_binding', '每个输出端口都需要结果字段映射')
        if field == 'input_bindings' and set(mapping.values()) != set(names):
            fail('$.'+field, 'missing_binding', '每个输入端口都需要消息字段映射')
    resources = data.setdefault('resources', [])
    if not isinstance(resources, list) or len(resources) > 32:
        fail('$.resources', 'invalid_resources', '资源需求必须是列表')
    data['resources'] = [parse(ResourceRequirement, item).model_dump(mode='json') for item in resources]
    if len({item['name'] for item in data['resources']}) != len(resources):
        fail('$.resources', 'duplicate_resource', '资源名称不能重复')
    return data


def field_value(value, path):
    if path=='$':return copy.deepcopy(value)
    for part in path.split('.'):
        try:
            value = value[int(part)] if isinstance(value, list) and part.isdigit() else value[part]
        except (KeyError, IndexError, TypeError):
            fail('$.bindings.'+path, 'missing_field', '消息中不存在映射字段 '+path)
    return copy.deepcopy(value)


def prepared_task(data, inputs=None):
    prepared = copy.deepcopy(data)
    contracts = {name: parse(TypeDescriptor, spec) for name, spec in data.get('inputs', {}).items()}
    values = _values(inputs or {}, contracts, '$.inputs')
    for path, key in data.get('input_bindings', {}).items():
        if path=='$':
            if not isinstance(values[key],dict) or len(data['input_bindings'])!=1:
                fail('$.input_bindings','invalid_root_binding','完整消息绑定需要单个 JSON 对象输入')
            prepared['payload']=copy.deepcopy(values[key])
            continue
        parts = path.split('.')
        target = prepared.setdefault('payload', {})
        for part in parts[:-1]:
            if isinstance(target, list) and part.isdigit():
                target = target[int(part)]
            elif isinstance(target, dict):
                target = target.setdefault(part, {})
            else:
                fail('$.input_bindings.'+path, 'invalid_field_path', '输入映射无法写入消息字段')
        last = parts[-1]
        if isinstance(target, list) and last.isdigit():
            target[int(last)] = copy.deepcopy(values[key])
        elif isinstance(target, dict):
            target[last] = copy.deepcopy(values[key])
        else:
            fail('$.input_bindings.'+path, 'invalid_field_path', '输入映射无法写入消息字段')
    return prepared


def mapped_outputs(data, response):
    output = {key: field_value(response, path) for key, path in data.get('output_bindings', {}).items()}
    return _values(output, {name: parse(TypeDescriptor, spec) for name, spec in data.get('outputs', {}).items()}, '$.outputs')


class RosTasks:
    def __init__(self, store, robots):
        self.store, self.robots = store, robots
        self._context=None
        self._domain=None
        self._context_active=0
        self._context_lock=threading.Lock()

    def _robot(self):
        key = self.robots.selected_id()
        if not key:
            fail('$.robot', 'no_robot', '请先选择机器人')
        return key

    def list(self):
        key = self._robot()
        return [self._bound(task) for task in self.store.list('ros_task') if task.get('robot_system_id') == key]

    def _bound(self, task):
        binding = next((item for item in self.store.list('ros_binding')
                        if item['task_id'] == task['id'] and item['robot_system_id'] == self._robot()), None)
        return {**task, 'interface': binding['interface'] if binding else task.get('interface', '')}

    def bind(self, identity, interface):
        task = self.get(identity)
        validate_task({**task, 'interface': interface})
        key = self._robot() + '_' + identity
        return self.store.put('ros_binding', key, {'id': key, 'task_id': identity,
                              'robot_system_id': self._robot(), 'interface': interface})

    def get(self, identity):
        task = self.store.get('ros_task', identity)
        if task.get('robot_system_id') != self._robot():
            fail('$.task', 'ownership', '任务不属于当前机器人')
        return self._bound(task)

    def save(self, raw):
        data = validate_task(raw)
        key = self._robot()
        identity = data.get('id') or 'ros_'+uuid4().hex
        if not IDENT.fullmatch(identity):
            fail('$.id', 'invalid_id', '任务标识无效')
        try:
            old = self.store.get('ros_task', identity)
        except Exception as exc:
            # 仅允许缺失记录时新建，不吞掉其他存储异常
            if not any(getattr(issue, 'code', '') == 'unknown_ros_task' for issue in getattr(exc, 'issues', [])):
                raise
            old = None
        if old and old.get('robot_system_id') != key:
            fail('$.task', 'ownership', '任务不属于当前机器人')
        data.update(id=identity, robot_system_id=key, revision=old['revision'] + 1 if old else 1)
        from .ros_interfaces import InterfaceLibrary
        try:
            if not data['ros_type']:
                fail('$.ros_type', 'type_not_found', '任务尚未选择接口类型')
            schema = InterfaceLibrary(self.store, key).describe(data['kind'], data['ros_type'], data.get('schema_id'))
            data['schema_id'] = schema['schema_id']
        except ContractValidationError as exc:
            if data.get('schema_id') or any(issue.code != 'type_not_found' for issue in exc.issues):
                raise
        interface = data.pop('interface', self._bound(old)['interface'] if old else '')
        self.store.put('ros_task', identity, data)
        self.bind(identity, interface)
        return self.get(identity)

    def delete(self, identity):
        self.get(identity)
        self.store.delete('ros_task', identity)
        self.store.delete('ros_binding', self._robot() + '_' + identity)
        return {'deleted': True}

    def connection(self):
        if self.store is None or self.robots is None:
            return {'domain_id':None,'namespace':'/'}
        key=self._robot()
        return next((item for item in self.store.list('ros_connection') if item['id']==key),
                    {'id':key,'domain_id':int(os.environ.get('ROS_DOMAIN_ID','0')),'namespace':'/'})

    def save_connection(self, domain_id, namespace):
        if not isinstance(domain_id,int) or isinstance(domain_id,bool) or not 0<=domain_id<=232:
            fail('$.domain_id','invalid_domain','ROS 域需为 0 到 232 的整数')
        if not isinstance(namespace,str) or not re.fullmatch(r'/(?:[A-Za-z_][A-Za-z0-9_]*(?:/[A-Za-z_][A-Za-z0-9_]*)*)?/?',namespace):
            fail('$.namespace','invalid_namespace','命名空间需要以 / 开头，并使用 ROS 名称')
        self.close()
        return self.store.put('ros_connection',self._robot(),{'id':self._robot(),'domain_id':domain_id,'namespace':namespace.rstrip('/') or '/'})

    def discover(self,connection=None):
        connection=connection or self.connection()
        result=self._discover(connection['domain_id'])
        namespace=connection['namespace']
        if namespace!='/':
            for key in ('topics','services','actions'):
                result[key]=[item for item in result[key] if item['name']==namespace or item['name'].startswith(namespace+'/')]
        return {**result,'connection':connection}

    def sample(self, interface, ros_type, domain_id=None):
        definition=validate_task({'name':'观察消息','kind':'subscribe_wait','interface':interface,'ros_type':ros_type,
                                 'payload':{},'condition':{'operator':'any'},'timeout_s':2,'qos_reliability':'best_effort'})
        definition['_ros_domain']=domain_id
        result=self._execute(definition,threading.Event(),None)
        return {'received':result['state']=='SUCCEEDED','message':result.get('response'), 'state':result['state']}

    @staticmethod
    def _discover(domain_id=None):
        def lookup():
            rclpy, _, _, _ = _ros_modules()
            context = rclpy.context.Context()
            rclpy.init(context=context, **({'domain_id':domain_id} if domain_id is not None else {}))
            node = None
            try:
                node = rclpy.create_node('atil_interface_discovery', context=context)
                # 允许 DDS graph 短暂发现其他 ROS 节点
                time.sleep(0.35)
                topics = [{'name': n, 'types': t} for n, t in node.get_topic_names_and_types() if not n.startswith('/rosout')]
                services = [{'name': n, 'types': t} for n, t in node.get_service_names_and_types() if '/_action/' not in n]
                action_services = node.get_service_names_and_types()
                actions = []
                for n, types in action_services:
                    if not n.endswith('/_action/send_goal'):
                        continue
                    for t in types:
                        if t.endswith('_SendGoal') and '/action/' in t:
                            actions.append({'name': n.removesuffix('/_action/send_goal'), 'types': [t.removesuffix('_SendGoal')]})
                return {'connected': True, 'topics': topics, 'services': services, 'actions': actions}
            finally:
                if node:
                    node.destroy_node()
                rclpy.shutdown(context=context)
        return lookup()

    def describe(self, kind, ros_type, schema_id=None):
        if kind not in KINDS:
            fail('$.kind', 'invalid_kind', '通信方式无效')
        from .ros_interfaces import InterfaceLibrary
        return InterfaceLibrary(self.store, self._robot()).describe(kind, ros_type, schema_id)

    def freeze(self, identity):
        data = self.get(identity)
        if not data.get('interface'):
            fail('$.task.' + identity, 'missing_endpoint', '任务尚未绑定机器人端点：' + data['name'])
        expected = self.describe(data['kind'], data['ros_type'], data.get('schema_id'))
        data['schema_id'] = expected['schema_id']
        data['interface_schema'] = {name: value for name, value in expected.items() if name not in ('source', 'schema_id')}
        self.verify_support(data)
        data['_ros_domain'] = self.connection()['domain_id']
        return copy.deepcopy(data)

    def verify_support(self, data):
        from .ros_interfaces import InterfaceLibrary, PRIMITIVES, installed_schema
        identity = data['id']
        expected = data.get('interface_schema') or self.describe(data['kind'], data['ros_type'], data.get('schema_id'))
        schemas = {data['ros_type']: expected}
        if data.get('schema_id'):
            record = self.store.get('ros_schema', data['schema_id'])
            if record.get('project_id') != self._robot():
                fail('$.task.' + identity, 'ownership', '任务接口定义不属于当前工程')
            schemas.update(InterfaceLibrary(self.store, self._robot()).compile(record['definitions'], saved_definitions=False))
        def normalized(value, package):
            if isinstance(value, dict):
                return {name: normalized(item, package) for name, item in value.items()}
            if isinstance(value, str):
                aliases = {'boolean': 'bool', 'float': 'float32', 'double': 'float64', 'octet': 'byte', 'char': 'uint8'}
                value = re.sub(r'(?:bounded_)?sequence<(.+?)(?:,\s*(\d+))?>', lambda match: match[1] + ('[<=' + match[2] + ']' if match[2] else '[]'), value)
                value = re.sub(r'\b(boolean|float|double|octet|char)\b', lambda match: aliases[match[0]], value)
                value = re.sub(r'(w?string)<(\d+)>', r'\1<=\2', value)
                value = value.replace('/msg/', '/').replace(' ', '')
                base = value.split('[', 1)[0]
                if '/' not in base and base not in PRIMITIVES and not re.fullmatch(r'w?string(?:<=\d+)?', base):
                    value = package + '/' + value
                return value
            return value
        for ros_type, schema in schemas.items():
            kind = {'srv': 'service', 'action': 'action', 'msg': 'publish_once'}[ros_type.split('/')[1]]
            try:
                actual = installed_schema(kind, ros_type)
            except (ImportError, AttributeError, ValueError):
                fail('$.task.' + identity, 'missing_type_support', '执行环境缺少接口类型支持：' + ros_type)
            for field in ('field_types', 'output_field_types', 'feedback_field_types'):
                package = ros_type.split('/')[0]
                if normalized(schema.get(field, {}), package) != normalized(actual.get(field, {}), package):
                    fail('$.task.' + identity, 'type_support_mismatch', '执行环境接口与任务定义不一致：' + data['name'] + ' / ' + ros_type)

    async def run(self, task_id, stop: threading.Event, feedback=None, *, definition=None, inputs=None):
        data = prepared_task(definition if definition is not None else self.get(task_id), inputs)
        data.setdefault('_ros_domain', self.connection()['domain_id'])
        result = await asyncio.to_thread(self._execute, data, stop, feedback)
        if isinstance(result, str):
            result = {'state':result,'response':data.get('payload',{})}
        if result['state']=='SUCCEEDED' and not _matches_value(result.get('response',{}),data.get('success_condition',{})):
            result['state']='FAILED'
            result['error']={'code':'completion_condition_failed','reason':'返回结果未满足完成条件','retryable':False}
        if result['state'] == 'SUCCEEDED':
            try:
                result['output'] = mapped_outputs(data, result.get('response', {}))
            except ContractValidationError as exc:
                result.update(state='FAILED',output={},error={'code':'output_binding_failed','reason':str(exc),'retryable':False})
        else:
            result['output'] = {}
        return result

    def _execute(self, data, stop, feedback):
        with self._context_lock:
            domain_id=data.pop('_ros_domain',None)
            if self._context is not None and self._domain!=domain_id:
                if self._context_active:fail('$.connection','connection_busy','当前环境仍有消息读取或任务，请稍后切换')
                rclpy, _, _, _ = _ros_modules()
                rclpy.shutdown(context=self._context)
                self._context=None
            if self._context is None:
                rclpy, _, _, _ = _ros_modules()
                context = rclpy.context.Context()
                rclpy.init(context=context, **({'domain_id':domain_id} if domain_id is not None else {}))
                self._context = context
                self._domain = domain_id
            context = self._context
            self._context_active+=1
        try:
            return _run_task(data,stop,feedback,context=context)
        finally:
            with self._context_lock:self._context_active-=1

    def close(self):
        with self._context_lock:
            if self._context_active:fail('$.connection','connection_busy','当前环境仍有消息读取或任务，请稍后切换')
            if self._context is not None:
                rclpy, _, _, _ = _ros_modules()
                rclpy.shutdown(context=self._context)
                self._context = None


def _ros_modules():
    try:
        import rclpy
        from rosidl_runtime_py.utilities import get_message, get_service, get_action
        from rosidl_runtime_py.set_message import set_message_fields
        return rclpy, (get_message, get_service, get_action), set_message_fields, None
    except ImportError:
        fail('$.ros', 'ros_not_installed', '当前环境未找到 ROS 2 Python 环境，请先 source ROS 2 与机器人工作空间')


def _message_as_dict(msg):
    from rosidl_runtime_py.convert import message_to_ordereddict
    return message_to_ordereddict(msg)


def _matches(msg, cond):
    return _matches_value(_message_as_dict(msg),cond)


def _matches_value(value, cond):
    op = cond.get('operator', 'any')
    if op == 'any':
        return True
    for segment in cond.get('field', '').split('.'):
        if not isinstance(value, dict) or segment not in value:
            return False
        value = value[segment]
    right = cond.get('value')
    if op == 'equals': return value == right
    if op == 'not_equals': return value != right
    if type(value) not in (int, float) or type(right) not in (int, float): return False
    return value > right if op == 'greater' else value < right


def _run_task(data, stop, feedback=None, *, context=None):
    rclpy, (get_message, get_service, get_action), fill, _ = _ros_modules()
    from rclpy.executors import SingleThreadedExecutor
    from rclpy.action import ActionClient
    owns_context=context is None
    if owns_context:
        context = rclpy.context.Context()
        rclpy.init(context=context)
    node = None
    executor = None
    action_goal = None
    kind = data['kind']
    deadline = time.monotonic() + data.get('timeout_s', 15)
    def remaining():
        return max(0.0, deadline - time.monotonic())
    def spin_until(future):
        while not future.done():
            if stop.is_set() or remaining() <= 0:
                return False
            executor.spin_once(timeout_sec=min(.05, remaining()))
        return True
    def message(cls, payload):
        msg = cls()
        try:
            fill(msg, payload)
        except Exception as exc:
            fail('$.payload', 'invalid_fields', '消息字段与 ROS 2 接口定义不匹配: ' + str(exc))
        return msg
    try:
        node = rclpy.create_node('atil_task_' + uuid4().hex[:8], context=context)
        executor = SingleThreadedExecutor(context=context)
        executor.add_node(node)
        interface = data['interface']
        ros_type = data['ros_type']
        if kind in ('publish_once', 'publish_periodic'):
            cls = get_message(ros_type)
            from rclpy.qos import QoSProfile, ReliabilityPolicy
            qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.BEST_EFFORT if data.get('qos_reliability') == 'best_effort' else ReliabilityPolicy.RELIABLE)
            pub = node.create_publisher(cls, interface, qos)
            msg = message(cls, data.get('payload', {}))
            if kind == 'publish_once':
                if stop.is_set(): return 'CANCELED'
                pub.publish(msg)
                executor.spin_once(timeout_sec=.08)
                return 'SUCCEEDED'
            final = message(cls, data['stop_payload'])
            delay = 1.0 / data.get('rate_hz', 5)
            while not stop.is_set() and remaining() > 0:
                pub.publish(msg)
                executor.spin_once(timeout_sec=min(delay, .05))
                if delay > .05:
                    stop.wait(delay - .05)
            # 不论正常超时还是取消，退出持续发布前都发送安全停止消息
            for _ in range(3):
                pub.publish(final)
                executor.spin_once(timeout_sec=.035)
            return 'CANCELED' if stop.is_set() else 'FAILED'
        if kind == 'subscribe_wait':
            cls = get_message(ros_type)
            from rclpy.qos import QoSProfile, ReliabilityPolicy
            qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.BEST_EFFORT if data.get('qos_reliability', 'best_effort') == 'best_effort' else ReliabilityPolicy.RELIABLE)
            matched = threading.Event()
            response = {}
            def observe(msg):
                nonlocal response
                if _matches(msg, data.get('condition', {})):
                    response = _message_as_dict(msg)
                    matched.set()
            sub = node.create_subscription(cls, interface, observe, qos)
            while not matched.is_set() and not stop.is_set() and remaining() > 0:
                executor.spin_once(timeout_sec=min(.05, remaining()))
            return {'state': 'CANCELED' if stop.is_set() else 'SUCCEEDED' if matched.is_set() else 'FAILED', 'response': response}
        if kind == 'service':
            cls = get_service(ros_type)
            client = node.create_client(cls, interface)
            while not client.wait_for_service(timeout_sec=.1):
                if stop.is_set(): return 'CANCELED'
                if remaining() <= 0: return 'FAILED'
            future = client.call_async(message(cls.Request, data.get('payload', {})))
            if not spin_until(future):
                future.cancel()
                # 服务请求可能已到达设备，取消本地等待并不等于服务端停止执行
                raise RuntimeError('Service 请求已发出但未收到响应，设备执行状态未知，请人工核对')
            result = future.result()
            if feedback:
                feedback(_message_as_dict(result))
            # 服务响应仅表示服务调用结束，并不证明实体动作已经完成
            return {'state': 'SUCCEEDED', 'response': _message_as_dict(result)}
        if kind == 'action':
            cls = get_action(ros_type)
            client = ActionClient(node, cls, interface)
            while not client.wait_for_server(timeout_sec=.1):
                if stop.is_set(): return 'CANCELED'
                if remaining() <= 0: return 'FAILED'
            def progress(event):
                if feedback:
                    feedback(_message_as_dict(event.feedback))
            future = client.send_goal_async(message(cls.Goal, data.get('payload', {})), feedback_callback=progress)
            if not spin_until(future):
                # 请求尚未接受时无法确认 goal 已取消，不允许假装停止成功
                raise RuntimeError('Action Goal 尚未确认接受，无法确认取消状态，请人工核对设备')
            action_goal = future.result()
            if not action_goal.accepted:
                return 'FAILED'
            result_future = action_goal.get_result_async()
            while not result_future.done():
                if stop.is_set() or remaining() <= 0:
                    cancel_future = action_goal.cancel_goal_async()
                    cancel_limit = time.monotonic() + 5
                    while not cancel_future.done() and time.monotonic() < cancel_limit:
                        executor.spin_once(timeout_sec=.05)
                    if not cancel_future.done() or not cancel_future.result().goals_canceling:
                        raise RuntimeError('Action 取消未被服务端确认，请人工核对设备停止状态')
                    # 必须等待最终结果，否则只能判定停止未确认
                    result_limit = time.monotonic() + 5
                    while not result_future.done() and time.monotonic() < result_limit:
                        executor.spin_once(timeout_sec=.05)
                    if not result_future.done():
                        raise RuntimeError('Action 取消后未收到最终结果，请人工核对设备停止状态')
                    return 'CANCELED'
                executor.spin_once(timeout_sec=min(.05, remaining()))
            result = result_future.result()
            from action_msgs.msg import GoalStatus
            if feedback:
                feedback(_message_as_dict(result.result))
            return {'state': 'SUCCEEDED' if result.status == GoalStatus.STATUS_SUCCEEDED else 'CANCELED' if result.status == GoalStatus.STATUS_CANCELED else 'FAILED', 'response': _message_as_dict(result.result)}
        raise ValueError('unsupported ROS task')
    finally:
        if executor:
            executor.shutdown()
        if node:
            node.destroy_node()
        if owns_context:rclpy.shutdown(context=context)
