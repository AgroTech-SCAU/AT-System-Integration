"""Read ROS declarations without importing packages or executing launch files."""
import ast
import hashlib
import os
from pathlib import Path
import re
import xml.etree.ElementTree as ET

import yaml


def _id(value):
    return hashlib.sha256(value.encode()).hexdigest()[:20]


def _name(value):
    return isinstance(value, str) and bool(re.fullmatch(r'/?[A-Za-z_][\w/]*', value)) and '//' not in value


def _arguments(text, start):
    """Split a call, preserving nested expressions and quoted commas."""
    parts, depth, begin, quote, escape = [], 0, start, '', False
    for i in range(start, len(text)):
        c = text[i]
        if quote:
            if escape:
                escape = False
            elif c == '\\':
                escape = True
            elif c == quote:
                quote = ''
            continue
        if c in '\"\'':
            quote = c
        elif c in '([{':
            depth += 1
        elif c in ')]}':
            if c == ')' and depth == 0:
                return parts + [text[begin:i].strip()]
            depth -= 1
        elif c == ',' and depth == 0:
            parts.append(text[begin:i].strip())
            begin = i + 1
    return []


def _literal(value):
    """Read scalar names/defaults, never interpret C++ containers as Python sets."""
    try:
        node = ast.parse(value.strip(), mode='eval').body
        if isinstance(node, ast.Constant) and isinstance(node.value, (str, bool, int, float)):
            return node.value
        if (isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub))
                and isinstance(node.operand, ast.Constant) and type(node.operand.value) in (int, float)):
            return ast.literal_eval(node)
    except (ValueError, SyntaxError, TypeError, RecursionError, OverflowError):
        return None
    return None


def _type(value, aliases):
    value = value.strip()
    for _ in range(8):
        if value not in aliases:
            break
        value = aliases[value]
    value = value.replace('::', '/').replace('.', '/')
    return value if re.fullmatch(r'\w+/(msg|srv|action)/\w+', value) else ''


def _cpp(text):
    text = re.sub(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\n]*|/\*.*?\*/',
                  lambda m: '\n' * m[0].count('\n') + ' ' if m[0].startswith(('//', '/*')) else m[0], text, flags=re.S)
    aliases = dict(re.findall(r'\busing\s+(\w+)\s*=\s*([\w:]+)\s*;', text))
    values, parameters = {}, {}
    defaults = {}
    for match in re.finditer(r'\bdeclare_parameter(?:<[^;\n]*?>)?\s*\(', text):
        args = _arguments(text, match.end())
        if len(args) >= 2 and isinstance(_literal(args[0]), str):
            defaults[_literal(args[0])] = _literal(args[1])
    for match in re.finditer(r'(\w+)\s*=\s*(?:\w+(?:->|\.))?declare_parameter(?:<[^;\n]*?>)?\s*\(', text):
        args = _arguments(text, match.end())
        if args and isinstance(_literal(args[0]), str):
            parameters[match[1]] = _literal(args[0])
            values[match[1]] = _literal(args[1]) if len(args) > 1 else None
    for match in re.finditer(r'(\w+)\s*=\s*(?:[\w:]+(?:->|\.))?get_parameter\s*\(', text):
        args = _arguments(text, match.end())
        if args and isinstance(_literal(args[0]), str):
            parameters[match[1]] = _literal(args[0])
            values[match[1]] = defaults.get(_literal(args[0]))
    for match in re.finditer(r'\bget_parameter\s*\(', text):
        args = _arguments(text, match.end())
        if len(args) == 2 and isinstance(_literal(args[0]), str) and re.fullmatch(r'\w+', args[1]):
            parameters[args[1]] = _literal(args[0])
            values[args[1]] = defaults.get(_literal(args[0]))
    for match in re.finditer(r'(\w+)\s*=\s*("(?:\\.|[^"\\])*")\s*;', text):
        value = _literal(match[2])
        if isinstance(value, str):
            values[match[1]] = value
    node_names = re.findall(r'(?:make_shared\s*<\s*rclcpp::Node\s*>|\bNode)\s*\(\s*"([^"\n]+)"', text)
    node_name = node_names[0] if len(set(node_names)) == 1 else ''
    pattern = r'(?:(rclcpp_action)::)?\b(create_publisher|create_subscription|create_service|create_client|create_server)\s*<\s*([\w:]+)\s*>\s*\('
    for match in re.finditer(pattern, text):
        action, method, raw_type = match.groups()
        resolved_type = _type(raw_type, aliases)
        action = bool(action) or '/action/' in resolved_type and method in ('create_client', 'create_server')
        args = _arguments(text, match.end())
        index = 1 if action else 0
        if len(args) <= index:
            continue
        expression = args[index]
        token = expression.removeprefix('this->')
        name = _literal(expression)
        if name is None:
            name = values.get(token)
        kind = 'action' if action else 'topic' if method in ('create_publisher', 'create_subscription') else 'service'
        yield {'kind': kind, 'role': {'create_publisher': 'publisher', 'create_subscription': 'subscriber', 'create_service': 'server', 'create_server': 'server', 'create_client': 'client'}[method],
               'ros_type': resolved_type, 'name': name if isinstance(name, str) else '',
               'expression': expression[:300], 'parameter': parameters.get(token, ''), 'node': node_name,
               'line': text.count('\n', 0, match.start()) + 1}


