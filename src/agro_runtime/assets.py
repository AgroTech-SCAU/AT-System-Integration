"""内置模板副本、不可变模拟资产与共享无动作预检"""
import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

from .configuration import encoded, upload_name
from .errors import ContractValidationError, fail, parse
from .tasks import TaskManifest, TaskStart
from .registry import read_document, _values


class AssetService:
    def __init__(self,context,store):
        self.context=context;self.store=store
        self.example=Path(__file__).resolve().parents[2]/'examples/tomato_picker'
        self.template=self.example/'tasks/harvest.xml'
        fixture=self.example/'assets/camera_to_arm.json'
        raw=fixture.read_bytes()
        self.builtin=self.import_asset('camera_to_arm.json',raw.decode())

    def templates(self):
        manifest=parse(TaskManifest,read_document(self.template.with_suffix('.task.json')))
        return [{'id':'tomato_picker','title':'番茄采摘模拟模板','manifest':manifest.model_dump(mode='json'),
                 'layout':read_document(self.template.with_suffix('.layout.json')),'xml':self.template.read_text(),
                 'editable_parameters':['approach_dz'],'simulation':True}]

    def import_asset(self,filename,content):
        upload_name(filename)
        if not isinstance(content,str) or len(content.encode())>1024*1024:
            fail('$.content','upload_too_large','资产最多 1 MiB')
        raw=content.encode();digest=hashlib.sha256(raw).hexdigest()
        # 当前只认可仓库附带的模拟校验证据，用户 verified 字段不是验证依据
        fixture=json.loads((self.example/'assets/camera_to_arm.json').read_bytes())
        try:
            value=json.loads(raw)
        except ValueError:
            fail('$.content','invalid_document','资产必须为 JSON 对象')
        if value!=fixture:
            fail('$.asset','unsupported_mock_calibration','当前只接入内置模拟标定证据，真实标定及自定义变换尚未接入')
        key='asset_'+digest
        directory=self.store.root/'assets';directory.mkdir(exist_ok=True)
        path=directory/(digest+'.json')
        if not path.exists():
            path.write_bytes(raw);path.chmod(0o400)
        return self.store.put('asset',key,{'id':key,'filename':filename,'sha256':digest,
            'metadata':value,'simulation':True,'support':'camera → arm_base，仅模拟 X 平移',
            'verification_source':'builtin_simulation_fixture'})

    def create_plan(self,parameters,asset_id,template_id='tomato_picker'):
        if template_id!='tomato_picker':
            fail('$.template_id','unknown_template','模板不存在')
        manifest=parse(TaskManifest,read_document(self.template.with_suffix('.task.json')))
        effective=_values(parameters,manifest.parameters,'$.parameters',parameters=True)
        asset=self.store.get('asset',asset_id or self.builtin['id'])
        key='plan_'+uuid4().hex
        root=self.store.root/'plans'/key;root.mkdir(parents=True)
        xml=root/'harvest.xml';xml.write_bytes(self.template.read_bytes());xml.chmod(0o400)
        asset_path=self.store.root/'assets'/(asset['sha256']+'.json')
        raw=asset_path.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=asset['sha256']:
            fail('$.asset','asset_checksum_mismatch','不可变资产摘要不匹配')
        (root/'camera_to_arm.json').write_bytes(raw);(root/'camera_to_arm.json').chmod(0o400)
        content=manifest.model_dump(mode='json')
        content['assets']['camera_to_arm'].update(path='camera_to_arm.json',sha256=asset['sha256'])
        (root/'harvest.task.json').write_text(encoded(content));(root/'harvest.task.json').chmod(0o400)
        return self.store.put('plan',key,{'id':key,'template_id':template_id,'parameters':effective,
            'asset_id':asset['id'],'asset_sha256':asset['sha256'],'task_ref':str(xml),
            'system_snapshot_id':self.context.snapshot_id,'immutable':True})

    def request(self,key,request_id):
        plan=self.store.get('plan',key)
        if plan['system_snapshot_id']!=self.context.snapshot_id:
            fail('$.system_snapshot_id','snapshot_conflict','方案基于旧系统，请在当前配置创建新方案')
        path=Path(plan['task_ref']).resolve()
        path.relative_to((self.store.root/'plans'/key).resolve())
        return TaskStart(task_ref=str(path),parameters=plan['parameters'],request_id=request_id)

    def preflight(self,key):
        try:
            if not self.context.tasks.executable or not Path(self.context.tasks.executable).is_file() or not os.access(self.context.tasks.executable, os.X_OK):
                fail('$.task_engine','task_engine_unavailable','未配置可执行的行为树引擎')
            request=self.request(key,'preflight')
            snapshot=self.context.tasks.preflight(request)
            return {'valid':True,'errors':[],'system_snapshot_id':self.context.snapshot_id,
                'parameters':snapshot['parameters'],'assets':snapshot['assets'],
                'executable_available':True}
        except ContractValidationError as exc:
            return {'valid':False,'errors':[i.model_dump() for i in exc.issues]}
