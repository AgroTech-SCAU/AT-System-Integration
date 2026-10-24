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
    if data.get('icon_mode', 'manual') not in ('workspace', 'manual'):
        fail('$.icon_mode', 'invalid_icon', '任务图标模式无效')
    if data.get('icon', 'generic') not in ('generic', 'navigation', 'arm', 'vision', 'operations', 'mechanical', 'electrical'):
        fail('$.icon', 'invalid_icon', '请选择任务图标')
    if 'workspace_ids' in data:
        workspace_ids = data['workspace_ids']
        if not isinstance(workspace_ids, list) or len(workspace_ids) > 64 or any(not isinstance(identity, str) for identity in workspace_ids) or len(set(workspace_ids)) != len(workspace_ids):
            fail('$.workspace_ids', 'invalid_workspaces', '子系统 ROS2 工作区选择必须是不重复的标识列表')
    labels = data.get('resource_labels', {})
    if not isinstance(labels, dict) or any(not isinstance(key, str) or not isinstance(value, str) or not 1 <= len(value.strip()) <= 80 for key, value in labels.items()):
        fail('$.resource_labels', 'invalid_resources', '请填写设备或互斥对象名称')
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


def validate_task_schema(data, schema):
    """Check payloads and active field references against the selected immutable schema."""
    from .ros_interfaces import validate_schema_value
    if not schema or 'field_schemas' not in schema:
        return
    request = {'kind': 'object', 'fields': schema['field_schemas']}
    response = {'kind': 'object', 'fields': schema.get('output_field_schemas', schema['field_schemas'])}
    validate_schema_value(data.get('payload', {}), request, '$.payload')
    if data.get('kind') == 'publish_periodic':
        validate_schema_value(data.get('stop_payload', {}), request, '$.stop_payload')

    def descriptor_at(path, descriptor, location):
        if path == '$':
            return descriptor
        if not isinstance(path, str) or not path:
            fail(location, 'missing_schema_field', '请选择接口中存在的字段')
        for part in path.split('.'):
            if descriptor['kind'] == 'object' and part in descriptor.get('fields', {}):
                descriptor = descriptor['fields'][part]
            elif descriptor['kind'] == 'array' and part.isdigit():
                bound = descriptor.get('length', descriptor.get('max_length'))
                if bound is not None and int(part) >= bound:
                    fail(location, 'invalid_array_index', '字段路径的数组索引超出接口边界：' + path)
                descriptor = descriptor['item']
            else:
                fail(location, 'missing_schema_field', '接口中不存在此字段路径：' + path)
        return descriptor

    for path in data.get('input_bindings', {}):
        descriptor = descriptor_at(path, request, '$.input_bindings.' + path)
        contract = data['inputs'][data['input_bindings'][path]]
        _check_field_contract(contract, descriptor, '$.input_bindings.' + path)
        if path == '$' and len(data['input_bindings']) != 1:
            fail('$.input_bindings', 'invalid_root_binding', '完整消息绑定需要单个 JSON 对象输入')
    for port, path in data.get('output_bindings', {}).items():
        descriptor = descriptor_at(path, response, '$.output_bindings.' + port)
        _check_field_contract(data['outputs'][port], descriptor, '$.output_bindings.' + port)
    for name in ('condition', 'success_condition'):
        condition = data.get(name, {})
        if name == 'condition' and data.get('kind') != 'subscribe_wait' or condition.get('operator', 'any') == 'any':
            continue
        descriptor = descriptor_at(condition.get('field'), response, '$.' + name + '.field')
        if condition.get('operator') in ('greater', 'less') and descriptor['kind'] not in ('integer', 'number'):
            fail('$.' + name + '.field', 'invalid_comparison_field', '大小比较需要选择数值字段')
        validate_schema_value(condition.get('value'), descriptor, '$.' + name + '.value')


def _check_field_contract(contract, descriptor, path):
    from .data_contracts import wire_shape
    extension = contract.get('extensions', {})
    if extension.get('ros_type'):
        expected = descriptor['kind'] if descriptor['kind'] not in ('object', 'array') else 'json'
        if contract['type'] != expected or extension['ros_type'] != descriptor.get('type') or extension.get('ros_shape') != wire_shape(descriptor):
            fail(path, 'field_contract_changed', '字段类型或结构已变化，请重新选择对应的输入输出字段')
        if descriptor.get('unit') and contract.get('unit') != descriptor['unit']:
            fail(path, 'field_unit_mismatch', '端口单位与已确认的字段单位不同')


