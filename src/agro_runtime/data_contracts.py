"""Shared offline port compatibility; conversions must be explicit."""


def contract_reason(source, target):
    for key, label in (('type', '数据类型'), ('unit', '单位'), ('frame_id', '坐标系'), ('clock_domain', '时间域')):
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
