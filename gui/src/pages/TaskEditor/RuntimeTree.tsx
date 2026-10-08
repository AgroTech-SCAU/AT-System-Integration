import {editorText} from './messages'
import {useEffect,useRef,useState} from 'react'
import {Panel,Field} from '../../components/Foundation'
import type {Json} from '../shared'
import TreeCanvas from './TreeCanvas'
export default function RuntimeTree({task,language='zh'}:{task:Json;language?:'zh'|'en'}){
 const t=editorText(language)
 const definition=task.snapshot?.definition,[zoom,setZoom]=useState(0),[scope,setScope]=useState(''),[selected,setSelected]=useState(''),latest=useRef<{task:string;sequence:number;states:Record<string,string>;lastStates:Record<string,string>}>({task:'',sequence:0,states:{},lastStates:{}})
 useEffect(()=>{setScope('');setSelected('');setZoom(0)},[task.task_run_id])
 if(!definition)return null
 if(latest.current.task!==task.task_run_id)latest.current={task:task.task_run_id,sequence:0,states:{},lastStates:{}}
 const events=[...(task.node_events||[])].sort((a:Json,b:Json)=>a.sequence-b.sequence)
 for(const event of events)if(event.sequence>latest.current.sequence){latest.current.states[event.path]=event.state;if(event.state!=='IDLE')latest.current.lastStates[event.path]=event.state;latest.current.sequence=event.sequence}
 if(task.event_sequence>=latest.current.sequence){for(const node of task.nodes||[]){latest.current.states[node.path]=node.state;if(node.state!=='IDLE')latest.current.lastStates[node.path]=node.state;}latest.current.sequence=Math.max(latest.current.sequence,task.event_sequence||0)}
 const document=definition.document,main=document.main_tree_id,mapping=definition.node_mapping
 const instances:Record<string,string>={'':main}
 function collect(treeId:string,prefix:string,seen:string[]){if(seen.includes(treeId))return;for(const node of Object.values(document.trees[treeId].nodes) as Json[])if(node.registration_id==='SubTree'){const path=prefix?prefix+'/'+node.editor_id:node.editor_id;instances[path]=node.attributes.ID;collect(node.attributes.ID,path,[...seen,treeId])}}collect(main,'',[])
 const tree=document.trees[instances[scope]||main],states:Record<string,string>={},lastStates:Record<string,string>={}
 for(const node of Object.values(tree.nodes) as Json[]){const path=scope?scope+'/'+node.editor_id:node.editor_id;states[node.editor_id]=latest.current.states[path]||'IDLE';lastStates[node.editor_id]=latest.current.lastStates[path]||''}
 const runtime=mapping.find((n:Json)=>n.editor_id===selected&&n.path===(scope?scope+'/'+selected:selected)),operations=(task.operations||[]).filter((o:Json)=>o.node_id===runtime?.operation_node_id)
 return <Panel title={t("冻结运行树")} subtitle={t("当前任务的节点执行状态")}><p>{t('定义')} {definition.id} · {t('摘要')} {definition.digest}</p><p>{t('树')} {task.tree_state} · {t('节点 halt 仅表示取消派发')} · {t('设备停止')}{task.stop_confirmed?t("已确认"):t("未确认")}</p><Field label={t("子树调用实例")}><select value={scope} onChange={e=>{setScope(e.target.value);setSelected('');setZoom(0)}}>{Object.entries(instances).map(([path,treeId])=><option key={path} value={path}>{treeId} · {path||t("主树")}</option>)}</select></Field><div className="buttons"><button onClick={()=>setZoom(0)}>{t("适配视图")}</button><button onClick={()=>setZoom(Math.max(.2,(zoom||.5)-.1))}>{t("缩小")}</button><button onClick={()=>setZoom(Math.min(3,(zoom||.5)+.1))}>{t("放大")}</button></div><TreeCanvas fit={zoom===0} language={language} tree={tree} layout={{...definition.layout,collapsed:[],zoom:zoom||1}} selected={selected} onSelect={setSelected} states={states} lastStates={lastStates}/>{selected&&<><p>{t('实例')} {runtime?.path} · {t('阶段')} {runtime?.stage||t("控制或查询")} · {t('事件游标')} {latest.current.sequence}</p><pre>{JSON.stringify({node:runtime,operations:operations.map((o:Json)=>({operation_id:o.operation_id,input:o.input,state:o.state,feedback:o.feedback,error:o.error,stop_state:o.stop_state}))},null,2)}</pre><h3>{t("执行轮次与状态事件")}</h3><pre>{JSON.stringify(events.filter((e:Json)=>e.path===runtime?.path),null,2)}</pre></>}</Panel>
}
