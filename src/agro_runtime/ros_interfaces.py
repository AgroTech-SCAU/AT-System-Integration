"""ROS interface reflection and native definition imports, without a running ROS graph."""
import ast
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re

from .errors import fail

TYPE = re.compile(r'^[A-Za-z]\w*/(msg|srv|action)/[A-Za-z]\w*$')
PRIMITIVES = {'bool': False, 'byte': 0, 'char': 0, 'float32': 0.0, 'float64': 0.0,
              **{name: 0 for name in ('int8','uint8','int16','uint16','int32','uint32','int64','uint64')}}


def _identity(ros_type):
    return 'schema_' + hashlib.sha256(ros_type.encode()).hexdigest()


def installed_schema(kind, ros_type):
    # Loading generated types does not initialise rclpy or contact DDS.
    from rosidl_runtime_py.utilities import get_message, get_service, get_action
    from rosidl_runtime_py.convert import message_to_ordereddict
    if kind == 'action':
        action = get_action(ros_type)
        request, response = action.Goal, action.Result
    elif kind == 'service':
        service = get_service(ros_type)
        request, response = service.Request, service.Response
    else:
        request = response = get_message(ros_type)
    result = {'fields': dict(message_to_ordereddict(request())), 'field_types': request.get_fields_and_field_types(),
              'output_fields': dict(message_to_ordereddict(response())), 'output_field_types': response.get_fields_and_field_types()}
    if kind == 'action':
        result.update(feedback_fields=dict(message_to_ordereddict(action.Feedback())),
                      feedback_field_types=action.Feedback.get_fields_and_field_types())
    return result


