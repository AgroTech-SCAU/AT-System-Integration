"""Single-user disposable tutorial runtime with real management routes and mock-only execution"""
import asyncio
import tempfile
from pathlib import Path

from .runtime import Runtime


class NoHardwareManager:
    """Tutorial capability manager never starts OS commands or hardware services"""
    def __init__(self):
        self.running = set()

    async def start(self, name, descriptor):
        self.running.add(name)

    async def stop(self, name, descriptor):
        self.running.discard(name)

    async def status(self, name, descriptor):
        return {'running': name in self.running, 'pid': None}


class TutorialSandbox:
    def __init__(self, secret, *, task_engine=None, endpoint=None, ui_directory=None):
        self.secret = secret
        self.task_engine = task_engine
        self.endpoint = endpoint
        self.ui_directory = ui_directory
        self.app = None
        self.context = None
        self.directory = None
        self.lock = asyncio.Lock()

    async def start(self):
        async with self.lock:
            if self.app is not None:
                from .errors import fail
                fail('$.tutorial','session_running','已有教学工作区，请先退出当前教学')
            temp = tempfile.TemporaryDirectory(prefix='agro-tutorial-')
            try:
                source = Path(__file__).resolve().parents[2] / 'examples' / 'tomato_picker' / 'system_four_backends.yaml'
                manager = NoHardwareManager()
                runtime = Runtime(source, temp.name, managers={
                    'local_process': manager, 'ros_launch': manager, 'systemd': manager
                }, allowed_entrypoints={'agro_mock:create_adapter'})
                from .api import create_app
                app = create_app(runtime, session_secret=self.secret, session_identity='tutorial_mock',
                                 task_engine=self.task_engine, endpoint=(self.endpoint or '')+'/tutorial',
                                 ui_directory=self.ui_directory, tutorial_only=True)
                context = app.router.lifespan_context(app)
                await context.__aenter__()
            except BaseException:
                temp.cleanup()
                raise
            self.directory, self.app, self.context = temp, app, context
            return {'ready': True, 'mock_only': True}

    async def close(self):
        async with self.lock:
            if self.app is None:
                return {'closed': True}
            # If stop cannot be confirmed, do not destroy the runtime or pretend the session closed
            try:
                await self.context.__aexit__(None, None, None)
            except BaseException:
                raise
            self.app = self.context = None
            self.directory.cleanup()
            self.directory = None
            return {'closed': True}

    async def __call__(self, scope, receive, send):
        target = self.app
        if target is None:
            from starlette.responses import JSONResponse
            await JSONResponse({'errors':[{'path':'$.tutorial','code':'not_started','reason':'请先在正式工作台打开教学'}]}, status_code=409)(scope, receive, send)
            return
        await target(scope, receive, send)
