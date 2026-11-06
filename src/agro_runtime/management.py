"""独立于机器人 operation 的持久管理 job"""
import asyncio
import hashlib
from datetime import datetime, timezone
from uuid import uuid4
from .configuration import encoded, identifier
from .errors import ContractValidationError, fail


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class ManagementJobs:
    def __init__(self,store):
        self.store=store
        self.workers={}
        for record in store.list('job'):
            if record['phase'] not in {'completed','failed','rolled_back','blocked'}:
                record.update(phase='failed',updated_at=timestamp(),finished_at=timestamp(),error={'code':'management_interrupted','reason':'管理过程在重启前未完成，请核对实际生效状态'})
                store.put('job',record['id'],record)

    def accept(self,action,request_id,payload,work,on_accept=None,*,context=None):
        identifier(request_id)
        digest=hashlib.sha256(encoded({'action':action,'payload':payload}).encode()).hexdigest()
        for job in self.store.list('job'):
            if job['request_id']==request_id:
                if job['fingerprint']!=digest:
                    fail('$.request_id','request_id_conflict','同一管理请求不能对应不同载荷')
                return job
        if action not in ('stop', 'stop_subsystems') and any(not t.done() for t in self.workers.values()):
            fail('$.management','management_busy','上一管理操作尚未完成')
        key='job_'+uuid4().hex
        now=timestamp()
        context={name:value for name,value in (context or payload).items()
                 if name in {'kind','reference','robot_system_id'} and isinstance(value,str)}
        record={'id':key,'request_id':request_id,'action':action,'fingerprint':digest,
                'accepted':True,'phase':'accepted','result':None,'error':None,
                'started_at':now,'updated_at':now,'finished_at':None,'context':context}
        self.store.put('job',key,record)
        def phase(value):
            record['phase']=value
            record['updated_at']=timestamp()
            self.store.put('job',key,record)
        async def run():
            try:
                phase('running')
                result=await work(phase)
                record.update(phase='completed',result=result)
                if isinstance(result,dict) and result.get('state') in {'FAILED','STOP_UNCONFIRMED','BLOCKED'}:
                    record.update(phase='failed',error={'code':'lifecycle_incomplete','reason':'管理操作未确认完成，请查看实际状态'})
            except Exception as exc:
                record.update(phase=record['phase'] if record['phase'] in {'rolled_back','blocked'} else 'failed',
                    error={'code':'management_failed','reason':str(exc)})
                if isinstance(exc,ContractValidationError):
                    record['error']={'errors':[i.model_dump() for i in exc.issues]}
            record.update(updated_at=timestamp(),finished_at=timestamp())
            self.store.put('job',key,record)
        if on_accept:
            on_accept()
        self.workers[key]=asyncio.create_task(run())
        return dict(record)

    def status(self,key):
        return self.store.get('job',key)
