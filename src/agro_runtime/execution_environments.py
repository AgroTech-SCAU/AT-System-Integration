"""Workspace environments are loaded only in child processes, never into Studio."""
import copy
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
from uuid import uuid4

from .errors import fail


WORKER = Path(__file__).with_name('ros_worker.py')


class WorkspaceEnvironments:
    def __init__(self, store, robots):
        self.store, self.robots = store, robots
        self.session_id = uuid4().hex
        self.processes = {}
        self.lock = threading.RLock()
        self.computers = {}

    def manage(self, robot, action, workspace_id, python='', setup=''):
        from types import SimpleNamespace
        from .configuration import WorkspaceStore
        store = WorkspaceStore(self.store.root.parent)
        manager = WorkspaceEnvironments(store, SimpleNamespace(selected_id=lambda:robot))
        manager.processes, manager.lock = self.processes, self.lock
        manager.computers = self.computers
        try:
            with self.lock:
                return getattr(manager, action)(workspace_id, python, setup)
        except (EnvironmentFailure, subprocess.SubprocessError) as error:
            fail('$.environment', 'environment_not_ready', str(error))
        finally:
            store.db.close()

    def _robot(self):
        robot = self.robots.selected_id()
        if not robot:
            fail('$.environment', 'no_robot', '请先选择机器人')
        return robot

    def active(self, workspace_id=None):
        robot = self._robot()
        entries = [v for v in self.store.list('execution_environment') if v.get('robot_system_id') == robot]
        return next((v for v in entries if v['workspace_id'] == workspace_id), None) if workspace_id else entries

    def _idle(self):
        robot = self._robot()
        with self.lock:
            busy = any(v[0] == robot and v[1] != 'data_context' and p.poll() is None for p, v in self.processes.items())
        records = [v for v in self.store.list('ros_operation') if v.get('definition', {}).get('robot_system_id') == robot]
        if busy or any(v['snapshot']['state'] in ('ACCEPTED', 'RUNNING', 'CANCELING') or v['snapshot'].get('stop_state') == 'UNCONFIRMED' for v in records):
            fail('$.environment', 'environment_busy', '仍有执行中的任务或停止未确认的操作，不能切换执行环境')

    def status(self, workspace_id):
        from .interface_sources import InterfaceWorkspaces
        record = InterfaceWorkspaces(self.store, self._robot()).get(workspace_id)
        root = Path(record['path']) if record.get('path') else None
        active = self.active(workspace_id)
        reports = self.store.list('environment_report')
        report = next((v for v in reports if v['id'] == workspace_id), None)
        setup_candidates = []
        for value in [(report or {}).get('setup'), (active or {}).get('setup'),
                      str(root / 'setup.bash') if root else '', str(root / 'install/setup.bash') if root else '']:
            if value and Path(value).is_file() and value not in setup_candidates:
                setup_candidates.append(value)
        candidates = []
        if root:
            for path in (root / '.venv/bin/python', root / 'venv/bin/python', root / '.install/venv/bin/python'):
                if path.is_file(): candidates.append(str(path))
        if Path('/usr/bin/python3').is_file(): candidates.append('/usr/bin/python3')
        for value in [(report or {}).get('python'), (active or {}).get('python')]:
            if value and os.access(value, os.X_OK) and value not in candidates:
                candidates.insert(0, value)
        loaded = False
        if active:
            try:
                loaded = active.get('signature') == self.signature(active)
            except OSError:
                pass
        return {'workspace_id': workspace_id, 'setup': next(iter(setup_candidates), ''),
                'setup_candidates': setup_candidates, 'candidates': candidates, 'report': report,
                'active': active, 'loaded': loaded}

    def _configuration(self, workspace_id, python, setup=''):
        state = self.status(workspace_id)
        if not isinstance(setup, str):
            fail('$.setup', 'invalid_setup', '请选择安装环境 setup 文件的绝对路径')
        setup = setup.strip() or state['setup']
        if not setup:
            fail('$.environment', 'workspace_not_built', '没有工作区安装环境，请先构建工作区，再检查执行环境')
        path = Path(setup).expanduser()
        if not path.is_absolute():
            fail('$.setup', 'invalid_setup', '请选择安装环境 setup 文件的绝对路径')
        if path.is_dir():
            path = path / 'setup.bash' if (path / 'setup.bash').is_file() else path / 'install/setup.bash'
        if not path.is_file():
            fail('$.setup', 'invalid_setup', '安装环境文件不存在，请选择已构建工作区的 setup.bash')
        python = python or (state['report'] or {}).get('python') or next(iter(state['candidates']), '')
        if not isinstance(python, str) or not Path(python).is_absolute() or not os.access(python, os.X_OK):
            fail('$.python', 'invalid_python', '请选择可执行的 Python 绝对路径')
        from .interface_sources import InterfaceWorkspaces
        workspace = InterfaceWorkspaces(self.store, self._robot()).get(workspace_id)
        return {'id': workspace_id, 'robot_system_id': self._robot(), 'workspace_id': workspace_id, 'name': workspace['name'],
                'setup': str(path.resolve()), 'python': python}

    def _expected(self, workspace_id):
        from .interface_sources import InterfaceWorkspaces
        resolution = InterfaceWorkspaces(self.store, self._robot()).require_resolved([workspace_id])
        return {v['ros_type']: self.store.get('ros_schema', v['schema_id'])['schema']
                for v in resolution['types'] if v.get('available') and v.get('schema_id')}

    def check(self, workspace_id, python='', setup=''):
        config = self._configuration(workspace_id, python, setup)
        expected = self._expected(workspace_id)
        try:
            response = self.call(config, {'op': 'probe', 'types': list(expected), 'expected': expected})
            report = {'id': workspace_id, 'ready': True, 'python': config['python'], 'setup': config['setup'],
                      'prefixes': response['prefixes'], 'interface_count': len(response['schemas']), 'reason': '', 'missing': ''}
        except EnvironmentFailure as error:
            report = {'id': workspace_id, 'ready': False, 'python': config['python'], 'setup': config['setup'],
                      'reason': str(error), 'missing': error.missing}
        self.store.put('environment_report', workspace_id, report)
        return self.status(workspace_id)

    def load(self, workspace_id, python='', setup=''):
        self._idle()
        state = self.check(workspace_id, python, setup)
        if not state['report']['ready']:
            return state
        config = self._configuration(workspace_id, state['report']['python'], state['report']['setup'])
        self._idle()
        config['signature'] = self.signature(config)
        self.store.put('execution_environment', config['id'], config)
        return self.status(workspace_id)

    def supplement(self, workspace_id, python='', setup=''):
        self._idle()
        config = self._configuration(workspace_id, python, setup)
        state = self.check(workspace_id, config['python'], config['setup'])
        if state['report']['ready']:
            return state
        packages = {'numpy': 'numpy', 'yaml': 'PyYAML'}
        missing = state['report'].get('missing', '').split('.')[0]
        if missing not in packages:
            fail('$.environment', 'external_dependency', '需要在工作区环境中补齐 ROS 通信库或构建接口，再重新检查：' + state['report']['reason'])
        target = self.store.root / 'environments' / workspace_id
        if not (target / 'bin/python').is_file():
            subprocess.run([config['python'], '-m', 'venv', '--system-site-packages', str(target)], check=True, capture_output=True, timeout=60)
        interpreter = str(target / 'bin/python')
        subprocess.run([interpreter, '-m', 'pip', 'install', packages[missing]], check=True, capture_output=True, timeout=180)
        return self.check(workspace_id, interpreter, config['setup'])

    @staticmethod
    def signature(config):
        path = Path(config['setup'])
        return hashlib.sha256(path.read_bytes() + config['python'].encode() + config['setup'].encode()).hexdigest()

    def workspace_for(self, task):
        if task.get('execution_workspace_id'):return task['execution_workspace_id']
        candidates=[]
        for identity in task.get('workspace_ids',[]):
            record=next((v for v in self.store.list('interface_workspace') if v['id']==identity),{})
            if task.get('ros_type') in record.get('definitions',{}):candidates.append(identity)
        candidates=candidates or task.get('workspace_ids',[])
        if len(candidates)!=1:
            fail('$.execution_workspace_id','provider_required','请选择此任务的执行子系统，多个接口来源不能决定启动位置')
        return candidates[0]

    def snapshot(self, task=None, workspace_id=None):
        if task is not None:
            workspace_id = workspace_id or self.workspace_for(task)
        if workspace_id is None:
            entries = self.active()
            if len(entries) != 1:
                fail('$.environment', 'provider_required', '请选择要使用的子系统执行环境')
            workspace_id = entries[0]['workspace_id']
        config = self.active(workspace_id)
        if not config:
            fail('$.environment', 'environment_not_loaded', '请在子系统工作区中加载执行环境，接口定义仍可离线编辑')
        if not Path(config['setup']).is_file() or config.get('signature') != self.signature(config):
            fail('$.environment', 'environment_changed', '工作区执行环境已变化，请重新检查并加载')
        return copy.deepcopy(config)

    def call(self, config, request, stop=None, feedback=None):
        # Positional shell arguments avoid interpreting paths as shell commands
        env = dict(os.environ)
        for key in ('AMENT_PREFIX_PATH', 'CMAKE_PREFIX_PATH', 'COLCON_PREFIX_PATH', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'LD_LIBRARY_PATH'):
            env.pop(key, None)
        env['PYTHONDONTWRITEBYTECODE'] = '1'
        env['ROS_LOG_DIR'] = str(self.store.root / 'ros_logs')
        command = ['bash', '--noprofile', '--norc', '-c',
                   'source "$1" >/dev/null && exec "$2" -u "$3"', 'atil-environment', config['setup'], config['python'], str(WORKER)]
        try:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       text=True, env=env, start_new_session=True)
        except OSError as error:
            if request['op'] == 'run':
                return {'state':'FAILED','stop_confirmed':True,'response':{},
                        'error':{'code':'environment_not_ready','reason':str(error),'retryable':False}}
            raise EnvironmentFailure(str(error)) from error
        events = queue.Queue()
        def reader():
            try:
                for line in process.stdout:
                    if line.startswith('ATIL_EVENT '):
                        try: events.put(json.loads(line[11:]))
                        except (ValueError, TypeError): pass
            finally:
                events.put({'kind': 'eof', 'value': None})
        with self.lock:
            self.processes[process] = (config.get('robot_system_id', config['id']), request['op'])
        threading.Thread(target=reader, daemon=True).start()
        sent_stop, dispatched, detached = False, False, False
        started = time.monotonic()
        try:
            process.stdin.write(json.dumps(request) + '\n'); process.stdin.flush()
            while True:
                if stop and stop.is_set() and not sent_stop:
                    process.stdin.write('STOP\n'); process.stdin.flush(); sent_stop = True
                try: event = events.get(timeout=.05)
                except queue.Empty:
                    limit = request.get('task', {}).get('timeout_s', 15) + 25 if dispatched else 30
                    if time.monotonic() - started > limit:
                        if dispatched:
                            if not sent_stop:
                                process.stdin.write('STOP\n'); process.stdin.flush()
                            detached = True
                        raise EnvironmentFailure('执行进程响应超时，停止未确认' if dispatched else '加载执行环境超时')
                    continue
                kind, value = event['kind'], event['value']
                if kind == 'dispatched': dispatched = True
                elif kind == 'feedback' and feedback: feedback(value)
                elif kind == 'result': return value
                elif kind == 'unconfirmed':
                    detached = True
                    raise EnvironmentFailure(value)
                elif kind == 'error':
                    if request['op'] == 'run' and not dispatched:
                        return {'state': 'FAILED', 'response': {}, 'stop_confirmed': True,
                                'error': {'code': 'environment_not_ready', 'reason': value['reason'], 'retryable': False}}
                    raise EnvironmentFailure(value['reason'], value.get('missing', ''))
                elif kind == 'eof': raise EnvironmentFailure('执行进程退出，未返回有效结果')
        except (EnvironmentFailure, OSError) as error:
            if request['op'] == 'run' and not dispatched:
                return {'state':'FAILED','stop_confirmed':True,'response':{},
                        'error':{'code':'environment_not_ready','reason':str(error),'retryable':False}}
            if dispatched and process.poll() is None:
                detached = True
                try:
                    process.stdin.write('STOP\n'); process.stdin.flush()
                except OSError:
                    pass
            raise
        finally:
            if detached:
                # Preserve delayed-cancel ownership; resources remain UNCONFIRMED in Studio
                def reap():
                    process.wait()
                    with self.lock: self.processes.pop(process, None)
                    process.stdin.close(); process.stdout.close()
                threading.Thread(target=reap, daemon=True).start()
            else:
                try: process.wait(timeout=2)
                except subprocess.TimeoutExpired: process.terminate(); process.wait(timeout=2)
                with self.lock: self.processes.pop(process, None)
                process.stdin.close(); process.stdout.close()

    def close(self):
        self.close_computers()
        with self.lock:
            for process in list(self.processes):
                if process.poll() is None:
                    try: process.stdin.write('STOP\n'); process.stdin.flush()
                    except (OSError, ValueError): pass

    def computer(self, config, domain):
        key=(config['workspace_id'],domain,config['signature'])
        with self.lock:
            existing=self.computers.get(key)
            if existing and existing['process'].poll() is None:return existing
            env=dict(os.environ)
            env['ROS_LOG_DIR']=str(self.store.root/'ros_logs')
            for name in ('AMENT_PREFIX_PATH','CMAKE_PREFIX_PATH','COLCON_PREFIX_PATH','PYTHONPATH','PYTHONHOME','VIRTUAL_ENV','LD_LIBRARY_PATH'):env.pop(name,None)
            worker=Path(__file__).with_name('data_worker.py')
            command=['bash','--noprofile','--norc','-c','source "$1" >/dev/null && exec "$2" -u "$3"','atil-data',config['setup'],config['python'],str(worker)]
            process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env=env,start_new_session=True)
            events=queue.Queue()
            def read():
                for line in process.stdout:
                    if line.startswith('ATIL_EVENT '):
                        try:events.put(json.loads(line[11:]))
                        except ValueError:pass
                events.put({'error':'数据处理进程已退出'})
            threading.Thread(target=read,daemon=True).start()
            process.stdin.write(json.dumps({'domain_id':domain})+'\n');process.stdin.flush()
            try:
                value=events.get(timeout=20)
                if not value.get('ready'):raise EnvironmentFailure(value.get('error','无法启动数据处理环境'))
            except BaseException:
                process.terminate();process.wait(timeout=5);raise
            result={'process':process,'events':events,'lock':threading.Lock()}
            self.computers[key]=result;self.processes[process]=(config['robot_system_id'],'data_context')
            return result

    def compute(self, config, data, stop):
        computer=self.computer(config,data.get('_ros_domain',0))
        with computer['lock']:
            if stop.is_set():return {'state':'CANCELED','response':{},'stop_confirmed':True}
            process=computer['process'];events=computer['events']
            process.stdin.write(json.dumps(data)+'\n');process.stdin.flush()
            deadline=time.monotonic()+data.get('timeout_s',15)+2;sent=False
            while True:
                if stop.is_set() and not sent:
                    process.stdin.write('STOP\n');process.stdin.flush();sent=True
                try:
                    result=events.get(timeout=.05)
                    if not result.get('state'):raise EnvironmentFailure(result.get('error','数据处理失败'))
                    return result
                except queue.Empty:
                    if time.monotonic()>deadline:
                        process.terminate();process.wait(timeout=5)
                        raise EnvironmentFailure('数据处理超时，未继续派发动作')

    def close_computers(self):
        with self.lock:
            for computer in self.computers.values():
                process=computer['process']
                if process.poll() is None:
                    try:process.stdin.write('QUIT\n');process.stdin.flush();process.wait(timeout=5)
                    except (OSError,subprocess.TimeoutExpired):process.terminate();process.wait(timeout=5)
                self.processes.pop(process,None)
                process.stdin.close();process.stdout.close()
            self.computers.clear()


class EnvironmentFailure(RuntimeError):
    def __init__(self, reason, missing=''):
        super().__init__(reason)
        self.missing = missing
