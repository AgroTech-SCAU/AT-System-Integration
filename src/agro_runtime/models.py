"""描述与执行共用的严格数据契约"""
import math
from enum import Enum
from typing import Annotated, Literal

from pydantic import (BaseModel, ConfigDict, Field, JsonValue, StrictBool,
                      StrictFloat, StrictInt, StrictStr, RootModel, ValidationError, model_serializer, model_validator)
from pydantic_core import PydanticCustomError

IDENTIFIER = r'^[a-z][a-z0-9_]*$'
QUALIFIED = r'^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
Identifier = Annotated[StrictStr, Field(pattern=IDENTIFIER)]
QualifiedName = Annotated[StrictStr, Field(pattern=QUALIFIED)]
CapabilityId = Annotated[StrictStr, Field(pattern=r'^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')]
Nonempty = Annotated[StrictStr, Field(min_length=1)]
Number = Annotated[StrictFloat, Field(allow_inf_nan=False)]
Positive = Annotated[Number, Field(gt=0)]
Nonnegative = Annotated[Number, Field(ge=0)]


def invalid(loc, code, reason):
    raise ValidationError.from_exception_data('Contract', [
        {'type': PydanticCustomError(code, reason), 'loc': loc, 'input': None}])


def unique(items, attr, field):
    seen = set()
    for index, item in enumerate(items):
        value = getattr(item, attr)
        if value in seen:
            invalid((field, index, attr), 'duplicate_id', f'标识 {value} 重复')
        seen.add(value)


class ContractModel(BaseModel):
    model_config = ConfigDict(extra='forbid', validate_default=True, allow_inf_nan=False)
    extensions: dict[StrictStr, JsonValue] = Field(default_factory=dict)


class TypeDescriptor(ContractModel):
    type: Literal['string', 'integer', 'number', 'boolean', 'stamped_pose', 'target_list', 'pick_result']
    unit: Nonempty | None = None
    minimum: Number | None = None
    maximum: Number | None = None
    choices: list[JsonValue] | None = None
    frame_id: QualifiedName | None = None
    clock_domain: QualifiedName | None = None
    max_age_s: Positive | None = None

    @model_validator(mode='after')
    def check_type(self):
        if self.type in {'integer', 'number', 'stamped_pose', 'target_list'} and self.unit is None:
            invalid(('unit',), 'unit_required', '数值与位姿必须声明单位，无量纲数值使用 1')
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            invalid(('maximum',), 'invalid_range', '最大值不能小于最小值')
        if self.type not in {'number', 'integer'} and (self.minimum is not None or self.maximum is not None):
            invalid(('minimum',), 'invalid_range', '只有数值类型支持数值范围')
        if self.type in {'stamped_pose', 'target_list'}:
            if self.unit != 'm':
                invalid(('unit',), 'unit_mismatch', '位姿位置使用 m')
            for field in ('frame_id', 'clock_domain', 'max_age_s'):
                if getattr(self, field) is None:
                    invalid((field,), 'required_field', '位姿描述必须声明坐标系、时间域和有效期')
        elif any(getattr(self, f) is not None for f in ('frame_id', 'clock_domain', 'max_age_s')):
            invalid(('frame_id',), 'invalid_type', '位姿约束只能用于 stamped_pose')
        if self.choices is not None:
            if not self.choices:
                invalid(('choices',), 'invalid_choices', '可选值不能为空')
            for index, value in enumerate(self.choices):
                code, reason = scalar_error(self, value, check_choices=False)
                if code:
                    invalid(('choices', index), code, reason)
        return self


def scalar_error(spec, value, *, check_choices=True):
    types = {'string': lambda x: isinstance(x, str),
             'integer': lambda x: type(x) is int,
             'number': lambda x: type(x) is int or (type(x) is float and math.isfinite(x)),
             'boolean': lambda x: type(x) is bool,
             'stamped_pose': lambda x: isinstance(x, dict),
             'target_list': lambda x: isinstance(x, list),
             'pick_result': lambda x: isinstance(x, dict)}
    if not types[spec.type](value):
        return 'invalid_type', f'需要 {spec.type} 类型'
    if spec.type in {'number', 'integer'}:
        if spec.minimum is not None and value < spec.minimum:
            return 'out_of_range', f'值不能小于 {spec.minimum}'
        if spec.maximum is not None and value > spec.maximum:
            return 'out_of_range', f'值不能大于 {spec.maximum}'
    if check_choices and spec.choices is not None and value not in spec.choices:
        return 'invalid_choice', '值不在声明的可选值中'
    return None, None


