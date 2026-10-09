"""整机模式、控制代次与单机资源门控"""
import math
from enum import Enum

from .errors import ContractValidationError, fail, parse
from .models import ControlToken, ResourceRequirement, StopState


class RobotMode(str, Enum):
    STANDBY = 'STANDBY'
    MANUAL = 'MANUAL'
    AUTO = 'AUTO'
    CALIBRATION = 'CALIBRATION'
    FAULT = 'FAULT'


TRANSITIONS = {
    RobotMode.STANDBY: {RobotMode.AUTO, RobotMode.MANUAL, RobotMode.CALIBRATION, RobotMode.FAULT},
    RobotMode.AUTO: {RobotMode.STANDBY, RobotMode.MANUAL, RobotMode.FAULT},
    RobotMode.MANUAL: {RobotMode.STANDBY, RobotMode.FAULT},
    RobotMode.CALIBRATION: {RobotMode.STANDBY, RobotMode.FAULT},
    RobotMode.FAULT: set(),
}


def _duration(value, field, *, zero=False):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0 or (not zero and value == 0):
        fail(f'$.{field}', 'invalid_timeout', '时间必须是有限的正数或声明允许的零值')
    return value


class ResourcePool:
    def __init__(self, clock):
        self.clock = clock
        self._holds: dict[str, dict[str, str]] = {}
        self._quarantine: dict[str, set[str]] = {}

    @property
    def unavailable(self):
        return bool(self._holds or self._quarantine)

    def check_quarantine(self, resources):
        for resource in resources:
            if self._quarantine.get(resource.name):
                fail('$.resources.' + resource.name, 'resource_quarantined', '资源停止未确认，保持隔离')

    def try_acquire(self, operation_id, resources):
        self.check_quarantine(resources)
        ordered = sorted(resources, key=lambda resource: resource.name)
        for resource in ordered:
            holders = self._holds.get(resource.name, {})
            others = {owner: access for owner, access in holders.items() if owner != operation_id}
            if others and (resource.access == 'exclusive' or 'exclusive' in others.values()):
                fail('$.resources.' + resource.name, 'resource_busy', '资源被其他操作持有')
        for resource in ordered:
            self._holds.setdefault(resource.name, {})[operation_id] = resource.access

    async def acquire(self, operation_id, resources, *, timeout_s=0):
        timeout_s = _duration(timeout_s, 'resource_timeout_s', zero=True)
        deadline = self.clock.now() + timeout_s
        while True:
            try:
                self.try_acquire(operation_id, resources)
                return
            except ContractValidationError as exc:
                if exc.issues[0].code != 'resource_busy' or timeout_s == 0:
                    raise
                remaining = deadline - self.clock.now()
                if remaining <= 0:
                    fail('$.resources', 'resource_timeout', '资源获取超时，没有部分占用资源')
                await self.clock.sleep(min(0.01, remaining))

    def validate_hold(self, operation_id, resources):
        self.check_quarantine(resources)
        for resource in resources:
            if self._holds.get(resource.name, {}).get(operation_id) != resource.access:
                fail('$.resources.' + resource.name, 'resource_not_held', '设备动作没有持有声明的资源')

    def settle(self, operation_id, resources, stop_state):
        for resource in resources:
            if stop_state == StopState.UNCONFIRMED:
                self._quarantine.setdefault(resource.name, set()).add(operation_id)
                continue
            holds = self._holds.get(resource.name, {})
            holds.pop(operation_id, None)
            if not holds:
                self._holds.pop(resource.name, None)
            blocked = self._quarantine.get(resource.name, set())
            blocked.discard(operation_id)
            if not blocked:
                self._quarantine.pop(resource.name, None)

    def restore(self, unresolved):
        for op_id, resources in unresolved:
            self.settle(op_id, [parse(ResourceRequirement, value) for value in resources], StopState.UNCONFIRMED)


