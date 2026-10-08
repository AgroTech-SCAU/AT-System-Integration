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
from .configuration import ActiveContext, ConfigurationService, WorkspaceStore
from .management import ManagementJobs
from .assets import AssetService
from .diagnostics import Diagnostics
from uuid import uuid4
from .workspace_models import (DescriptionUpload, DraftCreate, DraftSave, ConfigurationApply, PlanCreate, TaskIntent, LifecycleIntent)


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
    runtime = ActiveContext(runtime)
    store = WorkspaceStore(runtime.state_directory)
    configuration = ConfigurationService(runtime, store)
    TaskManager(runtime.current, executable=task_engine, endpoint=endpoint, session_secret=session_secret)
    class CurrentTasks:
        def __getattr__(self,name):
            return getattr(runtime.current.tasks,name)
    tasks = CurrentTasks()
    management = ManagementJobs(store)
    jobs = management.workers
    assets = AssetService(runtime,store)
    diagnostics = Diagnostics(runtime)
    from .task_documents import TaskDocuments
    from .tree_models import TreeCreate,TreeSave,TreePublish,TreeExtract,TreeValidate
    documents = TaskDocuments(runtime,store,assets)
    runtime.tasks.documents = documents

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
        store.db.close()

    app = FastAPI(title='Agro runtime management',
                  lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    @app.middleware('http')
    async def blocked_writes(request, call_next):
        if runtime.state == 'BLOCKED' and request.method not in {'GET','HEAD','OPTIONS'}:
            return JSONResponse(status_code=409,content={'errors':[{'path':'$.system','code':'runtime_blocked','reason':'配置恢复失败，写入已阻塞，请保留诊断并人工检查'}]})
        return await call_next(request)

    app.state.runtime = runtime
    app.state.configuration = configuration
    app.state.assets = assets
    app.state.management = management
    app.state.diagnostics = diagnostics
    app.state.documents = documents
    api = APIRouter(dependencies=[Depends(authenticate)])
    identity = {'application': 'AT-System-Integration',
                'source_root': str(Path(__file__).resolve().parents[2]),
                'config_path': str(runtime.config_path),
                'config_sha256': hashlib.sha256(runtime.config_path.read_bytes()).hexdigest(),
                'state_directory': str(runtime.state_directory.resolve()),
                'snapshot_id': runtime.snapshot_id, 'pid': os.getpid()}

    @api.get('/agent/identity')
    async def agent_identity():
        return {**identity,'config_path':str(runtime.config_path),
                'config_sha256':hashlib.sha256(runtime.config_path.read_bytes()).hexdigest(),
                'snapshot_id':runtime.snapshot_id}


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

    @api.get('/schemas')
    async def schemas():
        return configuration.schemas()

    @api.get('/catalog')
    async def catalog():
        return {'packages': configuration.catalog()}

    @api.post('/catalog')
    async def import_description(body: DescriptionUpload):
        body=body.model_dump()
        return configuration.import_package(body.get('filename'), body.get('content'))

    @api.delete('/catalog/{package_id}')
    async def delete_description(package_id: str):
        return configuration.delete_package(package_id)

    @api.get('/config/drafts')
    async def drafts():
        return {'drafts': store.list('draft')}

    @api.post('/config/drafts')
    async def create_draft(body: DraftCreate):
        body=body.model_dump()
        return configuration.create_draft(body.get('base_snapshot_id'), body.get('content'))

    @api.get('/config/drafts/{draft_id}')
    async def draft(draft_id: str):
        return configuration.get_draft(draft_id)

    @api.put('/config/drafts/{draft_id}')
    async def save_draft(draft_id: str, body: DraftSave):
        body=body.model_dump()
        return configuration.save_draft(draft_id, body.get('revision'), body.get('content'))

    @api.get('/config/drafts/{draft_id}/diff')
    async def diff_draft(draft_id: str):
        return configuration.diff(draft_id)

    @api.post('/config/validate')
    async def validate_config(body: dict):
        return configuration.validate(body)

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

    def accepted_job(action, request_id=None):
        async def work(phase):
            async with runtime.transition:
                phase(action)
                return await getattr(runtime, action)()
        def on_accept():
            runtime.stop_requested = action == 'stop'
            if action == 'stop':
                runtime.accepting = False
        job=management.accept(action,request_id or 'request_'+uuid4().hex,{},work,on_accept)
        return {'accepted':True,'action':action,'management_job_id':job['id'],**runtime.status()}

    @api.post('/system/start', status_code=202)
    async def start(body: LifecycleIntent | None = None):
        body=body.model_dump() if body else {}
        if body.get('path') and Path(body['path']).resolve()!=runtime.config_path:
            fail('$.config_ref','snapshot_mismatch','启动路径与当前生效配置不一致')
        return accepted_job('start',body.get('request_id'))

    @api.post('/system/stop', status_code=202)
    async def stop(body: LifecycleIntent | None = None):
        return accepted_job('stop',body.request_id if body else None)

    @api.get('/management/jobs')
    async def management_jobs():
        return {'jobs':store.list('job')}

    @api.get('/management/jobs/{job_id}')
    async def management_status(job_id: str):
        return management.status(job_id)

    @api.post('/config/apply', status_code=202)
    async def apply_config(body: ConfigurationApply):
        body=body.model_dump()
        async def work(phase):
            return await configuration.apply(body.get('draft_id'),body.get('revision'),body.get('base_snapshot_id'),phase)
        job=management.accept('apply',body.get('request_id'),body,work)
        return {'accepted':True,'management_job_id':job['id']}

    @api.get('/config/status')
    async def config_status():
        return {'snapshot_id':runtime.snapshot_id,'state':runtime.state,'content':runtime.bound.config.model_dump(mode='json'),
                'apply_policy':'restart'}

    @api.get('/templates')
    async def templates():
        return {'templates':assets.templates()}

    @api.get('/assets')
    async def asset_list():
        return {'assets':store.list('asset')}

    @api.post('/assets')
    async def asset_import(body: DescriptionUpload):
        body=body.model_dump()
        return assets.import_asset(body.get('filename'),body.get('content'))

    @api.get('/plans')
    async def plan_list():
        return {'plans':store.list('plan')}

    @api.post('/plans')
    async def plan_create(body: PlanCreate):
        body=body.model_dump()
        return assets.create_plan(body.get('parameters',{}),body.get('asset_id'),body.get('template_id','tomato_picker'))

    @api.get('/plans/{plan_id}/preflight')
    async def plan_preflight(plan_id: str):
        return assets.preflight(plan_id)

    @api.post('/plans/{plan_id}/start', status_code=202)
    async def plan_start(plan_id: str,body: TaskIntent,owner: str=Depends(authenticate)):
        body=body.model_dump()
        async with runtime.transition:
            return await tasks.start_task(assets.request(plan_id,body.get('request_id')),owner)

    @api.get('/diagnostics')
    async def diagnostic_status():
        return diagnostics.readiness()

    @api.get('/tasks/{task_run_id}/logs')
    async def task_logs(task_run_id: str,offset: int=0,limit: int=16384):
        return diagnostics.logs(task_run_id,offset,limit)

    @api.get('/tasks/{task_run_id}/report')
    async def task_report(task_run_id: str):
        return diagnostics.report(task_run_id)

    @api.get('/tasks/by-request/{request_id}')
    async def task_by_request(request_id: str):
        previous=tasks.store.by_request(request_id)
        return {'found':previous is not None,'task':tasks.status(previous['task_run_id']) if previous else None}

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
        async with runtime.transition:
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

    @api.post('/trees/validate')
    async def tree_preview(body: TreeValidate):
        return documents.validate_tree(body.document.model_dump(mode='json'),body.policy,body.parameters,engine=False)

    @api.get('/trees/models')
    async def tree_models():
        return documents.describe_nodes()

    @api.get('/trees/drafts')
    async def tree_drafts():
        return {'drafts':store.list('tree_draft')}

    @api.post('/trees/drafts')
    async def tree_create(body: TreeCreate):
        return documents.create(body.xml,body.template)

    @api.get('/trees/drafts/{key}')
    async def tree_get(key: str):
        return store.get('tree_draft',key)

    @api.put('/trees/drafts/{key}')
    async def tree_save(key: str,body: TreeSave):
        return documents.save(key,body.revision,body.layout_revision,body.document.model_dump(mode='json'),body.layout.model_dump(mode='json'),body.parameters)

    @api.post('/trees/extract')
    async def tree_extract(body: TreeExtract):
        return documents.extract_subtree(body.document.model_dump(mode='json'),body.tree_id,body.editor_id,body.subtree_id,{k:v.model_dump(mode='json') for k,v in body.ports.items()} if body.ports is not None else None)

    @api.get('/trees/drafts/{key}/xml')
    async def tree_xml(key: str):
        return documents.serialize_xml(store.get('tree_draft',key)['document'])

    @api.post('/trees/drafts/{key}/validate')
    async def tree_validate(key: str):
        return documents.validate_draft(key)

    @api.post('/trees/drafts/{key}/publish')
    async def tree_publish(key: str,body: TreePublish):
        async with runtime.transition:
            return documents.publish(key,body.revision,body.base_snapshot_id)

    @api.get('/trees/definitions')
    async def definitions():
        return {'definitions':store.list('tree_definition')}

    @api.get('/trees/definitions/{key}')
    async def definition_get(key: str):
        return store.get('tree_definition',key)

    @api.post('/trees/definitions/{key}/start',status_code=202)
    async def definition_start(key: str,body: TaskIntent,owner: str = Depends(authenticate)):
        async with runtime.transition:
            return await tasks.start_task(documents.definition_request(key,body.request_id),owner)

    app.include_router(api)
    directory = gui_directory(ui_directory)
    if (directory / 'index.html').is_file():
        app.mount('/ui', GuiFiles(directory=directory, html=True), name='gui')
    else:
        @app.get('/ui/{path:path}', response_class=HTMLResponse, status_code=503)
        async def missing_gui(path: str):
            return '<h1>GUI 资源未构建</h1><pre>npm --prefix gui ci\nnpm --prefix gui run build</pre>'
    return app
