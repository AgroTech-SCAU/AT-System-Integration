"""Offline orchestration regressions, no ROS graph or physical device access"""
import asyncio
import copy
import socket
import tempfile
import threading
from types import SimpleNamespace
from unittest.mock import Mock, patch
import unittest
from pathlib import Path

import uvicorn

from agro_runtime.api import create_app
from agro_runtime.errors import ContractValidationError
from agro_runtime.ros_tasks import RosTasks, prepared_task, mapped_outputs, validate_task
from agro_runtime.runtime import Runtime

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / '.install/task-engine/agro-bt'


def task(identity, *, inputs=None, outputs=None, input_bindings=None, output_bindings=None):
    return {'id':identity,'name':identity,'kind':'service','interface':'/offline/'+identity,
            'ros_type':'example_interfaces/srv/AddTwoInts','payload':{'a':1,'b':2},
            'inputs':inputs or {},'outputs':outputs or {},'input_bindings':input_bindings or {},
            'output_bindings':output_bindings or {},'timeout_s':2,'resources':[]}


class Bindings(unittest.TestCase):
    def test_nested_payload_and_result_bindings(self):
        spec=validate_task(task('sum',inputs={'value':{'type':'integer','unit':'1'}},
            outputs={'sum':{'type':'integer','unit':'1'}},input_bindings={'nested.a':'value'},output_bindings={'sum':'result.sum'}))
        ready=prepared_task(spec,{'value':4})
        self.assertEqual(ready['payload']['nested']['a'],4)
        self.assertNotIn('nested',spec['payload'])
        self.assertEqual(mapped_outputs(spec,{'result':{'sum':7}}),{'sum':7})
        with self.assertRaises(ContractValidationError):prepared_task(spec,{'value':'wrong'})
        with self.assertRaises(ContractValidationError):mapped_outputs(spec,{'result':{}})


class RosContracts(unittest.IsolatedAsyncioTestCase):
    async def test_context_is_reused_and_completion_checks_response(self):
        ros=RosTasks(None,None)
        rclpy=SimpleNamespace(context=SimpleNamespace(Context=object),init=Mock(),shutdown=Mock())
        definition=validate_task({**task('query'), 'success_condition':{'operator':'equals','field':'success','value':True}})
        with patch('agro_runtime.ros_tasks._ros_modules',return_value=(rclpy,None,None,None)), \
             patch('agro_runtime.ros_tasks._run_task',return_value={'state':'SUCCEEDED','response':{'success':False}}) as execute:
            first=await ros.run('query',threading.Event(),definition=definition)
            second=await ros.run('query',threading.Event(),definition=definition)
            self.assertEqual(first['state'],'FAILED')
            self.assertEqual(second['error']['code'],'completion_condition_failed')
            self.assertEqual(rclpy.init.call_count,1)
            self.assertIs(execute.call_args_list[0].kwargs['context'],execute.call_args_list[1].kwargs['context'])
            ros.close();self.assertEqual(rclpy.shutdown.call_count,1)

    async def test_complete_json_message_binding_preserves_types(self):
        definition=validate_task(task('whole',inputs={'message':{'type':'json'}},outputs={'result':{'type':'json'}},
            input_bindings={'$':'message'},output_bindings={'result':'$'}))
        value={'x':1.5,'enabled':True,'items':[{'name':'a'}]}
        self.assertEqual(prepared_task(definition,{'message':value})['payload'],value)
        self.assertEqual(mapped_outputs(definition,value),{'result':value})


