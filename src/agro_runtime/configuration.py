"""受控描述目录、配置草稿与停止态应用，共享服务不执行上传入口"""
import asyncio
import hashlib
import json
import re
import sqlite3
from pathlib import Path
from uuid import uuid4

from .errors import ContractValidationError, fail, parse
from .models import PackageDescriptor, SystemConfig, ParameterDescriptor
from .registry import Registry, bind_system, load_package
from .runtime import Runtime, runtime_plan


def encoded(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        fail('$', 'invalid_document', '内容必须为有限 JSON 数据')


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z][a-z0-9_]*', value):
        fail('$.id', 'invalid_identifier', '标识格式无效')
    return value


def upload_name(value):
    if not value or len(value)>255 or '/' in value or '\\' in value or '..' in value or '\x00' in value:
        fail('$.filename', 'invalid_filename', '上传名称必须是普通文件名')
    return value


class WorkspaceStore:
    def __init__(self, state):
        self.root=Path(state)/'workspace'
        self.root.mkdir(exist_ok=True)
        self.db=sqlite3.connect(self.root/'workspace.db')
        self.db.execute('CREATE TABLE IF NOT EXISTS documents(kind TEXT,id TEXT,body TEXT,PRIMARY KEY(kind,id))')
        self.db.commit()

    def get(self, kind, key):
        identifier(key)
        row=self.db.execute('SELECT body FROM documents WHERE kind=? AND id=?',(kind,key)).fetchone()
        if row is None:
            fail('$.id','unknown_'+kind,'记录不存在')
        return json.loads(row[0])

    def list(self, kind):
        return [json.loads(r[0]) for r in self.db.execute('SELECT body FROM documents WHERE kind=? ORDER BY rowid',(kind,))]

    def put(self, kind, key, value):
        identifier(key)
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO documents VALUES (?,?,?)',(kind,key,encoded(value)))
        return value

    def delete(self, kind, key):
        self.get(kind,key)
        with self.db:
            self.db.execute('DELETE FROM documents WHERE kind=? AND id=?',(kind,key))


class ActiveContext:
    """所有路由通过同一活动引用访问 Runtime，切换复用原状态目录"""
    def __init__(self, runtime):
        object.__setattr__(self,'current',runtime)
        object.__setattr__(self,'transition',asyncio.Lock())

    def __getattr__(self, name):
        return getattr(self.current,name)

    def __setattr__(self,name,value):
        if name in ('current','transition'):
            object.__setattr__(self,name,value)
        else:
            setattr(self.current,name,value)


