import {useLocale} from '../../locale'
import {useEffect,useRef,useState} from 'react'
import type {Json} from '../shared'
import TreeCanvas from './TreeCanvas'
import {nodeLabel} from './labels'
export default function RuntimeTree({task,language='zh'}:{task:Json;language?:'zh'|'en'}){
 const {t}=useLocale()

 const definition=task.snapshot?.definition,[scope,setScope]=useState(''),[selected,setSelected]=useState(''),latest=useRef<{task:string;sequence:number;states:Record<string,string>;lastStates:Record<string,string>}>({task:'',sequence:0,states:{},lastStates:{}})
 useEffect(()=>{setScope('');setSelected('')},[task.task_run_id])
 if(!definition)return null
 if(latest.current.task!==task.task_run_id)latest.current={task:task.task_run_id,sequence:0,states:{},lastStates:{}}
 const events=[...(task.node_events||[])].sort((a:Json,b:Json)=>a.sequence-b.sequence)
 for(const event of events)if(event.sequence>latest.current.sequence){latest.current.states[event.path]=event.state;if(event.state!=='IDLE')latest.current.lastStates[event.path]=event.state;latest.current.sequence=event.sequence}
 if(task.event_sequence>=latest.current.sequence){for(const node of task.nodes||[]){latest.current.states[node.path]=node.state;if(node.state!=='IDLE')latest.current.lastStates[node.path]=node.state;latest.current.sequence=Math.max(latest.current.sequence,task.event_sequence||0)}}
 const document=definition.document,main=document.main_tree_id,mapping=definition.node_mapping||[],instances:Record<string,string>={'':main}
 function collect(treeId:string,prefix:string,seen:string[]){if(seen.includes(treeId)||!document.trees[treeId])return;for(const node of Object.values(document.trees[treeId].nodes) as Json[])if(node.registration_id==='SubTree'){const path=prefix?prefix+'/'+node.editor_id:node.editor_id;instances[path]=node.attributes.ID;collect(node.attributes.ID,path,[...seen,treeId])}}
 collect(main,'',[])
 const tree=document.trees[instances[scope]||main],states:Record<string,string>={},lastStates:Record<string,string>={}
 for(const node of Object.values(tree.nodes) as Json[]){const path=scope?scope+'/'+node.editor_id:node.editor_id;states[node.editor_id]=latest.current.states[path]||'IDLE';lastStates[node.editor_id]=latest.current.lastStates[path]||''}
 const runtime=mapping.find((node:Json)=>node.editor_id===selected&&node.path===(scope?scope+'/'+selected:selected)),operations=(task.operations||[]).filter((operation:Json)=>operation.node_id===runtime?.operation_node_id),selectedEvents=events.filter((event:Json)=>event.path===runtime?.path).slice(-20)
 return <div className="bw-runtime-tree"><div className="bw-runtime-scope"><span className={task.tree_state==='FAILURE'?'bw-issue-dot':'bw-status-dot'}/><strong>{task.tree_state||task.state}</strong><span>{t("设备停止")}{task.stop_confirmed?t("已确认"):t("未确认")}</span><select aria-label={t("运行子树")} value={scope} onChange={event=>{setScope(event.target.value);setSelected('')}}>{Object.entries(instances).map(([path,id])=><option key={path} value={path}>{id}{path?t(" · 子树调用"):t(" · 主树")}</option>)}</select></div>
  <TreeCanvas language={language} tree={tree} layout={{...definition.layout,collapsed:[],zoom:1}} viewKey={`runtime:${task.task_run_id}:${scope}`} selected={selected} onSelect={setSelected} onOpen={id=>{const node=tree.nodes[id];if(node?.registration_id==='SubTree'){setScope(scope?scope+'/'+id:id);setSelected('')}}} states={states} lastStates={lastStates}/>
  {selected&&<div className="bw-runtime-details"><header><strong>{definition.layout?.labels?.[selected]||nodeLabel(tree.nodes[selected]?.registration_id||'',language)}</strong><span>{states[selected]}{runtime?.stage?` · ${runtime.stage}`:''}</span></header>{selectedEvents.map((event:Json,index:number)=><div key={`${event.sequence}:${index}`} className="bw-trace-row"><small>{String(event.sequence).padStart(4,'0')}</small><span>{event.previous||'IDLE'} → {event.state}</span>{event.reason&&<span>{event.reason}</span>}</div>)}<details><summary>{t("执行数据")}</summary><pre>{JSON.stringify(operations.map((operation:Json)=>({input:operation.input,state:operation.state,feedback:operation.feedback,error:operation.error,stop_state:operation.stop_state})),null,2)}</pre></details></div>}
 </div>
}
