"""仅用于框架内模拟的异步能力适配器"""
import asyncio
import math
from dataclasses import dataclass, field

from agro_runtime.errors import ContractValidationError, fail
from agro_runtime.models import (OperationError, OperationFeedback, OperationResult,
                                 OperationSnapshot, OperationState, StopState)

CAPABILITIES = {'navigation.move_to_waypoint', 'perception.detect_tomato',
                'geometry.transform_pose', 'manipulation.move_to_pose',
                'end_effector.grip', 'perception.verify_pick', 'perception.detect_targets',
                'manipulation.check_reachability', 'geometry.offset_pose',
                'manipulation.collection_pose', 'perception.verify_place', 'job.record_pick'}


@dataclass(frozen=True)
class FaultPlan:
    startup_delay_s: float = 0.0
    duration_s: float = 0.5
    cancel_delay_s: float = 0.0
    fail_execution: bool = False
    stale_feedback: bool = False
    lose_result: bool = False
    cancel_unconfirmed: bool = False
    reject_request: bool = False
    target_count: int = 1
    stale_observation: bool = False
    wrong_frame: bool = False
    unreachable: bool = False
    verify_pick_false: bool = False
    verify_place_false: bool = False

    def __post_init__(self):
        for name in ('startup_delay_s', 'duration_s', 'cancel_delay_s'):
            value = getattr(self, name)
            if type(value) not in (float, int) or not math.isfinite(value) or value < 0:
                fail(f'$.faults.{name}', 'invalid_fault', '故障延迟必须是有限非负数')
        for name in ('fail_execution', 'stale_feedback', 'lose_result', 'cancel_unconfirmed', 'reject_request', 'stale_observation', 'wrong_frame',
                     'unreachable', 'verify_pick_false', 'verify_place_false'):
            if type(getattr(self, name)) is not bool:
                fail(f'$.faults.{name}', 'invalid_fault', '故障开关必须为布尔值')

        if type(self.target_count) is not int or not 0 <= self.target_count <= 8:
            fail('$.faults.target_count', 'invalid_fault', '候选目标数量必须为 0 至 8 的整数')


@dataclass
class MockWorld:
    waypoint: str | None = None
    arm_pose: dict | None = None
    gripped_target: str | None = None
    effects: list[dict] = field(default_factory=list)
    placed_targets: set[str] = field(default_factory=set)
    recorded_targets: dict = field(default_factory=dict)


