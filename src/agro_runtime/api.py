"""本地会话管理 API，接受与完成保持独立"""
import asyncio
import hmac
import hashlib
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from pydantic import BaseModel, ConfigDict, Field

from .errors import ContractValidationError, field_path, fail
from .models import ExecutionRequest, Positive
from .registry import load_package
from .tasks import TaskManager, TaskStart


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


def gui_directory(directory=None):
    return Path(directory or os.environ.get('AGRO_GUI_DIST', '/tmp/agro-gui-dist')).resolve()


class GuiFiles(StaticFiles):
    """静态文件独立于管理认证，页面刷新回到同一入口"""
    async def get_response(self, path, scope):
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404 or Path(path).suffix or path.startswith('assets/') or '..' in path.split('/'):
                raise
            response = await super().get_response('index.html', scope)
        response.headers['Cache-Control'] = 'no-store' if path == 'index.html' or not Path(path).suffix else 'no-cache'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Content-Security-Policy'] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; "
            "object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        return response


def create_app(runtime, *, session_secret, session_identity='local_session', task_engine=None, endpoint=None,
               ui_directory=None):
    if not session_secret or not session_identity:
        fail('$.session', 'invalid_session_secret', '本地会话身份与密钥不能为空')
    jobs = {}
    tasks = TaskManager(runtime, executable=task_engine, endpoint=endpoint, session_secret=session_secret)

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

    app = FastAPI(title='Agro runtime management',
                  lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.runtime = runtime
    api = APIRouter(dependencies=[Depends(authenticate)])
    identity = {'application': 'AT-System-Integration',
                'source_root': str(Path(__file__).resolve().parents[2]),
                'config_path': str(runtime.config_path),
                'config_sha256': hashlib.sha256(runtime.config_path.read_bytes()).hexdigest(),
                'state_directory': str(runtime.state_directory.resolve()),
                'snapshot_id': runtime.snapshot_id, 'pid': os.getpid()}

    @api.get('/agent/identity')
    async def agent_identity():
        return identity


    @app.exception_handler(ContractValidationError)
    async def contract_error(request, exc):
        return JSONResponse(status_code=409, content={'errors': [issue.model_dump() for issue in exc.issues]})

    @app.exception_handler(RequestValidationError)
    async def request_error(request, exc):
        return JSONResponse(status_code=422, content={'errors': [
            {'path': field_path(error['loc']), 'code': error['type'], 'reason': error['msg']}
            for error in exc.errors()]})

    @api.get('/packages')
    async def packages():
        return {'packages': [dict(package.model_dump(mode='json'), enabled=runtime.registry.is_enabled(name))
                             for name, package in runtime.registry.packages.items()]}

    @api.post('/packages/validate')
    async def validate_package(body: PackagePath):
        package = load_package(body.path)
        return {'valid': True, 'package_id': package.package_id, 'enabled': False,
                'capabilities': [cap.capability_id for cap in package.capabilities]}

    @api.post('/packages/{package_id}/enable')
    async def enable_package(package_id: str):
        return {'package_id': package_id, 'enabled': runtime.enable_package(package_id)}

    @api.post('/packages/{package_id}/disable')
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

    @api.post('/system/start', status_code=202)
    async def start(body: PackagePath | None = None):
        if body and Path(body.path).resolve() != runtime.config_path:
            fail('$.config_ref', 'snapshot_mismatch', '启动路径与 Agent 当前配置不一致')
        return accepted_job('start')

    @api.post('/system/stop', status_code=202)
    async def stop():
        # HTTP 接受停止立即关闭派发入口，后台再处理取消与停止确认
        return accepted_job('stop')

    @api.get('/system/status')
    async def status():
        return runtime.status()

    @api.get('/system/snapshot')
    async def snapshot():
        return runtime.snapshot()

    @api.post('/system/readiness')
    async def readiness(body: ExecutionRequest, phase: str = 'dispatch'):
        return runtime.readiness(body.backend_instance, body.capability_id, phase=phase, control=body.control)

    @api.post('/control/take')
    async def take(body: ControlTake, owner: str = Depends(authenticate)):
        return runtime.take_control(body.mode, owner, lease_s=body.lease_s).model_dump(mode='json')

    @api.get('/control/status')
    async def control_status():
        return {'mode': runtime.engine.control.mode.value, 'estop': runtime.engine.control.estop,
                'clock_domain': runtime.engine.clock.clock_domain, 'timestamp': runtime.engine.clock.now()}

    @api.post('/operations', status_code=202)
    async def submit(body: ExecutionRequest):
        operation_id = await runtime.submit(body)
        return runtime.engine.get_operation(operation_id).model_dump(mode='json')

    @api.get('/operations')
    async def operations():
        return {'operations': [item.model_dump(mode='json') for item in runtime.records.list_operations()]}

    @api.get('/operations/{operation_id}')
    async def operation_status(operation_id: str):
        return runtime.engine.get_operation(operation_id).model_dump(mode='json')

    @api.post('/operations/{operation_id}/cancel', status_code=202)
    async def operation_cancel(operation_id: str):
        return runtime.engine.cancel(operation_id).model_dump(mode='json')

    @api.post('/tasks', status_code=202)
    async def task_start(body: TaskStart, owner: str = Depends(authenticate)):
        return await tasks.start_task(body, owner)

    @api.get('/tasks')
    async def task_list():
        return {'tasks': tasks.list()}

    @api.get('/tasks/{task_run_id}')
    async def task_status(task_run_id: str):
        return tasks.status(task_run_id)

    @api.post('/tasks/{task_run_id}/cancel', status_code=202)
    async def task_cancel(task_run_id: str):
        return tasks.cancel_task(task_run_id)

    app.include_router(api)
    directory = gui_directory(ui_directory)
    if (directory / 'index.html').is_file():
        app.mount('/ui', GuiFiles(directory=directory, html=True), name='gui')
    else:
        @app.get('/ui/{path:path}', response_class=HTMLResponse, status_code=503)
        async def missing_gui(path: str):
            return '<h1>GUI 资源未构建</h1><pre>npm --prefix gui ci\nnpm --prefix gui run build</pre>'
    return app