class InterfaceLibrary:
    def __init__(self, store, project_id=None):
        self.store = store
        self.project_id = project_id

    def configuration(self):
        return next((item for item in self.store.list('interface_catalog') if item['id'] == self.project_id),
                    {'id': self.project_id, 'schema_ids': [], 'sources': [], 'base_path': '', 'choices': {}})

    def saved(self):
        records = self.store.list('ros_schema') if self.store else []
        if self.project_id:
            active = set(self.configuration()['schema_ids'])
            return [item for item in records if item.get('project_id') == self.project_id and item.get('id') in active]
        return [item for item in records if not item.get('project_id')]

    def catalog(self):
        if self.project_id:
            primary = self.configuration().get('primary_types')
            return {'types': [{'ros_type': item['ros_type'], 'source': item.get('source', 'imported'),
                               'schema_id': item['id'], 'dependency': primary is not None and item['ros_type'] not in primary}
                              for item in self.saved()],
                    'configuration': self.configuration()}
        types = {item['ros_type']: {'ros_type': item['ros_type'], 'source': item.get('source', 'cached')}
                 for item in self.saved()}
        for prefix in os.environ.get('AMENT_PREFIX_PATH', '').split(os.pathsep):
            if not prefix:
                continue
            index = Path(prefix) / 'share/ament_index/resource_index/rosidl_interfaces'
            if not index.is_dir():
                continue
            for package in index.iterdir():
                if not package.is_file():
                    continue
                try:
                    if package.stat().st_size > 262144:
                        continue
                    for entry in package.read_text().splitlines():
                        parts = entry.strip().split('/')
                        if len(parts) == 2 and parts[0] in ('msg','srv','action'):
                            ros_type = package.name + '/' + parts[0] + '/' + Path(parts[1]).stem
                            if TYPE.fullmatch(ros_type):
                                types[ros_type] = {'ros_type': ros_type, 'source': 'installed'}
                except (OSError, UnicodeError):
                    continue
        return {'types': sorted(types.values(), key=lambda item: item['ros_type'])}

    def describe(self, kind, ros_type, schema_id=None):
        if not isinstance(ros_type, str) or not TYPE.fullmatch(ros_type):
            fail('$.ros_type','invalid_type','接口类型格式无效')
        expected = 'srv' if kind == 'service' else 'action' if kind == 'action' else 'msg'
        if ros_type.split('/')[1] != expected:
            fail('$.ros_type','kind_mismatch','接口类型与通信方式不匹配')
        if self.project_id:
            records = self.saved() if not schema_id else [self.store.get('ros_schema', schema_id)]
            saved = next((item for item in records if item['ros_type'] == ros_type and item.get('project_id') == self.project_id), None)
            if saved:
                return {**saved['schema'], 'source': saved.get('source', 'imported'), 'schema_id': saved['id']}
            fail('$.ros_type', 'type_not_found', '当前工程缺少接口定义，请在接口资源中添加工作区或导入定义文件')
        try:
            result = installed_schema(kind, ros_type)
        except (ImportError, AttributeError, ModuleNotFoundError, ValueError):
            saved = next((item for item in self.saved() if item['ros_type'] == ros_type), None)
            if saved:
                return {**saved['schema'], 'source': saved.get('source', 'cached')}
            fail('$.ros_type','type_not_found','未找到接口定义，请从本机已安装接口中选择或导入原生接口文件')
        if self.store:
            self.store.put('ros_schema', _identity(ros_type), {'ros_type': ros_type, 'schema': result, 'source': 'cached'})
        return {**result, 'source': 'installed'}

    def import_files(self, package, files):
        if not isinstance(package,str) or not re.fullmatch(r'[a-z][a-z0-9_]*',package):
            fail('$.package','invalid_package','填写 ROS 2 接口所属包名，仅使用小写字母、数字和下划线')
        if not isinstance(files,list) or not 1 <= len(files) <= 64:
            fail('$.files','invalid_files','每次导入 1 至 64 个原生接口文件')
        definitions = {}
        total = 0
        for item in files:
            name, content = item.get('name',''), item.get('content','')
            match = re.fullmatch(r'([A-Za-z]\w*)\.(msg|srv|action)',name)
            if not match or not isinstance(content,str):
                fail('$.files','invalid_definition','请选择 .msg、.srv 或 .action 原生接口文件')
            total += len(content.encode())
            if total > 262144:
                fail('$.files','definition_too_large','接口定义总大小不可超过 256 KiB')
            ros_type = package+'/'+match[2]+'/'+match[1]
            if ros_type in definitions:
                fail('$.files','duplicate_definition','导入文件中存在重复接口类型')
            definitions[ros_type] = content
        schemas = self.compile(definitions)
        if self.project_id:
            records = self.persist(definitions, schemas, 'imported')
            active = {item['ros_type']: item['id'] for item in self.saved()}
            active.update({item['ros_type']: item['id'] for item in records})
            configuration = self.configuration()
            self.store.put('interface_catalog', self.project_id, {**configuration, 'schema_ids': list(active.values()),
                'primary_types': sorted(set(configuration.get('primary_types', [])) | set(definitions))})
            return {'types': [{'ros_type': item['ros_type'], 'source': 'imported', 'schema_id': item['id']} for item in records]}
        self.store.put_many('ros_schema', [(_identity(ros_type), {'ros_type':ros_type,'schema':schema,'source':'imported'})
                                            for ros_type, schema in schemas.items()])
        return {'types':[{'ros_type':key,'source':'imported'} for key in schemas]}

    def persist(self, definitions, schemas, source, origins=None):
        available = {}
        for item in self.saved():
            available.update(item.get('definitions', {}))
        available.update(definitions)
        records = []
        for ros_type, schema in schemas.items():
            closure = {}
            def collect(identity):
                if identity in closure or identity not in available:
                    return
                closure[identity] = available[identity]
                package = identity.split('/')[0]
                for line in available[identity].splitlines():
                    fields = _without_comment(line).strip().split()
                    if len(fields) < 2 or fields[0] == '---':
                        continue
                    base = re.sub(r'\[.*\]$', '', fields[0])
                    if re.sub(r'<=\d+$', '', base) in PRIMITIVES or base.startswith(('string', 'wstring')):
                        continue
                    nested = base if '/msg/' in base else base.replace('/', '/msg/', 1) if '/' in base else package + '/msg/' + base
                    collect(nested)
            collect(ros_type)
            fingerprint = hashlib.sha256(json.dumps([schema, closure], sort_keys=True).encode()).hexdigest()
            identity = _identity(self.project_id + ':' + ros_type + ':' + fingerprint)
            records.append((identity, {'id': identity, 'project_id': self.project_id, 'ros_type': ros_type,
                                      'schema': schema, 'definition': definitions.get(ros_type),
                                      'definitions': closure, 'source': (origins or {}).get(ros_type, source)}))
        return self.store.put_many('ros_schema', records)

    def compile(self, definitions, allow_partial=False, saved_definitions=True):
        schemas, visiting, budget = {}, set(), [0, 0]
        saved = {item['ros_type']:item['schema'] for item in self.saved()} if saved_definitions else {}

        def resolve(ros_type):
            if ros_type in schemas:
                return schemas[ros_type]
            if ros_type not in definitions:
                if ros_type in saved:
                    return saved[ros_type]
                if self.project_id:
                    fail('$.files','missing_dependency','缺少依赖接口，请添加对应工作区：'+ros_type)
                try:
                    return installed_schema('publish_once',ros_type)
                except (ImportError, AttributeError, ModuleNotFoundError, ValueError):
                    fail('$.files','missing_dependency','缺少依赖接口，请一并导入其定义文件：'+ros_type)
            if len(visiting) >= 16:
                fail('$.files','definition_too_deep','嵌套消息最多支持 16 层')
            if ros_type in visiting:
                fail('$.files','recursive_definition','接口定义包含无法展开的递归字段：'+ros_type)
            visiting.add(ros_type)
            sections = re.split(r'^\s*---\s*(?:#.*)?$', definitions[ros_type], flags=re.M)
            kind = ros_type.split('/')[1]
            count = {'msg':1,'srv':2,'action':3}[kind]
            if len(sections) != count:
                fail('$.files','invalid_sections','接口分段不正确：'+ros_type)
            values = [_section(section,ros_type.split('/')[0],resolve,budget) for section in sections]
            schema = {'fields':values[0][0], 'field_types':values[0][1],
                      'output_fields':values[1 if count>1 else 0][0], 'output_field_types':values[1 if count>1 else 0][1]}
            if count == 3:
                schema.update(feedback_fields=values[2][0], feedback_field_types=values[2][1])
            visiting.remove(ros_type)
            try:
                schema_size = len(json.dumps(schema,ensure_ascii=False,allow_nan=False))
            except (ValueError,TypeError):
                fail('$.files','invalid_default','接口默认值必须是有限 JSON 数据')
            if schema_size > 262144:
                fail('$.files','schema_too_large','接口展开后的字段定义不可超过 256 KiB')
            schemas[ros_type] = schema
            return schema

        diagnostics = []
        for ros_type in definitions:
            try:
                resolve(ros_type)
            except Exception as exc:
                from .errors import ContractValidationError
                if not allow_partial or not isinstance(exc, ContractValidationError):
                    raise
                diagnostics.extend({'ros_type': ros_type, 'code': issue.code, 'reason': issue.reason} for issue in exc.issues)
            finally:
                visiting.clear()
                budget[:] = [0, 0]
        return (schemas, diagnostics) if allow_partial else schemas


