import {AnimatePresence,motion} from 'motion/react'
import {springs, fade} from '../motion'
import {useLocale} from '../locale'
import {useEffect,useMemo,useRef,useState} from 'react'
import {Field} from '../components/Foundation'
import {AnchoredPopover} from '../components/AnchoredPopover'
import {Icon} from '../components/Icon'
import {TaskIconPicker} from '../components/TaskIconPicker'
import {ApiError} from '../api'
import {ErrorFields,type PageProps} from './shared'
import './ros-workbench.css'
import InterfaceWorkspacePicker, {type InterfaceWorkspace, type WorkspaceResolution, type WorkspaceInterface, type InterfaceIssue} from './InterfaceWorkspacePicker'
import SchemaMessageForm, {fallbackFields, reconcileFields, invalidMessageFields, schemaFieldAt, type MessageSchema} from './SchemaMessageForm'
import type {Workspace} from '../types'

type Contract={type:string;unit?:string;[key:string]:unknown}
type PortRow={key:string;name:string;path:string;contract:Contract}
export type RosTask={
 id?:string;name:string;icon?:string;kind:'service'|'action'|'publish_once'|'publish_periodic'|'subscribe_wait'
 interface:string;ros_type:string;schema_id?:string;workspace_ids?:string[];payload:Record<string,unknown>;stop_payload?:Record<string,unknown>
 condition?:{field?:string;operator?:string;value?:unknown};success_condition?:{field?:string;operator?:string;value?:unknown};rate_hz:number;timeout_s:number
 qos_reliability?:'reliable'|'best_effort';inputs?:Record<string,Contract>;outputs?:Record<string,Contract>
 input_bindings?:Record<string,string>;output_bindings?:Record<string,string>;resources?:{name:string;access:'exclusive'|'shared'}[]
}
type Props=PageProps&{robotId?:string;onNavigate?:(page:Workspace)=>void;requestedTask?:string;requestKey?:number;contextLabel?:string;onBound?:(reference:string)=>void;onBack?:()=>void;onCancelOpen?:()=>void}
const kinds:RosTask['kind'][]=['action','service','publish_once','publish_periodic','subscribe_wait']
const names:Record<RosTask['kind'],string>={action:'执行 Action 目标',service:'调用 Service 服务',publish_once:'发布一次话题消息',publish_periodic:'持续发布话题消息',subscribe_wait:'等待话题消息'}
const fresh=(translate=(value:string)=>value):RosTask=>({icon:'navigation',name:translate('未命名任务'),kind:'action',interface:'',ros_type:'',payload:{},condition:{operator:'any'},rate_hz:5,timeout_s:15,inputs:{},outputs:{},input_bindings:{},output_bindings:{},resources:[]})
const pretty=(value:unknown)=>JSON.stringify(value??{},null,2)
const isRecord=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)
function leafFields(value:Record<string,unknown>,prefix:string[]=[]):{path:string[];value:unknown}[]{return Object.entries(value).flatMap(([name,content])=>isRecord(content)&&Object.keys(content).length?leafFields(content,[...prefix,name]):[{path:[...prefix,name],value:content}])}
const portRows=(task:RosTask,direction:'inputs'|'outputs'):PortRow[]=>direction==='inputs'?Object.entries(task.inputs||{}).flatMap(([name,contract])=>{const paths=Object.entries(task.input_bindings||{}).filter(([,input])=>input===name).map(([path])=>path);return (paths.length?paths:['']).map(path=>({key:crypto.randomUUID(),name,path,contract}))}):Object.entries(task.outputs||{}).map(([name,contract])=>({key:crypto.randomUUID(),name,path:task.output_bindings?.[name]||'',contract}))
function RosSelect({label,value,options,onChange,searchable=false}:{label:string;value:string;options:{value:string;label:string;hint?:string}[];onChange:(value:string)=>void;searchable?:boolean}){
 const {t}=useLocale()
 const [anchor,setAnchor]=useState<HTMLButtonElement|null>(null),[search,setSearch]=useState('')
 return <><button type="button" className="ros-select-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={!!anchor} onClick={event=>setAnchor(anchor?null:event.currentTarget)}><span>{options.find(option=>option.value===value)?.label||value}</span><Icon name="chevron-down"/></button><AnimatePresence>{anchor&&<AnchoredPopover anchor={anchor} label={label} role="listbox" align="start" className="ros-select-options" onClose={()=>{setAnchor(null);setSearch('')}}>{searchable&&<div className="ros-search"><Icon name="search"/><input autoFocus aria-label={t("搜索接口类型")} placeholder={t("搜索接口类型")} value={search} onChange={event=>setSearch(event.target.value)}/></div>}<div className="ros-select-scroll">{options.filter(option=>option.label.toLowerCase().includes(search.toLowerCase())).map(option=><button key={option.value} type="button" role="option" aria-selected={option.value===value} onClick={()=>{onChange(option.value);setAnchor(null)}}><span><strong>{option.label}</strong>{option.hint&&<small>{option.hint}</small>}</span><span aria-hidden="true">{option.value===value?'✓':''}</span></button>)}</div></AnchoredPopover>}</AnimatePresence></>
}


