"""受控任务日志与 GUI/CLI 共用脱敏报告"""
import re
import os
from pathlib import Path
from .configuration import identifier
from .errors import fail


class Diagnostics:
    def __init__(self,context):
        self.context=context

    def clean(self,value):
        secret=self.context.tasks.session_secret or ''
        hidden={'control','process_identity','task_ref','config_path','source_root','native_config','argv','control_epoch','expires_at','api_key','apikey'}
        if isinstance(value,dict):
            return {k:self.clean(v) for k,v in value.items() if k not in hidden and
                not any(s in k.lower() for s in ('token','secret','password','authorization','api_key','apikey','passwd')) and
                not (k=='path' and isinstance(v,str) and not v.startswith('$'))}
        if isinstance(value,list):
            return [self.clean(v) for v in value]
        if isinstance(value,str):
            if secret:
                value=value.replace(secret,'[redacted]')
            if re.search(r'password|api[_ -]?key|authorization|secret|token|control_epoch|expires_at',value,re.I):
                return '[redacted]'
            value=re.sub(r'Bearer\s+\S+','Bearer [redacted]',value,flags=re.I)
            value=re.sub(r'(?<![\w:])/(?:[^\s\"\'<>]+)','[local path]',value)
        return value

    def logs(self,key,offset=0,limit=16384):
        identifier(key)
        self.context.tasks.store.status(key)
        if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=65536:
            fail('$.logs','invalid_log_range','日志偏移必须非负，读取长度为 1 至 65536 字节')
        root=self.context.tasks.directory.resolve()
        path=(root/key/'executor.log').resolve()
        if not path.is_relative_to(root/key):
            fail('$.logs','invalid_log_path','日志必须位于该任务受控目录')
        if not path.is_file():
            return {'available':False,'text':'执行器日志尚不可用','next_offset':offset,'eof':True}
        if offset>path.stat().st_size:
            fail('$.offset','invalid_log_range','日志偏移超出文件大小')
        # Scan complete bounded lines before slicing, so offsets cannot bypass credential labels
        with path.open('rb') as stream:
            size=path.stat().st_size
            start=max(0,offset-65536)
            stream.seek(start)
            window=stream.read(limit+131072)
            masked=bytearray(window)
            cursor=0
            sensitive=re.compile(rb'bearer|authorization|secret|token|password|api[_ -]?key|control_epoch|expires_at',re.I)
            for line in window.splitlines(keepends=True):
                incomplete=(cursor==0 and start>0) or (cursor+len(line)==len(window) and start+len(window)<size and not line.endswith(b'\n'))
                if incomplete or sensitive.search(line):
                    masked[cursor:cursor+len(line)]=bytes(10 if b==10 else 42 for b in line)
                cursor+=len(line)
            secret=(self.context.tasks.session_secret or '').encode()
            data=bytes(masked)
            if secret:
                data=data.replace(secret,b'*'*len(secret))
            raw=data[offset-start:offset-start+limit]
            end=offset+len(raw)
        return {'available':True,'text':self.clean(raw.decode('utf-8',errors='replace')),'next_offset':end,'eof':end>=size}

    def report(self,key):
        task=self.context.tasks.status(key)
        return self.clean({'format':'agro.task_report.v1','task':task,'executor_log':self.logs(key),
            'module_logs':{'available':False,'reason':'当前模块日志未完整捕获'}})

    def readiness(self):
        runtime=self.context
        checks=[]
        for (backend,capability),spec in runtime.bound.capabilities.items():
            checks.append(runtime.readiness(backend,capability,control=None))
        return {'system':runtime.status(),'capabilities':checks,
            'executor_available':bool(runtime.tasks.executable and Path(runtime.tasks.executable).is_file() and os.access(runtime.tasks.executable,os.X_OK)),
            'module_logs_available':False,'control_acquired':False,
            'completed_targets':{name:sorted(runtime.tasks.completed_targets(name)) for name in runtime.bound.backends}}