@unittest.skipUnless(ENGINE.exists(),'Build the BehaviorTree.CPP executor first')
class Orchestration(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory=tempfile.TemporaryDirectory(prefix='atil-orchestration-')
        self.runtime=Runtime(ROOT/'examples/tomato_picker/system_four_backends.yaml',self.directory.name)
        self.socket=socket.socket();self.socket.bind(('127.0.0.1',0));self.socket.listen(20)
        port=self.socket.getsockname()[1]
        self.app=create_app(self.runtime,session_secret='offline-test',task_engine=str(ENGINE),
                            endpoint=f'http://127.0.0.1:{port}',tutorial_only=True)
        self.documents=self.app.state.documents
        self.store=self.documents.store
        self.robots=self.app.state.robot_systems
        self.store.put('robot_system','robot_test',{'id':'robot_test','name':'Offline','configured':True})
        self.store.put('robot_selection','selected',{'system_id':'robot_test'})
        self.robots.active=lambda *args:True
        self.runtime.state='READY';self.runtime.accepting=True
        self.server=uvicorn.Server(uvicorn.Config(self.app,log_level='error',lifespan='off'))
        self.server.install_signal_handlers=lambda:None
        self.server_task=asyncio.create_task(self.server.serve(sockets=[self.socket]))
        for _ in range(100):
            if self.server.started:break
            await asyncio.sleep(.01)
        self.ros=self.app.state.ros_tasks
        self.hsm=self.app.state.hsm
        self.calls=[]
        async def run(identity,stop,feedback=None,*,definition=None,inputs=None):
            self.calls.append((identity,copy.deepcopy(definition),copy.deepcopy(inputs)))
            await asyncio.sleep(.03)
            return {'state':'CANCELED' if stop.is_set() else 'SUCCEEDED',
                    'output':{'sum':inputs.get('value',1)+2} if definition.get('outputs') else {}}
        self.ros.run=run

    async def asyncTearDown(self):
        await self.hsm.close()
        await self.documents.ros_operations.close()
        await self.runtime.tasks.close()
        await self.runtime.engine.aclose()
        self.runtime.records.close();self.runtime._owner.close();self.store.db.close()
        self.server.should_exit=True
        await self.server_task
        self.directory.cleanup()

    async def wait(self,predicate):
        for _ in range(400):
            if predicate():return
            await asyncio.sleep(.02)
        self.fail('Timed out waiting for orchestration')

    async def test_real_cpp_sequence_freezes_ros_and_flows_typed_outputs(self):
        first=self.ros.save(task('first',outputs={'sum':{'type':'integer','unit':'1'}},output_bindings={'sum':'sum'}))
        second=self.ros.save(task('second',inputs={'value':{'type':'integer','unit':'1'}},input_bindings={'a':'value'}))
        xml='<root BTCPP_format="4" main_tree_to_execute="Main"><BehaviorTree ID="Main"><Sequence><RosTask_first node_id="first" out_sum="{answer}"/><RosTask_second node_id="second" value="{answer}"/></Sequence></BehaviorTree></root>'
        draft=self.documents.create(xml)
        definition=self.documents.publish(draft['id'],draft['revision'],self.runtime.snapshot_id)
        self.ros.save({**first,'payload':{'a':99,'b':100}})
        started=await self.runtime.tasks.start_task(self.documents.definition_request(definition['id'],'test_sequence'),'test')
        identity=started['task_run_id']
        await self.wait(lambda:self.runtime.tasks.status(identity)['state'] not in {'ACCEPTED','RUNNING','CANCELING'})
        status=self.runtime.tasks.status(identity)
        self.assertEqual(status['state'],'SUCCEEDED',status.get('error'))
        self.assertTrue(status['stop_confirmed'])
        self.assertEqual([c[0] for c in self.calls],['first','second'])
        self.assertEqual(self.calls[0][1]['payload'],{'a':1,'b':2})
        self.assertEqual(self.calls[1][2],{'value':3})
        self.assertEqual(len(status['operations']),2)

    async def test_unconfigured_workspace_publishes_and_runs_ros_tree_with_confirmation(self):
        import httpx
        self.store.put('robot_system','robot_test',{'id':'robot_test','name':'Offline','configured':False})
        self.robots.active=lambda *args:False
        self.runtime.state='STOPPED';self.runtime.accepting=False
        self.ros.save(task('standalone'))
        draft=self.documents.create('<root BTCPP_format="4" main_tree_to_execute="Main"><BehaviorTree ID="Main"><RosTask_standalone node_id="standalone"/></BehaviorTree></root>')
        self.ros.save(task('another'))
        draft=self.documents.rebase_draft(draft['id'])
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),base_url='http://test',headers={'Authorization':'Bearer offline-test'}) as client:
            response=await client.post('/trees/drafts/'+draft['id']+'/publish',json={'revision':draft['revision'],'base_snapshot_id':self.runtime.snapshot_id})
            self.assertEqual(response.status_code,200,response.text)
            definition=response.json()
            route='/trees/definitions/'+definition['id']+'/start'
            denied=await client.post(route,json={'request_id':'offline_no_confirmation'})
            self.assertEqual(denied.status_code,409,denied.text)
            accepted=await client.post(route,json={'request_id':'offline_confirmed','confirm_safety':True})
            self.assertEqual(accepted.status_code,202,accepted.text)
        identity=accepted.json()['task_run_id']
        await self.wait(lambda:self.runtime.tasks.status(identity)['state'] not in {'ACCEPTED','RUNNING','CANCELING'})
        status=self.runtime.tasks.status(identity)
        self.assertEqual(status['state'],'SUCCEEDED',status.get('error'))
        self.assertTrue(status['stop_confirmed'])
        self.assertEqual(self.calls[0][0],'standalone')
        self.assertEqual(self.runtime.state,'STOPPED')

    async def test_fifo_events_and_frozen_machine(self):
        spec={'initial':'root','variables':{},'states':[{'id':'root','initial':'a'},
              {'id':'a','parent':'root'},{'id':'b','parent':'root'},{'id':'c','parent':'root'}],
              'transitions':[{'source':'a','target':'b','event':'next'},{'source':'b','target':'c','event':'finish'}]}
        machine=self.hsm.save({'name':'test','document':spec})
        await self.hsm.start(machine['id'])
        await self.wait(lambda:self.hsm.status()['status']=='RUNNING')
        changed=copy.deepcopy(spec);changed['transitions']=[]
        self.hsm.save({**machine,'document':changed})
        await self.hsm.event('next',{})
        await self.hsm.event('finish',{})
        await self.wait(lambda:self.hsm.status()['active']=='c')
        self.assertEqual([e['event'] for e in self.hsm.status()['events']],['next','finish'])
        self.assertEqual(self.hsm.status()['pending_events'],0)

    async def test_direct_ros_output_to_state_variable_and_next_task(self):
        first=self.ros.save(task('first',outputs={'sum':{'type':'integer','unit':'1'}},output_bindings={'sum':'sum'}))
        second=self.ros.save(task('second',inputs={'value':{'type':'integer','unit':'1'}},input_bindings={'a':'value'}))
        spec={'initial':'root','variables':{'answer':0},'states':[{'id':'root','initial':'a'},
              {'id':'a','parent':'root','do':'ros:first','bindings':{'do':{'outputs':{'sum':'answer'}}}},
              {'id':'b','parent':'root','entry':'ros:second','bindings':{'entry':{'inputs':{'value':'answer'}}}}],
              'transitions':[{'source':'a','target':'b','event':'completed'}]}
        machine=self.hsm.save({'name':'test','document':spec})
        await self.hsm.start(machine['id'])
        await self.wait(lambda:self.hsm.status()['active']=='b' or self.hsm.status()['status']=='UNKNOWN')
        self.assertEqual(self.hsm.status()['status'],'RUNNING',self.hsm.status().get('error'))
        self.assertEqual(self.hsm.status()['variables']['answer'],3)
        self.assertEqual(self.calls[1][2],{'value':3})

    async def test_cancellation_revokes_dispatch_and_releases_resources(self):
        definition=self.ros.save({**task('waiting'),'resources':[{'name':'arm.left','access':'exclusive'}]})
        entered=asyncio.Event()
        async def waiting(identity,stop,feedback=None,**kwargs):
            entered.set()
            while not stop.is_set():await asyncio.sleep(.01)
            return {'state':'CANCELED','output':{}}
        self.ros.run=waiting
        control=self.runtime.engine.control
        token=control.begin_task('test').model_dump(mode='json')
        manager=self.documents.ros_operations
        first=await manager.start(definition,{},token,task_id='session_test',node_id='node_first',request_id='first')
        await entered.wait()
        with self.assertRaises(ContractValidationError) as busy:
            await manager.start(definition,{},token,task_id='session_test',node_id='node_second',request_id='second')
        self.assertEqual(busy.exception.issues[0].code,'resource_busy')
        control.set_mode('MANUAL')
        await self.wait(lambda:manager.snapshot(first['operation_id'])['state']=='CANCELED')
        self.assertEqual(manager.snapshot(first['operation_id'])['stop_state'],'CONFIRMED')
        self.assertFalse(control.resources.unavailable)
        with self.assertRaises(ContractValidationError):
            await manager.start(definition,{},token,task_id='session_test',node_id='node_third',request_id='third')

    async def test_late_completion_does_not_trigger_a_new_activation(self):
        self.ros.save(task('slow'))
        started=asyncio.Event()
        async def late(identity,stop,feedback=None,**kwargs):
            started.set()
            while not stop.is_set():await asyncio.sleep(.01)
            return {'state':'SUCCEEDED','output':{}}
        self.ros.run=late
        spec={'initial':'root','variables':{},'states':[{'id':'root','initial':'a'},
              {'id':'a','parent':'root','do':'ros:slow'},{'id':'b','parent':'root'},{'id':'c','parent':'root'}],
              'transitions':[{'source':'a','target':'b','event':'next'},{'source':'b','target':'c','event':'completed'}]}
        machine=self.hsm.save({'name':'test','document':spec})
        await self.hsm.start(machine['id']);await started.wait()
        await self.hsm.event('next',{})
        await self.wait(lambda:self.hsm.status()['active']=='b')
        await asyncio.sleep(.08)
        self.assertEqual(self.hsm.status()['active'],'b')
        self.assertEqual([e['event'] for e in self.hsm.status()['events']],['next'])

    async def test_parent_behavior_survives_child_state_transition(self):
        self.ros.save(task('monitor'))
        started=asyncio.Event();calls=[]
        async def monitor(identity,stop,feedback=None,**kwargs):
            calls.append(identity);started.set()
            while not stop.is_set():await asyncio.sleep(.01)
            return {'state':'CANCELED','output':{}}
        self.ros.run=monitor
        spec={'initial':'root','variables':{},'states':[{'id':'root','initial':'a','do':'ros:monitor'},
              {'id':'a','parent':'root'},{'id':'b','parent':'root'}],
              'transitions':[{'source':'a','target':'b','event':'next'}]}
        machine=self.hsm.save({'name':'test','document':spec})
        await self.hsm.start(machine['id']);await started.wait()
        await self.hsm.event('next',{})
        await self.wait(lambda:self.hsm.status()['active']=='b')
        self.assertEqual(calls,['monitor'])
        self.assertEqual(self.hsm.status()['status'],'RUNNING')
        await self.hsm.stop()
        self.assertEqual(self.hsm.status()['status'],'STOPPED')

    async def test_structured_json_crosses_cpp_blackboard_without_string_encoding(self):
        self.ros.save(task('source',outputs={'document':{'type':'json'}},output_bindings={'document':'result'}))
        self.ros.save(task('sink',inputs={'document':{'type':'json'}},input_bindings={'goal':'document'}))
        payload={'pose':{'x':1.25,'frame':'map'},'labels':['ripe','reachable'],'valid':True}
        async def structured(identity,stop,feedback=None,*,definition=None,inputs=None):
            self.calls.append((identity,definition,copy.deepcopy(inputs)))
            return {'state':'SUCCEEDED','output':{'document':payload} if identity=='source' else {}}
        self.ros.run=structured
        xml='<root BTCPP_format="4" main_tree_to_execute="Main"><BehaviorTree ID="Main"><Sequence><RosTask_source node_id="first" out_document="{pose}"/><RosTask_sink node_id="second" document="{pose}"/></Sequence></BehaviorTree></root>'
        draft=self.documents.create(xml)
        definition=self.documents.publish(draft['id'],draft['revision'],self.runtime.snapshot_id)
        started=await self.runtime.tasks.start_task(self.documents.definition_request(definition['id'],'json_sequence'),'test')
        identity=started['task_run_id']
        await self.wait(lambda:self.runtime.tasks.status(identity)['state'] not in {'ACCEPTED','RUNNING','CANCELING'})
        status=self.runtime.tasks.status(identity)
        self.assertEqual(status['state'],'SUCCEEDED',status.get('error'))
        self.assertEqual(self.calls[1][2],{'document':payload})

    async def test_unknown_ros_stop_quarantines_resources(self):
        definition=self.ros.save({**task('unknown'),'resources':[{'name':'arm.left','access':'exclusive'}]})
        async def unknown(*args,**kwargs):raise RuntimeError('Simulated cancellation acknowledgement lost')
        self.ros.run=unknown
        control=self.runtime.engine.control
        token=control.begin_task('test').model_dump(mode='json')
        manager=self.documents.ros_operations
        operation=await manager.start(definition,{},token,task_id='session_test',node_id='node_test',request_id='unknown')
        await self.wait(lambda:manager.snapshot(operation['operation_id'])['state']=='UNKNOWN')
        self.assertEqual(manager.snapshot(operation['operation_id'])['stop_state'],'UNCONFIRMED')
        self.assertTrue(control.resources.unavailable)
        self.runtime.state='STOPPED'
        with self.assertRaises(ContractValidationError) as blocked:self.robots.require_stopped()
        self.assertEqual(blocked.exception.issues[0].code,'operation_not_stopped')


if __name__=='__main__':unittest.main()
