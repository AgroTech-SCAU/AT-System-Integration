import hashlib
import json
import os
import copy
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from uuid import uuid4

from .errors import fail
from .ros_interfaces import InterfaceLibrary, TYPE, interface_file_definitions, normalized_definition


class InterfaceSources:
    def __init__(self, store, project_id):
        self.store = store
        self.library = InterfaceLibrary(store, project_id)
        self.project_id = project_id

    def scan(self, sources, base_path='', choices=None):
        if not isinstance(sources, list) or not 1 <= len(sources) <= 16:
            fail('$.sources', 'invalid_sources', '请选择 1 至 16 个工作区')
        choices = choices or {}
        if not isinstance(choices, dict) or any(not isinstance(value, str) for value in choices.values()):
            fail('$.choices', 'invalid_choices', '接口包来源选择无效')
        packages, diagnostics, normalized, seen = {}, [], [], set()
        total_bytes = 0
        directory_count = 0

        def discover(source, dependency=False):
            nonlocal total_bytes, directory_count
            raw_path = source.get('path') if isinstance(source, dict) else None
            mode = source.get('mode', 'source') if isinstance(source, dict) else None
            if not isinstance(raw_path, str) or not raw_path.strip() or mode not in ('source', 'installed'):
                fail('$.sources', 'invalid_source', '填写工作区路径并选择源码或安装目录')
            root = Path(raw_path).expanduser()
            if not root.is_absolute():
                fail('$.sources', 'absolute_path_required', '请填写 Studio 主机上的绝对路径')
            root = root.resolve()
            if not root.is_dir():
                fail('$.sources', 'missing_workspace', '工作区目录不存在或不可读：' + str(root))
            identity = str(root) + ':' + mode
            if identity in seen:
                return
            seen.add(identity)
            normalized.append({'path': str(root), 'mode': mode, 'dependency': dependency})
            visited = set()
            count = 0
            for current, directories, files in os.walk(root, followlinks=True):
                directory_count += 1
                if directory_count > 20000:
                    fail('$.sources', 'workspace_too_large', '扫描范围过大，请选择具体工作区目录')
                directory = Path(current)
                resolved = str(directory.resolve())
                if resolved in visited or 'COLCON_IGNORE' in files and mode == 'source':
                    directories[:] = []
                    continue
                visited.add(resolved)
                excluded = {'.git', '.venv', 'node_modules', '__pycache__'}
                if mode == 'source':
                    excluded.update({'build', 'install', 'log'})
                directories[:] = sorted(name for name in directories if name not in excluded and not name.startswith('.'))
                if 'package.xml' not in files:
                    continue
                try:
                    manifest = directory / 'package.xml'
                    if manifest.stat().st_size > 262144:
                        raise ValueError()
                    package = ET.fromstring(manifest.read_text()).findtext('name')
                    if not package or not re.fullmatch(r'[a-z][a-z0-9_]*', package):
                        raise ValueError()
                except (OSError, ValueError, ET.ParseError, UnicodeError):
                    diagnostics.append({'code': 'invalid_package', 'reason': '无法读取接口包清单：' + str(directory)})
                    directories[:] = []
                    continue
                definitions = {}
                for kind, suffix in (('msg', '.msg'), ('srv', '.srv'), ('action', '.action')):
                    folder = directory / kind
                    if not folder.is_dir():
                        continue
                    for path in sorted(folder.rglob('*')):
                        if not path.is_file() or path.suffix not in (suffix, '.idl'):
                            continue
                        if path.suffix == '.idl':
                            if not path.with_suffix(suffix).exists():
                                diagnostics.append({'code': 'idl_not_supported', 'reason': '此定义需要原生接口文件：' + str(path)})
                            continue
                        ros_type = package + '/' + kind + '/' + path.stem
                        if not TYPE.fullmatch(ros_type):
                            continue
                        try:
                            size = path.stat().st_size
                            total_bytes += size
                            if size > 262144 or total_bytes > 8 * 1024 * 1024:
                                fail('$.sources', 'definitions_too_large', '接口定义超出导入容量，请缩小工作区范围')
                            content = path.read_text(encoding='utf-8')
                        except (OSError, UnicodeError):
                            diagnostics.append({'code': 'unreadable_definition', 'ros_type': ros_type, 'reason': '接口文件不可读：' + str(path)})
                            continue
                        if ros_type in definitions and definitions[ros_type] != content:
                            fail('$.sources', 'duplicate_definition', '同一包存在不同的同名定义：' + ros_type)
                        definitions[ros_type] = content
                if definitions:
                    count += len(definitions)
                    packages.setdefault(package, []).append({'path': str(directory), 'source': str(root),
                                                             'dependency': dependency, 'definitions': definitions})
                directories[:] = []
            normalized[-1]['count'] = count
            if not count and not dependency:
                diagnostics.append({'code': 'no_definitions', 'reason': '工作区未发现可读取的接口定义：' + str(root)})

        for source in sources:
            discover(source)
        if base_path:
            discover({'path': base_path, 'mode': 'installed'}, True)
        definitions, origins, conflicts, primary = {}, {}, [], set()
        for package, candidates in sorted(packages.items()):
            selected = next((candidate for candidate in candidates if candidate['path'] == choices.get(package)), None)
            if selected is None:
                fingerprints = {json.dumps({name: normalized_definition(name, value) for name, value in candidate['definitions'].items()}, sort_keys=True) for candidate in candidates}
                if len(fingerprints) > 1:
                    conflicts.append({'package': package, 'sources': [candidate['path'] for candidate in candidates]})
                    continue
                selected = next((candidate for candidate in candidates if not candidate['dependency']), candidates[0])
            definitions.update(selected['definitions'])
            origins.update({name: selected['source'] for name in selected['definitions']})
            if not selected['dependency']:
                primary.update(selected['definitions'])
        if len(definitions) > 3000:
            fail('$.sources', 'too_many_definitions', '接口数量过多，请选择更具体的工作区')
        schemas, errors = self.library.compile(definitions, allow_partial=True, saved_definitions=False)
        diagnostics.extend(issue for issue in errors if issue.get('ros_type') in primary)
        digest = hashlib.sha256(json.dumps([normalized, choices, definitions, conflicts, diagnostics], sort_keys=True).encode()).hexdigest()
        current = {item['ros_type']: item for item in self.library.saved()}
        changed = {name for name, item in current.items() if item['schema'] != schemas.get(name) or
                   any(definitions.get(dependency) != content for dependency, content in item.get('definitions', {}).items())}
        affected = [{'id': task['id'], 'name': task['name'], 'ros_type': task['ros_type']}
                    for task in self.store.list('ros_task') if task.get('robot_system_id') == self.project_id and task['ros_type'] in changed]
        result = {'sources': normalized, 'base_path': base_path, 'choices': choices, 'digest': digest,
                  'conflicts': conflicts, 'diagnostics': diagnostics, 'affected_tasks': affected,
                  'types': [{'ros_type': name, 'source': origins[name], 'dependency': name not in primary}
                            for name in sorted(schemas)], 'primary_types': sorted(primary)}
        return result, definitions, schemas, origins

    def preview(self, sources, base_path='', choices=None):
        return self.scan(sources, base_path, choices)[0]

    def apply(self, sources, base_path, choices, digest):
        result, definitions, schemas, origins = self.scan(sources, base_path, choices)
        if result['digest'] != digest:
            fail('$.digest', 'source_changed', '工作区内容发生变化，请重新预览')
        if result['conflicts']:
            fail('$.sources', 'source_conflict', '请先为冲突的接口包选择来源')
        records = self.library.persist(definitions, schemas, 'workspace', origins)
        retained = [item for item in self.library.saved() if item.get('source') == 'imported' and item['ros_type'] not in schemas]
        configuration = {'id': self.project_id, 'schema_ids': [item['id'] for item in retained + records],
                         'sources': [item for item in result['sources'] if not item['dependency']],
                         'base_path': base_path, 'choices': choices, 'diagnostics': result['diagnostics'],
                         'primary_types': sorted(set(result['primary_types']) | {item['ros_type'] for item in retained})}
        self.store.put('interface_catalog', self.project_id, configuration)
        return {**self.library.catalog(), 'diagnostics': result['diagnostics'], 'affected_tasks': result['affected_tasks']}


