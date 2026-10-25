"""Persistent observation context with serialized, cancellable data operations."""
import json
import queue
import sys
import threading

from data_operations import DataContext


def main():
    first=json.loads(sys.stdin.readline())
    context=DataContext(first.get('domain_id',0))
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
                result=context.run(task['operation'],task.get('payload',{}),stop)
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
