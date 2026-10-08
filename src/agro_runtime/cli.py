"""静态契约校验与同一管理 API 的 CLI"""
import argparse
import asyncio
import json
from pathlib import Path
from urllib.parse import quote, urlparse
from uuid import uuid4

from .errors import ContractValidationError, fail
from .registry import load_package, read_document


def _parser():
    parser = argparse.ArgumentParser(prog='agroctl')
    parser.add_argument('--endpoint', default='http://127.0.0.1:8765')
    parser.add_argument('--session-file', type=Path)
    groups = parser.add_subparsers(dest='group', required=True)
    packages = groups.add_parser('package').add_subparsers(dest='command', required=True)
    packages.add_parser('validate').add_argument('path', type=Path)
    packages.add_parser('list')
    for command in ('enable', 'disable'):
        packages.add_parser(command).add_argument('identity')
    systems = groups.add_parser('system').add_subparsers(dest='command', required=True)
    systems.add_parser('validate').add_argument('path', type=Path)
    for command in ('start', 'status', 'stop', 'snapshot'):
        system_command = systems.add_parser(command)
        if command=='start':
            system_command.add_argument('path', nargs='?', type=Path)
    operations = groups.add_parser('operation').add_subparsers(dest='command', required=True)
    for command in ('status', 'cancel'):
        operations.add_parser(command).add_argument('identity')
    operations.add_parser('submit').add_argument('path', type=Path)
    operations.add_parser('list')
    controls = groups.add_parser('control').add_subparsers(dest='command', required=True)
    controls.add_parser('status')
    take = controls.add_parser('take')
    take.add_argument('mode', choices=['AUTO', 'MANUAL', 'CALIBRATION'])
    take.add_argument('--lease-s', type=float, default=30.0)
    tasks = groups.add_parser('task').add_subparsers(dest='command', required=True)
    task_start = tasks.add_parser('start')
    task_start.add_argument('path', type=Path)
    task_start.add_argument('--config', type=Path)
    task_start.add_argument('--request-id', default=None)
    task_start.add_argument('--parameters', type=Path)
    for command in ('status', 'cancel'):
        tasks.add_parser(command).add_argument('identity')
    tasks.add_parser('list')
    configs = groups.add_parser('config').add_subparsers(dest='command', required=True)
    configs.add_parser('status')
    configs.add_parser('validate').add_argument('path', type=Path)
    configs.add_parser('diff').add_argument('identity')
    config_apply = configs.add_parser('apply')
    config_apply.add_argument('identity')
    config_apply.add_argument('--revision', type=int, required=True)
    config_apply.add_argument('--base-snapshot', required=True)
    config_apply.add_argument('--request-id', required=True)
    for name in ('catalog', 'asset'):
        commands = groups.add_parser(name).add_subparsers(dest='command', required=True)
        commands.add_parser('list')
        commands.add_parser('import').add_argument('path', type=Path)
        if name == 'catalog':
            commands.add_parser('delete').add_argument('identity')
    plans = groups.add_parser('plan').add_subparsers(dest='command', required=True)
    plans.add_parser('list')
    plans.add_parser('preflight').add_argument('identity')
    plan_create = plans.add_parser('create')
    plan_create.add_argument('--parameters', type=Path)
    plan_create.add_argument('--asset')
    templates = groups.add_parser('template').add_subparsers(dest='command', required=True)
    templates.add_parser('list')
    reports = groups.add_parser('report')
    reports.add_argument('identity')
    reports.set_defaults(command='report')
    management = groups.add_parser('management').add_subparsers(dest='command', required=True)
    management.add_parser('status').add_argument('identity')
    trees = groups.add_parser('tree').add_subparsers(dest='command', required=True)
    for command in ('models','list','definitions'):
        trees.add_parser(command)
    tree_new=trees.add_parser('new')
    tree_new.add_argument('--template',choices=['simulation_inspection','tomato_picker'],default='simulation_inspection')
    tree_import=trees.add_parser('import')
    tree_import.add_argument('path',type=Path)
    tree_import.add_argument('--template',choices=['simulation_inspection','tomato_picker'],default='simulation_inspection')
    for command in ('validate','xml'):
        trees.add_parser(command).add_argument('identity')
    tree_save=trees.add_parser('save');tree_save.add_argument('identity');tree_save.add_argument('path',type=Path)
    tree_extract=trees.add_parser('extract');tree_extract.add_argument('path',type=Path)
    tree_publish=trees.add_parser('publish');tree_publish.add_argument('identity');tree_publish.add_argument('--revision',type=int,required=True);tree_publish.add_argument('--base-snapshot',required=True)
    tree_start=trees.add_parser('start');tree_start.add_argument('identity');tree_start.add_argument('--request-id',required=True)
    agents = groups.add_parser('agent').add_subparsers(dest='command', required=True)
    serve = agents.add_parser('serve')
    serve.add_argument('--config', required=True, type=Path)
    serve.add_argument('--state-dir', required=True, type=Path)
    serve.add_argument('--host', choices=['127.0.0.1', '::1', 'localhost'], default='127.0.0.1')
    serve.add_argument('--port', type=int, default=8765)
    serve.add_argument('--task-engine', type=Path)
    serve.add_argument('--ui-dir', type=Path)
    gui = groups.add_parser('gui').add_subparsers(dest='command', required=True)
    open_gui = gui.add_parser('open')
    open_gui.add_argument('--config', required=True, type=Path)
    open_gui.add_argument('--state-dir', required=True, type=Path)
    open_gui.add_argument('--task-engine', type=Path)
    open_gui.add_argument('--ui-dir', type=Path)
    open_gui.add_argument('--desktop-dir', type=Path)
    open_gui.add_argument('--no-window', '--no-browser', dest='no_window', action='store_true',
                          help='只核对 Agent，不打开桌面窗口')
    return parser