def _without_comment(line):
    quote, escaped = None, False
    for index, char in enumerate(line):
        if escaped:
            escaped = False
        elif char == '\\':
            escaped = True
        elif quote:
            if char == quote: quote = None
        elif char in ('"', "'"):
            quote = char
        elif char == '#':
            return line[:index]
    return line


def _section(text, package, resolve, budget):
    fields, types = {}, {}
    for line in text.splitlines():
        line = _without_comment(line).strip()
        if not line:
            continue
        match = re.fullmatch(r'(\S+)\s+([A-Za-z][A-Za-z0-9_]*)(?:\s*(.*))?', line)
        if not match:
            fail('$.files','invalid_field','无法读取接口字段：'+line[:100])
        type_name, name, default = match.groups()
        if default and default.startswith('='):
            continue  # Constants are type metadata, not message fields.
        if name in fields or len(fields) >= 256:
            fail('$.files','invalid_field','接口字段重复或超过 256 项')
        array = re.fullmatch(r'(.+)\[(?:(<=)?(\d+))?\]',type_name)
        base = array[1] if array else type_name
        def scalar():
            budget[0] += 1
            if budget[0] > 4096:
                fail('$.files','schema_too_large','接口展开后的字段数量不可超过 4096 项')
            primitive = re.sub(r'<=\d+$','',base)
            if primitive in PRIMITIVES:
                return PRIMITIVES[primitive]
            if primitive in ('string','wstring'):
                return ''
            nested = base if '/msg/' in base else base.replace('/','/msg/',1) if '/' in base else package+'/msg/'+base
            nested_fields = resolve(nested)['fields']
            budget[1] += len(json.dumps(nested_fields,ensure_ascii=False))
            if budget[1] > 1048576:
                fail('$.files','schema_too_large','接口展开后的字段定义不可超过 256 KiB')
            return copy.deepcopy(nested_fields)
        if array:
            length = int(array[3]) if array[3] and not array[2] else 0
            if length > 256:
                fail('$.files','array_too_large','固定长度数组最多支持 256 个表单元素')
            element = scalar()
            value = [copy.deepcopy(element) for _ in range(length)]
        else:
            value = scalar()
        if default:
            try:
                tree = ast.parse(default, mode='eval')
                if base == 'bool':
                    tree = _BooleanNames().visit(tree)
                value = ast.literal_eval(tree)
            except (ValueError,SyntaxError):
                if base.startswith(('string','wstring')):
                    value = default
                else:
                    fail('$.files','invalid_default','无法读取接口默认值：'+name)
        _validate_default(value, type_name, package, resolve, name)
        fields[name], types[name] = value, type_name
    return fields, types