class InterfaceWorkspaces:
    """Named, independently stored design resources; selection belongs to each task."""

    def __init__(self, store, project_id):
        self.store, self.project_id = store, project_id
        self.library = InterfaceLibrary(store, project_id)

    def migrate(self):
        configuration = self.library.configuration()
        if configuration.get('workspaces_migrated'):
            return
        saved = self.library.saved()
        definitions = {}
        for item in saved:
            definitions.update(item.get('definitions', {}))
        workspace_ids = []
        if definitions:
            identity = 'workspace_' + hashlib.sha256(self.project_id.encode()).hexdigest()[:24]
            record = {'id': identity, 'project_id': self.project_id, 'name': '原工程接口',
                      'mode': 'files', 'path': '', 'definitions': definitions, 'diagnostics': [],
                      'legacy_sources': configuration.get('sources', [])}
            self.store.put('interface_workspace', identity, record)
            workspace_ids.append(identity)
            for task in self.store.list('ros_task'):
                if task.get('robot_system_id') == self.project_id and 'workspace_ids' not in task and task.get('schema_id'):
                    self.store.put('ros_task', task['id'], {**task, 'workspace_ids': workspace_ids})
        self.store.put('interface_catalog', self.project_id, {**configuration, 'workspaces_migrated': True,
                                                            'default_workspace_ids': workspace_ids})

    def records(self):
        self.migrate()
        return [item for item in self.store.list('interface_workspace') if item.get('project_id') == self.project_id]

    def get(self, identity):
        record = next((item for item in self.records() if item['id'] == identity), None)
        if record is None:
            fail('$.workspace_ids', 'unknown_workspace', '接口工作区不存在或不属于当前机器人')
        return record

    @staticmethod
    def conflicting_types(left, right):
        a, b = left['definitions'], right['definitions']
        for record in (left, right):
            if '_normalized' not in record:
                record['_normalized'] = {name: normalized_definition(name, content) for name, content in record['definitions'].items()}
        return sorted(name for name in a.keys() & b.keys() if left['_normalized'][name] != right['_normalized'][name])

    def summary(self, record, records=None):
        records = self.records() if records is None else records
        conflicts = []
        for other in records:
            if other['id'] != record['id']:
                types = self.conflicting_types(record, other)
                if types:
                    conflicts.append({'id': other['id'], 'name': other['name'], 'types': types})
        used_tasks = {task['id'] for task in self.store.list('ros_task')
                      if task.get('robot_system_id') == self.project_id and record['id'] in task.get('workspace_ids', [])}
        for definition in self.store.list('tree_definition'):
            if definition.get('robot_system_id') == self.project_id and not definition.get('archived'):
                used_tasks.update(task['id'] for task in definition.get('ros_tasks', []) if record['id'] in task.get('workspace_ids', []))
        return {key: copy.deepcopy(record.get(key)) for key in ('id', 'name', 'mode', 'path', 'diagnostics')} | {
            'interface_count': len(record['definitions']), 'conflicts_with': conflicts,
            'used_by': len(used_tasks)}

    def catalog(self):
        records = self.records()
        available = {item['id'] for item in records}
        defaults = [identity for identity in self.library.configuration().get('default_workspace_ids', []) if identity in available]
        if not defaults and len(records) == 1:
            defaults = [records[0]['id']]
        return {'workspaces': [self.summary(item, records) for item in records], 'default_workspace_ids': defaults}

    def save(self, raw, identity=None):
        if not isinstance(raw, dict):
            fail('$.workspace', 'invalid_workspace', '接口工作区配置无效')
        records = self.records()
        old = self.get(identity) if identity else None
        if not old and len(records) >= 64:
            fail('$.workspace', 'too_many_workspaces', '当前机器人最多保存 64 个接口工作区')
        mode = raw.get('mode', old['mode'] if old else 'source')
        if mode not in ('source', 'installed', 'files'):
            fail('$.mode', 'invalid_source', '选择源码工作区、安装目录或接口文件')
        path = raw.get('path', old.get('path', '') if old else '')
        if not isinstance(path, str):
            fail('$.path', 'invalid_source', '工作区路径必须是文本')
        default_name = raw.get('package', '') if mode == 'files' else Path(path.strip()).name
        name = raw.get('name', old['name'] if old else default_name)
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
            fail('$.name', 'invalid_name', '填写工作区名称，最多 80 个字符')
        if any(item['id'] != identity and item['name'] == name.strip() for item in records):
            fail('$.name', 'duplicate_name', '接口工作区名称已存在')
        refresh = not old or raw.get('refresh') or mode != old['mode'] or path != old.get('path', '') or 'files' in raw
        if refresh:
            if mode == 'files':
                if 'files' in raw:
                    definitions = interface_file_definitions(raw.get('package'), raw['files'])
                elif old and old['mode'] == 'files':
                    definitions = old['definitions']
                else:
                    fail('$.files', 'invalid_files', '请选择需要导入的接口文件')
                _, diagnostics = self.library.compile(definitions, allow_partial=True, saved_definitions=False)
                path = ''
            else:
                result, definitions, _, _ = InterfaceSources(self.store, self.project_id).scan([{'path': path, 'mode': mode}])
                if result['conflicts']:
                    fail('$.path', 'source_conflict', '此目录内存在冲突接口包，请分别添加具体工作区目录')
                diagnostics = result['diagnostics']
                path = result['sources'][0]['path']
        else:
            definitions, diagnostics = old['definitions'], old.get('diagnostics', [])
        record = {'id': identity or 'workspace_' + uuid4().hex, 'project_id': self.project_id,
                  'name': name.strip(), 'mode': mode, 'path': path, 'definitions': definitions, 'diagnostics': diagnostics}
        self.store.put('interface_workspace', record['id'], record)
        return self.summary(record)

    def delete(self, identity):
        record = self.get(identity)
        if self.summary(record)['used_by']:
            fail('$.workspace', 'workspace_in_use', '工作区已被任务使用，请先调整任务的接口工作区选择')
        self.store.delete('interface_workspace', identity)
        return {'deleted': True}

    def selection(self, workspace_ids):
        if not isinstance(workspace_ids, list) or len(workspace_ids) > 64 or any(not isinstance(identity, str) for identity in workspace_ids):
            fail('$.workspace_ids', 'invalid_workspaces', '接口工作区选择必须是标识列表')
        if len(set(workspace_ids)) != len(workspace_ids):
            fail('$.workspace_ids', 'duplicate_workspace', '接口工作区不能重复选择')
        records = {item['id']: item for item in self.records()}
        if any(identity not in records for identity in workspace_ids):
            fail('$.workspace_ids', 'unknown_workspace', '接口工作区不存在或不属于当前机器人')
        return [records[identity] for identity in workspace_ids]

    def resolve(self, workspace_ids):
        selected = self.selection(workspace_ids)
        definitions, owners, conflicts = {}, {}, []
        for record in selected:
            for name, content in record['definitions'].items():
                owners.setdefault(name, []).append(record)
                if name not in definitions:
                    definitions[name] = content
        for name, records in owners.items():
            fingerprints = {json.dumps(normalized_definition(name, record['definitions'][name]), sort_keys=True) for record in records}
            if len(fingerprints) > 1:
                conflicts.append({'ros_type': name, 'workspace_ids': [item['id'] for item in records],
                                  'workspace_names': [item['name'] for item in records]})
        result = {'workspace_ids': workspace_ids, 'types': [], 'conflicts': conflicts, 'diagnostics': []}
        if conflicts:
            return result
        schemas, diagnostics = self.library.compile(definitions, allow_partial=True, saved_definitions=False)
        origins = {name: ' · '.join(item['name'] for item in records) for name, records in owners.items()}
        records = self.library.persist(definitions, schemas, 'workspace', origins, workspace_ids)
        result['types'] = [{'ros_type': item['ros_type'], 'schema_id': item['id'], 'source': item['source'],
                            'workspace_ids': [record['id'] for record in owners[item['ros_type']]], 'dependency': False}
                           for item in sorted(records, key=lambda item: item['ros_type'])]
        result['diagnostics'] = diagnostics + [issue for item in selected for issue in item.get('diagnostics', [])
                                               if issue.get('code') in ('invalid_package', 'unreadable_definition', 'idl_not_supported', 'no_definitions')]
        return result

    def require_resolved(self, workspace_ids):
        result = self.resolve(workspace_ids)
        if result['conflicts']:
            conflict = result['conflicts'][0]
            fail('$.workspace_ids', 'workspace_conflict', '所选工作区接口冲突：' + ' / '.join(conflict['workspace_names']) + ' · ' + conflict['ros_type'])
        return result