def _python(text):
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return
    aliases, values, parameters = {}, {}, {}
    node_names = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                aliases[alias.asname or alias.name] = node.module + '.' + alias.name
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    aliases[alias.asname] = alias.name
        if isinstance(node, ast.Call):
            func = ast.unparse(node.func)
            if func.endswith(('.__init__', 'Node', 'create_node')) and node.args:
                name = _literal(ast.unparse(node.args[0]))
                if isinstance(name, str):
                    node_names.append(name)
            if func.endswith('declare_parameter') and len(node.args) >= 2:
                key, value = map(lambda x: _literal(ast.unparse(x)), node.args[:2])
                if isinstance(key, str):
                    parameters[key] = value
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if node.value:
                for target in targets:
                    values[ast.unparse(target)] = node.value
    dictionaries = {}
    for name, value in values.items():
        if isinstance(value, ast.Dict):
            dictionaries[name] = {_literal(ast.unparse(k)): _literal(ast.unparse(v)) for k, v in zip(value.keys, value.values) if k is not None}
    # Recognise declaration loops and parameter dictionaries without executing source
    for loop in (n for n in ast.walk(tree) if isinstance(n, ast.For)):
        if isinstance(loop.iter, ast.Call) and isinstance(loop.iter.func, ast.Attribute) and loop.iter.func.attr == 'items':
            source = dictionaries.get(ast.unparse(loop.iter.func.value), {})
            if isinstance(loop.target, (ast.Tuple, ast.List)) and len(loop.target.elts) == 2:
                key, value = map(ast.unparse, loop.target.elts)
                for call in (n for n in ast.walk(loop) if isinstance(n, ast.Call)):
                    if ast.unparse(call.func).endswith('declare_parameter') and len(call.args) >= 2 and ast.unparse(call.args[0]) == key and ast.unparse(call.args[1]) == value:
                        parameters.update({k:v for k,v in source.items() if isinstance(k,str)})
    parameter_maps = {}
    for name, value in values.items():
        if isinstance(value, ast.DictComp) and len(value.generators) == 1:
            generator = value.generators[0]
            if ast.unparse(value.key) != ast.unparse(generator.target):
                continue
            source = dictionaries.get(ast.unparse(generator.iter), {})
            if any(isinstance(n,ast.Call) and ast.unparse(n.func).endswith('get_parameter') and n.args and ast.unparse(n.args[0]) == ast.unparse(value.key) for n in ast.walk(value.value)):
                parameter_maps[name] = source
    def resolve(node, seen=None):
        seen = seen or set()
        expr = ast.unparse(node)
        if expr in seen:
            return None, ''
        seen.add(expr)
        literal = _literal(expr)
        if literal is not None:
            return literal, ''
        if isinstance(node,ast.Subscript):
            name, key = ast.unparse(node.value), _literal(ast.unparse(node.slice))
            if isinstance(key,str) and name in parameter_maps and key in parameter_maps[name]:
                return parameters.get(key), key
            if isinstance(key,str) and key in dictionaries.get(name,{}):
                return dictionaries[name][key], ''
        if expr in values:
            return resolve(values[expr], seen)
        for call in ast.walk(node):
            if isinstance(call, ast.Call) and ast.unparse(call.func).endswith(('get_parameter', 'declare_parameter')) and call.args:
                key = _literal(ast.unparse(call.args[0]))
                if isinstance(key, str):
                    return parameters.get(key), key
        return None, ''
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = ast.unparse(node.func).split('.')[-1]
        func = aliases.get(func, func).split('.')[-1]
        if func not in ('create_publisher', 'create_subscription', 'create_service', 'create_client', 'ActionServer', 'ActionClient'):
            continue
        action = func in ('ActionServer', 'ActionClient')
        keys = {item.arg: item.value for item in node.keywords}
        index = 1 if action else 0
        type_node = node.args[index] if len(node.args) > index else keys.get('action_type' if action else 'msg_type' if func in ('create_publisher', 'create_subscription') else 'srv_type')
        name_node = node.args[index + 1] if len(node.args) > index + 1 else keys.get('action_name' if action else 'topic' if func in ('create_publisher', 'create_subscription') else 'srv_name')
        if type_node is None or name_node is None:
            continue
        name, parameter = resolve(name_node)
        raw_type = ast.unparse(type_node)
        if '.' in raw_type and raw_type.split('.')[0] in aliases:
            raw_type = aliases[raw_type.split('.')[0]] + raw_type[raw_type.index('.'):]
        yield {'kind': 'action' if action else 'topic' if func in ('create_publisher', 'create_subscription') else 'service',
               'role': 'publisher' if func == 'create_publisher' else 'subscriber' if func == 'create_subscription' else 'client' if func in ('create_client', 'ActionClient') else 'server',
               'ros_type': _type(raw_type, aliases), 'name': name if isinstance(name, str) else '', 'parameter': parameter,
               'expression': ast.unparse(name_node)[:300], 'node': node_names[0] if len(set(node_names)) == 1 else '', 'line': node.lineno}


