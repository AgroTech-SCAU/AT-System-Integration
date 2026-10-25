"""Offline module inventory without importing or executing workspace Python."""
import ast
import configparser
import os
import re
from pathlib import Path
from xml.etree import ElementTree as ET


def scan_modules(directory):
    root = Path(directory)
    found, warnings = {}, []
    if not root.is_dir():
        return {'modules': [], 'warnings': ['工作区目录不可用']}
    paths = []
    for base, dirs, files in os.walk(root):
        dirs[:] = [v for v in dirs if v not in {'.git','build','log','.venv','venv','node_modules','__pycache__','.install'}]
        if len(paths) > 30000:
            warnings.append('目录过大，请缩小扫描范围'); break
        paths.extend(Path(base) / v for v in files if v in ('package.xml','CMakeLists.txt','setup.py','setup.cfg') or v.endswith(('.launch.py','.launch.xml','.launch.yaml')))
    packages = {}
    for path in paths:
        if path.name == 'package.xml':
            try:
                name = ET.parse(path).getroot().findtext('name')
                if name: packages[path.parent] = name
            except (ET.ParseError, OSError): warnings.append('无法读取 ' + str(path))
    def add(package, executable, kind, path, **extras):
        if not re.fullmatch(r'[\w.\-/]+', executable): return
        found[(package, executable, kind)] = {'package': package, 'executable': executable, 'kind': kind, 'source': str(path), **extras}
    for path in paths:
        package_root = next((p for p in sorted(packages, key=lambda p:len(p.parts), reverse=True) if path.is_relative_to(p)), None)
        if package_root is None: continue
        package = packages[package_root]
        try:
            content = path.read_text()
            if path.name.endswith(('.launch.py','.launch.xml','.launch.yaml')):
                add(package, path.name, 'launch', path)
            elif path.name == 'setup.py':
                for node in ast.walk(ast.parse(content)):
                    if isinstance(node, ast.Constant) and isinstance(node.value, str):
                        match = re.fullmatch(r'\s*([\w.-]+)\s*=\s*([\w.]+):([\w.]+)\s*', node.value)
                        if match: add(package, match[1], 'node', path)
            elif path.name == 'setup.cfg':
                config = configparser.ConfigParser(); config.read_string(content)
                for line in config.get('options.entry_points', 'console_scripts', fallback='').splitlines():
                    if '=' in line: add(package, line.split('=',1)[0].strip(), 'node', path)
            elif path.name == 'CMakeLists.txt':
                for executable in re.findall(r'add_executable\s*\(\s*([\w.-]+)', content):
                    add(package, executable, 'node', path)
                for body in re.findall(r'install\s*\(\s*PROGRAMS\s+(.+?)\s+DESTINATION', content, re.S):
                    for name in body.split():
                        if '$' not in name: add(package, Path(name).name, 'node', path)
                for plugin in re.findall(r'rclcpp_components_register_nodes\s*\([^\)]*?"([\w:]+)"', content, re.S):
                    found[(package,plugin,'component')]={'package':package,'executable':'','kind':'component','plugin':plugin,'source':str(path)}
        except (OSError, ValueError, SyntaxError, configparser.Error):
            warnings.append('无法静态识别 ' + str(path))
    # Installed executables are authoritative when available
    for directory in [root/'install', root]:
        for package in set(packages.values()):
            for lib in (directory/'lib'/package, directory/package/'lib'/package):
                if lib.is_dir():
                    for path in lib.iterdir():
                        if path.is_file() and os.access(path, os.X_OK): add(package,path.name,'node',path,installed=True)
    return {'modules': sorted(found.values(), key=lambda v:(v['package'],v['kind'],v['executable'])), 'warnings': warnings}
