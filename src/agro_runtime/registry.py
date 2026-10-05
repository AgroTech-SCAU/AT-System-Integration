"""仅处理数据的接入包注册与系统绑定"""
import copy
import json
import math
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Mapping

import yaml

from .errors import ContractValidationError, fail, parse
from .models import (BackendInstance, CapabilityDescriptor, ExecutionRequest,
                     OperationSnapshot, PackageDescriptor, ParameterDescriptor,
                     StampedPose, SystemConfig, scalar_error)


class DescriptorLoader(yaml.SafeLoader):
    pass


def _mapping(loader, node, deep=False):
    values = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, str):
            fail('$', 'invalid_type', '描述字段名称必须是字符串')
        if key in values:
            fail(f'$.{key}', 'duplicate_key', f'描述键 {key} 重复')
        values[key] = loader.construct_object(value_node, deep=deep)
    return values


DescriptorLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping)


def read_document(path):
    try:
        text = Path(path).read_text(encoding='utf-8')
    except (OSError, UnicodeError) as exc:
        fail('$', 'read_error', f'无法读取描述: {exc}')
    try:
        data = yaml.load(text, Loader=DescriptorLoader)
    except (yaml.YAMLError, RecursionError) as exc:
        fail('$', 'invalid_document', f'无法解析描述: {exc}')
    if not isinstance(data, dict):
        fail('$', 'invalid_type', '描述根节点必须是对象')
    # 保持 YAML 与 HTTP/JSON 数据范围一致，拒绝别名环与非 JSON 值
    try:
        json.dumps(data, allow_nan=False)
    except (TypeError, ValueError, RecursionError) as exc:
        fail('$', 'invalid_document', f'描述必须兼容 JSON: {exc}')
    return data


def load_package(path) -> PackageDescriptor:
    data = read_document(path)
    if isinstance(data.get('adapter_entrypoint'), str):
        import re
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*:[A-Za-z_][A-Za-z0-9_]*', data['adapter_entrypoint']):
            fail('$.adapter_entrypoint', 'invalid_entrypoint', '适配器入口必须使用 module:function')
    return parse(PackageDescriptor, data)


class Registry:
    def __init__(self):
        self._packages: dict[str, PackageDescriptor] = {}
        self._enabled: set[str] = set()

    @property
    def packages(self) -> Mapping[str, PackageDescriptor]:
        return MappingProxyType(copy.deepcopy(self._packages))

    def register(self, package: PackageDescriptor):
        package = parse(PackageDescriptor, package.model_dump(exclude_unset=True))
        if package.package_id in self._packages:
            fail('$.package_id', 'duplicate_id', '接入包已经注册')
        existing = {c.capability_id for p in self._packages.values() for c in p.capabilities}
        for index, cap in enumerate(package.capabilities):
            if cap.capability_id in existing:
                fail(f'$.capabilities[{index}].capability_id', 'duplicate_id', '能力标识已经注册')
        self._packages[package.package_id] = copy.deepcopy(package)

    def enable(self, package_id, *, allowed_entrypoints: set[str]):
        package = self._get(package_id)
        if package.adapter_entrypoint not in allowed_entrypoints:
            fail('$.adapter_entrypoint', 'adapter_not_authorized', '适配器入口没有显式授权')
        self._enabled.add(package_id)

    def disable(self, package_id):
        self._get(package_id)
        self._enabled.discard(package_id)

    def is_enabled(self, package_id) -> bool:
        self._get(package_id)
        return package_id in self._enabled

    def _get(self, package_id):
        if package_id not in self._packages:
            fail('$.package_id', 'unknown_package', f'接入包 {package_id} 未注册')
        return self._packages[package_id]


@dataclass(frozen=True)
class BoundRole:
    backend_instance: str
    capability: CapabilityDescriptor
    parameters: dict


@dataclass(frozen=True)
class BoundSystem:
    config: SystemConfig
    backends: Mapping[str, BackendInstance]
    roles: Mapping[str, BoundRole]
    capabilities: Mapping[tuple[str, str], CapabilityDescriptor]