def _yaml_parameters(text):
    try:
        data = yaml.safe_load(text)
    except (yaml.YAMLError, ValueError, RecursionError):
        return []
    found = []
    def walk(value, prefix='', depth=0):
        if depth > 12 or not isinstance(value, dict):
            return
        if isinstance(value.get('ros__parameters'), dict):
            found.append((prefix, value['ros__parameters']))
        else:
            for key, item in value.items():
                walk(item, prefix.rstrip('/') + '/' + str(key).lstrip('/'), depth + 1)
    walk(data)
    return found


def _launch(text, packages, supplied):
    """Conservative static evaluator for ordinary launch Node declarations."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return [], []
    env, arguments = {}, {}
    helpers = {n.name:n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and len(n.body)==1 and isinstance(n.body[0],ast.Return)}
    def evaluate(node, depth=0):
        if node is None or depth > 20:
            return None
        ev = lambda n: evaluate(n, depth + 1)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return env.get(node.id)
        if isinstance(node, (ast.List, ast.Tuple)):
            return [ev(item) for item in node.elts]
        if isinstance(node, ast.Dict):
            return {ev(k): ev(v) for k, v in zip(node.keys, node.values) if isinstance(ev(k), str)}
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Div)):
            left, right = ev(node.left), ev(node.right)
            if isinstance(left, str) and isinstance(right, str):
                return left + right if isinstance(node.op, ast.Add) else str(Path(left) / right)
        if isinstance(node, ast.Call):
            name = ast.unparse(node.func).split('.')[-1]
            args = [ev(arg) for arg in node.args]
            kwargs = {kw.arg: ev(kw.value) for kw in node.keywords}
            if name in helpers and len(args) == len(helpers[name].args.args):
                old = dict(env)
                env.update({parameter.arg:value for parameter,value in zip(helpers[name].args.args,args)})
                try: return ev(helpers[name].body[0].value)
                finally: env.clear(); env.update(old)
            if name == 'ParameterValue' and args:
                return args[0]
            if name == 'LaunchConfiguration' and args and isinstance(args[0], str):
                key = args[0]
                arguments.setdefault(key, kwargs.get('default'))
                return supplied.get(key, arguments.get(key))
            if name in ('get_package_share_directory', 'FindPackageShare') and args and isinstance(args[0], str):
                return packages.get(args[0])
            if name in ('join', 'PathJoinSubstitution'):
                parts = args[0] if name == 'PathJoinSubstitution' and args else args
                if isinstance(parts, list) and parts and all(isinstance(v, str) for v in parts):
                    return os.path.join(*parts)
            if name in ('str', 'TextSubstitution', 'Path'):
                return args[0] if args else kwargs.get('text')
        return None
    # Defaults can be declared after their LaunchConfiguration use in source order
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and ast.unparse(node.func).endswith('DeclareLaunchArgument') and node.args:
            name = evaluate(node.args[0])
            default = next((evaluate(kw.value) for kw in node.keywords if kw.arg == 'default_value'), None)
            if isinstance(name, str):
                arguments[name] = default
    assignments = sorted((n for n in ast.walk(tree) if isinstance(n, (ast.Assign, ast.AnnAssign))), key=lambda n: n.lineno)
    for _ in range(3):
        for node in assignments:
            for target in node.targets if isinstance(node, ast.Assign) else [node.target]:
                if isinstance(target, ast.Name):
                    env[target.id] = evaluate(node.value)
    nodes = []
    assigned = {target.id: n.value for n in assignments for target in (n.targets if isinstance(n, ast.Assign) else [n.target]) if isinstance(target, ast.Name)}
    def contains(expression, target, seen=None):
        seen = seen or set()
        for child in ast.walk(expression):
            if child is target:
                return True
            if isinstance(child, ast.Name) and child.id in assigned and child.id not in seen:
                if contains(assigned[child.id], target, seen | {child.id}):
                    return True
        return False
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or ast.unparse(node.func).split('.')[-1] != 'Node':
            continue
        values = {kw.arg: evaluate(kw.value) for kw in node.keywords}
        unknown = [kw.arg for kw in node.keywords if values[kw.arg] is None or kw.arg == 'condition']
        groups = [group for group in ast.walk(tree) if isinstance(group, ast.Call) and ast.unparse(group.func).split('.')[-1] == 'GroupAction']
        scoped = [action for action in ast.walk(tree) if isinstance(action, ast.Call) and ast.unparse(action.func).split('.')[-1] in ('PushRosNamespace', 'SetRemap')]
        if any(not any(contains(group, action) for group in groups) for action in scoped):
            unknown.append('global namespace / remapping')
        for group in ast.walk(tree):
            if not isinstance(group, ast.Call) or ast.unparse(group.func).split('.')[-1] != 'GroupAction' or not contains(group, node):
                continue
            for action in ast.walk(group):
                if isinstance(action, ast.Call) and ast.unparse(action.func).split('.')[-1] in ('PushRosNamespace', 'SetRemap'):
                    unknown.append('group namespace / remapping')
        nodes.append({**values, 'unknown': unknown, 'line': node.lineno})
    return nodes, [{'name': key, 'default': value, 'value': supplied.get(key, value)} for key, value in arguments.items()]


def _xml_launch(text, packages, supplied):
    try:
        tree = ET.fromstring(text)
    except ET.ParseError:
        return [], []
    defaults = {item.get('name'): item.get('default') for item in tree.iter('arg') if item.get('name')}
    def value(raw):
        if raw is None:
            return None
        def substitute(match):
            kind, key = match[1], match[2]
            result = packages.get(key) if kind == 'find-pkg-share' else supplied.get(key, defaults.get(key))
            return str(result) if result is not None else match[0]
        result = re.sub(r'\$\((var|find-pkg-share)\s+([^()]+)\)', substitute, raw)
        return None if '$(' in result else result
    nodes = []
    def walk(element, namespace='', remappings=None, depth=0):
        if depth > 20:
            return
        mappings = list(remappings or [])
        for child in element:
            if child.tag in ('push-ros-namespace', 'push_ros_namespace'):
                pushed = value(child.get('namespace'))
                namespace = '/'.join(part.strip('/') for part in (namespace, pushed) if part) if pushed is not None and namespace is not None else None
            elif child.tag in ('set-remap', 'set_remap'):
                mappings.append([value(child.get('from')), value(child.get('to'))])
            elif child.tag == 'group':
                walk(child, namespace, mappings, depth + 1)
            elif child.tag == 'node':
                own_namespace = value(child.get('namespace', ''))
                full_namespace = '/'.join(part.strip('/') for part in (namespace, own_namespace) if part) if namespace is not None and own_namespace is not None else None
                parameters, remaps = [], list(mappings)
                for entry in child:
                    if entry.tag == 'param':
                        if entry.get('from'):
                            parameters.append(value(entry.get('from')))
                        elif entry.get('name'):
                            parameters.append({entry.get('name'): value(entry.get('value'))})
                    elif entry.tag == 'remap':
                        remaps.append([value(entry.get('from')), value(entry.get('to'))])
                result = {'package': value(child.get('pkg')), 'executable': value(child.get('exec') or child.get('executable')),
                          'name': value(child.get('name', '')), 'namespace': full_namespace, 'parameters': parameters,
                          'remappings': remaps, 'line': 1}
                result['unknown'] = [key for key in ('package', 'executable', 'name', 'namespace') if result[key] is None]
                nodes.append(result)
    walk(tree)
    return nodes, [{'name': name, 'default': default, 'value': supplied.get(name, default)} for name, default in defaults.items()]


def scan_communications(root, mode='source', profile='', arguments=None, module=None):
    root, arguments = Path(root).resolve(), arguments or {}
    if not root.is_dir():
        return {'endpoints': [], 'profiles': [], 'profile': profile, 'arguments': arguments, 'mode': mode,
                'notices': ['工作区目录不可读，请重新选择来源']}
    files, packages, notices, visited = [], {}, [], set()
    total = 0
    for current, directories, names in os.walk(root, followlinks=True):
        directory = Path(current)
        resolved = str(directory.resolve())
        if resolved in visited or len(visited) > 20000:
            directories[:] = []
            continue
        visited.add(resolved)
        excluded = {'.git', '.venv', 'node_modules', '__pycache__', 'test', 'tests'}
        if mode == 'source':
            excluded |= {'build', 'install', 'log'}
        directories[:] = sorted(d for d in directories if d not in excluded and not d.startswith('.'))
        if 'COLCON_IGNORE' in names and mode == 'source':
            directories[:] = []
            continue
        if 'package.xml' in names:
            try:
                manifest = directory / 'package.xml'
                if manifest.stat().st_size <= 262144:
                    name = ET.fromstring(manifest.read_text()).findtext('name')
                    if name:
                        packages[name] = str(directory)
            except (OSError, ValueError, ET.ParseError, UnicodeError):
                pass
        for name in sorted(names):
            path = directory / name
            if path.suffix not in ('.cpp', '.cc', '.cxx', '.hpp', '.h', '.py', '.yaml', '.yml', '.xml', '.launch') and name != 'CMakeLists.txt':
                continue
            try:
                size = path.stat().st_size
                if size > 1048576 or total + size > 32 * 1048576 or len(files) >= 8000:
                    if not notices:
                        notices.append('部分文件超过离线扫描容量，请缩小到具体子系统工作区')
                    continue
                text = path.read_text(encoding='utf-8')
                total += size
                files.append((path, text))
            except (OSError, UnicodeError):
                notices.append('无法读取 ' + str(path.relative_to(root)))
    def package_for(path):
        matches = [(len(folder), name) for name, folder in packages.items() if path.is_relative_to(Path(folder))]
        return max(matches)[1] if matches else ''
    def static_value(value):
        # Resolve file/package references as data; never import a workspace or run launch code
        if isinstance(value, list):
            return [static_value(v) for v in value]
        if not isinstance(value, dict):
            return value
        if '$package' in value:
            folder = packages.get(value['$package'])
            return str(Path(folder) / value.get('path', '')) if folder else None
        if '$file' in value or '$yaml' in value:
            target = static_value(value.get('$file', value.get('$yaml')))
            if not isinstance(target, str):
                return None
            try:
                path = Path(target)
                if path.stat().st_size > 1048576:
                    return None
                content = path.read_text()
                return yaml.safe_load(content) if '$yaml' in value else content
            except (OSError, ValueError, UnicodeError, yaml.YAMLError):
                return None
        if '$merge' in value:
            parts = [static_value(v) for v in value['$merge']]
            if not all(isinstance(v, dict) for v in parts):
                return None
            return {k: v for part in parts for k, v in part.items()}
        if any(k.startswith('$') for k in value):
            return None
        return {k: static_value(v) for k, v in value.items()}

    if module and module.get('kind') == 'launch':
        matches = [path for path, _ in files if path.name == module.get('executable') and package_for(path) == module.get('package')]
        profile = str(matches[0].relative_to(root)) if len(matches) == 1 else '__module_launch_unresolved__'
        arguments = {k: str(value) if value is not None else None
                     for k, v in module.get('launch_arguments', {}).items() for value in [static_value(v)]}
        if any(v is None for v in arguments.values()):
            notices.append('部分启动参数无法静态解析，请核对启动模块中的参数来源')
    elif module:
        arguments = {}
    declarations, configs, profiles = [], {}, []
    for path, text in files:
        relative = str(path.relative_to(root))
        try:
            if path.suffix in ('.yaml', '.yml'):
                parameters = _yaml_parameters(text)
                if parameters:
                    configs[str(path)] = parameters
                    profiles.append({'id': relative, 'label': relative, 'kind': 'parameters', 'arguments': []})
            if path.name.endswith(('.launch.py', '.launch.xml', '.launch')):
                reader = _launch if path.suffix == '.py' else _xml_launch
                nodes, launch_args = reader(text, packages, arguments if profile == relative else {})
                if nodes:
                    profiles.append({'id': relative, 'label': relative, 'kind': 'launch', 'nodes': nodes, 'arguments': launch_args})
            elif path.suffix in ('.cpp', '.cc', '.cxx', '.hpp', '.h', '.py'):
                parsed = _python(text) if path.suffix == '.py' else _cpp(text)
                for item in parsed:
                    item.update(source=relative, package=package_for(path))
                    item['id'] = _id(relative + ':' + str(item['line']) + ':' + item['expression'])
                    declarations.append(item)
            elif '.launch.' in path.name or path.name.endswith('.launch'):
                notices.append('启动文件暂需人工确认命名空间与重映射：' + relative)
        except (ValueError, TypeError, SyntaxError, RecursionError, OverflowError) as error:
            notices.append('部分通信声明未能解析，已保留此前识别的结果：' + relative + '（' + type(error).__name__ + '）')
    selected = next((p for p in profiles if p['id'] == profile), None)
    if module and module.get('kind') in ('node', 'component'):
        relevant = [v for v in declarations if v['package'] == module.get('package')]
        matches = [v for v in relevant if module.get('executable') in (Path(v['source']).stem, v['node'])]
        identities = {v['node'] or v['source'] for v in relevant}
        if not matches and len(identities) == 1:
            matches = relevant
        if len({v['node'] or v['source'] for v in matches}) > 1:
            matches = []
        nodes = []
        for identity in sorted({v['node'] or v['source'] for v in matches}):
            original = next(v for v in matches if (v['node'] or v['source']) == identity)
            parameters = [static_value(v) for v in module.get('parameter_files', [])]
            parameters.append(static_value(module.get('parameters', {})))
            cli_overrides = any(v in ('-p', '--param', '-r', '--remap', '--params-file') for v in module.get('arguments', []))
            nodes.append({'package': module['package'], 'executable': module.get('executable'),
                          'name': module.get('node_name') or module['id'], '_source_node': original['node'],
                          '_source_file': original['source'], 'namespace': module.get('namespace', ''),
                          'parameters': parameters, 'remappings': module.get('remappings', []),
                          'unknown': ['parameters'] if cli_overrides else []})
        if not nodes:
            notices.append('无法从源码唯一确认启动模块对应的节点，请核对入口与源码声明')
        declarations = matches if nodes else relevant
        selected = {'id': module['name'], 'kind': 'module', 'nodes': nodes}
    elif module and module.get('kind') == 'process':
        notices.append('独立程序的通信配置需要人工确认，不能从程序参数推断 ROS 名称')
        selected = {'id': module['name'], 'kind': 'module', 'nodes': []}
    endpoints = []
    for original in declarations:
        variants = [None]
        if selected and selected['kind'] in ('launch', 'module'):
            matches = [node for node in selected['nodes'] if node.get('package') == original['package'] and
                       (node.get('_source_file') == original['source'] or node.get('_source_node', node.get('name')) == original['node'] or
                        node.get('executable') in (Path(original['source']).stem, original['node']))]
            variants = matches or [None]
        for index, node in enumerate(variants):
            item = {**original, 'id': original['id'] + ':' + str(index), 'profile': profile, 'status': 'resolved', 'reason': '', 'configuration': []}
            name, namespace = item['name'], ''
            node_name = item['node']
            params, unknown = {}, []
            def apply_config(path):
                path = str(Path(path))
                if path not in configs and module:
                    try:
                        file = Path(path)
                        if file.is_file() and file.stat().st_size <= 1048576:
                            configs[path] = _yaml_parameters(file.read_text())
                    except (OSError, ValueError, UnicodeError, yaml.YAMLError):
                        pass
                for target, values in configs.get(str(Path(path)), []):
                    full_node = '/' + '/'.join(p for p in (namespace.strip('/'), node_name) if p)
                    if target in ('/**', '/' + node_name, full_node) and (node_name or target == '/**'):
                        params.update(values)
                        source = Path(path)
                        item['configuration'].append(str(source.relative_to(root)) if source.is_relative_to(root) else str(source))
            if selected and selected['kind'] == 'parameters':
                apply_config(root / selected['id'])
            if node:
                node_name = node.get('name') or node_name
                namespace = node.get('namespace') or ''
                if not isinstance(namespace, str) or not isinstance(node_name, str):
                    unknown.append('namespace / name')
                    namespace, node_name = '', ''
                unknown.extend(k for k in node['unknown'] if k in ('name', 'namespace', 'parameters', 'remappings', 'condition', 'group namespace / remapping', 'global namespace / remapping'))
                for entry in node.get('parameters') or []:
                    if isinstance(entry, str):
                        if entry in configs or module and Path(entry).is_file():
                            apply_config(entry)
                        else:
                            unknown.append('参数文件 ' + entry)
                    elif isinstance(entry, dict):
                        params.update(entry)
                    else:
                        unknown.append('parameters')
                item['configuration'].append(selected['id'])
            elif selected and selected['kind'] in ('launch', 'module'):
                unknown.append('此启动配置未静态定位到对应节点')
            if item['parameter'] in params:
                name = params[item['parameter']]
            parameter_key = 'node:' + (node_name or item['package']) + ':' + item['parameter']
            if item['parameter'] and parameter_key in arguments:
                name = arguments[parameter_key]
                item['configuration'].append('工作区补充参数 ' + item['parameter'])
            def expand(value):
                if not isinstance(value, str):
                    return ''
                if value.startswith('~/'):
                    return '/' + '/'.join(p for p in (namespace.strip('/'), node_name, value[2:]) if p) if node_name else ''
                return value if value.startswith('/') else '/' + '/'.join(p for p in (namespace.strip('/'), value) if p)
            if isinstance(name, str) and name and (name.startswith('/') or node or not profile):
                expanded = expand(name)
                if not name.startswith('/') and not node:
                    unknown.append('需要启动命名空间')
                for pair in (node or {}).get('remappings') or []:
                    if isinstance(pair, list) and len(pair) == 2 and all(isinstance(v, str) for v in pair):
                        if expand(pair[0]) == expanded:
                            expanded = expand(pair[1])
                    else:
                        unknown.append('remappings')
                name = expanded
            if not item['ros_type']:
                unknown.append('接口类型需要确认')
            elif item['ros_type'].split('/')[1] != {'topic': 'msg', 'service': 'srv', 'action': 'action'}[item['kind']]:
                unknown.append('通信方式与接口类型不一致')
            if not _name(name):
                unknown.append(item['parameter'] or item['expression'])
            item['name'] = name if isinstance(name, str) else ''
            item['node'] = node_name
            if unknown:
                item.update(status='unresolved', reason='待补充或确认：' + ' · '.join(dict.fromkeys(unknown)))
            elif not profile:
                item['reason'] = '源码声明，未应用启动覆盖'
            endpoints.append(item)
    missing_parameters = {}
    for item in endpoints:
        if item['parameter']:
            key = 'node:' + (item['node'] or item['package']) + ':' + item['parameter']
            if item['status'] == 'unresolved' or key in arguments:
                missing_parameters[key] = {'name': key, 'label': (item['node'] or item['package']) + ' · ' + item['parameter'], 'value': arguments.get(key, '')}
    public_profiles = [{k: v for k, v in p.items() if k != 'nodes'} for p in profiles]
    if profile and not selected:
        notices.append('原启动配置已不存在，请重新选择')
        for item in endpoints:
            item.update(status='unresolved', reason='原启动配置已不存在')
    return {'endpoints': endpoints, 'profiles': public_profiles, 'profile': profile, 'arguments': arguments,
            'missing_parameters': list(missing_parameters.values()), 'notices': list(dict.fromkeys(notices)), 'mode': mode}


def portable_communications(raw):
    from .errors import fail
    if not isinstance(raw, dict) or not isinstance(raw.get('endpoints'), list) or len(raw['endpoints']) > 5000:
        fail('$.communications', 'invalid_scan', '离线通信快照格式无效')
    endpoints = []
    for item in raw['endpoints']:
        if not isinstance(item, dict) or item.get('kind') not in ('topic', 'service', 'action') or item.get('status') not in ('resolved', 'unresolved', 'conflict'):
            fail('$.communications', 'invalid_scan', '通信声明格式无效')
        clean = {}
        for key in ('id', 'kind', 'role', 'ros_type', 'name', 'node', 'source', 'parameter', 'expression', 'status', 'reason'):
            value = item.get(key, '')
            if not isinstance(value, str) or len(value) > 2048:
                fail('$.communications', 'invalid_scan', '通信声明超出长度限制')
            clean[key] = value
        if type(item.get('line')) is not int or not 1 <= item['line'] <= 1000000:
            fail('$.communications', 'invalid_scan', '通信声明位置无效')
        if clean['status'] == 'resolved' and (not _name(clean['name']) or not re.fullmatch(r'\w+/(msg|srv|action)/\w+', clean['ros_type'])):
            fail('$.communications', 'invalid_scan', '通信名称或类型无效')
        clean.update(line=item['line'], configuration=[], profile='')
        endpoints.append(clean)
    return {'endpoints': endpoints, 'profiles': [], 'profile': '', 'arguments': {}, 'notices': ['导入的离线通信快照，可直接用于配置任务']}
