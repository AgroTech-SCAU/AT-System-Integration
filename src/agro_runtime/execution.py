"""异步能力执行与独立停止追踪"""
import asyncio
import hashlib
import importlib
import inspect
import json
import math
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol
from uuid import uuid4

from .errors import ContractValidationError, fail, parse
from .models import (ExecutionRequest, OperationError, OperationFeedback,
                     OperationSnapshot, OperationState, StopState)
from .registry import BoundSystem, Registry, validate_request, validate_snapshot

TERMINAL = {OperationState.SUCCEEDED, OperationState.FAILED,
            OperationState.CANCELED, OperationState.UNKNOWN}


class Clock(Protocol):
    clock_domain: str

    def now(self) -> float: ...

    async def sleep(self, seconds: float) -> None: ...


class MonotonicClock:
    clock_domain = 'monotonic_host'

    def now(self):
        return time.monotonic()

    async def sleep(self, seconds):
        await asyncio.sleep(seconds)


class AdapterOperation(Protocol):
    async def run(self, report: Callable[[OperationFeedback], None]) -> OperationSnapshot: ...

    async def request_cancel(self) -> bool: ...

    async def wait_stopped(self) -> StopState: ...


class Adapter(Protocol):
    # accept 只做本地非阻塞接纳，run 承担耗时通信与执行
    def accept(self, request: ExecutionRequest, operation_id: str) -> AdapterOperation: ...

    async def aclose(self) -> None: ...


@dataclass
class _Operation:
    request: ExecutionRequest
    snapshot: OperationSnapshot
    handle: AdapterOperation
    deadline: float
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    cancel_deadline: float | None = None
    abort_error: OperationError | None = None
    run_task: asyncio.Task | None = None
    worker: asyncio.Task | None = None
    reconciling: bool = False


def _positive(value, name):
    if type(value) not in (int, float) or value <= 0 or not math.isfinite(value):
        fail(f'$.{name}', 'invalid_timeout', '超时必须是有限正数')
    return value


