"""Workspace-side JSON transport, using only the standard library until ROS is loaded."""
import json
import os
import re
import sys
import threading

from ros_transport import _run_task


def emit(kind, value):
    sys.__stdout__.write('ATIL_EVENT ' + json.dumps({'kind': kind, 'value': value}, ensure_ascii=False) + '\n')
    sys.__stdout__.flush()


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


def main():
    request = json.loads(sys.stdin.readline())
    op = request['op']
    if op == 'module_probe':
        from module_worker import inspect
        emit('result', inspect(request['module']))
        return
    if op == 'ready':
        import rclpy
        context = rclpy.context.Context()
        rclpy.init(context=context, domain_id=request.get('domain_id') or 0)
        node = rclpy.create_node('atil_readiness', context=context)
        try:
            import time
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                rclpy.spin_once(node, timeout_sec=.1)
            services = dict(node.get_service_names_and_types())
            topics = dict(node.get_topic_names_and_types())
            missing = []
            for endpoint in request.get('endpoints', []):
                kind, name = endpoint['kind'], endpoint['name']
                actual = topics.get(name, []) if kind == 'topic' else services.get(name + '/_action/send_goal' if kind == 'action' else name, [])
                wanted = endpoint.get('type')
                if kind == 'action' and wanted: wanted += '_SendGoal'
                if not actual or wanted and wanted not in actual: missing.append(name)
            emit('result', {'ready':not missing, 'missing':missing})
        finally:
            node.destroy_node(); rclpy.shutdown(context=context)
        return
    if op in ('probe', 'verify'):
        import rclpy
        actual = {name: schema(name) for name in request.get('types', [])}
        if request.get('expected'):
            actual.update(verify(request['expected']))
        emit('result', {'schemas': actual, 'python': sys.executable, 'prefixes': os.environ.get('AMENT_PREFIX_PATH', '').split(os.pathsep)})
        return
    if op == 'discover':
        import rclpy
        context = rclpy.context.Context()
        rclpy.init(context=context, domain_id=request.get('domain_id') or 0)
        node = rclpy.create_node('atil_environment_discovery', context=context)
        try:
            import time
            time.sleep(.35)
            services = node.get_service_names_and_types()
            actions = [{'name': name.removesuffix('/_action/send_goal'), 'types': [t.removesuffix('_SendGoal')]}
                       for name, types in services if name.endswith('/_action/send_goal')
                       for t in types if t.endswith('_SendGoal') and '/action/' in t]
            emit('result', {'connected': True, 'topics': [{'name': n, 'types': t} for n, t in node.get_topic_names_and_types()],
                            'services': [{'name': n, 'types': t} for n, t in services if '/_action/' not in n], 'actions': actions})
        finally:
            node.destroy_node(); rclpy.shutdown(context=context)
        return
    data = request['task']
    verify(request.get('expected', {}))
    schema(data['ros_type'])
    stop = threading.Event()
    def controls():
        for line in sys.stdin:
            if line.strip() == 'STOP':
                stop.set()
        # Parent disappearance must request cancellation, never replay work
        stop.set()
    threading.Thread(target=controls, daemon=True).start()
    import rclpy
    context = rclpy.context.Context()
    rclpy.init(context=context, domain_id=data.get('_ros_domain') or 0)
    emit('dispatched', True)
    try:
        result = _run_task(data, stop, lambda v: emit('feedback', v), context=context,
                           unconfirmed=lambda reason: emit('unconfirmed', reason))
        if isinstance(result, str):
            result = {'state': result, 'response': data.get('payload', {}), 'stop_confirmed': True}
        emit('result', result)
    finally:
        rclpy.shutdown(context=context)


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        emit('error', {'reason': str(error), 'missing': getattr(error, 'name', '') or '', 'type': type(error).__name__})
        sys.exit(1)
