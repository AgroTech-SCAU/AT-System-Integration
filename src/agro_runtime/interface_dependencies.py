"""Read local interface dependencies without starting ROS or executing setup scripts."""
import copy
import os
from pathlib import Path

from .errors import fail


class InterfaceFoundation:
    def __init__(self, store, project_id):
        self.store, self.project_id = store, project_id

    def candidates(self):
        paths = list(Path('/opt/ros').glob('*'))
        paths += [Path(value) for value in os.environ.get('AMENT_PREFIX_PATH', '').split(os.pathsep) if value]
        return sorted({str(path.resolve()) for path in paths
                       if (path / 'share/ament_index').is_dir()
                       and (path / 'share/builtin_interfaces').is_dir()})

    def record(self):
        saved = next((item for item in self.store.list('interface_foundation') if item['id'] == self.project_id), None)
        if saved:
            return saved
        configuration = next((item for item in self.store.list('interface_catalog') if item['id'] == self.project_id), {})
        if configuration.get('base_path') and Path(configuration['base_path']).is_dir():
            return self.select(configuration['base_path'])
        candidates = self.candidates()
        if len(candidates) == 1:
            return self.select(candidates[0])
        return {'id': self.project_id, 'path': '', 'definitions': {}}

    def public(self):
        record = self.record()
        return {'path': record['path'], 'candidates': self.candidates(),
                'interface_count': len(record['definitions']),
                'status': 'ready' if record['definitions'] else 'unselected'}

    def select(self, path):
        if not isinstance(path, str) or not path.strip() or not Path(path).expanduser().is_absolute():
            fail('$.path', 'invalid_path', '请选择基础 ROS 接口所在的安装目录')
        from .interface_sources import InterfaceSources
        result, definitions, _, _ = InterfaceSources(self.store, self.project_id).scan([{'path': path, 'mode': 'installed'}])
        if result['conflicts'] or not definitions:
            fail('$.path', 'invalid_foundation', '此目录没有可用的基础接口，或存在定义冲突')
        record = {'id': self.project_id, 'path': result['sources'][0]['path'], 'definitions': definitions}
        self.store.put('interface_foundation', self.project_id, record)
        return copy.deepcopy(record)


def detect_workspace(store, project_id, raw_path):
    from .interface_sources import InterfaceSources
    if not isinstance(raw_path, str) or not raw_path.strip() or not Path(raw_path).expanduser().is_absolute():
        fail('$.path', 'invalid_path', '请填写 Studio 主机上的绝对路径')
    root = Path(raw_path).expanduser().resolve()
    scanner = InterfaceSources(store, project_id)
    installed = (root / 'share/ament_index').is_dir() or (root / 'local_setup.bash').is_file()
    if installed:
        return {'mode': 'installed', 'path': str(root), 'alternatives': []}
    _, source, _, _ = scanner.scan([{'path': str(root), 'mode': 'source'}])
    installation = root / 'install'
    if installation.is_dir():
        _, built, _, _ = scanner.scan([{'path': str(installation), 'mode': 'installed'}])
        if not source and built:
            return {'mode': 'installed', 'path': str(installation), 'alternatives': []}
        if source and built:
            from .ros_interfaces import normalized_definition
            canonical = lambda data: {name: normalized_definition(name, content) for name, content in data.items()}
            if canonical(source) != canonical(built):
                return {'mode': 'ambiguous', 'path': str(root), 'alternatives': [
                    {'mode': 'source', 'path': str(root)}, {'mode': 'installed', 'path': str(installation)}]}
    return {'mode': 'source', 'path': str(root), 'alternatives': []}