class ParameterDescriptor(TypeDescriptor):
    type: Literal['string', 'integer', 'number', 'boolean']
    required: StrictBool = False
    default: JsonValue = None
    apply_policy: Literal['immediate', 'idle', 'restart']

    @model_serializer(mode='wrap')
    def serialize_default(self, handler):
        data = handler(self)
        if 'default' not in self.model_fields_set:
            data.pop('default', None)
        return data

    @model_validator(mode='after')
    def check_default(self):
        if 'default' in self.model_fields_set:
            code, reason = scalar_error(self, self.default)
            if code:
                invalid(('default',), code, reason)
        return self


class ResourceRequirement(ContractModel):
    name: QualifiedName
    access: Literal['shared', 'exclusive']


class CapabilityDescriptor(ContractModel):
    capability_id: CapabilityId
    description: Nonempty
    input: dict[Identifier, TypeDescriptor]
    output: dict[Identifier, TypeDescriptor]
    parameters: dict[Identifier, ParameterDescriptor] = Field(default_factory=dict)
    resources: list[ResourceRequirement] = Field(default_factory=list)
    preconditions: list[Nonempty] = Field(default_factory=list)
    timeout_s: Positive
    cancellation: Literal['supported', 'unsupported']
    retry_policy: Literal['never', 'safe_errors_only']
    feedback: dict[Identifier, TypeDescriptor] = Field(default_factory=dict)
    errors: list[Identifier] = Field(default_factory=list)

    @model_validator(mode='after')
    def check_resources(self):
        unique(self.resources, 'name', 'resources')
        return self


class RuntimeDescriptor(ContractModel):
    manager: Literal['local_process', 'systemd', 'ros_launch']
    target: Nonempty
    dependencies: list[Identifier] = Field(default_factory=list)
    health_check: Nonempty
    argv: list[Nonempty] = Field(default_factory=list)
    start_timeout_s: Positive = 10.0
    stop_timeout_s: Positive = 5.0


class PackageDescriptor(ContractModel):
    package_id: Identifier
    source: Nonempty
    platforms: list[Nonempty] = Field(min_length=1)
    contract: Literal['agro.capabilities.v1']
    adapter_entrypoint: Annotated[StrictStr, Field(pattern=r'^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*:[A-Za-z_][A-Za-z0-9_]*$')]
    capabilities: list[CapabilityDescriptor] = Field(min_length=1)
    config: dict[Identifier, ParameterDescriptor] = Field(default_factory=dict)
    runtime: RuntimeDescriptor

    @model_validator(mode='after')
    def check_ids(self):
        unique(self.capabilities, 'capability_id', 'capabilities')
        return self


class BackendInstance(ContractModel):
    instance_id: Identifier
    package_id: Identifier
    config: dict[Identifier, JsonValue] = Field(default_factory=dict)
    runtime: RuntimeDescriptor | None = None
    native_config: Nonempty | None = None


class RoleBinding(ContractModel):
    capability_id: CapabilityId
    backend_instance: Identifier
    input: dict[Identifier, TypeDescriptor]
    output: dict[Identifier, TypeDescriptor]
    parameters: dict[Identifier, JsonValue] = Field(default_factory=dict)


class SystemConfig(ContractModel):
    system_id: Identifier
    packages: list[Nonempty] = Field(default_factory=list)
    backends: list[BackendInstance] = Field(min_length=1)
    required_roles: list[Identifier] = Field(min_length=1)
    roles: dict[Identifier, RoleBinding]

    @model_validator(mode='after')
    def check_ids(self):
        unique(self.backends, 'instance_id', 'backends')
        if len(self.required_roles) != len(set(self.required_roles)):
            invalid(('required_roles',), 'duplicate_id', '必需角色重复')
        return self