def _remote(args):
    import httpx
    endpoint = urlparse(args.endpoint)
    if (endpoint.scheme != 'http' or endpoint.hostname not in ('127.0.0.1', '::1', 'localhost')
            or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
            or endpoint.path not in ('', '/')):
        fail('$.endpoint', 'loopback_required', '管理入口必须是本地回环 HTTP 地址，远程连接使用 SSH 隧道')
    if args.session_file is None:
        fail('$.session_file', 'local_session_required', '请通过 --session-file 指定 Agent 的本地会话文件')
    secret = args.session_file.read_text(encoding='utf-8').strip()
    if not secret:
        fail('$.session_file', 'local_session_required', '本地会话文件为空')
    method, body = 'GET', None
    if args.group == 'tree':
        command=args.command
        if command in ('models','definitions'):
            path='/trees/'+command
        elif command=='list':path='/trees/drafts'
        elif command in ('new','import'):
            method,path,body='POST','/trees/drafts',{'template':args.template}
            if command=='import':body['xml']=args.path.read_text(encoding='utf-8')
        elif command=='extract':method,path,body='POST','/trees/extract',read_document(args.path)
        elif command=='save':method,path,body='PUT','/trees/drafts/'+quote(args.identity,safe=''),read_document(args.path)
        elif command=='start':method,path,body='POST','/trees/definitions/'+quote(args.identity,safe='')+'/start',{'request_id':args.request_id}
        else:
            path='/trees/drafts/'+quote(args.identity,safe='')+'/'+command
            if command=='validate':method='POST'
            elif command=='publish':method,body='POST',{'revision':args.revision,'base_snapshot_id':args.base_snapshot}
    elif args.group == 'config':
        if args.command == 'validate':
            path, method, body = '/config/validate', 'POST', read_document(args.path)
        elif args.command == 'diff':
            path = '/config/drafts/' + quote(args.identity, safe='') + '/diff'
        elif args.command == 'apply':
            path, method, body = '/config/apply', 'POST', {'draft_id': args.identity,
                'revision': args.revision, 'base_snapshot_id': args.base_snapshot, 'request_id': args.request_id}
        else:
            path = '/config/status'
    elif args.group in ('catalog', 'asset'):
        path = '/catalog' if args.group == 'catalog' else '/assets'
        if args.command == 'import':
            method, body = 'POST', {'filename': args.path.name, 'content': args.path.read_text(encoding='utf-8')}
        elif args.command == 'delete':
            method, path = 'DELETE', path + '/' + quote(args.identity, safe='')
    elif args.group == 'plan':
        path = '/plans'
        if args.command == 'create':
            method, body = 'POST', {'parameters': read_document(args.parameters) if args.parameters else {}, 'asset_id': args.asset}
        elif args.command == 'preflight':
            path += '/' + quote(args.identity, safe='') + '/preflight'
    elif args.group == 'template':
        path = '/templates'
    elif args.group == 'report':
        path = '/tasks/' + quote(args.identity, safe='') + '/report'
    elif args.group == 'management':
        path = '/management/jobs/' + quote(args.identity, safe='')
    elif args.group == 'system':
        path = '/system/' + args.command
        if args.command in ('start', 'stop'):
            method = 'POST'
        if args.command=='start' and args.path:
            body={'path':str(args.path.resolve())}
    elif args.group == 'package':
        path = '/packages'
        if args.command != 'list':
            path += '/' + quote(args.identity, safe='') + '/' + args.command
            method = 'POST'
    elif args.group == 'task':
        path = '/tasks'
        if args.command == 'start':
            method, body = 'POST', {'task_ref':str(args.path.resolve()),
                'request_id':args.request_id or 'request_'+uuid4().hex,
                'parameters':read_document(args.parameters) if args.parameters else {}}
            if args.config:
                body['config_ref']=str(args.config.resolve())
        elif args.command != 'list':
            path += '/' + quote(args.identity, safe='')
            if args.command=='cancel':
                method,path='POST',path+'/cancel'
    elif args.group == 'control':
        path = '/control/' + args.command
        if args.command == 'take':
            method, body = 'POST', {'mode': args.mode, 'lease_s': args.lease_s}
    else:
        path = '/operations'
        if args.command == 'submit':
            method, body = 'POST', read_document(args.path)
        elif args.command != 'list':
            path += '/' + quote(args.identity, safe='')
            if args.command == 'cancel':
                method, path = 'POST', path + '/cancel'
    try:
        with httpx.Client(base_url=args.endpoint, timeout=10.0, trust_env=False,
                          headers={'Authorization': 'Bearer ' + secret}) as client:
            response = client.request(method, path, json=body)
        result = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        fail('$.endpoint', 'agent_unreachable', str(exc))
    return result, 0 if response.is_success else 1