class MockOperation:
    def __init__(self, adapter, request, operation_id):
        self.adapter = adapter
        self.request = request
        self.operation_id = operation_id
        self.faults = adapter.faults_by_capability.get(request.capability_id, adapter.faults)
        self._cancel = asyncio.Event()
        self._stopped = asyncio.Event()
        self._stop_task = None

    def _snapshot(self, state, *, output=None, error=None, stopped=StopState.CONFIRMED):
        return OperationSnapshot(operation_id=self.operation_id, state=state, stop_state=stopped,
                                 result=OperationResult(output=output) if output is not None else None,
                                 error=error)

    async def _delay(self, delay):
        timer = asyncio.create_task(self.adapter.clock.sleep(delay))
        cancelled = asyncio.create_task(self._cancel.wait())
        try:
            await asyncio.wait({timer, cancelled}, return_when=asyncio.FIRST_COMPLETED)
            return not self._cancel.is_set()
        finally:
            timer.cancel()
            cancelled.cancel()
            await asyncio.gather(timer, cancelled, return_exceptions=True)

    def _feedback(self, report, stage, progress):
        timestamp = self.adapter.clock.now()
        if self.faults.stale_feedback:
            timestamp = max(0.0, timestamp - 10.0)
        report(OperationFeedback(stage=stage, progress=progress, timestamp=timestamp,
                                 clock_domain=self.adapter.clock.clock_domain))

    async def _canceled_result(self):
        await self._stopped.wait()
        return self._snapshot(OperationState.CANCELED)

    async def run(self, report):
        self._feedback(report, 'starting', 0.0)
        if not await self._delay(self.faults.startup_delay_s):
            return await self._canceled_result()
        self._feedback(report, 'executing', 0.25)
        if not await self._delay(self.faults.duration_s):
            return await self._canceled_result()
        if self.faults.fail_execution:
            self._stopped.set()
            return self._snapshot(OperationState.FAILED, error=OperationError(code='mock_failure', reason='模拟执行失败'))
        try:
            if self.adapter.before_effect is not None:
                await self.adapter.before_effect(self.request)
            output = self._produce()
        except ContractValidationError as exc:
            issue = exc.issues[0]
            if issue.code == 'execution_aborted':
                return await self._canceled_result()
            self._stopped.set()
            return self._snapshot(OperationState.FAILED, error=OperationError(code=issue.code, reason=issue.reason, path=issue.path))
        if self.faults.lose_result:
            return self._snapshot(OperationState.UNKNOWN, stopped=StopState.UNCONFIRMED,
                                  error=OperationError(code='result_lost', reason='模拟后端结果丢失，禁止直接重试'))
        self._stopped.set()
        self._feedback(report, 'finished', 1.0)
        return self._snapshot(OperationState.SUCCEEDED, output=output)

    def _produce(self):
        request = self.request
        cap = request.capability_id
        self.adapter.gateway.validate(request, self.operation_id)
        world = self.adapter.world
        clock = self.adapter.clock
        if cap == 'perception.detect_targets':
            return {'targets': [{'target_id': f'tomato_{index+1}',
                    'frame_id': 'wrong_frame' if self.faults.wrong_frame else 'camera',
                    'timestamp': max(0, clock.now()-20) if self.faults.stale_observation else clock.now(),
                    'clock_domain': clock.clock_domain, 'position': [0.3, 0.1, 0.2],
                    'position_unit': 'm', 'orientation': [0, 0, 0, 1]}
                    for index in range(self.faults.target_count) if f'tomato_{index+1}' not in world.placed_targets]}
        if cap == 'manipulation.check_reachability':
            return {'reachable': not self.faults.unreachable and all(abs(v)<=1 for v in request.input['target']['position'])}
        if cap == 'geometry.offset_pose':
            pose = dict(request.input['target'])
            pose['position'] = list(pose['position'])
            pose['position'][2] += request.parameters['dz']
            return {'target': pose}
        if cap == 'manipulation.collection_pose':
            return {'target': {'target_id': request.input['target_id'], 'frame_id': 'arm_base',
                    'timestamp': clock.now(), 'clock_domain': clock.clock_domain,
                    'position': [0.1, -0.2, 0.3], 'position_unit': 'm', 'orientation': [0, 0, 0, 1]}}
        if cap == 'perception.verify_place':
            return {'placed': not self.faults.verify_place_false and request.input['target_id'] in world.placed_targets}
        if cap == 'job.record_pick':
            result = request.input['result']
            if result['outcome']=='picked' and result['target_id'] not in world.placed_targets:
                fail('$.input.result', 'placement_not_verified', '正常放置前不能记录采摘成功')
            world.recorded_targets[result['target_id']] = dict(result)
            return {'result': dict(result)}
        if cap == 'navigation.move_to_waypoint':
            world.waypoint = request.input['waypoint']
            output = {'arrived': True}
        elif cap == 'perception.detect_tomato':
            return {'found': True, 'target': {'target_id': 'tomato_1', 'frame_id': 'camera',
                    'timestamp': clock.now(), 'clock_domain': clock.clock_domain,
                    'position': [0.3, 0.1, 0.2], 'position_unit': 'm', 'orientation': [0, 0, 0, 1]}}
        elif cap == 'geometry.transform_pose':
            pose = dict(request.input['target'])
            pose['frame_id'] = 'arm_base'
            pose['position'] = [pose['position'][0] + request.parameters['offset_x'],
                                pose['position'][1], pose['position'][2]]
            return {'target': pose}
        elif cap == 'manipulation.move_to_pose':
            world.arm_pose = dict(request.input['target'])
            output = {'reached': True}
        elif cap == 'end_effector.grip':
            closed = request.parameters['close']
            if not closed and world.gripped_target == request.input['target_id'] and world.arm_pose and world.arm_pose['position'] == [0.1, -0.2, 0.3]:
                world.placed_targets.add(request.input['target_id'])
            world.gripped_target = request.input['target_id'] if closed else None
            output = {'gripped': closed}
        else:
            return {'picked': not self.faults.verify_pick_false and world.gripped_target == request.input['target_id']}
        world.effects.append({'operation_id': self.operation_id, 'request_id': request.request_id,
                              'capability_id': cap, 'target_id': request.input.get('target_id')})
        return output

    async def request_cancel(self):
        if self._stop_task is not None:
            return True
        self.adapter.cancel_requests += 1
        self._cancel.set()
        self._stop_task = asyncio.create_task(self._confirm_stop())
        return True

    async def _confirm_stop(self):
        if self.faults.cancel_unconfirmed:
            return
        await self.adapter.clock.sleep(self.faults.cancel_delay_s)
        self._stopped.set()

    async def wait_stopped(self):
        await self._stopped.wait()
        return StopState.CONFIRMED

    async def aclose(self):
        if self._stop_task is not None:
            self._stop_task.cancel()
            await asyncio.gather(self._stop_task, return_exceptions=True)


class MockAdapter:
    def __init__(self, *, backend_instance, clock, gateway, before_effect=None, faults=None, faults_by_capability=None, completed_targets=None, world=None):
        self.backend_instance = backend_instance
        self.clock = clock
        self.before_effect = before_effect
        self.gateway = gateway
        self.faults = faults or FaultPlan()
        self.faults_by_capability = faults_by_capability or {}
        self.world = world if world is not None else MockWorld()
        self.world.placed_targets.update(completed_targets or ())
        self.accepted_requests = 0
        self.cancel_requests = 0
        self._operations = []

    def accept(self, request, operation_id):
        if self.faults.reject_request:
            fail('$', 'backend_rejected', '模拟后端拒绝请求')
        if request.backend_instance != self.backend_instance or request.capability_id not in CAPABILITIES:
            fail('$.capability_id', 'backend_rejected', '模拟后端没有提供请求能力')
        operation = MockOperation(self, request, operation_id)
        self._operations.append(operation)
        self.accepted_requests += 1
        return operation

    async def aclose(self):
        await asyncio.gather(*(operation.aclose() for operation in self._operations))


def create_adapter(*, backend_instance, clock, gateway, before_effect=None, faults=None, faults_by_capability=None, completed_targets=None, world=None):
    return MockAdapter(backend_instance=backend_instance, clock=clock, gateway=gateway,
                       before_effect=before_effect, faults=faults, faults_by_capability=faults_by_capability, completed_targets=completed_targets, world=world)
