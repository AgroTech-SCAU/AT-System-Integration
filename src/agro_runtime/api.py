"""本地会话管理 API，接受与完成保持独立"""
import asyncio
import hmac
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .errors import ContractValidationError, field_path, fail
from .models import ExecutionRequest, Positive
from .registry import load_package


class ControlTake(BaseModel):
    model_config = ConfigDict(extra='forbid')
    mode: Literal['AUTO', 'MANUAL', 'CALIBRATION']
    lease_s: Positive = 30.0


class PackagePath(BaseModel):
    model_config = ConfigDict(extra='forbid')
    path: str = Field(min_length=1)


def session_secret_file(directory):
    path = Path(directory) / 'session.token'
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if path.stat().st_mode & 0o077:
            fail('$.session', 'insecure_session_file', '本地会话文件必须仅允许当前用户访问')
    else:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            stream.write(secrets.token_urlsafe(32))
    secret = path.read_text(encoding='utf-8').strip()
    if not secret:
        fail('$.session', 'invalid_session_secret', '本地会话密钥不能为空')
    return secret


def create_app(runtime, *, session_secret, session_identity='local_session'):
    if not session_secret or not session_identity:
        fail('$.session', 'invalid_session_secret', '本地会话身份与密钥不能为空')
    jobs = {}

    async def authenticate(authorization: Annotated[str | None, Header()] = None):
        if authorization is None or not hmac.compare_digest(authorization.encode('utf-8'),
                                                             ('Bearer ' + session_secret).encode('utf-8')):
            raise HTTPException(status_code=401, detail='local_session_required')
        return session_identity

    @asynccontextmanager
    async def lifespan(app):
        yield
        for task in jobs.values():
            if task and not task.done():
                await task
        await runtime.aclose()

    app = FastAPI(title='Agro runtime management', dependencies=[Depends(authenticate)],
                  lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.runtime = runtime

    @app.exception_handler(ContractValidationError)
    async def contract_error(request, exc):
        return JSONResponse(status_code=409, content={'errors': [issue.model_dump() for issue in exc.issues]})

    @app.exception_handler(RequestValidationError)
    async def request_error(request, exc):
        return JSONResponse(status_code=422, content={'errors': [
            {'path': field_path(error['loc']), 'code': error['type'], 'reason': error['msg']}
            for error in exc.errors()]})

    @app.get('/packages')
    async def packages():
        return {'packages': [dict(package.model_dump(mode='json'), enabled=runtime.registry.is_enabled(name))
                             for name, package in runtime.registry.packages.items()]}

    @app.post('/packages/validate')
    async def validate_package(body: PackagePath):
        package = load_package(body.path)
        return {'valid': True, 'package_id': package.package_id, 'enabled': False,
                'capabilities': [cap.capability_id for cap in package.capabilities]}

    @app.post('/packages/{package_id}/enable')
    async def enable_package(package_id: str):
        return {'package_id': package_id, 'enabled': runtime.enable_package(package_id)}

    @app.post('/packages/{package_id}/disable')
    async def disable_package(package_id: str):
        runtime.registry.disable(package_id)
        return {'package_id': package_id, 'enabled': False}

    def accepted_job(action):
        opposite = jobs.get('stop' if action == 'start' else 'start')
        if opposite and not opposite.done():
            fail('$.system', 'lifecycle_busy', '系统启动或停止尚未完成')
        if action == 'stop':
            runtime.accepting = False
        previous = jobs.get(action)
        if previous is None or previous.done():
            jobs[action] = asyncio.create_task(getattr(runtime, action)())
        return {'accepted': True, 'action': action, **runtime.status()}

    @app.post('/system/start', status_code=202)
    async def start():
        return accepted_job('start')

    @app.post('/system/stop', status_code=202)
    async def stop():
        # HTTP 接受停止立即关闭派发入口，后台再处理取消与停止确认
        return accepted_job('stop')

    @app.get('/system/status')
    async def status():
        return runtime.status()

    @app.get('/system/snapshot')
    async def snapshot():
        return runtime.snapshot()

    @app.post('/system/readiness')
    async def readiness(body: ExecutionRequest, phase: str = 'dispatch'):
        return runtime.readiness(body.backend_instance, body.capability_id, phase=phase, control=body.control)

    @app.post('/control/take')
    async def take(body: ControlTake, owner: str = Depends(authenticate)):
        return runtime.take_control(body.mode, owner, lease_s=body.lease_s).model_dump(mode='json')

    @app.get('/control/status')
    async def control_status():
        return {'mode': runtime.engine.control.mode.value, 'estop': runtime.engine.control.estop,
                'clock_domain': runtime.engine.clock.clock_domain, 'timestamp': runtime.engine.clock.now()}

    @app.post('/operations', status_code=202)
    async def submit(body: ExecutionRequest):
        operation_id = await runtime.submit(body)
        return runtime.engine.get_operation(operation_id).model_dump(mode='json')

    @app.get('/operations')
    async def operations():
        return {'operations': [item.model_dump(mode='json') for item in runtime.records.list_operations()]}

    @app.get('/operations/{operation_id}')
    async def operation_status(operation_id: str):
        return runtime.engine.get_operation(operation_id).model_dump(mode='json')

    @app.post('/operations/{operation_id}/cancel', status_code=202)
    async def operation_cancel(operation_id: str):
        return runtime.engine.cancel(operation_id).model_dump(mode='json')

    return app