class ExecutionEngine:
    def __init__(self, bound: BoundSystem, registry: Registry, *, clock: Clock | None = None,
                 execution_timeout_s=None, cancel_timeout_s=2.0, feedback_timeout_s=1.0,
                 authorize=None):
        self.bound = bound
        self.registry = registry
        self.clock = clock or MonotonicClock()
        self.execution_timeout_s = (None if execution_timeout_s is None else
                                    _positive(execution_timeout_s, 'execution_timeout_s'))
        self.cancel_timeout_s = _positive(cancel_timeout_s, 'cancel_timeout_s')
        self.feedback_timeout_s = _positive(feedback_timeout_s, 'feedback_timeout_s')
        self.authorize = authorize
        self._adapters: dict[str, Adapter] = {}
        self._operations: dict[str, _Operation] = {}
        self._requests: dict[str, tuple[str, str]] = {}
        self._lock = asyncio.Lock()
        self._tasks: set[asyncio.Task] = set()
        self._closed = False

    def enable_adapter(self, backend_instance, *, allowed_entrypoints: set[str], **options):
        if self._closed:
            fail('$', 'engine_closed', '执行器已关闭')
        backend = self.bound.backends.get(backend_instance)
        if backend is None:
            fail('$.backend_instance', 'unknown_backend', '后端实例不存在')
        package = self.registry.packages[backend.package_id]
        if package.adapter_entrypoint not in allowed_entrypoints:
            fail('$.adapter_entrypoint', 'adapter_not_authorized', '适配器入口没有显式授权')
        if backend_instance in self._adapters:
            if options:
                fail('$.backend_instance', 'adapter_already_loaded', '已加载的适配器不能隐式替换配置')
            self.registry.enable(package.package_id, allowed_entrypoints=allowed_entrypoints)
            return self._adapters[backend_instance]
        module, name = package.adapter_entrypoint.split(':')
        try:
            factory = getattr(importlib.import_module(module), name)
            adapter = factory(backend_instance=backend_instance, clock=self.clock,
                              before_effect=self._before_effect, **options)
            if not callable(getattr(adapter, 'accept', None)) or not callable(getattr(adapter, 'aclose', None)):
                fail('$.adapter_entrypoint', 'invalid_adapter', '适配器必须实现 accept 与 aclose')
        except ContractValidationError:
            raise
        except Exception as exc:
            fail('$.adapter_entrypoint', 'adapter_load_failed', f'适配器加载失败: {exc}')
        self.registry.enable(package.package_id, allowed_entrypoints=allowed_entrypoints)
        self._adapters[backend_instance] = adapter
        return adapter

    async def _authorize(self, request):
        if self.authorize is None:
            return
        cap = self.bound.capabilities[(request.backend_instance, request.capability_id)]
        allowed = self.authorize(request.model_copy(deep=True), [r.model_copy(deep=True) for r in cap.resources])
        if inspect.isawaitable(allowed):
            allowed = await allowed
        if allowed is False:
            fail('$.control', 'control_denied', '请求未获得控制授权')

    async def _before_effect(self, request):
        op_id = self._requests[request.request_id][1]
        operation = self._operations[op_id]
        if self._closed or operation.snapshot.cancel_requested:
            fail('$', 'execution_aborted', '操作已停止派发副作用')
        if self.clock.now() >= operation.deadline:
            fail('$', 'execution_timeout', '动作已超过执行期限')
        backend = self.bound.backends[request.backend_instance]
        if not self.registry.is_enabled(backend.package_id):
            fail('$.backend_instance', 'adapter_disabled', '适配器已禁用')
        await self._authorize(request)
        # 授权检查可能让出事件循环，返回后重新检查最终执行条件
        if self._closed or operation.snapshot.cancel_requested:
            fail('$', 'execution_aborted', '操作已停止派发副作用')
        if self.clock.now() >= operation.deadline:
            fail('$', 'execution_timeout', '动作已超过执行期限')
        if not self.registry.is_enabled(backend.package_id):
            fail('$.backend_instance', 'adapter_disabled', '适配器已禁用')
        validate_request(request, self.bound, now=self.clock.now(), clock_domain=self.clock.clock_domain)

    def _spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def submit(self, request) -> str:
        async with self._lock:
            if self._closed:
                fail('$', 'engine_closed', '执行器已关闭')
            if isinstance(request, ExecutionRequest):
                request = request.model_dump(mode='json', exclude_unset=True)
            raw = parse(ExecutionRequest, request)
            try:
                body = json.dumps(raw.model_dump(mode='json'), sort_keys=True, allow_nan=False)
            except (ValueError, TypeError) as exc:
                fail('$', 'invalid_data', f'请求必须兼容 JSON: {exc}')
            fingerprint = hashlib.sha256(body.encode()).hexdigest()
            previous = self._requests.get(raw.request_id)
            if previous is not None:
                if previous[0] != fingerprint:
                    fail('$.request_id', 'request_id_conflict', '同一请求标识不能对应不同载荷')
                return previous[1]
            parsed = validate_request(raw, self.bound, now=self.clock.now(), clock_domain=self.clock.clock_domain)
            backend = self.bound.backends[parsed.backend_instance]
            if not self.registry.is_enabled(backend.package_id):
                fail('$.backend_instance', 'adapter_disabled', '适配器尚未启用')
            adapter = self._adapters.get(parsed.backend_instance)
            if adapter is None:
                fail('$.backend_instance', 'adapter_not_loaded', '适配器尚未显式加载')
            await self._authorize(parsed)
            if self._closed:
                fail('$', 'engine_closed', '执行器已关闭')
            if not self.registry.is_enabled(backend.package_id):
                fail('$.backend_instance', 'adapter_disabled', '适配器已禁用')
            parsed = validate_request(parsed, self.bound, now=self.clock.now(), clock_domain=self.clock.clock_domain)
            op_id = 'operation_' + uuid4().hex
            try:
                handle = adapter.accept(parsed.model_copy(deep=True), op_id)
            except ContractValidationError:
                raise
            except Exception as exc:
                fail('$', 'backend_rejected', f'后端没有接纳请求: {exc}')
            if not all(callable(getattr(handle, name, None)) for name in ('run', 'request_cancel', 'wait_stopped')):
                fail('$', 'backend_rejected', '后端没有返回合法执行句柄')
            cap = self.bound.capabilities[(parsed.backend_instance, parsed.capability_id)]
            timeout = cap.timeout_s if self.execution_timeout_s is None else min(cap.timeout_s, self.execution_timeout_s)
            snapshot = OperationSnapshot(operation_id=op_id, state=OperationState.ACCEPTED,
                                         stop_state=StopState.UNCONFIRMED,
                                         feedback=OperationFeedback(stage='accepted'))
            operation = _Operation(parsed, snapshot, handle, self.clock.now() + timeout)
            self._operations[op_id] = operation
            self._requests[parsed.request_id] = (fingerprint, op_id)
            operation.worker = self._spawn(self._drive(operation))
            return op_id

    def _get(self, op_id):
        if op_id not in self._operations:
            fail('$.operation_id', 'unknown_operation', '执行实例不存在')
        return self._operations[op_id]

    def get_operation(self, operation_id) -> OperationSnapshot:
        return self._get(operation_id).snapshot.model_copy(deep=True)

    def _request_cancel(self, operation, error=None):
        snapshot = operation.snapshot
        if error is not None:
            operation.abort_error = error
            snapshot.error = error
        if not snapshot.cancel_requested:
            snapshot.cancel_requested = True
            operation.cancel_deadline = self.clock.now() + self.cancel_timeout_s
            operation.cancel_event.set()
        if snapshot.state not in TERMINAL:
            snapshot.state = OperationState.CANCELING

    def cancel(self, operation_id) -> OperationSnapshot:
        operation = self._get(operation_id)
        if operation.snapshot.state in TERMINAL:
            if (not self._closed and operation.snapshot.state == OperationState.UNKNOWN and
                    operation.snapshot.stop_state == StopState.UNCONFIRMED and not operation.reconciling):
                self._request_cancel(operation)
                operation.cancel_deadline = self.clock.now() + self.cancel_timeout_s
                operation.reconciling = True
                self._spawn(self._stop(operation, preserve_unknown=True))
            return self.get_operation(operation_id)
        cap = self.bound.capabilities[(operation.request.backend_instance, operation.request.capability_id)]
        if cap.cancellation == 'unsupported':
            fail('$.capability_id', 'cancellation_unsupported', '能力声明不支持取消')
        self._request_cancel(operation)
        return self.get_operation(operation_id)

    def _feedback(self, operation, feedback):
        if operation.snapshot.state in TERMINAL or operation.snapshot.cancel_requested:
            return
        try:
            feedback = parse(OperationFeedback, feedback.model_dump() if isinstance(feedback, OperationFeedback) else feedback)
            if feedback.timestamp is None or feedback.clock_domain != self.clock.clock_domain:
                fail('$.feedback.clock_domain', 'feedback_clock_mismatch', '反馈缺少兼容的时间域与时间戳')
            age = self.clock.now() - feedback.timestamp
            if age < 0 or age > self.feedback_timeout_s:
                fail('$.feedback.timestamp', 'feedback_stale', '反馈时间戳过期或来自未来')
            candidate = operation.snapshot.model_copy(deep=True, update={'feedback': feedback})
            cap = self.bound.capabilities[(operation.request.backend_instance, operation.request.capability_id)]
            validate_snapshot(candidate, cap, now=self.clock.now(), clock_domain=self.clock.clock_domain)
            operation.snapshot.feedback = feedback
        except ContractValidationError as exc:
            issue = exc.issues[0]
            self._request_cancel(operation, OperationError(code=issue.code, reason=issue.reason, path=issue.path))

    async def _sleep_until(self, deadline):
        await self.clock.sleep(max(0.0, deadline - self.clock.now()))

    def _publish_result(self, operation):
        candidate = operation.run_task.result()
        cap = self.bound.capabilities[(operation.request.backend_instance, operation.request.capability_id)]
        candidate = validate_snapshot(candidate, cap, now=self.clock.now(), clock_domain=self.clock.clock_domain)
        if candidate.operation_id != operation.snapshot.operation_id or candidate.state not in TERMINAL:
            fail('$.state', 'invalid_backend_result', '后端必须返回对应执行实例的结束结果')
        if candidate.state == OperationState.CANCELED and operation.snapshot.cancel_requested:
            return False
        candidate.cancel_requested = operation.snapshot.cancel_requested
        candidate.cancel_accepted = operation.snapshot.cancel_accepted
        if candidate.feedback.stage is None:
            candidate.feedback = operation.snapshot.feedback.model_copy(deep=True)
        operation.snapshot = candidate
        return True

    async def _late_confirmation(self, operation, work):
        try:
            stopped = await work
            if stopped in {StopState.CONFIRMED, StopState.NOT_APPLICABLE}:
                operation.snapshot.stop_state = stopped
        except asyncio.CancelledError:
            work.cancel()
            raise
        except Exception:
            operation.snapshot.stop_state = StopState.UNCONFIRMED
        finally:
            operation.reconciling = False

    async def _stop(self, operation, *, preserve_unknown=False):
        cap = self.bound.capabilities[(operation.request.backend_instance, operation.request.capability_id)]
        if cap.cancellation == 'unsupported':
            if not preserve_unknown:
                operation.snapshot.state = OperationState.UNKNOWN
                operation.snapshot.error = OperationError(code='cancellation_unsupported', reason='执行超时且后端不支持取消，必须核对')
            return

        async def confirm():
            accepted = await operation.handle.request_cancel()
            operation.snapshot.cancel_accepted = accepted is True
            if accepted is not True:
                return StopState.UNCONFIRMED
            return await operation.handle.wait_stopped()

        work = asyncio.create_task(confirm())
        timer = asyncio.create_task(self._sleep_until(operation.cancel_deadline))
        keep_waiting = False
        try:
            done, _ = await asyncio.wait({work, timer}, return_when=asyncio.FIRST_COMPLETED)
            stopped = work.result() if work in done else StopState.UNCONFIRMED
            if stopped not in {StopState.CONFIRMED, StopState.NOT_APPLICABLE}:
                stopped = StopState.UNCONFIRMED
            if work not in done:
                keep_waiting = True
                operation.reconciling = True
                self._spawn(self._late_confirmation(operation, work))
            if preserve_unknown:
                operation.snapshot.stop_state = stopped
                return
            # 后端结果与停止确认独立，取消过程中已完成的结果必须保留
            if (operation.run_task is not None and operation.run_task.done() and
                    not operation.run_task.cancelled() and self._publish_result(operation)):
                if stopped in {StopState.CONFIRMED, StopState.NOT_APPLICABLE}:
                    operation.snapshot.stop_state = stopped
                return
            operation.snapshot.stop_state = stopped
            if stopped == StopState.UNCONFIRMED:
                operation.snapshot.state = OperationState.UNKNOWN
                code = 'cancel_rejected' if work in done else 'cancel_timeout'
                operation.snapshot.error = OperationError(code=code, reason='取消未得到停止确认，必须核对结果')
            elif operation.abort_error is not None:
                operation.snapshot.state = OperationState.FAILED
                operation.snapshot.error = operation.abort_error
            else:
                operation.snapshot.state = OperationState.CANCELED
                operation.snapshot.error = None
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            operation.snapshot.stop_state = StopState.UNCONFIRMED
            if not preserve_unknown:
                operation.snapshot.state = OperationState.UNKNOWN
                operation.snapshot.error = OperationError(code='cancel_failed', reason=f'取消异常，停止未确认: {exc}')
        finally:
            if not keep_waiting:
                work.cancel()
            timer.cancel()
            await asyncio.gather(timer, *([] if keep_waiting else [work]), return_exceptions=True)

    async def _drive(self, operation):
        timer = None
        cancellation = None
        try:
            if not operation.snapshot.cancel_requested:
                operation.snapshot.state = OperationState.RUNNING
            operation.run_task = asyncio.create_task(operation.handle.run(lambda feedback: self._feedback(operation, feedback)))
            timer = asyncio.create_task(self._sleep_until(operation.deadline))
            cancellation = asyncio.create_task(operation.cancel_event.wait())
            done, _ = await asyncio.wait({operation.run_task, timer, cancellation}, return_when=asyncio.FIRST_COMPLETED)
            if operation.run_task in done:
                if not self._publish_result(operation):
                    await self._stop(operation)
            else:
                if not operation.snapshot.cancel_requested:
                    self._request_cancel(operation, OperationError(code='execution_timeout', reason='执行超时，正在请求取消'))
                await self._stop(operation)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            operation.snapshot.state = OperationState.UNKNOWN
            operation.snapshot.stop_state = StopState.UNCONFIRMED
            operation.snapshot.error = OperationError(code='backend_result_unknown', reason=f'后端结果无法确认: {exc}')
        finally:
            tasks = [task for task in (operation.run_task, timer, cancellation) if task is not None]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def aclose(self):
        if self._closed:
            return
        self._closed = True
        for operation in self._operations.values():
            if operation.snapshot.state not in TERMINAL:
                self._request_cancel(operation)
                operation.snapshot.state = OperationState.UNKNOWN
                operation.snapshot.stop_state = StopState.UNCONFIRMED
                operation.snapshot.error = OperationError(code='engine_closed', reason='执行器关闭，未确认的操作需要核对')
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.gather(*(adapter.aclose() for adapter in self._adapters.values()), return_exceptions=True)
