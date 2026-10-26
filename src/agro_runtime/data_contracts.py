"""Shared offline port compatibility; conversions must be explicit."""


def contract_reason(source, target):
    for key, label in (('type', '数据类型'), ('unit', '单位'), ('frame_id', '坐标系'), ('clock_domain', '时间域'), ('frame_path', '坐标系字段'), ('stamp_path', '采样时间字段')):
        if target.get(key) is not None and source.get(key) != target[key]:
            return label + '不一致，需要明确转换'
    a, b = source.get('extensions', {}), target.get('extensions', {})
    if b.get('ros_type') and a.get('ros_type') != b['ros_type']:
        return 'ROS 字段类型不一致或尚未声明'
    if b.get('ros_shape') and a.get('ros_shape') != b['ros_shape']:
        return '消息结构或数组边界不一致'
    for key, compare in (('minimum', lambda a, b: a >= b), ('maximum', lambda a, b: a <= b)):
        if target.get(key) is not None and (source.get(key) is None or not compare(source[key], target[key])):
            return '来源数值范围不能保证满足目标范围'
    if target.get('choices') and (not source.get('choices') or any(value not in target['choices'] for value in source['choices'])):
        return '来源可选值不能保证满足目标限制'
    if target.get('max_age_s') is not None and (source.get('max_age_s') is None or source['max_age_s'] > target['max_age_s']):
        return '来源数据有效期不满足目标要求'
    return ''


def wire_shape(descriptor):
    result = {key: descriptor[key] for key in ('type', 'kind', 'length', 'max_length', 'min', 'max') if key in descriptor}
    for key in ('min', 'max'):
        if descriptor.get('kind') == 'integer' and abs(result.get(key, 0)) > 9007199254740991:
            result.pop(key, None)
    if descriptor.get('fields') is not None:
        result['fields'] = {key: wire_shape(child) for key, child in descriptor['fields'].items()}
    if descriptor.get('item'):
        result['item'] = wire_shape(descriptor['item'])
    return result


def valid_shape(shape, depth=0):
    if depth > 16 or not isinstance(shape, dict) or shape.get('kind') not in ('object', 'array', 'integer', 'number', 'boolean', 'string'):
        return False
    if len(shape) > 10 or not isinstance(shape.get('type', ''), str):
        return False
    for key in ('length', 'max_length'):
        if key in shape and (type(shape[key]) is not int or shape[key] < 0):
            return False
    for key in ('min', 'max'):
        if key in shape and type(shape[key]) not in (float, int):
            return False
    if shape['kind'] == 'object':
        fields = shape.get('fields')
        return isinstance(fields, dict) and len(fields) <= 256 and all(isinstance(key, str) and valid_shape(child, depth + 1) for key, child in fields.items())
    if shape['kind'] == 'array':
        return valid_shape(shape.get('item'), depth + 1)
    return True


def field_at_path(value, path):
    if path == '$': return value
    for part in path.split('.'):
        value = value[int(part)] if isinstance(value, list) else value[part]
    return value


def semantic_reason(contract, value, clocks=None):
    """Validate actual frame/sample time, without refreshing the sample timestamp."""
    try:
        if contract.get('frame_path') and field_at_path(value, contract['frame_path']) != contract.get('frame_id'):
            return '数据中的坐标系与端口声明不同'
        if contract.get('stamp_path'):
            stamp = field_at_path(value, contract['stamp_path'])
            if not isinstance(stamp, dict) or type(stamp.get('sec')) is not int or type(stamp.get('nanosec')) is not int or not 0 <= stamp['nanosec'] < 1000000000:
                return '采样时间需要 sec 与 nanosec 字段'
            import time
            now = (clocks or {}).get(contract.get('clock_domain'))
            if now is None and contract.get('clock_domain') == 'system': now = time.time_ns()
            if now is None: return '无法读取声明的时间域，不能确认数据有效期'
            age = (now - stamp['sec'] * 1000000000 - stamp['nanosec']) / 1e9
            if stamp['sec'] * 1000000000 + stamp['nanosec'] <= 0 or not 0 <= age <= contract['max_age_s']:
                return '采样数据已过期或时间戳超前'
    except (KeyError, IndexError, TypeError, ValueError):
        return '数据中缺少声明的语义字段'
    return ''