def _serve(args):
    import uvicorn
    from .api import create_app, session_secret_file
    from .runtime import Runtime

    from .configuration import active_config
    runtime = Runtime(active_config(args.config, args.state_dir), args.state_dir)
    endpoint=f'http://[{args.host}]:{args.port}' if args.host=='::1' else f'http://{args.host}:{args.port}'
    app = create_app(runtime, session_secret=session_secret_file(args.state_dir),
                     task_engine=args.task_engine, endpoint=endpoint, ui_directory=args.ui_dir)

    class ManagedServer(uvicorn.Server):
        """退出信号先完成停止，未确认时继续服务诊断"""
        shutdown_task = None
        def handle_exit(self, sig, frame):
            if self.shutdown_task is None or self.shutdown_task.done():
                self.shutdown_task = asyncio.create_task(self.stop_before_exit())

        async def stop_before_exit(self):
            result = await app.state.runtime.stop()
            if result['state'] == 'STOPPED':
                self.should_exit = True
            else:
                print(json.dumps({'errors': [{'code': 'stop_unconfirmed',
                                  'reason': '停止未确认，Agent 保留网关与诊断'}]}, ensure_ascii=False), flush=True)

    ManagedServer(uvicorn.Config(app, host=args.host, port=args.port, access_log=False)).run()
    return 0


def main(argv=None):
    args = _parser().parse_args(argv)
    try:
        if args.group == 'gui':
            from .gui import open_gui
            result = open_gui(args)
            print(json.dumps(result, ensure_ascii=False))
            return 0 if result.get('valid') else 1
        if args.group == 'agent':
            return _serve(args)
        if args.command == 'validate' and args.group in ('package', 'system'):
            if args.group == 'package':
                package = load_package(args.path)
                result = {'valid': True, 'package_id': package.package_id, 'enabled': False,
                          'capabilities': [cap.capability_id for cap in package.capabilities]}
            else:
                from .runtime import load_system
                bound, _ = load_system(args.path)
                result = {'valid': True, 'system_id': bound.config.system_id,
                          'roles': {name: {'backend_instance': role.backend_instance,
                                          'capability_id': role.capability.capability_id}
                                    for name, role in bound.roles.items()}}
            code = 0
        else:
            result, code = _remote(args)
        print(json.dumps(result, ensure_ascii=False))
        return code
    except ContractValidationError as exc:
        print(json.dumps({'valid': False, 'errors': [issue.model_dump() for issue in exc.issues]}, ensure_ascii=False))
        return 1
    except OSError as exc:
        print(json.dumps({'errors': [{'code': 'io_error', 'reason': str(exc)}]}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