function Ports({title,rows,onChange,input}:{title:string;rows:PortRow[];onChange:(rows:PortRow[])=>void;input:boolean}){
 const {t}=useLocale()

 const update=(key:string,patch:Partial<PortRow>)=>onChange(rows.map(row=>row.key===key?{...row,...patch}:row))
 return <section className="ros-section"><div className="ros-section-title"><div><h3>{title}</h3><p>{input?t("将任务输入写入消息字段"):t("将响应或结果字段提供给后续任务")}</p></div><button title={t("添加")+title} aria-label={t("添加")+title} onClick={()=>onChange([...rows,{key:crypto.randomUUID(),name:'',path:'',contract:{type:'string'}}])}><Icon name="plus"/></button></div>
 {!rows.length?<div className="ros-port-empty">{input?t("使用消息中的固定值"):t("暂未声明输出")}</div>:<div className="ros-ports">{rows.map((row,index)=><div className="ros-port-row" key={row.key}>
 <input aria-label={t("{0} {1} 名称", {0: title, 1: index+1})} placeholder={t("参数名")} value={row.name} onChange={e=>update(row.key,{name:e.target.value})}/>
 <select aria-label={t("{0} {1} 类型", {0: title, 1: index+1})} value={row.contract.type} onChange={e=>update(row.key,{contract:{type:e.target.value,...(['stamped_pose','target_list'].includes(e.target.value)?{unit:'m',frame_id:'',clock_domain:'',max_age_s:1}:['number','integer'].includes(e.target.value)?{unit:'1'}:{})}})}>{['string','number','integer','boolean','json','stamped_pose','target_list','pick_result'].map(type=><option key={type}>{type}</option>)}</select>
 <input aria-label={t("{0} {1} 字段路径", {0: title, 1: index+1})} placeholder={input?t("消息字段路径"):t("结果字段路径")} value={row.path} onChange={e=>update(row.key,{path:e.target.value})}/>
 {['number','integer','stamped_pose','target_list'].includes(row.contract.type)&&<input className="ros-unit" aria-label={t("{0} {1} 单位", {0: title, 1: index+1})} placeholder={t("单位")} value={row.contract.unit||''} onChange={e=>update(row.key,{contract:{...row.contract,unit:e.target.value}})}/>}
 {['stamped_pose','target_list'].includes(row.contract.type)&&<div className="ros-pose-contract"><input aria-label={t("{0} {1} 坐标系", {0: title, 1: index+1})} placeholder={t("坐标系")} value={String(row.contract.frame_id||'')} onChange={e=>update(row.key,{contract:{...row.contract,frame_id:e.target.value}})}/><input aria-label={t("{0} {1} 时间域", {0: title, 1: index+1})} placeholder={t("时间域")} value={String(row.contract.clock_domain||'')} onChange={e=>update(row.key,{contract:{...row.contract,clock_domain:e.target.value}})}/><input type="number" min="0.001" step="0.1" aria-label={t("{0} {1} 有效期秒", {0: title, 1: index+1})} value={Number(row.contract.max_age_s||1)} onChange={e=>update(row.key,{contract:{...row.contract,max_age_s:Number(e.target.value)}})}/></div>}
 <button aria-label={t("移除{0} {1}", {0: title, 1: index+1})} title={t("移除字段")} onClick={()=>onChange(rows.filter(item=>item.key!==row.key))}><Icon name="x"/></button></div>)}</div>}</section>
}

