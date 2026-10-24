import copy
import hashlib

from .errors import fail
from .ros_interfaces import validate_schema_value


def definition_key(text):
    return hashlib.sha256(text.encode()).hexdigest()


def field_at(schema, path):
    section, _, path = path.partition('.')
    fields = schema.get({'input': 'field_schemas', 'output': 'output_field_schemas', 'feedback': 'feedback_field_schemas'}.get(section, ''), {})
    descriptor = {'kind': 'object', 'fields': fields}
    for part in path.split('.'):
        if descriptor.get('kind') == 'object':
            descriptor = descriptor.get('fields', {}).get(part)
        elif descriptor.get('kind') == 'array' and part == '*':
            descriptor = descriptor.get('item')
        else:
            descriptor = None
        if not descriptor:
            fail('$.field_notes', 'unknown_field', '接口中不存在字段：' + path)
    return descriptor


def validate_notes(raw, schema):
    if not isinstance(raw, dict) or len(raw) > 256:
        fail('$.field_notes', 'invalid_notes', '字段说明最多 256 项')
    result = {}
    for path, note in raw.items():
        if not isinstance(path, str) or len(path) > 512 or not isinstance(note, dict) or set(note) - {'label', 'description', 'unit', 'options'}:
            fail('$.field_notes', 'invalid_notes', '字段说明格式无效')
        descriptor = field_at(schema, path)
        clean = {}
        for key, limit in (('label', 80), ('description', 2000), ('unit', 40)):
            value = note.get(key, '')
            if not isinstance(value, str) or len(value) > limit:
                fail('$.field_notes.' + path, 'invalid_notes', '字段说明超出长度限制')
            if value.strip():
                clean[key] = value.strip()
        if clean.get('unit') and descriptor['kind'] not in ('integer', 'number'):
            fail('$.field_notes.' + path, 'invalid_unit', '单位仅适用于数值字段')
        if note.get('options'):
            if descriptor['kind'] not in ('integer', 'number', 'string') or not isinstance(note['options'], list) or len(note['options']) > 128:
                fail('$.field_notes.' + path, 'invalid_options', '此字段不能配置这些可选值')
            options = []
            for option in note['options']:
                if not isinstance(option, dict) or not isinstance(option.get('label'), str) or not 1 <= len(option['label']) <= 120:
                    fail('$.field_notes.' + path, 'invalid_options', '为每个可选值填写说明')
                value = option.get('value')
                validate_schema_value(value, {key: value for key, value in descriptor.items() if key != 'options'}, '$.field_notes.' + path)
                if any(item['value'] == value for item in options):
                    fail('$.field_notes.' + path, 'duplicate_options', '可选值不能重复')
                options.append({'label': option['label'], 'value': value})
            clean['options'] = options
        result[path] = clean
    return result


def apply_notes(schema, notes):
    schema = copy.deepcopy(schema)
    schema['field_notes'] = copy.deepcopy(notes)
    for path, note in notes.items():
        descriptor = field_at(schema, path)
        if note:
            descriptor['source_description'] = descriptor.get('description', '')
            descriptor.update(note)
            descriptor['annotation_source'] = 'workspace'
    return schema