def prepared_task(data, inputs=None, schema=None):
    prepared = copy.deepcopy(data)
    schema = schema or data.get('interface_schema')
    if schema:
        validate_task_schema(prepared, schema)
    if schema and 'field_schemas' in schema and data.get('input_bindings'):
        def with_defaults(value, descriptor):
            if descriptor['kind'] == 'object':
                return {name: with_defaults(value.get(name, copy.deepcopy(field.get('default'))), field)
                        for name, field in descriptor.get('fields', {}).items()}
            if descriptor['kind'] == 'array':
                return [with_defaults(item, descriptor['item']) for item in value]
            return value
        prepared['payload'] = with_defaults(prepared.get('payload', {}), {'kind': 'object', 'fields': schema['field_schemas']})
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
                if int(part) >= len(target):
                    fail('$.input_bindings.'+path, 'invalid_field_path', '输入映射的数组元素尚未配置')
                target = target[int(part)]
            elif isinstance(target, dict):
                target = target.setdefault(part, {})
            else:
                fail('$.input_bindings.'+path, 'invalid_field_path', '输入映射无法写入消息字段')
        last = parts[-1]
        if isinstance(target, list) and last.isdigit():
            if int(last) >= len(target):
                fail('$.input_bindings.'+path, 'invalid_field_path', '输入映射的数组元素尚未配置')
            target[int(last)] = copy.deepcopy(values[key])
        elif isinstance(target, dict):
            target[last] = copy.deepcopy(values[key])
        else:
            fail('$.input_bindings.'+path, 'invalid_field_path', '输入映射无法写入消息字段')
    if schema:
        validate_task_schema(prepared, schema)
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
        from .interface_sources import InterfaceWorkspaces
        InterfaceWorkspaces(self.store, key).migrate()
        return [self._bound(task) for task in self.store.list('ros_task') if task.get('robot_system_id') == key]

    def _bound(self, task):
        binding = next((item for item in self.store.list('ros_binding')
                        if item['task_id'] == task['id'] and item['robot_system_id'] == self._robot()), None)
        result = {**task, 'interface': binding['interface'] if binding else task.get('interface', '')}
        if task.get('icon_mode') == 'workspace':
            first = next(iter(task.get('workspace_ids', [])), None)
            workspace = next((item for item in self.store.list('interface_workspace')
                              if item['id'] == first and item.get('project_id') == self._robot()), None)
            result['icon'] = workspace.get('icon', 'generic') if workspace else 'generic'
        return result

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
        from .interface_sources import InterfaceWorkspaces
        workspaces = InterfaceWorkspaces(self.store, key)
        workspaces.migrate()
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
        data.setdefault('workspace_ids', old.get('workspace_ids', []) if old else workspaces.catalog()['default_workspace_ids'])
        workspaces.selection(data['workspace_ids'])
        preserved_snapshot = bool(old and old.get('schema_id') and data.get('schema_id') == old.get('schema_id')
                                  and data['ros_type'] == old['ros_type']
                                  and set(data['workspace_ids']) == set(old.get('workspace_ids', [])))
        selected_type = None
        if not preserved_snapshot:
            resolution = workspaces.require_resolved(data['workspace_ids'])
            selected_type = next((item for item in resolution['types'] if item['ros_type'] == data['ros_type'] and item.get('available', True)), None)
            if data['workspace_ids']:
                if data.get('schema_id') and (not selected_type or selected_type['schema_id'] != data['schema_id']):
                    from .ros_interfaces import normalized_definition
                    requested = self.store.get('ros_schema', data['schema_id'])
                    resolved = self.store.get('ros_schema', selected_type['schema_id']) if selected_type else None
                    canonical = lambda record: {name: normalized_definition(name, value) for name, value in record.get('definitions', {}).items()}
                    if not resolved or requested.get('project_id') != key or requested.get('ros_type') != data['ros_type'] or canonical(requested) != canonical(resolved):
                        fail('$.schema_id', 'workspace_schema_mismatch', '接口定义不属于所选工作区，请重新选择接口')
                if selected_type:
                    data['schema_id'] = selected_type['schema_id']
            elif data.get('schema_id'):
                fail('$.workspace_ids', 'missing_workspace', '请为接口选择所属工作区')
        data.update(id=identity, robot_system_id=key, revision=old['revision'] + 1 if old else 1)
        from .ros_interfaces import InterfaceLibrary
        try:
            if not data['ros_type'] or not preserved_snapshot and not selected_type:
                fail('$.ros_type', 'type_not_found', '任务尚未选择接口类型')
            schema = InterfaceLibrary(self.store, key).describe(data['kind'], data['ros_type'], data.get('schema_id'))
            data['schema_id'] = schema['schema_id']
            validate_task_schema(data, schema)
        except ContractValidationError as exc:
            if data.get('schema_id') or any(issue.code != 'type_not_found' for issue in exc.issues):
                raise
        previous_interface = self._bound(old)['interface'] if old else ''
        # An omitted endpoint must never carry an old communication contract into a new one
        contract_changed = old and any(data.get(field) != old.get(field) for field in ('kind', 'ros_type', 'schema_id'))
        interface = data.pop('interface', '' if contract_changed else previous_interface)
        self.store.put('ros_task', identity, data)
        self.bind(identity, interface)
        return self.get(identity)

    def validate_task_workspaces(self, tasks):
        """Validate frozen dependency closures together without touching ROS or DDS."""
        from .ros_interfaces import InterfaceLibrary, normalized_definition
        definitions, owners = {}, {}
        key = self._robot()
        for value in tasks:
            task = self.get(value.removeprefix('ros:')) if isinstance(value, str) else value
            if not isinstance(task, dict):
                fail('$.tasks', 'invalid_task', '流程包含无效任务定义')
            if task.get('robot_system_id', key) != key:
                fail('$.tasks', 'ownership', '流程任务不属于当前机器人')
            self.require_snapshot(task)
            if task.get('schema_id'):
                record = self.store.get('ros_schema', task['schema_id'])
            elif task.get('ros_type'):
                schema = InterfaceLibrary(self.store, key).describe(task['kind'], task['ros_type'])
                record = self.store.get('ros_schema', schema['schema_id'])
            else:
                fail('$.tasks', 'missing_interface', '任务尚未选择接口类型：' + task.get('name', task.get('id', '')))
            if record.get('project_id') != key:
                fail('$.tasks', 'ownership', '任务接口定义不属于当前机器人')
            label = task.get('name') or task.get('id', '')
            for ros_type, content in record.get('definitions', {}).items():
                normalized = normalized_definition(ros_type, content)
                if ros_type in definitions and definitions[ros_type] != normalized:
                    fail('$.tasks', 'task_interface_conflict', '流程任务接口定义冲突：' + owners[ros_type] + ' / ' + label + ' · ' + ros_type)
                definitions[ros_type], owners[ros_type] = normalized, label

    def copy(self, identity, name):
        original = self.get(identity)
        data = validate_task({**original, 'name': name})
        data.update(id='ros_' + uuid4().hex, revision=1)
        interface = data.pop('interface', '')
        self.store.put('ros_task', data['id'], data)
        self.bind(data['id'], interface)
        return self.get(data['id'])

    def uses(self):
        robot = self._robot()
        result = {}
        phases = {'entry': '进入', 'do': '持续', 'exit': '退出'}
        for machine in self.store.list('state_machine'):
            if machine.get('robot_system_id') != robot:
                continue
            for state in machine['document']['states']:
                for phase, label in phases.items():
                    ref = state.get(phase) or ''
                    if ref.startswith('ros:'):
                        result.setdefault(ref[4:], []).append({'kind': 'state', 'name': machine['name'], 'detail': state['label'] + ' / ' + label})
        drafts = [item for item in self.store.list('tree_draft') if item.get('robot_system_id') == robot]
        draft_ids = {item['id'] for item in drafts}
        records = drafts + [item for item in self.store.list('tree_definition') if item.get('draft_id') not in draft_ids]
        for record in records:
            if record.get('robot_system_id') != robot or record.get('archived') or record.get('test_only'):
                continue
            for tree in record.get('document', {}).get('trees', {}).values():
                for node in tree.get('nodes', {}).values():
                    ref = node['registration_id']
                    if ref.startswith('RosTask_'):
                        result.setdefault(ref[8:], []).append({'kind': 'tree', 'name': record.get('name') or record['document']['main_tree_id'], 'detail': record.get('layout', {}).get('labels', {}).get(node['editor_id']) or tree['tree_id']})
        return result

    def resources(self):
        values = {item['name']: item for item in self.store.list('ros_resource') if item.get('robot_system_id') == self._robot()}
        for task in self.list():
            for resource in task.get('resources', []):
                name = resource['name']
                values.setdefault(name, {'name': name, 'label': task.get('resource_labels', {}).get(name, name)})
        return list(values.values())

    def resource(self, label):
        label = label.strip()
        if not label:
            fail('$.name', 'invalid_name', '请填写设备或互斥对象名称')
        existing = next((item for item in self.resources() if item['label'].casefold() == label.casefold()), None)
        if existing:
            return existing
        name = 'resource_' + uuid4().hex
        return self.store.put('ros_resource', name, {'id': name, 'name': name, 'label': label, 'robot_system_id': self._robot()})

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

    @staticmethod
    def require_snapshot(data):
        if data.get('workspace_ids') and not data.get('schema_id'):
            fail('$.ros_type', 'definition_incomplete', '任务接口定义尚未补齐，请补齐依赖后重新保存任务：' + data.get('name', ''))

    def freeze(self, identity):
        data = self.get(identity)
        self.require_snapshot(data)
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
        expected = self.validate_structure(data)
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

    def validate_structure(self, data):
        validate_task(data)
        self.require_snapshot(data)
        schema = data.get('interface_schema')
        if not schema or 'field_schemas' not in schema:
            schema = self.describe(data['kind'], data['ros_type'], data.get('schema_id'))
        validate_task_schema(data, schema)
        return schema

    async def run(self, task_id, stop: threading.Event, feedback=None, *, definition=None, inputs=None):
        original = definition if definition is not None else self.get(task_id)
        data = prepared_task(original, inputs, self.validate_structure(original))
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
    if cond.get('field') != '$':
        for segment in cond.get('field', '').split('.'):
            if isinstance(value, dict) and segment in value:
                value = value[segment]
            elif isinstance(value, list) and segment.isdigit() and int(segment) < len(value):
                value = value[int(segment)]
            else:
                return False
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