export default function RosTaskLibrary({client,requestedTask,requestKey,contextLabel,onBound,onBack,onCancelOpen,robotId,onNavigate}:Props){
 const {t}=useLocale()

 const root=useRef<HTMLDivElement>(null),generation=useRef(0),locked=useRef(false),saveRef=useRef<()=>void>(()=>{}),alive=useRef(true)
 const [items,setItems]=useState<RosTask[]>([]),[current,setCurrent]=useState<RosTask>(()=>fresh(t))
 const [payload,setPayload]=useState('{}'),[stopPayload,setStopPayload]=useState('{}'),[conditionValue,setConditionValue]=useState('')
 const [inputRows,setInputRows]=useState<PortRow[]>([]),[outputRows,setOutputRows]=useState<PortRow[]>([])
 const [dirty,setDirty]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState<unknown>(null),[busy,setBusy]=useState(false),[query,setQuery]=useState('')
 const [schemaEpoch,setSchemaEpoch]=useState(0)
 const [interfaceTypes,setInterfaceTypes]=useState<WorkspaceInterface[]>([]),[schemaSource,setSchemaSource]=useState('')
 const [workspaces,setWorkspaces]=useState<InterfaceWorkspace[]>([]),[defaultIds,setDefaultIds]=useState<string[]>([])
 const [interfaceIssues,setInterfaceIssues]=useState<InterfaceIssue[]>([]),[resolving,setResolving]=useState(false),[schemaLoading,setSchemaLoading]=useState(false)
 const [schemaFields,setSchemaFields]=useState<MessageSchema|null>(null)
 const [fields,setFields]=useState<Record<string,string>|null>(null),[formMode,setFormMode]=useState(true),[detail,setDetail]=useState<'message'|'ports'>('message')
 const payloadRef=useRef(payload);payloadRef.current=payload
 const leavingForConfig=useRef(false),restoredDraft=useRef(false)
 const draftKey='atil.task.config-return.'+(robotId||'current')
 const selectedWorkspaceIds=current.workspace_ids??defaultIds
 const workspaceKey=selectedWorkspaceIds.join('|')
 const load=async()=>{const result=await client.request<{tasks:RosTask[]}>('/ros/tasks');if(alive.current){setItems(result.tasks);setCurrent(previous=>{const saved=result.tasks.find(item=>item.id===previous.id);return saved?{...previous,interface:saved.interface}:previous})}return result.tasks}
 const loadTypes=async()=>{const result=await client.request<{workspaces:InterfaceWorkspace[];default_workspace_ids:string[]}>('/ros/interface-workspaces');if(alive.current){setWorkspaces(result.workspaces);setDefaultIds(result.default_workspace_ids)}}
 useEffect(()=>{alive.current=true;void load().catch(setError);void loadTypes().catch(setError);const refresh=()=>{void loadTypes().catch(setError)};window.addEventListener('agro:interfaces:changed',refresh);return()=>{alive.current=false;generation.current++;window.removeEventListener('agro:interfaces:changed',refresh)}},[client])
 useEffect(()=>{
   setInterfaceTypes([]);setInterfaceIssues([])
   if(!selectedWorkspaceIds.length){setResolving(false);return}
   const controller=new AbortController();setResolving(true)
   void client.request<WorkspaceResolution>('/ros/interface-workspaces/resolve','POST',{workspace_ids:selectedWorkspaceIds},controller.signal).then(result=>{if(controller.signal.aborted)return;setInterfaceTypes(result.types);setInterfaceIssues([...result.diagnostics,...result.conflicts.map(issue=>({code:'workspace_conflict',reason:t('工作区定义冲突，请调整选择'),ros_type:issue.ros_type}))])}).catch(cause=>{if(!controller.signal.aborted)setError(cause)}).finally(()=>{if(!controller.signal.aborted)setResolving(false)})
   return()=>controller.abort()
 },[client,workspaceKey,workspaces])
 function apply(item:RosTask){generation.current++;setSchemaEpoch(epoch=>epoch+1);setCurrent(structuredClone(item));setPayload(pretty(item.payload));setStopPayload(pretty(item.stop_payload));setConditionValue(item.condition?.value===undefined?'':typeof item.condition.value==='string'?item.condition.value:JSON.stringify(item.condition.value));setInputRows(portRows(item,'inputs'));setOutputRows(portRows(item,'outputs'));setDirty(false);setFields(null);setSchemaFields(null);setSchemaSource('');setNotice('');setError(null);setFormMode(true)}
 useEffect(()=>{
   const raw=sessionStorage.getItem(draftKey)
   if(!raw)return
   try{const saved=JSON.parse(raw);apply(saved.current);setPayload(saved.payload);setStopPayload(saved.stopPayload);setConditionValue(saved.conditionValue);setInputRows(saved.inputRows);setOutputRows(saved.outputRows);setDirty(saved.dirty);setDetail(saved.detail||'message');restoredDraft.current=true;sessionStorage.removeItem(draftKey)}catch{sessionStorage.removeItem(draftKey)}
 },[client,draftKey])
 useEffect(()=>{
  if(!robotId)return
  const raw=sessionStorage.getItem('atil.task.seed');if(!raw)return
  try{const seed=JSON.parse(raw);if(seed.robotId!==robotId)return;sessionStorage.removeItem('atil.task.seed');apply({...fresh(t),name:seed.name,kind:seed.kind,interface:seed.interface,ros_type:seed.ros_type});setDirty(true)}catch{sessionStorage.removeItem('atil.task.seed')}
 },[robotId])
 const selectedInterface=interfaceTypes.find(item=>item.ros_type===current.ros_type)
 const effectiveSchemaId=current.schema_id||selectedInterface?.schema_id
 useEffect(()=>{
  setSchemaFields(null);setFields(null);setSchemaSource('')
  if(!current.ros_type||!effectiveSchemaId){setSchemaLoading(false);return}
  const revision=generation.current,controller=new AbortController();setSchemaLoading(true)
  void client.request<MessageSchema>(`/ros/schema?kind=${current.kind}&ros_type=${encodeURIComponent(current.ros_type)}&schema_id=${encodeURIComponent(effectiveSchemaId)}`,'GET',undefined,controller.signal).then(result=>{
    if(controller.signal.aborted||revision!==generation.current||!alive.current)return
    setFields(result.field_types);setSchemaFields(result);setSchemaSource(result.source||'workspace')
    setCurrent(previous=>({...previous,schema_id:result.schema_id}))
    if(current.kind!=='subscribe_wait'){
      let old:unknown;try{old=JSON.parse(payloadRef.current)}catch{return}
      if(!isRecord(old))return
      const reconciled=reconcileFields(result.field_schemas||fallbackFields(result.fields,result.field_types),old)
      const next=pretty(reconciled.value)
      if(next!==pretty(old)){setPayload(next);setDirty(true)}
      if(reconciled.changed.length)setNotice(t('字段已调整，请检查 {0}',{0:reconciled.changed.join(' · ')}))
    }
  }).catch(cause=>{if(!controller.signal.aborted)setError(cause)}).finally(()=>{if(!controller.signal.aborted)setSchemaLoading(false)})
  return()=>controller.abort()
 },[current.kind,current.ros_type,current.id,effectiveSchemaId,robotId,schemaEpoch])
 const discard=()=>!dirty||window.confirm(t("放弃当前未保存的任务修改"))
 function choose(item:RosTask){if(item.id===current.id)return;if(!busy&&discard())apply(item)}
 function reset(){if(!busy&&discard()){apply(fresh(t));setDirty(true)}}
 useEffect(()=>{if(requestKey===undefined)return;if(restoredDraft.current){restoredDraft.current=false;return}if(!discard()){onCancelOpen?.();return}let stopped=false;void load().then(all=>{if(stopped)return;const found=requestedTask?all.find(item=>item.id===requestedTask.replace(/^ros:/,'')):undefined;if(requestedTask&&!found){setError(new ApiError('response',[{path:'$.task',code:'not_found',reason:t("绑定的任务已不存在，请重新选择")}]));return}apply(found||{...fresh(t),name:contextLabel?.slice(0,80)||fresh(t).name})}).catch(setError);return()=>{stopped=true}},[requestKey,client])
 useEffect(()=>{
 const visible=()=>Boolean(root.current&&!root.current.closest('[hidden]'))
 const leave=(event:Event)=>{if(leavingForConfig.current&&event.type==='agro:navigate')return;if(dirty&&(event.type==='agro:navigate'||visible())&&!discard())event.preventDefault()}
 const unload=(event:BeforeUnloadEvent)=>{if(dirty){event.preventDefault();event.returnValue=''}}
 const key=(event:KeyboardEvent)=>{if(!visible()||!event.ctrlKey&&!event.metaKey||event.key.toLowerCase()!=='s')return;event.preventDefault();saveRef.current()}
 window.addEventListener('agro:navigate',leave);window.addEventListener('agro:studio:leave-task',leave);window.addEventListener('beforeunload',unload);window.addEventListener('keydown',key)
 return()=>{window.removeEventListener('agro:navigate',leave);window.removeEventListener('agro:studio:leave-task',leave);window.removeEventListener('beforeunload',unload);window.removeEventListener('keydown',key)}
 },[dirty])
 const update=(changes:Partial<RosTask>)=>{setCurrent(p=>({...p,...changes}));setDirty(true);setNotice('')}
 const typeGroup=current.kind==='action'?'action':current.kind==='service'?'srv':'msg'
 const matchingTypes=interfaceTypes.filter(item=>!item.dependency&&item.ros_type.split('/')[1]===typeGroup)
 const filtered=items.filter(task=>(task.name+' '+task.interface+' '+task.ros_type).toLowerCase().includes(query.toLowerCase()))
 const parsedPayload=useMemo(()=>{try{const value=JSON.parse(payload);return isRecord(value)?value:null}catch{return null}},[payload])
 const messageFields=useMemo(()=>schemaFields?(schemaFields.field_schemas||fallbackFields(schemaFields.fields,schemaFields.field_types)):null,[schemaFields])
 function expose(path:string[],value:unknown,input:boolean){const name=path.join('_'),field=path.join('.'),type=typeof value==='number'?'number':typeof value==='boolean'?'boolean':typeof value==='string'?'string':'json',row:PortRow={key:crypto.randomUUID(),name,path:field,contract:{type,...(type==='number'?{unit:'1'}:{})}};if(input)setInputRows(old=>old.some(item=>item.path===field)?old:[...old,row]);else setOutputRows(old=>old.some(item=>item.path===field)?old:[...old,row]);setDirty(true);setNotice(t("已添加任务{0} {1}", {0: input?t("输入"):t("输出"), 1: name}))}
 async function run(work:()=>Promise<void>){if(locked.current)return;locked.current=true;setBusy(true);setError(null);setNotice('');try{await work()}catch(cause){if(alive.current)setError(cause)}finally{locked.current=false;if(alive.current)setBusy(false)}}
 const canSave=Boolean(current.name.trim())&&!resolving&&!schemaLoading
 async function save(bind=false){if(!canSave)return;await run(async()=>{
 const revision=generation.current;if(root.current?.querySelector('[aria-invalid="true"]'))throw new ApiError('response',[{path:'$.payload',code:'invalid_json',reason:t("请先修正标记的字段")}]);let parsed:unknown,stop:unknown
 try{parsed=JSON.parse(payload);stop=JSON.parse(stopPayload);if(current.kind==='publish_periodic'&&messageFields&&isRecord(stop))stop=reconcileFields(messageFields,stop).value}catch{throw new ApiError('response',[{path:'$.payload',code:'invalid_json',reason:t("消息内容必须是有效的 JSON 对象")}])}
 if(!isRecord(parsed)||!isRecord(stop))throw new ApiError('response',[{path:'$.payload',code:'invalid_json',reason:t("消息内容必须是 JSON 对象")}])
 if(messageFields){
   const invalid=[...invalidMessageFields(messageFields,parsed,'payload'),...(current.kind==='publish_periodic'?invalidMessageFields(messageFields,stop,'stop_payload'):[])]
   if(invalid.length)throw new ApiError('response',invalid.map(path=>({path,code:'invalid_field',reason:t('字段值不符合接口类型或范围')})))
   const outputFields=schemaFields?.output_field_schemas||fallbackFields(schemaFields?.output_fields||schemaFields?.fields||{})
   const missing=[...inputRows.filter(row=>!schemaFieldAt(messageFields,row.path)),...outputRows.filter(row=>!schemaFieldAt(outputFields,row.path))]
   if(missing.length)throw new ApiError('response',missing.map(row=>({path:row.path,code:'missing_field',reason:t('绑定字段不在当前接口中，请重新选择')})))
 }

 const inputs:Record<string,Contract>={},outputs:Record<string,Contract>={},input_bindings:Record<string,string>={},output_bindings:Record<string,string>={}
 for(const row of inputRows){inputs[row.name]=row.contract;input_bindings[row.path]=row.name}for(const row of outputRows){outputs[row.name]=row.contract;output_bindings[row.name]=row.path}
 if(new Set(outputRows.map(row=>row.name)).size!==outputRows.length||new Set(inputRows.map(row=>row.path)).size!==inputRows.length)throw new ApiError('response',[{path:'$.ports',code:'duplicate_binding',reason:t("输出名称或输入字段路径重复")}])
 let value:unknown=conditionValue;try{value=JSON.parse(conditionValue)}catch{}
 const editable={...current} as RosTask&{robot_system_id?:string;revision?:number};delete editable.robot_system_id;delete editable.revision
 const result=await client.request<RosTask>('/ros/tasks','POST',{...editable,workspace_ids:selectedWorkspaceIds,interface:current.id?undefined:editable.interface,payload:parsed,stop_payload:current.kind==='publish_periodic'?stop:undefined,condition:current.kind==='subscribe_wait'?{...current.condition,value:conditionValue===''?undefined:value}:undefined,inputs,outputs,input_bindings,output_bindings,qos_reliability:current.qos_reliability||(current.kind==='subscribe_wait'?'best_effort':'reliable')})
 if(generation.current!==revision||!alive.current)return;setCurrent(result);setDirty(false);setNotice(t("已保存"));await load();window.dispatchEvent(new Event('agro:ros:refresh'));window.dispatchEvent(new Event('agro:trees:refresh'));if(bind&&result.id)onBound?.('ros:'+result.id)
 })}
 saveRef.current=()=>{void save()}
 function selectInterface(ros_type:string){if(ros_type===current.ros_type)return;generation.current++;setSchemaEpoch(epoch=>epoch+1);setError(null);setFields(null);setSchemaFields(null);setSchemaSource('');setFormMode(true);update({ros_type,schema_id:interfaceTypes.find(item=>item.ros_type===ros_type)?.schema_id,success_condition:undefined,condition:{operator:'any'}})}
 function configureRobot(tab:'resources'|'bindings'){
   if(!onNavigate)return
   sessionStorage.setItem(draftKey,JSON.stringify({current:{...current,workspace_ids:selectedWorkspaceIds},payload,stopPayload,conditionValue,inputRows,outputRows,dirty,detail}))
   sessionStorage.setItem('atil.robot.tab.'+(robotId||'current'),tab)
   sessionStorage.setItem('atil.robot.return.'+(robotId||'current'),root.current?.closest('.studio-workspace')?'editor':'system')
   leavingForConfig.current=true
   onNavigate('overview')
   leavingForConfig.current=false
 }
 function manageWorkspaces(){configureRobot('resources')}
 function selectWorkspaces(ids:string[]){generation.current++;setSchemaEpoch(epoch=>epoch+1);setError(null);setSchemaFields(null);setFields(null);update({workspace_ids:ids,schema_id:undefined})}
 async function remove(){if(!current.id||!window.confirm(t("删除此任务\n已被状态或行为树引用的能力无法删除")))return;await client.request('/ros/tasks/'+current.id,'DELETE');apply(fresh(t));await load();setNotice(t("已删除"));window.dispatchEvent(new Event('agro:ros:refresh'));window.dispatchEvent(new Event('agro:trees:refresh'))}

 function duplicate(){if(busy||!discard())return;apply({...structuredClone(current),id:undefined,name:current.name+t(" 副本")});setDirty(true)}
 return <div className="ros-workbench" ref={root}>
 <header className="ros-toolbar"><div className="ros-document-title"><Icon name="boxes"/><strong>{current.name}</strong><span className="ros-save-state">{busy?t("处理中"):dirty?t("未保存"):current.id?t("已保存"):t("新任务")}</span></div><div className="ros-toolbar-actions">{onBound&&current.id&&!dirty&&<button className="primary" disabled={busy} onClick={()=>onBound('ros:'+current.id)}>{t("使用此任务")}</button>}<button disabled={busy} title={t("复制任务")} onClick={duplicate}><Icon name="copy"/></button><button disabled={busy||!canSave} title={t("保存任务 ⌘S / Ctrl+S")} onClick={()=>void save()}><Icon name="save"/>{t("保存")}</button>{onBound&&(!current.id||dirty)&&<button className="primary" disabled={busy||!canSave} onClick={()=>void save(true)}>{t("用于 {0} 阶段",{0:contextLabel?.split(' / ').at(-1)})}</button>}</div></header>
 <div className="ros-workbench-body"><aside className="ros-browser"><div className="ros-browser-title"><strong>{t("任务库")}</strong><span>{items.length}</span><button title={t("新建任务")} aria-label={t("新建任务")} disabled={busy} onClick={reset}><Icon name="plus"/></button></div><div className="ros-search"><Icon name="search"/><input aria-label={t("搜索任务")} placeholder={t("搜索名称或接口")} value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="ros-browser-items">{filtered.map(item=><button key={item.id} className={current.id===item.id?'selected':''} disabled={busy} onClick={()=>choose(item)}><span className="ros-kind-symbol">{item.kind==='action'?'A':item.kind==='service'?'S':'T'}</span><span><strong>{item.name}</strong><small>{item.interface}</small></span></button>)}{!filtered.length&&<div className="ros-browser-empty">{query?t("没有匹配的能力"):t("还没有任务")}<small>{query?t("尝试其他名称或接口"):t("点击上方加号开始创建")}</small></div>}</div></aside>
 <main className="ros-editor"><div className="ros-editor-inner"><fieldset disabled={busy} className="ros-form-fields"><section className="ros-section"><div className="ros-section-title"><div><h2>{t("任务设置")}</h2><p>{t("定义业务能力的输入输出、完成条件与停止方式")}</p></div><span className="ros-transport-badge">ROS 2</span></div><div className="ros-task-name"><TaskIconPicker value={current.icon} onChange={icon=>update({icon})}/><Field label={t("任务名称")}><input aria-label={t("任务名称")} value={current.name} onChange={e=>update({name:e.target.value})}/></Field></div>
 <InterfaceWorkspacePicker workspaces={workspaces} value={selectedWorkspaceIds} onChange={selectWorkspaces} onManage={onNavigate?manageWorkspaces:undefined} disabled={busy}/>
 <div className="ros-form-grid"><Field label={t("通信方式")}><RosSelect label={t("通信方式")} value={current.kind} options={kinds.map(kind=>({value:kind,label:t(names[kind])}))} onChange={value=>{generation.current++;const kind=value as RosTask['kind'];update({kind,interface:'',ros_type:'',schema_id:undefined,success_condition:undefined,condition:{operator:'any'},qos_reliability:kind==='subscribe_wait'?'best_effort':'reliable'});setFields(null);setSchemaFields(null);setSchemaSource('');setPayload('{}');setStopPayload('{}');setInputRows([]);setOutputRows([])}}/></Field><Field label={t("接口类型")}><RosSelect searchable label={t("接口类型")} value={current.ros_type} options={[{value:'',label:t(resolving?'正在读取接口':'选择接口类型')},...matchingTypes.map(item=>({value:item.ros_type,label:item.ros_type,hint:item.workspace_ids.map(id=>workspaces.find(workspace=>workspace.id===id)?.name).filter(Boolean).join(' · ')}))]} onChange={selectInterface}/></Field></div>
 {!!interfaceIssues.length&&<details className="ros-interface-issues"><summary>{t('工作区有 {0} 项待补充',{0:interfaceIssues.length})}</summary>{interfaceIssues.map((issue,index)=><p key={index}>{issue.ros_type&&<code>{issue.ros_type} · </code>}{t(issue.reason)}</p>)}</details>}
 {current.schema_id&&selectedInterface&&selectedInterface.schema_id!==current.schema_id&&<div className="ros-definition-update"><span>{t('工作区定义已变化，当前任务保留原定义')}</span><button type="button" onClick={()=>{generation.current++;update({schema_id:selectedInterface.schema_id});setFormMode(true)}}>{t('更新接口定义')}</button></div>}
 <div className="ros-binding-summary"><span>{t('当前机器人端点')}</span><code>{current.interface||t('尚未绑定')}</code>{onNavigate&&<button type="button" onClick={()=>configureRobot('bindings')}>{t('前往机器人绑定')}<Icon name="chevron-right"/></button>}</div></section>
 <div className="ros-detail-tabs" role="tablist" aria-label={t("任务配置")}><button role="tab" aria-selected={detail==='message'} onClick={()=>setDetail('message')}>{detail==='message'&&<motion.span layoutId="task-detail-tab" className="workspace-selection" transition={springs.quick}/>}<b className="ros-tab-label">{t("消息配置")}</b></button><button role="tab" aria-selected={detail==='ports'} onClick={()=>setDetail('ports')}>{detail==='ports'&&<motion.span layoutId="task-detail-tab" className="workspace-selection" transition={springs.quick}/>}<b className="ros-tab-label">{t("输入与输出")}</b><span>{inputRows.length+outputRows.length||''}</span></button></div>
 {detail==='message'?<section className="ros-section"><div className="ros-section-title"><h3>{current.kind==='subscribe_wait'?t("等待条件"):current.kind==='action'?t("目标参数"):current.kind==='service'?t("请求参数"):t("消息内容")}</h3><div className="ros-inline-actions">{schemaSource&&<small className="ros-schema-source">{t('接口定义已加载')}</small>}{schemaFields&&current.kind!=='subscribe_wait'&&<button type="button" onClick={()=>setFormMode(!formMode)}>{formMode?t('编辑 JSON'):t('返回表单')}</button>}</div></div>
 {!current.ros_type?<div className="ros-parameter-empty"><Icon name="boxes"/><p>{t('选择工作区和接口后，参数字段会自动显示')}</p></div>:schemaLoading?<div className="ros-parameter-empty" role="status">{t('正在读取参数字段')}</div>:!schemaFields?<div className="ros-parameter-empty"><p>{t('当前工作区没有此接口的完整定义')}</p>{onNavigate&&<button onClick={manageWorkspaces}>{t('补充接口定义')}</button>}</div>:current.kind==='subscribe_wait'?<><Field label={t("触发条件")}><RosSelect label={t("触发条件")} value={current.condition?.operator||'any'} onChange={value=>update({condition:{...current.condition,operator:value}})} options={[{value:'any',label:t("收到任意消息")},{value:'equals',label:t("字段等于")},{value:'not_equals',label:t("字段不等于")},{value:'greater',label:t("字段大于")},{value:'less',label:t("字段小于")}]}/></Field>{(current.condition?.operator||'any')!=='any'&&<div className="ros-form-grid"><Field label={t("消息字段路径")}><input list="ros-wait-field-options" value={current.condition?.field||''} placeholder={t("data 或 pose.position.x")} onChange={e=>update({condition:{...current.condition,field:e.target.value}})}/></Field><Field label={t("期望值")}><input value={conditionValue} onChange={e=>{setConditionValue(e.target.value);setDirty(true)}} placeholder="true / 1 / ready"/></Field><datalist id="ros-wait-field-options">{schemaFields&&leafFields(schemaFields.fields).map(({path})=><option key={path.join('.')} value={path.join('.')}/>)}</datalist></div>}</>:formMode&&messageFields&&parsedPayload?<SchemaMessageForm fields={messageFields} value={parsedPayload} onChange={value=>{setPayload(pretty(value));setDirty(true)}} onExpose={(path,value)=>expose(path,value,true)}/>:<><textarea rows={8} aria-label={t('请求消息 JSON')} aria-invalid={!parsedPayload} spellCheck={false} className="ros-code" value={payload} onChange={event=>{setPayload(event.target.value);setDirty(true)}}/>{!parsedPayload&&<small className="ros-invalid">{t('消息必须是有效的 JSON 对象')}</small>}</>}

 <div className="ros-stop-message ros-completion"><h3>{t("完成判定")}</h3><p>{t(current.kind==='action'?"Action 返回成功状态时完成；可进一步检查结果字段":current.kind==='service'?"收到服务响应时完成；建议检查响应中的业务成功字段":current.kind==='publish_once'?"消息发送后立即完成，不代表设备动作已完成":current.kind==='publish_periodic'?"持续运行，退出状态或取消任务时停止发布": "收到满足等待条件的消息时完成")}</p>{['action','service'].includes(current.kind)&&<><Field label={t("成功条件")}><RosSelect label={t("成功条件")} value={current.success_condition?.operator||'any'} onChange={value=>update({success_condition:{...current.success_condition,operator:value}})} options={[{value:'any',label:t(current.kind==='action'?"Action 成功即完成":"收到服务响应即完成")},{value:'equals',label:t("结果字段等于")},{value:'not_equals',label:t("结果字段不等于")},{value:'greater',label:t("结果字段大于")},{value:'less',label:t("结果字段小于")}]}/></Field>{current.success_condition?.operator&&current.success_condition.operator!=='any'&&<div className="ros-form-grid"><Field label={t("结果字段路径")}><input list="ros-result-field-options" value={current.success_condition.field||''} placeholder="success" onChange={e=>update({success_condition:{...current.success_condition,field:e.target.value}})}/><datalist id="ros-result-field-options">{schemaFields&&leafFields(schemaFields.output_fields||{}).map(({path})=><option key={path.join('.')} value={path.join('.')}/>)}</datalist></Field><Field label={t("成功值")}><input value={typeof current.success_condition.value==='string'?current.success_condition.value:JSON.stringify(current.success_condition.value)??''} placeholder="true" onChange={e=>{let value:unknown=e.target.value;try{value=JSON.parse(e.target.value)}catch{}update({success_condition:{...current.success_condition,value}})}}/></Field></div>}</>}</div>
 {schemaFields&&['action','service','subscribe_wait'].includes(current.kind)&&<details className="ros-output-fields"><summary>{t("选择需要输出到任务的字段")}</summary>{leafFields(schemaFields.output_fields||schemaFields.fields).map(({path,value})=><div key={path.join('.')}><code>{path.join('.')}</code><button disabled={outputRows.some(row=>row.path===path.join('.'))} onClick={()=>expose(path,value,false)}>{outputRows.some(row=>row.path===path.join('.'))?t("已添加"):t("设为任务输出")}</button></div>)}</details>}
 {current.kind==='publish_periodic'&&<div className="ros-stop-message"><h3>{t("停止消息")}</h3><p>{t("任务停止时发送，用于撤销持续输出")}</p>{messageFields&&formMode?<SchemaMessageForm fields={messageFields} value={(()=>{try{return JSON.parse(stopPayload)}catch{return {}}})()} onChange={value=>{setStopPayload(pretty(value));setDirty(true)}}/>:<textarea rows={5} aria-label={t("停止消息 JSON")} className="ros-code" value={stopPayload} onChange={e=>{setStopPayload(e.target.value);setDirty(true)}} spellCheck={false}/>}</div>}</section>:<><Ports title={t("输入")} rows={inputRows} input onChange={rows=>{setInputRows(rows);setDirty(true)}}/><Ports title={t("输出")} rows={outputRows} input={false} onChange={rows=>{setOutputRows(rows);setDirty(true)}}/></>}
 </fieldset><ErrorFields value={error}/></div></main>
 <aside className="ros-inspector"><fieldset disabled={busy} className="ros-form-fields"><div className="ros-inspector-heading">{t("执行设置")}</div><Field label={t("等待超时 · 秒")}><input type="number" min="0.2" max="3600" step="0.5" value={current.timeout_s} onChange={e=>update({timeout_s:Number(e.target.value)})}/></Field>{current.kind==='publish_periodic'&&<Field label={t("发布频率 · Hz")}><input type="number" min="0.2" max="100" step="0.5" value={current.rate_hz} onChange={e=>update({rate_hz:Number(e.target.value)})}/></Field>}{!['action','service'].includes(current.kind)&&<Field label={t("消息传输")}><select value={current.qos_reliability||(current.kind==='subscribe_wait'?'best_effort':'reliable')} onChange={e=>update({qos_reliability:e.target.value as 'reliable'|'best_effort'})}><option value="reliable">Reliable</option><option value="best_effort">Best Effort</option></select></Field>}
 <div className="ros-resource-header"><strong>{t("占用资源")}</strong><button aria-label={t("添加资源")} onClick={()=>update({resources:[...(current.resources||[]),{name:'',access:'exclusive'}]})}><Icon name="plus"/></button></div>{(current.resources||[]).map((resource,index)=><div className="ros-resource-row" key={index}><input aria-label={t("资源 {0}", {0: index+1})} value={resource.name} placeholder="arm.left" onChange={e=>update({resources:current.resources?.map((item,i)=>i===index?{...item,name:e.target.value}:item)})}/><select aria-label={t("资源 {0} 访问方式", {0: index+1})} value={resource.access} onChange={e=>update({resources:current.resources?.map((item,i)=>i===index?{...item,access:e.target.value as 'exclusive'|'shared'}:item)})}><option value="exclusive">{t("独占")}</option><option value="shared">{t("共享")}</option></select><button aria-label={t("移除资源 {0}", {0: index+1})} onClick={()=>update({resources:current.resources?.filter((_,i)=>i!==index)})}><Icon name="x"/></button></div>)}{!current.resources?.length&&<p className="ros-field-hint">{t("未声明资源")}</p>}
 <div className="ros-execution-note"><Icon name="info"/><p>{current.kind==='action'?t("完成目标后返回结果，退出状态时取消目标并等待停止确认"):current.kind==='service'?t("服务响应代表请求完成，设备运动应使用 Action 跟踪"):current.kind==='publish_once'?t("发送完成后结束任务，不代表设备已完成执行"):current.kind==='publish_periodic'?t("停止周期发布后发送停止消息，设备端应配置心跳保护"):t("收到匹配消息后完成，消息字段可映射为任务输出")}</p></div>
 {current.id&&<button className="ros-delete" disabled={busy} onClick={()=>void run(remove)}><Icon name="trash"/>{t("删除任务")}</button>}</fieldset>{onBack&&<button className="ros-back" disabled={busy} onClick={onBack}><Icon name="arrow-left"/>{t("返回状态")}</button>}</aside>
 </div><footer className="ros-status" role="status"><span>{t(notice)||(current.id?current.interface:t("选择通信方式，配置接口与消息"))}</span><span>{t("输入 {0}",{0:inputRows.length})}<span className="ros-status-divider"/>{t("输出 {0}",{0:outputRows.length})}</span></footer>
 </div>
}