def _values(values, descriptors, path, *, parameters=False, now=None, clock_domain=None):
    result = copy.deepcopy(values)
    for name in values:
        if name not in descriptors:
            fail(f'{path}.{name}', 'unknown_field', '字段未在契约中声明')
    for name, spec in descriptors.items():
        field = f'{path}.{name}'
        if name not in values:
            if parameters and 'default' in spec.model_fields_set:
                result[name] = copy.deepcopy(spec.default)
            elif not parameters or spec.required:
                fail(field, 'required_field', '缺少必填字段')
            else:
                continue
        value = result[name]
        code, reason = scalar_error(spec, value)
        if code:
            fail(field, code, reason)
        if spec.type == 'stamped_pose':
            pose = parse(StampedPose, value, field)
            if pose.frame_id != spec.frame_id:
                fail(f'{field}.frame_id', 'frame_mismatch', '观测坐标系与能力契约不匹配')
            if pose.position_unit != spec.unit:
                fail(f'{field}.position_unit', 'unit_mismatch', '位置单位与能力契约不匹配')
            if pose.clock_domain != spec.clock_domain or (clock_domain is not None and pose.clock_domain != clock_domain):
                fail(f'{field}.clock_domain', 'clock_mismatch', '时间域不兼容，不能判断数据新鲜度')
            if now is None or clock_domain is None:
                fail(f'{field}.timestamp', 'clock_context_required', '位姿校验需要当前时间和同域时钟')
            if type(now) not in (int, float) or not math.isfinite(now) or now < 0:
                fail(f'{field}.timestamp', 'invalid_clock', '当前时间必须是有限非负数')
            if pose.timestamp > now:
                fail(f'{field}.timestamp', 'future_data', '观测来自未来')
            if now - pose.timestamp > spec.max_age_s:
                fail(f'{field}.timestamp', 'stale_data', '观测已经超过有效期')
            result[name] = pose.model_dump(mode='json')
    return result


def _compatible(expected, offered, path):
    if set(expected) != set(offered):
        fail(path, 'incompatible_type', '输入或输出字段集合不兼容')
    for name, spec in expected.items():
        other = offered[name]
        for field in ('type', 'unit', 'frame_id', 'clock_domain', 'max_age_s', 'minimum', 'maximum', 'choices'):
            if getattr(spec, field) != getattr(other, field):
                fail(f'{path}.{name}.{field}', 'incompatible_type', '角色与能力的数据契约不兼容')


def bind_system(config, registry: Registry) -> BoundSystem:
    if isinstance(config, SystemConfig):
        config = config.model_dump(exclude_unset=True)
    config = parse(SystemConfig, config)
    packages = registry.packages
    backends = {}
    capabilities = {}
    for index, backend in enumerate(config.backends):
        path = f'$.backends[{index}]'
        if backend.package_id not in packages:
            fail(f'{path}.package_id', 'unknown_package', '后端引用的接入包未注册')
        package = packages[backend.package_id]
        values = _values(backend.config, package.config, f'{path}.config', parameters=True)
        backends[backend.instance_id] = backend.model_copy(update={'config': values})
        for cap in package.capabilities:
            capabilities[(backend.instance_id, cap.capability_id)] = cap
    for role in config.required_roles:
        if role not in config.roles:
            fail(f'$.roles.{role}', 'missing_role', '缺少任务要求的角色绑定')
    roles = {}
    for role, binding in config.roles.items():
        path = f'$.roles.{role}'
        if binding.backend_instance not in backends:
            fail(f'{path}.backend_instance', 'unknown_backend', '角色引用的后端实例不存在')
        cap = capabilities.get((binding.backend_instance, binding.capability_id))
        if cap is None:
            fail(f'{path}.capability_id', 'unknown_capability', '后端没有提供所需能力')
        _compatible(binding.input, cap.input, f'{path}.input')
        _compatible(binding.output, cap.output, f'{path}.output')
        params = _values(binding.parameters, cap.parameters, f'{path}.parameters', parameters=True)
        roles[role] = BoundRole(binding.backend_instance, cap, params)
    return BoundSystem(config, MappingProxyType(backends), MappingProxyType(roles), MappingProxyType(capabilities))


def validate_request(request, bound: BoundSystem, *, now=None, clock_domain=None) -> ExecutionRequest:
    if isinstance(request, ExecutionRequest):
        request = request.model_dump(exclude_unset=True)
    request = parse(ExecutionRequest, request)
    if request.backend_instance not in bound.backends:
        fail('$.backend_instance', 'unknown_backend', '请求引用的后端实例不存在')
    cap = bound.capabilities.get((request.backend_instance, request.capability_id))
    if cap is None:
        fail('$.capability_id', 'unknown_capability', '后端没有提供请求的能力')
    inputs = _values(request.input, cap.input, '$.input', now=now, clock_domain=clock_domain)
    parameters = _values(request.parameters, cap.parameters, '$.parameters', parameters=True)
    return request.model_copy(update={'input': inputs, 'parameters': parameters})


def validate_snapshot(snapshot, capability: CapabilityDescriptor | None = None, *, now=None, clock_domain=None) -> OperationSnapshot:
    if isinstance(snapshot, OperationSnapshot):
        snapshot = snapshot.model_dump(exclude_unset=True)
    snapshot = parse(OperationSnapshot, snapshot)
    if capability is not None:
        _values(snapshot.feedback.data, capability.feedback, '$.feedback.data', parameters=False,
                now=now, clock_domain=clock_domain)
        if snapshot.result is not None:
            _values(snapshot.result.output, capability.output, '$.result.output', now=now, clock_domain=clock_domain)
    return snapshot