class _BooleanNames(ast.NodeTransformer):
    def visit_Name(self, node):
        if node.id in ('true', 'false'):
            return ast.copy_location(ast.Constant(node.id == 'true'), node)
        return node


def _validate_default(value, type_name, package, resolve, field, depth=0):
    type_name = {'boolean':'bool','float':'float32','double':'float64','octet':'byte'}.get(type_name,type_name)
    sequence = re.fullmatch(r'(?:bounded_)?sequence<(.+?)(?:,\s*(\d+))?>',type_name)
    if sequence:
        type_name = sequence[1] + ('[<='+sequence[2]+']' if sequence[2] else '[]')
    def invalid():
        fail('$.files','invalid_default','无法读取接口默认值：'+field)
    if depth > 16:
        invalid()
    array = re.fullmatch(r'(.+)\[(?:(<=)?(\d+))?\]',type_name)
    if array:
        if not isinstance(value,list) or len(value) > 4096:
            invalid()
        bound = int(array[3]) if array[3] else None
        if bound is not None and (len(value) > bound if array[2] else len(value) != bound):
            invalid()
        for item in value:
            _validate_default(item,array[1],package,resolve,field,depth+1)
        return
    string = re.fullmatch(r'(w?string)(?:<=(\d+))?',type_name)
    if string:
        if not isinstance(value,str) or string[2] and len(value) > int(string[2]):
            invalid()
        return
    if type_name == 'bool':
        if type(value) is not bool:
            invalid()
        return
    integer = re.fullmatch(r'(u?)int(8|16|32|64)',type_name)
    if integer or type_name in ('byte','char'):
        signed = bool(integer and not integer[1])
        bits = int(integer[2]) if integer else 8
        minimum, maximum = (-(1 << (bits-1)), (1 << (bits-1))-1) if signed else (0,(1 << bits)-1)
        if type(value) is not int or not minimum <= value <= maximum:
            invalid()
        return
    if type_name in ('float32','float64'):
        maximum = 3.4028234663852886e38 if type_name == 'float32' else 1.7976931348623157e308
        if type(value) not in (int,float) or not -maximum <= value <= maximum or not math.isfinite(value):
            invalid()
        return
    nested = type_name if '/msg/' in type_name else type_name.replace('/','/msg/',1) if '/' in type_name else package+'/msg/'+type_name
    schema = resolve(nested)
    if not isinstance(value,dict) or set(value) != set(schema['field_types']):
        invalid()
    for name, nested_type in schema['field_types'].items():
        _validate_default(value[name],nested_type,nested.split('/')[0],resolve,field+'.'+name,depth+1)