class ConfigurationService:
    def __init__(self, context, store):
        self.context=context
        self.store=store
        for name, package in context.registry.packages.items():
            if not any(e['id']==name for e in self.catalog()):
                self.store.put('package',name,{'id':name,'filename':name+'.yaml',
                    'sha256':hashlib.sha256(encoded(package.model_dump(mode='json')).encode()).hexdigest(),
                    'description':package.model_dump(mode='json'),'imported':False})

    def schemas(self):
        return {'package':PackageDescriptor.model_json_schema(), 'system':SystemConfig.model_json_schema(),
                'parameter':ParameterDescriptor.model_json_schema(),'hosts':['localhost'],
                'apply_policy':'restart','native_config':'requires_backend_validator'}

    def catalog(self):
        return self.store.list('package')

    def import_package(self, filename, content):
        upload_name(filename)
        if not isinstance(content,str) or len(content.encode())>2*1024*1024:
            fail('$.content','upload_too_large','描述最多 2 MiB')
        raw=content.encode()
        digest=hashlib.sha256(raw).hexdigest()
        directory=self.store.root/'catalog';directory.mkdir(exist_ok=True)
        path=directory/(digest+'_'+uuid4().hex+'.tmp')
        path.write_bytes(raw)
        try:
            package=load_package(path)
            registry=Registry()
            for entry in self.catalog():
                registry.register(parse(PackageDescriptor,entry['description']))
            registry.register(package)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        destination=directory/(digest+'.yaml')
        path.replace(destination)
        destination.chmod(0o400)
        return self.store.put('package',package.package_id,{'id':package.package_id,'filename':filename,
            'sha256':digest,'description':package.model_dump(mode='json'),'imported':True})

    def delete_package(self, key):
        for draft in self.store.list('draft'):
            backends=draft['content'].get('backends',[])
            if isinstance(backends,list) and any(isinstance(b,dict) and b.get('package_id')==key for b in backends):
                fail('$.package_id','package_referenced','接入包仍被配置草稿引用')
        self.store.delete('package',key)
        return {'deleted':key,'running_registry_unchanged':True}

    def create_draft(self, base_snapshot_id, content=None):
        if base_snapshot_id!=self.context.snapshot_id:
            fail('$.base_snapshot_id','snapshot_conflict','生效快照已改变，请重新创建草稿')
        if content is None:
            content=self.context.bound.config.model_dump(mode='json',exclude_unset=True)
            content['packages']=['packages/'+name+'.yaml' for name in self.context.registry.packages]
        key='draft_'+uuid4().hex
        return self.store.put('draft',key,{'id':key,'revision':1,'base_snapshot_id':base_snapshot_id,
            'content':content,'validation':self.validate(content),'apply_policy':'restart'})

    def get_draft(self,key):
        return self.store.get('draft',key)

    def save_draft(self,key,revision,content):
        current=self.get_draft(key)
        if type(revision) is not int or current['revision']!=revision:
            fail('$.revision','revision_conflict','草稿已被其他页面修改，请重新加载')
        encoded(content)
        return self.store.put('draft',key,{**current,'revision':revision+1,'content':content,
            'validation':self.validate(content)})

    def bound(self,content):
        config=parse(SystemConfig,content)
        registry=Registry()
        packages={e['id']:e for e in self.catalog()}
        names=list(dict.fromkeys(b.package_id for b in config.backends))
        expected=['packages/'+name+'.yaml' for name in names]
        if set(config.packages)!=set(expected) or len(config.packages)!=len(expected):
            fail('$.packages','controlled_reference_required','依赖必须引用所选接入包的受控副本')
        for name in names:
            if name not in packages:
                fail('$.packages','unknown_package','接入包未导入目录')
            registry.register(parse(PackageDescriptor,packages[name]['description']))
        bound=bind_system(config,registry)
        runtime_plan(bound,registry)
        for i,backend in enumerate(config.backends):
            if backend.native_config is not None:
                fail(f'$.backends[{i}].native_config','native_validator_required','尚未接入该后端原生配置校验器')
        return bound,registry

    def validate(self,content):
        try:
            bound,_=self.bound(content)
            return {'valid':True,'errors':[],'effective':bound.config.model_dump(mode='json')}
        except ContractValidationError as exc:
            return {'valid':False,'errors':[i.model_dump() for i in exc.issues]}

    def diff(self,key):
        draft=self.get_draft(key)
        previous=self.context.bound.config.model_dump(mode='json')
        changes=[]
        def walk(old,new,path):
            if isinstance(old,dict) and isinstance(new,dict):
                for k in sorted(set(old)|set(new)):
                    walk(old.get(k),new.get(k),path+'.'+k)
            elif old!=new:
                changes.append({'path':path,'before':old,'after':new,'apply_policy':'restart'})
        walk(previous,draft['validation'].get('effective',draft['content']),'$')
        return {'id':key,'revision':draft['revision'],'base_snapshot_id':draft['base_snapshot_id'],
                'active_snapshot_id':self.context.snapshot_id,'changes':changes,'validation':draft['validation']}

    def materialize(self,draft):
        bound,registry=self.bound(draft['content'])
        root=self.store.root/'configurations'/f"{draft['id']}_{draft['revision']}"
        root.mkdir(parents=True,exist_ok=True)
        (root/'packages').mkdir(exist_ok=True)
        config=bound.config.model_dump(mode='json',exclude_unset=True)
        for name,package in registry.packages.items():
            (root/'packages'/f'{name}.yaml').write_text(encoded(package.model_dump(mode='json')))
        path=root/'system.yaml';path.write_text(encoded(config))
        return path,bound,registry

    async def apply(self,key,revision,base_snapshot_id,phase=lambda value: None):
        async with self.context.transition:
            draft=self.get_draft(key)
            if type(revision) is not int or draft['revision']!=revision:
                fail('$.revision','revision_conflict','应用请求对应的草稿已改变')
            old=self.context.current
            if base_snapshot_id!=old.snapshot_id or draft['base_snapshot_id']!=old.snapshot_id:
                fail('$.base_snapshot_id','snapshot_conflict','生效配置已改变，请基于当前配置重新创建草稿')
            if old.state!='STOPPED' or any(t['state'] in {'ACCEPTED','RUNNING','CANCELING','UNKNOWN'} or not t['stop_confirmed'] for t in old.tasks.list()):
                fail('$.system','apply_not_stopped','应用需要停止态，且任务和设备停止均已确认')
            if any(o.state.value=='UNKNOWN' or o.stop_state.value=='UNCONFIRMED' or o.state.value in {'ACCEPTED','RUNNING','CANCELING'} for o in old.records.list_operations()):
                fail('$.operations','unresolved_operation','存在未核对操作，不能应用')
            for name,descriptor in old.modules.items():
                manager=old.managers[descriptor.manager]
                measured=await asyncio.wait_for(manager.status(name,descriptor),descriptor.start_timeout_s)
                if measured['running'] or getattr(manager,'identities',{}):
                    fail('$.modules','process_still_present','遗留进程或管理身份尚未清理')
            phase('validating')
            path,bound,registry=self.materialize(draft)
            # 设备和模拟场景身份不能靠变更配置摘要重置
            if any(old.tasks.store.targets(t['task_run_id']) for t in old.tasks.list()):
                if ({k:v.model_dump(mode='json') for k,v in old.bound.backends.items()} !=
                    {k:v.model_dump(mode='json') for k,v in bound.backends.items()} or
                    {k:v.model_dump(mode='json') for k,v in old.registry.packages.items()} !=
                    {k:v.model_dump(mode='json') for k,v in registry.packages.items()}):
                    fail('$.backends','device_continuity_required','已有目标台账，无法证明设备与场景连续的变更不能应用')
            old_path=old.config_path
            options=getattr(old,'replacement_options',{})
            task_options={'executable':old.tasks.executable,'endpoint':old.tasks.endpoint,'session_secret':old.tasks.session_secret}
            from .tasks import TaskManager
            candidate=None
            phase('releasing_old')
            await old.aclose(release_owner=False)
            try:
                phase('creating_new')
                candidate=Runtime(path,old.state_directory,owner_lock=old._owner,**options)
                TaskManager(candidate,**task_options)
                pointer=old.state_directory/'active-config.json'
                temporary=pointer.with_suffix('.tmp')
                temporary.write_text(encoded({'config_path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}))
                temporary.replace(pointer)
                self.context.current=candidate
            except BaseException:
                if candidate:
                    await candidate.aclose(release_owner=False)
                try:
                    restored=Runtime(old_path,old.state_directory,owner_lock=old._owner,**options)
                    TaskManager(restored,**task_options)
                    self.context.current=restored
                    phase('rolled_back')
                except BaseException:
                    from .records import OperationLedger
                    old.records=OperationLedger(old.state_directory/'operations.db')
                    old.engine.records=old.records
                    old.engine.control.records=old.records
                    TaskManager(old,**task_options)
                    old.state='BLOCKED';old.accepting=False
                    self.context.current=old
                    phase('blocked')
                raise
            return {'snapshot_id':candidate.snapshot_id,'config_path':str(path),'state':candidate.state,
                    'revision':revision,'applied':True}


def active_config(default,state):
    """持久生效引用必须经过摘要与受控根目录校验，禁止退回初始配置绕过恢复态"""
    pointer=Path(state)/'active-config.json'
    if not pointer.exists():
        return Path(default).resolve()
    try:
        value=json.loads(pointer.read_text())
        path=Path(value['config_path']).resolve()
        path.relative_to((Path(state)/'workspace/configurations').resolve())
        if hashlib.sha256(path.read_bytes()).hexdigest()!=value['sha256']:
            raise ValueError('digest')
        return path
    except (OSError,ValueError,KeyError,TypeError):
        fail('$.config','active_config_invalid','生效引用损坏，需要核对，不能回退至初始配置')
