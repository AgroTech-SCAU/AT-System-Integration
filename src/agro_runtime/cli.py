"""静态契约校验 CLI"""
import argparse
import json
from pathlib import Path

from .errors import ContractValidationError
from .models import SystemConfig
from .errors import parse
from .registry import Registry, bind_system, load_package, read_document


def main(argv=None):
    parser = argparse.ArgumentParser(prog='agroctl')
    groups = parser.add_subparsers(dest='group', required=True)
    for group in ('package', 'system'):
        commands = groups.add_parser(group).add_subparsers(dest='command', required=True)
        commands.add_parser('validate').add_argument('path', type=Path)
    args = parser.parse_args(argv)
    try:
        if args.group == 'package':
            package = load_package(args.path)
            result = {'valid': True, 'package_id': package.package_id, 'enabled': False,
                      'capabilities': [cap.capability_id for cap in package.capabilities]}
        else:
            config = parse(SystemConfig, read_document(args.path))
            registry = Registry()
            for ref in config.packages:
                registry.register(load_package(args.path.resolve().parent / ref))
            bound = bind_system(config, registry)
            result = {'valid': True, 'system_id': config.system_id,
                      'roles': {name: {'backend_instance': role.backend_instance,
                                       'capability_id': role.capability.capability_id}
                                for name, role in bound.roles.items()}}
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ContractValidationError as exc:
        print(json.dumps({'valid': False, 'errors': [issue.model_dump() for issue in exc.issues]}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
