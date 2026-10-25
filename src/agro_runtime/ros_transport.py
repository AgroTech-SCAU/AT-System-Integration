"""Dependency-light ROS transport for isolated workspace processes."""
import json
import threading
import time
from uuid import uuid4


def fail(path, code, reason):
    raise RuntimeError(reason)


def _ros_modules():
    try:
        import rclpy
        from rosidl_runtime_py.utilities import get_message, get_service, get_action
        from rosidl_runtime_py.set_message import set_message_fields
        return rclpy, (get_message, get_service, get_action), set_message_fields, None
    except ImportError:
        fail('$.ros', 'ros_not_installed', '当前环境未找到 ROS 2 Python 环境，请先 source ROS 2 与机器人工作空间')


def _message_as_dict(msg):
    from rosidl_runtime_py.convert import message_to_ordereddict
    return message_to_ordereddict(msg)


def _matches(msg, cond):
    return _matches_value(_message_as_dict(msg),cond)


def _matches_value(value, cond):
    op = cond.get('operator', 'any')
    if op == 'any':
        return True
    if cond.get('field') != '$':
        for segment in cond.get('field', '').split('.'):
            if isinstance(value, dict) and segment in value:
                value = value[segment]
            elif isinstance(value, list) and segment.isdigit() and int(segment) < len(value):
                value = value[int(segment)]
            else:
                return False
    right = cond.get('value')
    if op == 'equals': return value == right
    if op == 'not_equals': return value != right
    if type(value) not in (int, float) or type(right) not in (int, float): return False
    return value > right if op == 'greater' else value < right


