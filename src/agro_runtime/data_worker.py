"""Persistent observation context with serialized, cancellable data operations."""
import inspect
import json
import queue
import sys
import threading
import time

from data_operations import DataContext


def main():
    first=json.loads(sys.stdin.readline())
    context=DataContext(first.get('domain_id',0), first.get('use_sim_time',False))
    jobs=queue.Queue();stop=threading.Event()
    def reader():
        for line in sys.stdin:
            if line.strip()=='STOP':stop.set()
            elif line.strip()=='QUIT':stop.set();jobs.put(None);return
            else:jobs.put(json.loads(line))
        stop.set();jobs.put(None)
    threading.Thread(target=reader,daemon=True).start()
    print('ATIL_EVENT '+json.dumps({'ready':True}),flush=True)
    try:
        while True:
            task=jobs.get()
            if task is None:break
            try:
                from data_contracts import field_at_path, semantic_reason
                def validate_semantics(direction,value):
                    for left,right in task.get('input_bindings' if direction=='inputs' else 'output_bindings',{}).items():
                        path,name=(left,right) if direction=='inputs' else (right,left)
                        contract=task.get(direction,{}).get(name,{})
                        if not contract.get('stamp_path') and not contract.get('frame_path'):continue
                        reason=semantic_reason(contract,field_at_path(value,path),{'ros':context.now()})
                        if reason:raise ValueError(name+' · '+reason)
                deadline=time.monotonic()+task.get('timeout_s',15)
                while first.get('use_sim_time') and context.now()==0:
                    if stop.is_set():raise InterruptedError('数据处理已取消')
                    if time.monotonic()>deadline:raise TimeoutError('尚未收到 ROS 仿真时钟 /clock')
                    time.sleep(.02)
                validate_semantics('inputs',task.get('payload',{}))
                if task['operation']=='extension':
                    import importlib
                    module, function=task['compute_entrypoint'].split(':')
                    entrypoint=getattr(importlib.import_module(module),function)
                    options={'context':context} if 'context' in inspect.signature(entrypoint).parameters else {}
                    result=entrypoint(task.get('payload',{}),stop,**options)
                    if not isinstance(result,dict):raise ValueError('计算扩展必须返回 JSON 对象')
                else:
                    result=context.run(task['operation'],task.get('payload',{}),stop)
                validate_semantics('outputs',result)
                value={'state':'SUCCEEDED','response':result,'stop_confirmed':True}
            except Exception as error:
                value={'state':'CANCELED' if isinstance(error,InterruptedError) else 'FAILED','response':{},'stop_confirmed':True,
                       'error':{'code':'data_operation_failed','reason':str(error),'retryable':False}}
            print('ATIL_EVENT '+json.dumps(value,ensure_ascii=False,allow_nan=False),flush=True)
            stop.clear()
    finally:context.close()


if __name__=='__main__':
    try:main()
    except Exception as error:
        print('ATIL_EVENT '+json.dumps({'error':str(error)}),flush=True)
