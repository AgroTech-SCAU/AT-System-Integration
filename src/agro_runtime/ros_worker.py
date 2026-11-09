"""Workspace-side JSON transport, using only the standard library until ROS is loaded."""
import json
import os
import queue
import re
import sys
import threading
from functools import lru_cache

from ros_transport import RosSession, _run_task

CURRENT_REQUEST = None


def emit(kind, value):
    sys.__stdout__.write('ATIL_EVENT ' + json.dumps({'request_id':CURRENT_REQUEST,'kind': kind, 'value': value}, ensure_ascii=False) + '\n')
    sys.__stdout__.flush()


@lru_cache(maxsize=256)
def schema(ros_type):
    from rosidl_runtime_py.utilities import get_action, get_message, get_service
    from rosidl_runtime_py.convert import message_to_ordereddict
    from rclpy.type_support import check_for_type_support
    category = ros_type.split('/')[1]
    cls = {'action': get_action, 'srv': get_service, 'msg': get_message}[category](ros_type)
    check_for_type_support(cls)
    request = cls.Goal if category == 'action' else cls.Request if category == 'srv' else cls
    response = cls.Result if category == 'action' else cls.Response if category == 'srv' else cls
    result = {'field_types': request.get_fields_and_field_types(), 'output_field_types': response.get_fields_and_field_types(),
              'fields': dict(message_to_ordereddict(request())), 'output_fields': dict(message_to_ordereddict(response()))}
    if category == 'action':
        result.update(feedback_field_types=cls.Feedback.get_fields_and_field_types(), feedback_fields=dict(message_to_ordereddict(cls.Feedback())))
    return result


def canonical(fields, package):
    result = {}
    for key, value in fields.items():
        value = re.sub(r'(?:bounded_)?sequence<(.+?)(?:,\s*(\d+))?>', lambda m: m[1] + ('[<=' + m[2] + ']' if m[2] else '[]'), value)
        aliases = {'boolean': 'bool', 'float': 'float32', 'double': 'float64', 'octet': 'byte', 'char': 'uint8'}
        value = re.sub(r'\b(boolean|float|double|octet|char)\b', lambda m: aliases[m[0]], value)
        value = re.sub(r'(w?string)<(\d+)>', r'\1<=\2', value).replace('/msg/', '/').replace(' ', '')
        base = value.split('[', 1)[0]
        primitives = {'bool','byte','int8','uint8','int16','uint16','int32','uint32','int64','uint64','float32','float64'}
        if '/' not in base and base not in primitives and not re.fullmatch(r'w?string(?:<=\d+)?',base):
            value = package + '/' + value
        result[key] = value
    return result


def verify(expected):
    actual = {}
    for name, wanted in expected.items():
        actual[name] = found = schema(name)
        for key in ('field_types', 'output_field_types', 'feedback_field_types'):
            if canonical(found.get(key, {}), name.split('/')[0]) != canonical(wanted.get(key, {}), name.split('/')[0]):
                raise ValueError('接口定义与执行环境不一致：' + name + ' / ' + key)
    return actual


