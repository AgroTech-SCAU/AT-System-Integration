import hashlib
import json
import os
from pathlib import Path
import re
import xml.etree.ElementTree as ET

from .errors import fail
from .ros_interfaces import InterfaceLibrary, TYPE


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
                fingerprints = {json.dumps(candidate['definitions'], sort_keys=True) for candidate in candidates}
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