def _run_task(data, stop, feedback=None, *, context=None, unconfirmed=None):
    rclpy, (get_message, get_service, get_action), fill, _ = _ros_modules()
    from rclpy.executors import SingleThreadedExecutor
    from rclpy.action import ActionClient
    owns_context=context is None
    if owns_context:
        context = rclpy.context.Context()
        rclpy.init(context=context)
    node = None
    executor = None
    action_goal = None
    kind = data['kind']
    deadline = time.monotonic() + data.get('timeout_s', 15)
    def remaining():
        return max(0.0, deadline - time.monotonic())
    def spin_until(future):
        while not future.done():
            if stop.is_set() or remaining() <= 0:
                return False
            executor.spin_once(timeout_sec=min(.05, remaining()))
        return True
    def message(cls, payload):
        msg = cls()
        try:
            fill(msg, payload)
        except Exception as exc:
            fail('$.payload', 'invalid_fields', '消息字段与 ROS 2 接口定义不匹配: ' + str(exc))
        return msg
    try:
        node = rclpy.create_node('atil_task_' + uuid4().hex[:8], context=context)
        executor = SingleThreadedExecutor(context=context)
        executor.add_node(node)
        interface = data['interface']
        ros_type = data['ros_type']
        if kind in ('publish_once', 'publish_periodic'):
            cls = get_message(ros_type)
            from rclpy.qos import QoSProfile, ReliabilityPolicy
            qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.BEST_EFFORT if data.get('qos_reliability') == 'best_effort' else ReliabilityPolicy.RELIABLE)
            pub = node.create_publisher(cls, interface, qos)
            msg = message(cls, data.get('payload', {}))
            if kind == 'publish_once':
                if stop.is_set(): return 'CANCELED'
                pub.publish(msg)
                executor.spin_once(timeout_sec=.08)
                return 'SUCCEEDED'
            final = message(cls, data['stop_payload'])
            delay = 1.0 / data.get('rate_hz', 5)
            while not stop.is_set() and remaining() > 0:
                pub.publish(msg)
                executor.spin_once(timeout_sec=min(delay, .05))
                if delay > .05:
                    stop.wait(delay - .05)
            # 不论正常超时还是取消，退出持续发布前都发送安全停止消息
            for _ in range(3):
                pub.publish(final)
                executor.spin_once(timeout_sec=.035)
            return 'CANCELED' if stop.is_set() else 'FAILED'
        if kind == 'subscribe_wait':
            cls = get_message(ros_type)
            from rclpy.qos import QoSProfile, ReliabilityPolicy
            qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.BEST_EFFORT if data.get('qos_reliability', 'best_effort') == 'best_effort' else ReliabilityPolicy.RELIABLE)
            matched = threading.Event()
            response = {}
            def observe(msg):
                nonlocal response
                if _matches(msg, data.get('condition', {})):
                    response = _message_as_dict(msg)
                    matched.set()
            sub = node.create_subscription(cls, interface, observe, qos)
            while not matched.is_set() and not stop.is_set() and remaining() > 0:
                executor.spin_once(timeout_sec=min(.05, remaining()))
            return {'state': 'CANCELED' if stop.is_set() else 'SUCCEEDED' if matched.is_set() else 'FAILED', 'response': response}
        if kind == 'service':
            cls = get_service(ros_type)
            client = node.create_client(cls, interface)
            while not client.wait_for_service(timeout_sec=.1):
                if stop.is_set(): return 'CANCELED'
                if remaining() <= 0: return 'FAILED'
            future = client.call_async(message(cls.Request, data.get('payload', {})))
            if not spin_until(future):
                future.cancel()
                # 服务请求可能已到达设备，取消本地等待并不等于服务端停止执行
                raise RuntimeError('Service 请求已发出但未收到响应，设备执行状态未知，请人工核对')
            result = future.result()
            if feedback:
                feedback(_message_as_dict(result))
            # 服务响应仅表示服务调用结束，并不证明实体动作已经完成
            return {'state': 'SUCCEEDED', 'response': _message_as_dict(result)}
        if kind == 'action':
            cls = get_action(ros_type)
            client = ActionClient(node, cls, interface)
            while not client.wait_for_server(timeout_sec=.1):
                if stop.is_set(): return 'CANCELED'
                if remaining() <= 0: return 'FAILED'
            def progress(event):
                if feedback:
                    feedback(_message_as_dict(event.feedback))
            future = client.send_goal_async(message(cls.Goal, data.get('payload', {})), feedback_callback=progress)
            cancel_reason = None
            if not spin_until(future):
                cancel_reason = 'canceled' if stop.is_set() else 'timeout'
                limit = time.monotonic() + 5
                while not future.done() and time.monotonic() < limit:
                    executor.spin_once(timeout_sec=.05)
                if not future.done():
                    if unconfirmed:
                        unconfirmed('Action 目标尚未确认接受，仍在等待并尝试取消')
                    else:
                        raise RuntimeError('Action 目标接受状态未知')
                    # This worker retains the pending goal even after reporting UNKNOWN
                    while not future.done():
                        executor.spin_once(timeout_sec=.1)
            action_goal = future.result()
            if not action_goal.accepted:
                return {'state': 'FAILED', 'response': {}, 'stop_confirmed': True,
                        'error': {'code': 'goal_rejected', 'reason': 'Action 目标被服务端拒绝', 'retryable': False}}
            result_future = action_goal.get_result_async()
            cancel_sent, notified = False, False
            cancel_deadline = None
            while not result_future.done():
                if cancel_reason or stop.is_set() or remaining() <= 0:
                    cancel_reason = cancel_reason or ('canceled' if stop.is_set() else 'timeout')
                    if not cancel_sent:
                        action_goal.cancel_goal_async()
                        cancel_sent = True
                        cancel_deadline = time.monotonic() + 10
                    if time.monotonic() >= cancel_deadline and not notified:
                        if unconfirmed:
                            unconfirmed('Action 停止未确认，继续等待服务端最终状态')
                        else:
                            raise RuntimeError('Action 停止未确认')
                        notified = True
                    executor.spin_once(timeout_sec=.05)
                else:
                    executor.spin_once(timeout_sec=min(.05, remaining()))
            result = result_future.result()
            from action_msgs.msg import GoalStatus
            response = _message_as_dict(result.result)
            if feedback:
                feedback(response)
            def value_at(path):
                value = response
                for part in path.split('.'):
                    value = value.get(part) if isinstance(value, dict) else None
                return value
            field = data.get('stop_confirmation_field', '')
            stopped = value_at(field) is True if field else result.status in (GoalStatus.STATUS_SUCCEEDED, GoalStatus.STATUS_CANCELED)
            state = ('SUCCEEDED' if result.status == GoalStatus.STATUS_SUCCEEDED else
                     'CANCELED' if result.status == GoalStatus.STATUS_CANCELED else 'FAILED')
            reason = value_at(data.get('error_message_field') or 'message') or 'Action 未成功完成'
            if not stopped:
                return {'state': 'UNKNOWN', 'terminal_received': True, 'terminal_state': state, 'response': response, 'stop_confirmed': False,
                        'error': {'code': 'stop_unconfirmed', 'reason': str(reason), 'retryable': False}}
            if cancel_reason == 'timeout':
                state, reason = 'FAILED', '任务整体超时，设备停止已确认'
            outcome = {'state': state, 'terminal_received': True, 'terminal_state': state, 'response': response, 'stop_confirmed': True}
            if state == 'FAILED':
                outcome['error'] = {'code': 'task_timeout' if cancel_reason == 'timeout' else 'action_failed',
                                    'reason': str(reason), 'retryable': False}
            return outcome
        raise ValueError('unsupported ROS task')
    finally:
        if executor:
            executor.shutdown()
        if node:
            node.destroy_node()
        if owns_context:rclpy.shutdown(context=context)