class StampedPose(ContractModel):
    target_id: Identifier
    frame_id: QualifiedName
    timestamp: Nonnegative
    clock_domain: QualifiedName
    position: tuple[Number, Number, Number]
    position_unit: Nonempty
    orientation: tuple[Number, Number, Number, Number]

    @model_validator(mode='after')
    def check_orientation(self):
        if not math.isclose(sum(x*x for x in self.orientation), 1.0, abs_tol=1e-6):
            invalid(('orientation',), 'invalid_orientation', '四元数 xyzw 必须归一化')
        return self


class TargetList(RootModel[list[StampedPose]]):
    pass


class PickResult(ContractModel):
    target_id: Identifier
    outcome: Literal['picked', 'skipped', 'failed', 'unknown']
    reason: Nonempty | None = None

    @model_validator(mode='after')
    def check_reason(self):
        if self.outcome in {'failed', 'unknown'} and self.reason is None:
            invalid(('reason',), 'required_field', '失败或结果未知必须保留单果原因')
        return self


class ControlToken(ContractModel):
    owner: Identifier
    control_epoch: Annotated[StrictInt, Field(ge=0)]
    expires_at: Nonnegative
    clock_domain: QualifiedName


class ExecutionRequest(ContractModel):
    capability_id: CapabilityId
    backend_instance: Identifier
    input: dict[Identifier, JsonValue]
    parameters: dict[Identifier, JsonValue] = Field(default_factory=dict)
    request_id: Identifier
    task_run_id: Identifier
    node_id: Identifier
    control: ControlToken


class OperationState(str, Enum):
    ACCEPTED = 'ACCEPTED'
    RUNNING = 'RUNNING'
    CANCELING = 'CANCELING'
    SUCCEEDED = 'SUCCEEDED'
    FAILED = 'FAILED'
    CANCELED = 'CANCELED'
    UNKNOWN = 'UNKNOWN'


class StopState(str, Enum):
    CONFIRMED = 'CONFIRMED'
    UNCONFIRMED = 'UNCONFIRMED'
    NOT_APPLICABLE = 'NOT_APPLICABLE'


class OperationError(ContractModel):
    code: Identifier
    reason: Nonempty
    path: StrictStr = '$'
    retryable: StrictBool = False


class OperationFeedback(ContractModel):
    timestamp: Nonnegative | None = None
    clock_domain: QualifiedName | None = None
    stage: Nonempty | None = None
    progress: Annotated[Number, Field(ge=0, le=1)] | None = None
    data: dict[Identifier, JsonValue] = Field(default_factory=dict)


class OperationResult(ContractModel):
    output: dict[Identifier, JsonValue] = Field(default_factory=dict)


class OperationSnapshot(ContractModel):
    operation_id: Identifier
    state: OperationState
    stop_state: StopState
    feedback: OperationFeedback = Field(default_factory=OperationFeedback)
    result: OperationResult | None = None
    error: OperationError | None = None
    cancel_requested: StrictBool = False
    cancel_accepted: StrictBool = False

    @model_validator(mode='after')
    def check_state(self):
        if self.cancel_accepted and not self.cancel_requested:
            invalid(('cancel_accepted',), 'invalid_state', '没有取消请求时不能记录后端接受取消')
        if self.state == OperationState.CANCELED and self.stop_state == StopState.UNCONFIRMED:
            invalid(('stop_state',), 'stop_unconfirmed', '适用的停止未确认，不能记录 CANCELED')
        if self.state == OperationState.SUCCEEDED and self.result is None:
            invalid(('result',), 'required_field', '成功状态必须携带结果')
        if self.state in {OperationState.FAILED, OperationState.UNKNOWN} and self.error is None:
            invalid(('error',), 'required_field', '失败或未知状态必须提供原因')
        if self.state == OperationState.UNKNOWN and self.error.retryable:
            invalid(('error', 'retryable'), 'unsafe_retry', '结果未知不能直接重试')
        if self.state in {OperationState.ACCEPTED, OperationState.RUNNING, OperationState.CANCELING} and self.result is not None:
            invalid(('result',), 'invalid_state', '尚未完成的操作不能携带结束结果')
        return self