class WorkspaceWorker:
    def __init__(self, configuration):
        self.domain=configuration.get('domain_id')
        self.use_sim_time=configuration.get('use_sim_time',False)
        self.session=None;self.health=None;self.retire=False;self.discovered=False

    def ros(self):
        if self.session is None:self.session=RosSession(self.domain,self.use_sim_time)
        return self.session

    def dispatch(self, request, stop):
        op=request['op']
        if op=='module_probe':
            from module_worker import inspect
            emit('result',inspect(request['module']))
        elif op=='compute_probe':
            if request.get('entrypoint'):
                import importlib
                module,function=request['entrypoint'].split(':')
                if not callable(getattr(importlib.import_module(module),function)):raise ValueError('计算入口不可调用')
            emit('result',{'ready':True})
        elif op=='ready':
            from module_health import HealthProbe
            if self.health is None:self.health=HealthProbe(self.domain or 0)
            emit('result',self.health.probe(request))
        elif op in ('probe','verify'):
            import rclpy
            actual={name:schema(name) for name in request.get('types',[])}
            if request.get('expected'):actual.update(verify(request['expected']))
            emit('result',{'schemas':actual,'python':sys.executable,'prefixes':os.environ.get('AMENT_PREFIX_PATH','').split(os.pathsep)})
        elif op=='discover':
            import time
            session=self.ros();node=session.node
            if not self.discovered:
                deadline=time.monotonic()+.35
                while time.monotonic()<deadline:session.executor.spin_once(timeout_sec=.05)
                self.discovered=True
            services=node.get_service_names_and_types()
            actions=[{'name':name.removesuffix('/_action/send_goal'),'types':[kind.removesuffix('_SendGoal')]}
                     for name,types in services if name.endswith('/_action/send_goal')
                     for kind in types if kind.endswith('_SendGoal') and '/action/' in kind]
            emit('result',{'connected':True,'topics':[{'name':name,'types':types} for name,types in node.get_topic_names_and_types()],
                           'services':[{'name':name,'types':types} for name,types in services if '/_action/' not in name],'actions':actions})
        elif op=='run':
            data=request['task'];verify(request.get('expected',{}));schema(data['ros_type'])
            session=self.ros()
            if stop.is_set():
                emit('result',{'state':'CANCELED','response':{},'stop_confirmed':True});return
            emit('dispatched',True)
            sent=False
            def completed(value):
                nonlocal sent
                if not sent:emit('result',value);sent=True
            def unconfirmed(reason):
                self.retire=True
                emit('unconfirmed',reason)
            try:
                result=_run_task(data,stop,lambda value:emit('feedback',value),session=session,
                                 unconfirmed=unconfirmed,completed=completed)
                if isinstance(result,str):result={'state':result,'response':data.get('payload',{}),'stop_confirmed':True}
                if result.get('state')=='UNKNOWN':self.retire=True
                completed(result)
            except BaseException:
                self.retire=True
                raise
        else:raise ValueError('未知执行环境操作：'+str(op))

    def close(self):
        if self.health:self.health.close()
        if self.session:self.session.close()


def main():
    global CURRENT_REQUEST
    configuration=json.loads(sys.stdin.readline())
    jobs=queue.Queue();quitting=threading.Event();lock=threading.Lock()
    active={'id':None,'stop':None};pending_stops=set()
    def controls():
        try:
            for line in sys.stdin:
                value=json.loads(line)
                with lock:
                    if 'stop' in value:
                        if active['id']==value['stop'] and active['stop'] is not None:active['stop'].set()
                        else:pending_stops.add(value['stop'])
                    if value.get('quit'):
                        quitting.set()
                        if active['stop'] is not None:active['stop'].set()
                        jobs.put(None);return
                    if 'request' in value:jobs.put(value)
        finally:
            # Losing the parent cancels the current goal; never dispatch queued work
            quitting.set()
            with lock:
                if active['stop'] is not None:active['stop'].set()
            jobs.put(None)
    threading.Thread(target=controls,daemon=True).start()
    worker=WorkspaceWorker(configuration)
    try:
        while not quitting.is_set():
            try:job=jobs.get(timeout=.01)
            except queue.Empty:
                if worker.session:worker.session.executor.spin_once(timeout_sec=0)
                continue
            if job is None or quitting.is_set():break
            CURRENT_REQUEST=job['request_id'];stop=threading.Event()
            with lock:
                active.update(id=CURRENT_REQUEST,stop=stop)
                if quitting.is_set():stop.set()
                if CURRENT_REQUEST in pending_stops:stop.set();pending_stops.remove(CURRENT_REQUEST)
            try:worker.dispatch(job['request'],stop)
            except BaseException as error:
                emit('error',{'reason':str(error),'missing':getattr(error,'name','') or '','type':type(error).__name__})
            finally:
                with lock:active.update(id=None,stop=None)
            if worker.retire:break
            emit('idle',True)
    finally:worker.close()


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        emit('error', {'reason': str(error), 'missing': getattr(error, 'name', '') or '', 'type': type(error).__name__})
        sys.exit(1)
