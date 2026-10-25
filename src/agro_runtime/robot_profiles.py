"""Directory-backed robot projects; SQLite is a local editing/index cache."""
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

from .errors import fail


PROJECT_KINDS = {
    'robot_system', 'ros_connection', 'interface_workspace', 'interface_foundation',
    'interface_catalog', 'ros_schema', 'ros_task', 'ros_resource', 'ros_binding',
    'tree_draft', 'tree_definition', 'state_machine', 'plan', 'asset',
    'execution_environment', 'subsystem_module', 'data_task',
}


def atomic_json(path, value):
    temporary = path.with_name('.' + path.name + '.' + uuid4().hex)
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


class RobotProfiles:
    def __init__(self, store):
        self.store = store

    def entries(self):
        return self.store.list('robot_profile')

    def path(self, robot):
        entry = next((v for v in self.entries() if v['id'] == robot), None)
        return Path(entry['path']) if entry else None

    def _owned(self, kind, value, robot):
        return (value.get('robot_system_id') == robot or value.get('project_id') == robot
                or kind in ('robot_system', 'ros_connection', 'interface_foundation', 'interface_catalog') and value.get('id') == robot)

    def records(self, robot):
        records = {}
        for kind in sorted(PROJECT_KINDS):
            rows = [v for v in self.store.list(kind) if self._owned(kind, v, robot)]
            if rows:
                records[kind] = rows
        # Catalog entries and referenced immutable assets travel with the project
        system = self.store.get('robot_system', robot)
        packages = {b['package_id'] for b in system['content'].get('backends', [])}
        records['package'] = [p for p in self.store.list('package') if p['id'] in packages]
        schema_ids={v.get('schema_id') for v in records.get('ros_task',[])}
        for definition in records.get('tree_definition',[]):
            schema_ids.update(v.get('schema_id') for v in definition.get('ros_tasks',[]))
        records['ros_schema']=[v for v in records.get('ros_schema',[]) if v['id'] in schema_ids]
        records.pop('interface_catalog',None)
        for definition in records.get('tree_definition', []):
            definition.pop('task_ref', None)
        return records

    @staticmethod
    def paths(value, root, writing):
        if isinstance(value, dict):
            return {k: RobotProfiles.paths(v, root, writing) for k, v in value.items() if k != 'storage_path'}
        if isinstance(value, list):
            return [RobotProfiles.paths(v, root, writing) for v in value]
        if isinstance(value, str):
            if not writing and value.startswith('profile-path:'):
                return str((root / value[13:]).resolve())
            if writing and value.startswith('/') and not value.startswith(('/usr/','/opt/','/bin/','/lib/')) and Path(value).exists():
                # ROS names like /arm/move remain names; only real filesystem paths are rewritten
                return 'profile-path:' + os.path.relpath(value, root)
        return value

    def attach(self, robot, directory):
        root = Path(str(directory)).expanduser()
        if not root.is_absolute():
            fail('$.storage_path', 'absolute_path_required', '请选择机器人工程的绝对存储路径')
        root = root.resolve()
        if root.exists() and (not root.is_dir() or any(root.iterdir())):
            fail('$.storage_path', 'directory_not_empty', '新建工程需要空目录，已有工程请使用打开')
        root.mkdir(parents=True, exist_ok=True)
        (root / 'assets').mkdir(exist_ok=True)
        # This is project configuration, not a colcon package
        (root / 'COLCON_IGNORE').touch()
        self.store.put('robot_profile', robot, {'id': robot, 'path': str(root)})
        self.flush(robot)
        return self.store.get('robot_system', robot)

    def flush(self, robot=None):
        for entry in self.entries():
            if robot and entry['id'] != robot:
                continue
            if not any(v['id'] == entry['id'] for v in self.store.list('robot_system')):
                continue
            root = Path(entry['path'])
            if not root.is_dir():
                fail('$.storage_path', 'profile_unavailable', '机器人工程目录不可用，请恢复目录后保存')
            # Every cache opening this project must use the same filesystem lock
            with (root / '.robot.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                entry=self.store.get('robot_profile',entry['id'])
                records = self.records(entry['id'])
                for record in records.get('asset', []):
                    source = self.store.root / 'assets' / (record['sha256'] + '.json')
                    target = root / 'assets' / source.name
                    if source.is_file() and not target.exists():
                        target.write_bytes(source.read_bytes())
                content = {'format': 'atil.robot-profile', 'robot_id': entry['id'],
                           'documents': self.paths(records, root, True)}
                target = root / 'robot.json'
                if target.is_file():
                    existing = target.read_bytes()
                    digest = hashlib.sha256(existing).hexdigest()
                    if json.loads(existing) == content:
                        self.store.put('robot_profile', entry['id'], {**entry, 'digest': digest})
                        continue
                    if entry.get('digest') and entry['digest'] != digest:
                        fail('$.storage_path', 'profile_changed', '工程文件已被外部修改，请重新打开后再编辑')
                atomic_json(target, content)
                value = {**entry, 'digest': hashlib.sha256(target.read_bytes()).hexdigest()}
                with self.store.db:
                    self.store.db.execute('INSERT OR REPLACE INTO documents VALUES (?,?,?)',
                                          ('robot_profile', entry['id'], json.dumps(value)))

    def open(self, directory):
        root = Path(str(directory)).expanduser().resolve()
        if root.name == 'robot.json':
            root = root.parent
        path = root / 'robot.json'
        try:
            if path.stat().st_size > 32 * 1024 * 1024:
                raise ValueError('too large')
            raw = path.read_bytes()
            profile = json.loads(raw)
            if profile.get('format') != 'atil.robot-profile':
                raise ValueError('format')
            robot = profile['robot_id']
            from .configuration import identifier, encoded
            identifier(robot)
            records = self.paths(profile['documents'], root, False)
            if set(records) - (PROJECT_KINDS | {'package'}):
                raise ValueError('document kind')
            systems = records.get('robot_system', [])
            if len(systems) != 1 or systems[0]['id'] != robot:
                raise ValueError('robot')
            rows = []
            for kind, values in records.items():
                for value in values:
                    identifier(value['id'])
                    if kind != 'package' and not self._owned(kind, value, robot):
                        raise ValueError('ownership')
                    rows.append((kind, value['id'], encoded(value)))
        except (OSError, ValueError, TypeError, KeyError) as error:
            fail('$.storage_path', 'invalid_profile', '无法读取完整的机器人工程，请选择包含 robot.json 的目录')
        old = self.path(robot)
        if old and old != root and (old / 'robot.json').exists():
            fail('$.storage_path', 'profile_already_open', '同一机器人已从其他目录打开，请先从最近工程移除原记录')
        for definition in records.get('tree_definition', []):
            xml=definition.get('xml','')
            if hashlib.sha256(xml.encode()).hexdigest()!=definition.get('xml_sha256'):
                fail('$.profile','definition_checksum_mismatch','工程中的行为树内容与摘要不一致')
            directory=self.store.root/'plans'/definition['id'];directory.mkdir(parents=True,exist_ok=True)
            (directory/'task.xml').write_text(xml)
            atomic_json(directory/'task.task.json',definition['manifest'])
            definition['task_ref']=str(directory/'task.xml')
            atomic_json(directory/'definition.json',definition)
        rows=[(kind,v['id'],encoded(v)) for kind,values in records.items() for v in values]
        with self.store.db:
            for kind in PROJECT_KINDS:
                for value in self.store.list(kind):
                    if self._owned(kind, value, robot):
                        self.store.db.execute('DELETE FROM documents WHERE kind=? AND id=?', (kind, value['id']))
            self.store.db.executemany('INSERT OR REPLACE INTO documents VALUES (?,?,?)', rows)
            self.store.db.execute('INSERT OR REPLACE INTO documents VALUES (?,?,?)', (
                'robot_profile', robot, json.dumps({'id': robot, 'path': str(root), 'digest': hashlib.sha256(raw).hexdigest()})))
        for asset in records.get('asset', []):
            source = root / 'assets' / (asset['sha256'] + '.json')
            if source.is_file() and hashlib.sha256(source.read_bytes()).hexdigest() == asset['sha256']:
                target = self.store.root / 'assets' / source.name
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(source.read_bytes())
        return {**self.store.get('robot_system', robot), 'storage_path': str(root)}

    def restore(self):
        for entry in self.entries():
            if (Path(entry['path']) / 'robot.json').is_file():
                self.open(entry['path'])