class ControlManager:
    def __init__(self, *, clock, records):
        self.clock = clock
        self.records = records
        self.resources = ResourcePool(clock)
        self.estop = records.metadata('estop') == '1'
        self.mode = RobotMode.FAULT if self.estop else RobotMode.STANDBY
        self._epoch = records.advance_epoch()
        self._token = None
        self._estop_dirty = False

    def _mode(self, mode):
        try:
            return RobotMode(mode)
        except (ValueError, TypeError):
            fail('$.mode', 'invalid_mode', '整机模式未定义')

    def _check_transition(self, mode):
        if self.estop and mode != RobotMode.FAULT:
            fail('$.estop', 'estop_active', '设备急停未解除')
        if mode != self.mode and mode not in TRANSITIONS[self.mode]:
            fail('$.mode', 'invalid_mode_transition', f'不能从 {self.mode.value} 切换到 {mode.value}')

    def set_mode(self, mode):
        mode = self._mode(mode)
        self._check_transition(mode)
        if mode != self.mode:
            self._token = None
            self.mode = mode
            self._epoch = self.records.advance_epoch()
        return self.mode

    def begin_task(self, owner, *, ready=True, lease_s=30):
        if ready is not True:
            fail('$.ready', 'system_not_ready', '任务所需模块尚未就绪')
        if self.mode != RobotMode.STANDBY:
            fail('$.mode', 'invalid_mode_transition', '开始任务要求待命模式')
        if self.resources.unavailable:
            fail('$.resources', 'resources_unconfirmed', '任务启动前资源仍被占用或隔离')
        return self.take_control(RobotMode.AUTO, owner, lease_s=lease_s)

    def take_control(self, mode, owner, *, lease_s=30):
        mode = self._mode(mode)
        if mode not in {RobotMode.AUTO, RobotMode.MANUAL, RobotMode.CALIBRATION}:
            fail('$.mode', 'control_not_permitted', '该模式不授予设备控制权')
        self._check_transition(mode)
        lease_s = _duration(lease_s, 'lease_s')
        candidate = parse(ControlToken, {'owner': owner, 'control_epoch': self._epoch,
                                         'expires_at': self.clock.now() + lease_s,
                                         'clock_domain': self.clock.clock_domain})
        self._token = None
        self._epoch = self.records.advance_epoch()
        candidate.control_epoch = self._epoch
        self.mode = mode
        self._token = candidate
        return candidate.model_copy(deep=True)

    def validate_control(self, token, resources):
        token = parse(ControlToken, token.model_dump() if isinstance(token, ControlToken) else token)
        if self.estop or self.mode == RobotMode.FAULT:
            fail('$.control', 'estop_active' if self.estop else 'fault_active', '整机不允许动作')
        if self.mode not in {RobotMode.AUTO, RobotMode.MANUAL, RobotMode.CALIBRATION}:
            fail('$.control', 'control_not_permitted', '整机当前模式不允许动作')
        if self._token is None or token.control_epoch != int(self.records.metadata('control_epoch')) or token.control_epoch != self._epoch:
            fail('$.control.control_epoch', 'stale_control', '控制代次已撤销或重启失效')
        if token.owner != self._token.owner or token.expires_at != self._token.expires_at:
            fail('$.control', 'invalid_control', '控制令牌与当前授权不匹配')
        if token.clock_domain != self.clock.clock_domain:
            fail('$.control.clock_domain', 'clock_mismatch', '控制令牌时间域不兼容')
        if self.clock.now() >= token.expires_at:
            fail('$.control.expires_at', 'control_expired', '控制授权已过期')
        self.resources.check_quarantine(resources)
        return True

    def set_estop(self, active, *, device_confirmed=False):
        if type(active) is not bool:
            fail('$.estop', 'invalid_type', '急停状态必须为布尔值')
        if not active and device_confirmed is not True:
            fail('$.estop', 'device_confirmation_required', '急停解除需要设备侧确认')
        if active:
            changed = not self.estop
            # 急停输入先锁存并撤销本地授权，存储失败不能恢复动作权限
            self.estop = True
            self.mode = RobotMode.FAULT
            self._token = None
            if changed or self._estop_dirty:
                self._estop_dirty = True
                self._epoch = self.records.persist_estop(True)
                self._estop_dirty = False
        elif self.estop:
            self._epoch = self.records.persist_estop(False)
            self._token = None
            self.estop = False
            self._estop_dirty = False

    def clear_fault(self):
        if self.mode != RobotMode.FAULT or self.estop:
            fail('$.mode', 'fault_reset_denied', '故障复位需要设备已解除急停')
        if self.resources.unavailable:
            fail('$.resources', 'resources_unconfirmed', '故障复位前必须确认设备已停止')
        self._epoch = self.records.advance_epoch()
        self._token = None
        self.mode = RobotMode.STANDBY


class DeviceGateway:
    def __init__(self, control, bound):
        self.control = control
        self.bound = bound

    def validate(self, request, operation_id):
        cap = self.bound.capabilities[(request.backend_instance, request.capability_id)]
        self.control.validate_control(request.control, cap.resources)
        self.control.resources.validate_hold(operation_id, cap.resources)
        return True
