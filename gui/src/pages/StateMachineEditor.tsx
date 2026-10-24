import {contractReason,type DataContract} from '../data-contracts'
import {TaskIcon} from '../components/TaskIconPicker'
import StudioSelect from '../components/StudioSelect'
import {confirmDialog, nameDialog, unsavedDialog, deferNavigation, reportError} from '../components/StudioDialogs'
import {AnimatePresence, motion} from 'motion/react'
import {springs, fade} from '../motion'
import {SpatialPanel} from '../components/SpatialPanel'
import {useLocale} from '../locale'
import {useCallback,useEffect,useMemo,useRef,useState,type DragEvent,type ReactNode} from 'react'
import HsmCanvas,{automaticHsmLayout} from './HsmCanvas'
import type {RosTask} from './RosTaskLibrary'
import {ApiError} from '../api'
import type {Json,PageProps} from './shared'
import type {Workspace} from '../types'
import {activeStatus,blankMachine,canReparent,descendants,diagnoseMachine,eventBranches,fingerprint,isFallback,isIdentifier,normalizeInitials,snapshotOf,statePath,transitionPlan,type Diagnostic,type MachineSnapshot,type MachineState,type SavedMachine,type Scalar,type Transition} from './hsm-model'
import './hsm-workbench.css'

type Phase='entry'|'do'|'exit'
type CheckIssue=Diagnostic&{taskId?:string;path?:string;phase?:Phase}
type CheckResult={key:string;status:'checking'|'passed'|'failed';message:string;issues:CheckIssue[]}
export type OpenStateTask={kind:'ros'|'tree';reference?:string;stateId:string;stateLabel:string;phase:Phase;machineId?:string}
type Props=PageProps & {onNavigate:(page:Workspace)=>void;onOpenRos:()=>void;onOpenTask?:(request:OpenStateTask)=>void}
const phaseLabels={entry:'进入时',do:'状态期间',exit:'离开时'}
const newMachineId=()=>'machine_'+crypto.randomUUID().replaceAll('-','')
const statusLabels:Record<string,string>={ENTERING:'进入状态',RUNNING:'运行中',TRANSITIONING:'切换状态',STOPPING:'正在停止',STOPPED:'已停止',SUCCEEDED:'已完成',FAILED:'执行失败',UNKNOWN:'状态待确认',CANCELED:'已取消'}
const errorMessage=(error:unknown,translate:(text:string)=>string=text=>text)=>{reportError(error);return error instanceof ApiError?error.kind==='offline'?'无法连接后台，修改仍保留在当前草稿':error.kind==='unauthorized'?'后台连接已失效，请重新连接':error.details.map(detail=>translate(detail.reason)).join(' · '):error instanceof Error?error.message:'操作未完成，请重试'}
const setting=(key:string,fallback:boolean)=>{try{return localStorage.getItem(key)==='true'||localStorage.getItem(key)===null&&fallback}catch{return fallback}}
const tinyIcon=(kind:'outline'|'inspect'|'undo'|'redo'|'play'|'stop'|'plus'|'chevron'|'close'|'state'|'branch'|'check'|'focus')=><svg viewBox="0 0 20 20" aria-hidden="true">{kind==='outline'?<><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M8 3 V17"/></>:kind==='inspect'?<><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M12 3 V17"/></>:kind==='undo'?<><path d="M7 5 L3 9 L7 13"/><path d="M3 9 H11 Q16 9 16 14"/></>:kind==='redo'?<><path d="M13 5 L17 9 L13 13"/><path d="M17 9 H9 Q4 9 4 14"/></>:kind==='play'?<path d="M6 4 L16 10 L6 16 Z"/>:kind==='stop'?<rect x="5" y="5" width="10" height="10" rx="2"/>:kind==='plus'?<path d="M10 4 V16 M4 10 H16"/>:kind==='chevron'?<path d="M8 5 L13 10 L8 15"/>:kind==='close'?<path d="M5 5 L15 15 M15 5 L5 15"/>:kind==='branch'?<><rect x="2" y="3" width="6" height="5" rx="1.5"/><rect x="12" y="12" width="6" height="5" rx="1.5"/><path d="M5 8 V14 H12"/></>:kind==='check'?<path d="M4 10 L8 14 L16 5"/>:kind==='focus'?<><path d="M3 7 V3 H7 M13 3 H17 V7 M17 13 V17 H13 M7 17 H3 V13"/></>:<rect x="4" y="4" width="12" height="12" rx="4"/>}</svg>

function Property({label,children}:{label:string;children:ReactNode}){return <label className="wb-property"><span>{label}</span>{children}</label>}
function ScalarInput({value,onChange,label,onValidity}:{value:Scalar;onChange:(value:Scalar)=>void;label:string;onValidity?:(valid:boolean)=>void}){
 const {t}=useLocale()
 const textValue=typeof value==='object'&&value!==null?JSON.stringify(value,null,2):String(value??'null')
 const [text,setText]=useState(textValue),[invalid,setInvalid]=useState(false)
 useEffect(()=>{setText(textValue);setInvalid(false);onValidity?.(true)},[textValue])
 if(typeof value==='boolean')return <select aria-label={label} value={String(value)} onChange={event=>onChange(event.target.value==='true')}><option value="false">false</option><option value="true">true</option></select>
 if(value===null)return <input aria-label={label} disabled value="null"/>
 if(typeof value==='object')return <div className="wb-json-field"><textarea aria-label={label} aria-invalid={invalid} rows={3} value={text} onChange={event=>{setText(event.target.value);try{const next=JSON.parse(event.target.value);if(next===null||typeof next!=='object')throw Error();setInvalid(false);onValidity?.(true);onChange(next)}catch{setInvalid(true);onValidity?.(false)}}}/>{invalid&&<small>{t("需要有效的 JSON 对象或数组")}</small>}</div>
 return <input aria-label={label} type={typeof value==='number'?'number':'text'} step="any" value={typeof value==='number'?text:value} aria-invalid={invalid} onChange={event=>{if(typeof value==='number'){setText(event.target.value);if(event.target.value===''||!Number.isFinite(Number(event.target.value))){setInvalid(true);onValidity?.(false);return}setInvalid(false);onValidity?.(true);onChange(Number(event.target.value))}else onChange(event.target.value)}}/>
}

export default function StateMachineEditor({client,onNavigate,onOpenRos,onOpenTask}:Props){
 const [historyEvent,setHistoryEvent]=useState<Json|null>(null)
 const [phaseQuery,setPhaseQuery]=useState('')
 const {t}=useLocale()

 const [loadAttempt,setLoadAttempt]=useState(0),[checkResult,setCheckResult]=useState<CheckResult|null>(null)
 const [machines,setMachines]=useState<SavedMachine[]>([]),[definitions,setDefinitions]=useState<Json[]>([]),[rosTasks,setRosTasks]=useState<RosTask[]>([])
 const [current,setCurrent]=useState<SavedMachine|null>(null),[snapshot,setSnapshot]=useState<MachineSnapshot>(()=>blankMachine(t)),snapshotRef=useRef(snapshot)
 const [draftId,setDraftId]=useState(newMachineId),[robotKey,setRobotKey]=useState(''),[reveal,setReveal]=useState<{id:string;nonce:number}>()
 const [savedFingerprint,setSavedFingerprint]=useState(()=>fingerprint(blankMachine(t))),[loaded,setLoaded]=useState(false)
 const [selected,setSelected]=useState('workflow'),[edgeIndex,setEdgeIndex]=useState<number|null>(null),[scope,setScope]=useState('workflow')
 const [outlineOpen,setOutlineOpen]=useState(true),[inspectorOpen,setInspectorOpen]=useState(false)
 const [collapsed,setCollapsed]=useState<Set<string>>(new Set()),[filter,setFilter]=useState(''),[dragOver,setDragOver]=useState('')
 const [bottom,setBottom]=useState<'runtime'|'variables'|'diagnostics'|null>(null),[session,setSession]=useState<Json|null>(null),[statusConnected,setStatusConnected]=useState(true)
 const [notice,setNotice]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState<'save'|'run'|'delete'|'copy'|'check'|null>(null),busyRef=useRef(false)
 const [variableName,setVariableName]=useState(''),[variableType,setVariableType]=useState('boolean'),[addMenu,setAddMenu]=useState(false),[phaseMenu,setPhaseMenu]=useState<Phase|null>(null)
 const [invalidFields,setInvalidFields]=useState<Record<string,boolean>>({})
 const [saveFailedAt,setSaveFailedAt]=useState(''),[historyCount,setHistoryCount]=useState({past:0,future:0})
 const history=useRef<{past:MachineSnapshot[];future:MachineSnapshot[];key:string;at:number}>({past:[],future:[],key:'',at:0})
 const editor=useRef<HTMLDivElement>(null),nameInput=useRef<HTMLInputElement>(null),alive=useRef(true),epoch=useRef(0)
 const {document,layout,title}=snapshot,currentFingerprint=fingerprint(snapshot),dirty=currentFingerprint!==savedFingerprint
 const checkKey=(current?.id||draftId)+'|'+currentFingerprint+'|'+JSON.stringify([rosTasks,definitions])
 const state=document.states.find(s=>s.id===selected),transition=edgeIndex===null?undefined:document.transitions[edgeIndex]
 const currentRunning=activeStatus(session?.status)&&session?.machine_id===current?.id
 const children=(id:string)=>document.states.filter(s=>s.parent===id)
 const references=useMemo(()=>new Set([...rosTasks.map(task=>'ros:'+task.id),...definitions.map(item=>String(item.id))]),[rosTasks,definitions])
 const diagnostics=useMemo<Diagnostic[]>(()=>[...diagnoseMachine(snapshot,references,t),...Object.keys(invalidFields).filter(key=>invalidFields[key]&&(key.startsWith('variable:')?key.slice(9) in document.variables:key==='guard:'+edgeIndex)).map(key=>({message:key.startsWith('variable:')?t("变量 {0} 的格式需要修正", {0: key.slice(9)}):t("转换条件值的格式需要修正")}))],[snapshot,references,invalidFields,edgeIndex])
 const fieldValidity=(key:string,valid:boolean)=>setInvalidFields(previous=>Boolean(previous[key])===!valid?previous:{...previous,[key]:!valid})
 const taskLabels=useMemo(()=>Object.fromEntries([...rosTasks.map(task=>['ros:'+task.id,task.name]),...definitions.map(item=>[item.id,item.name||item.layout?.labels?.[item.document?.trees?.[item.document?.main_tree_id]?.root_id]||item.document?.main_tree_id||t("行为树")])]),[rosTasks,definitions])
 const setEditor=useCallback((next:MachineSnapshot)=>{snapshotRef.current=next;setSnapshot(next)},[])
 const resetHistory=()=>{history.current={past:[],future:[],key:'',at:0};setHistoryCount({past:0,future:0});setInvalidFields({})}
 const edit=useCallback((transform:(draft:MachineSnapshot)=>void,key='')=>{
  const before=snapshotRef.current,next=structuredClone(before);transform(next)
  if(fingerprint(before)===fingerprint(next))return
  const h=history.current,now=Date.now()
  if(!key||h.key!==key||now-h.at>650){h.past=[...h.past.slice(-79),before]}
  h.future=[];h.key=key;h.at=now;setHistoryCount({past:h.past.length,future:0});setEditor(next);setNotice('');setSaveFailedAt('')
 },[setEditor])
 const selectState=(id:string,locate=false)=>{setSelected(id);setEdgeIndex(null);setPhaseMenu(null);if(locate){const item=document.states.find(s=>s.id===id);if(item){setScope(item.parent||document.initial);setReveal(previous=>({id,nonce:(previous?.nonce||0)+1}))}}}
 const selectEdge=(index:number)=>{setEdgeIndex(index);setPhaseMenu(null);setInspectorOpen(true)}
 const openScope=(id:string)=>{setScope(id);setSelected(id);setEdgeIndex(null);setPhaseMenu(null)}
 const undo=useCallback((redo=false)=>{
  const h=history.current,source=redo?h.future:h.past;if(!source.length)return
  const next=source.pop()!;if(redo)h.past.push(snapshotRef.current);else h.future.push(snapshotRef.current)
  h.key='';setEditor(next);setEdgeIndex(null);setNotice('');setSaveFailedAt('');setHistoryCount({past:h.past.length,future:h.future.length})
 },[setEditor])
 function changeState(id:string,updates:Partial<MachineState>){edit(draft=>{draft.document.states=draft.document.states.map(s=>s.id===id?{...s,...updates}:s)},'state:'+id+':'+Object.keys(updates).join(','))}
 function changeTransition(updates:Partial<Transition>){if(edgeIndex===null)return;edit(draft=>{draft.document.transitions[edgeIndex]={...draft.document.transitions[edgeIndex],...updates}},'edge:'+edgeIndex+':'+Object.keys(updates).join(','))}
 function moveBranch(index:number,direction:-1|1){
  const edge=document.transitions[index],branches=eventBranches(document,edge).filter(item=>!isFallback(item.edge)),position=branches.findIndex(item=>item.index===index),other=branches[position+direction]
  if(!other)return
  edit(draft=>{[draft.document.transitions[index],draft.document.transitions[other.index]]=[draft.document.transitions[other.index],draft.document.transitions[index]]});setEdgeIndex(other.index)
 }
 function addBranch(){
  if(!transition||document.transitions.length>=160)return
  const next=document.transitions.length
  edit(draft=>{draft.document.transitions.push({...structuredClone(transition),guard:{operator:'equals',key:'',value:''}})})
  setEdgeIndex(next)
 }
 function freezePositions(draft:MachineSnapshot){draft.layout.positions={...automaticHsmLayout(draft.document.states,draft.layout.positions).positions,...draft.layout.positions}}
 function removeSelection(stateId=selected,transitionIndex=edgeIndex){
  if(transitionIndex!==null){edit(draft=>{draft.document.transitions.splice(transitionIndex,1)});setEdgeIndex(null);return}
  const checkKey=(current?.id||draftId)+'|'+currentFingerprint+'|'+JSON.stringify([rosTasks,definitions])
 const state=document.states.find(item=>item.id===stateId)
  if(!state||state.id===document.initial)return
  const doomed=descendants(document,state.id),parent=state.parent||document.initial
  edit(draft=>{freezePositions(draft);draft.document=normalizeInitials({...draft.document,states:draft.document.states.filter(s=>!doomed.has(s.id)),transitions:draft.document.transitions.filter(t=>!doomed.has(t.source)&&!doomed.has(t.target))});draft.layout.positions=Object.fromEntries(Object.entries(draft.layout.positions).filter(([id])=>!doomed.has(id)))})
  setSelected(parent);if(doomed.has(scope))setScope(parent)
 }
 function addState(parent=scope,x?:number,y?:number){
  if(document.states.length>=48){setNotice(t("最多可添加 48 个状态"));return}
  const id='state_'+crypto.randomUUID().slice(0,8)
  edit(draft=>{freezePositions(draft);draft.document.states.push({id,label:t("新状态"),parent});draft.document=normalizeInitials(draft.document);if(x!==undefined&&y!==undefined)draft.layout.positions[id]=[x,y];else draft.layout.positions[id]=automaticHsmLayout(draft.document.states,draft.layout.positions).positions[id]||[36,64]})
  setSelected(id);setEdgeIndex(null);setInspectorOpen(true);setAddMenu(false);setCollapsed(previous=>{const next=new Set(previous);next.delete(parent);return next});requestAnimationFrame(()=>{nameInput.current?.focus();nameInput.current?.select()})
 }
 function connect(source:string,target:string){
  if(document.transitions.length>=160){setNotice(t("最多可添加 160 条转换"));return}
  let event='completed',suffix=1
  while(document.transitions.some(edge=>edge.source===source&&edge.event===event))event='event_'+suffix++
  const index=document.transitions.length
  edit(draft=>{draft.document.transitions.push({source,target,event,guard:{operator:'always'}})})
  setSelected(source);setEdgeIndex(index);setInspectorOpen(true)
 }
 function reparent(child:string,parent:string){
  if(!canReparent(document,child,parent)){setNotice(t("无法移动到自身或下级状态"));return}
  edit(draft=>{freezePositions(draft);draft.document=normalizeInitials({...draft.document,states:draft.document.states.map(s=>s.id===child?{...s,parent}:s)});delete draft.layout.positions[child]})
  setScope(parent);setSelected(child);setEdgeIndex(null)
 }
 function dropState(event:DragEvent,parent:string){event.preventDefault();event.stopPropagation();setDragOver('');const child=event.dataTransfer.getData('application/x-hsm-state');if(child)reparent(child,parent)}
 function bindPhase(stateId:string,phase:Phase,reference:string){changeState(stateId,{[phase]:reference||undefined});setPhaseMenu(null);setPhaseQuery('')}
 function openTask(phase:Phase,kind?:'ros'|'tree',stateId=selected){
  const item=document.states.find(s=>s.id===stateId);if(!item)return
  const reference=item[phase];setSelected(stateId);setEdgeIndex(null);setPhaseMenu(null)
  if(onOpenTask){onOpenTask({kind:kind||(reference?.startsWith('ros:')?'ros':'tree'),reference:kind?undefined:reference,stateId:item.id,stateLabel:item.label,phase,machineId:current?.id||draftId})}
  else if(kind==='ros'||reference?.startsWith('ros:'))onOpenRos()
  else{setInspectorOpen(true);setPhaseMenu(phase)}
 }
 async function loadMachine(machine:SavedMachine,restore=true){
  if(dirty&&loaded&&!await unsavedDialog(title,()=>save()))return false
  if(dirty&&loaded){try{localStorage.removeItem(current?'agro.hsm.draft.'+current.id:'agro.hsm.unsaved.'+robotKey)}catch{}}
  let next=snapshotOf(machine);const base=fingerprint(next);let recovered=false
  if(restore){try{const cached=JSON.parse(localStorage.getItem('agro.hsm.draft.'+machine.id)||'null');if(cached?.base===base&&cached?.snapshot){next=cached.snapshot;recovered=true}}catch{}}
  setCurrent(machine);setEditor(next);setSavedFingerprint(base);setSelected(next.document.states.find(s=>s.parent)?.id||next.document.initial);setScope(next.document.initial);setEdgeIndex(null);setError('');setSaveFailedAt('');setNotice(recovered?t("已恢复本地未保存草稿"):'');resetHistory()
  return true
 }
 async function create(){
  if(dirty&&!await unsavedDialog(title,()=>save()))return
  const name=await nameDialog(t('新建状态机'),t('未命名状态机'),'创建状态机');if(!name?.trim())return
  if(dirty){try{localStorage.removeItem(current?'agro.hsm.draft.'+current.id:'agro.hsm.unsaved.'+robotKey)}catch{}}
  setDraftId(newMachineId())
  const next={...blankMachine(t),title:name.trim()};setCurrent(null);setEditor(next);setSavedFingerprint('');setSelected(next.document.initial);setScope('workflow');setEdgeIndex(null);setError('');setNotice(t('状态机已创建，尚未保存'));setSaveFailedAt('');resetHistory()
 }
 async function refreshCatalog(){
  const [machineData,treeData,taskData]=await Promise.all([client.request<Json>('/state-machines'),client.request<Json>('/trees/behaviors'),client.request<Json>('/ros/tasks')])
  if(!alive.current)return
  setMachines(machineData.machines||[]);setDefinitions(treeData.definitions||[]);setRosTasks(taskData.tasks||[])
 }
 async function save(manual=true){
  if(busyRef.current)return false
  if(Object.entries(invalidFields).some(([key,value])=>value&&(key.startsWith('variable:')?key.slice(9) in document.variables:key==='guard:'+edgeIndex))){if(manual){setBottom('diagnostics');setNotice(t("字段格式尚未完成，已保留本地草稿"))}return false}
  const submitted=structuredClone(snapshotRef.current),submittedFingerprint=fingerprint(submitted),generation=epoch.current
  busyRef.current=true;setBusy('save');setError('')
  try{
   const saved=await client.request<SavedMachine>('/state-machines','POST',{id:current?.id||draftId,name:submitted.title,document:submitted.document,layout:submitted.layout})
   if(!alive.current||generation!==epoch.current)return false
   setCurrent(saved);setMachines(previous=>[...previous.filter(item=>item.id!==saved.id),saved]);setSavedFingerprint(submittedFingerprint);setSaveFailedAt('');setNotice(manual?t("已保存"):'')
   try{localStorage.removeItem('agro.hsm.draft.'+saved.id);localStorage.removeItem('agro.hsm.unsaved.'+robotKey)}catch{}
   return true
  }catch(cause){if(alive.current&&generation===epoch.current){setError(errorMessage(cause,t));setSaveFailedAt(submittedFingerprint)}return false}
  finally{busyRef.current=false;if(alive.current)setBusy(null)}
 }
 async function execute(action:'start'|'stop'){
  if(busyRef.current)return
  if(action==='start'&&(!current||dirty)){setNotice(t('先保存状态机，再运行'));return}
  busyRef.current=true;setBusy('run');setError('');setBottom('runtime')
  try{
   let body:Json={mode:'auto'}
   if(action==='start'){
    const systems=await client.request<Json>('/robot-systems'),robot=systems.systems?.find((item:Json)=>item.id===systems.selected_id)
    if(robot&&!robot.configured){if(!await confirmDialog(t('此操作会向机器人发送真实命令，请确认设备急停和通信失联保护可用'),'启动运行'))return;body={mode:'auto',confirm_safety:true}}
   }
   await client.request(action==='start'?`/state-machines/${current!.id}/start`:'/state-machines/stop','POST',body)
   const status=await client.request<Json>('/state-machines/status');setSession(status.session);setNotice(action==='start'?t("启动请求已提交"):t("取消请求已提交，正在等待停止确认"))
  }catch(cause){setError(errorMessage(cause,t))}finally{busyRef.current=false;setBusy(null)}
 }
 async function check(){
  if(busyRef.current)return
  const key=checkKey,generation=epoch.current
  setBottom('diagnostics');setError('');setCheckResult({key,status:'checking',message:t('正在校验离线配置'),issues:[]})
  if(diagnostics.length){setCheckResult({key,status:'failed',message:t('运行前需补充配置'),issues:[]});setNotice(t('运行前需补充配置'));return}
  if((dirty||!current)&&!await save(false)){setCheckResult({key,status:'failed',message:t('状态机未能保存，校验尚未完成'),issues:[]});return}
  if(!alive.current||generation!==epoch.current)return
  busyRef.current=true;setBusy('check')
  try{
   const result=await client.request<Json>(`/state-machines/${current?.id||draftId}/check`,'POST',{})
   if(!alive.current||generation!==epoch.current)return
   const issues:CheckIssue[]=(result.diagnostics||[]).map((item:Json)=>({message:item.message||item.reason,taskId:item.task_id,path:item.path,stateId:item.state_id,phase:item.phase}))
   setCheckResult({key,status:result.valid?'passed':'failed',message:t(result.message||'运行前需补充配置'),issues});setNotice(t(result.message||'运行前需补充配置'))
  }catch(cause){
   if(!alive.current||generation!==epoch.current)return
   const message=errorMessage(cause,t)
   const issues:CheckIssue[]=cause instanceof ApiError?cause.details.map(item=>{
    const parts=item.path?.match(/\.states\.([^.]+)(?:\.(entry|do|exit))?/),edge=item.path?.match(/\.transitions\.(\d+)/)
    return {message:t(item.reason),path:item.path,stateId:parts?.[1],edgeIndex:edge?Number(edge[1]):undefined}
   }):[]
   setError(message);setCheckResult({key,status:'failed',message,issues})
  }finally{busyRef.current=false;if(alive.current)setBusy(null)}
 }
 function locateIssue(issue:CheckIssue){
  if(issue.stateId)selectState(issue.stateId,true)
  if(issue.edgeIndex!==undefined)selectEdge(issue.edgeIndex)
  if(issue.stateId&&issue.phase){openTask(issue.phase,undefined,issue.stateId);setInspectorOpen(true);return}
  if(issue.taskId){
   const owner=document.states.find(item=>(['entry','do','exit'] as Phase[]).some(phase=>item[phase]==='ros:'+issue.taskId))
   const phase=owner&&(['entry','do','exit'] as Phase[]).find(phase=>owner[phase]==='ros:'+issue.taskId)
   if(owner&&phase){selectState(owner.id,true);openTask(phase,undefined,owner.id)}else onOpenRos()
  }
  setInspectorOpen(true)
 }

 async function fire(event:string){
  if(busyRef.current)return;busyRef.current=true;setBusy('run');setError('')
  try{await client.request('/state-machines/event','POST',{event,variables:{}});const status=await client.request<Json>('/state-machines/status');setSession(status.session);setNotice(t("已提交事件 ")+event)}catch(cause){setError(errorMessage(cause,t))}finally{busyRef.current=false;setBusy(null)}
 }
 async function deleteMachine(){
  if(!current||busyRef.current||!await confirmDialog(t('删除状态机「{0}」及其保存定义',{0:title}),'删除状态机',true))return
  busyRef.current=true;setBusy('delete');setError('')
  try{await client.request(`/state-machines/${current.id}`,'DELETE');setMachines(previous=>previous.filter(item=>item.id!==current.id));const next=blankMachine(t);setCurrent(null);setEditor(next);setSavedFingerprint('');setSelected(next.document.initial);setScope('workflow');setEdgeIndex(null);setNotice(t("定义已删除"));setDraftId(newMachineId());resetHistory()}catch(cause){setError(errorMessage(cause,t))}finally{busyRef.current=false;setBusy(null)}
 }
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 useEffect(()=>{
  let valid=true;const generation=++epoch.current;setLoaded(false)
  Promise.all([client.request<Json>('/state-machines'),client.request<Json>('/trees/behaviors'),client.request<Json>('/ros/tasks'),client.request<Json>('/robot-systems')]).then(([machineData,treeData,taskData,robots])=>{
   if(!valid||generation!==epoch.current)return
   setMachines(machineData.machines||[]);setDefinitions(treeData.definitions||[]);setRosTasks(taskData.tasks||[])
   const owner=String(robots.selected_id||'');setRobotKey(owner)
   let location:{machineId?:string;selected?:string;scope?:string;inspector?:boolean;outline?:boolean}|null=null
   try{location=JSON.parse(sessionStorage.getItem('atil.hsm.location.'+owner)||'null')}catch{}
   let unsaved:{id:string;snapshot:MachineSnapshot}|null=null
   try{const cached=JSON.parse(localStorage.getItem('agro.hsm.unsaved.'+owner)||'null');if(cached?.id&&cached?.snapshot?.document?.states?.length&&!machineData.machines?.some((item:SavedMachine)=>item.id===cached.id))unsaved=cached}catch{}
   const available=machineData.machines as SavedMachine[]
   const latest=available?.find(item=>item.id===location?.machineId)||available?.at(-1)
   if(unsaved){setCurrent(null);setDraftId(unsaved.id);setEditor(unsaved.snapshot);setSavedFingerprint('');setSelected(unsaved.snapshot.document.initial);setScope(unsaved.snapshot.document.initial);setNotice(t('已恢复 {0} 的未保存修改',{0:unsaved.snapshot.title}))}
   else if(latest){let next=snapshotOf(latest);const base=fingerprint(next);try{const cached=JSON.parse(localStorage.getItem('agro.hsm.draft.'+latest.id)||'null');if(cached?.base===base&&cached?.snapshot){next=cached.snapshot;setNotice(t('已恢复 {0} 的未保存修改',{0:next.title}))}}catch{}setCurrent(latest);setEditor(next);setSavedFingerprint(base);setSelected(next.document.states.find(s=>s.parent)?.id||next.document.initial);setScope(next.document.initial)}
   else{const next=blankMachine(t);setCurrent(null);setEditor(next);setSavedFingerprint('');setSelected(next.document.initial);setScope(next.document.initial)}
   const recovered=unsaved?.snapshot.document||latest?.document,recoveredId=unsaved?.id||latest?.id
   if(recovered&&location&&location.machineId===recoveredId){
    if(recovered.states.some(item=>item.id===location?.selected)){setSelected(location.selected!);setReveal(previous=>({id:location!.selected!,nonce:(previous?.nonce||0)+1}))}
    if(recovered.states.some(item=>item.id===location?.scope))setScope(location.scope!)
    if(typeof location.inspector==='boolean')setInspectorOpen(location.inspector)
    if(typeof location.outline==='boolean')setOutlineOpen(location.outline)
   }
   resetHistory();setLoaded(true);setError('')
  }).catch(cause=>{if(valid)setError(errorMessage(cause,t))})
  return()=>{valid=false}
 },[client,loadAttempt,setEditor])
 useEffect(()=>{
  let valid=true,timer=0
  const refresh=async()=>{try{const result=await client.request<Json>('/state-machines/status');if(valid){setSession(result.session);setStatusConnected(true)}}catch{if(valid)setStatusConnected(false)}finally{if(valid)timer=window.setTimeout(refresh,1200)}}
  void refresh();return()=>{valid=false;clearTimeout(timer)}
 },[client])
 useEffect(()=>{
  const refresh=()=>{void refreshCatalog().catch(cause=>setError(errorMessage(cause,t)))}
  const bind=(event:Event)=>{const detail=(event as CustomEvent<{stateId:string;phase:Phase;reference:string;machineId?:string}>).detail;if(!detail||!['entry','do','exit'].includes(detail.phase)||!snapshotRef.current.document.states.some(s=>s.id===detail.stateId)||detail.machineId&&detail.machineId!==(current?.id||draftId))return;edit(draft=>{draft.document.states=draft.document.states.map(s=>s.id===detail.stateId?{...s,[detail.phase]:detail.reference}:s)});setSelected(detail.stateId);setEdgeIndex(null);setNotice(t("已关联状态行为"));refresh()}
  window.addEventListener('agro:hsm:refresh',refresh);window.addEventListener('agro:ros:refresh',refresh);window.addEventListener('agro:studio:bind',bind)
  return()=>{window.removeEventListener('agro:hsm:refresh',refresh);window.removeEventListener('agro:ros:refresh',refresh);window.removeEventListener('agro:studio:bind',bind)}
 },[client,current?.id,draftId,edit])
 useEffect(()=>{
  if(!loaded||!robotKey)return
  const key=current?'agro.hsm.draft.'+current.id:'agro.hsm.unsaved.'+robotKey
  try{if(dirty)localStorage.setItem(key,JSON.stringify({id:current?.id||draftId,base:savedFingerprint,snapshot}));else localStorage.removeItem(key)}catch{}
 },[current?.id,draftId,robotKey,currentFingerprint,savedFingerprint,dirty,loaded])
 useEffect(()=>{
  if(!loaded||!robotKey)return
  try{sessionStorage.setItem('atil.hsm.location.'+robotKey,JSON.stringify({machineId:current?.id||draftId,selected,scope,inspector:inspectorOpen,outline:outlineOpen}))}catch{}
 },[loaded,robotKey,current?.id,draftId,selected,scope,inspectorOpen,outlineOpen])
 useEffect(()=>{
  if(!loaded||!current||!dirty||Object.entries(invalidFields).some(([key,value])=>value&&(key.startsWith('variable:')?key.slice(9) in document.variables:key==='guard:'+edgeIndex))||saveFailedAt===currentFingerprint||busy)return
  const timer=window.setTimeout(()=>{void save(false)},1100);return()=>clearTimeout(timer)
 },[loaded,current?.id,currentFingerprint,dirty,currentRunning,diagnostics.length,saveFailedAt,busy])
 useEffect(()=>{const beforeUnload=(event:BeforeUnloadEvent)=>{if(dirty){event.preventDefault();event.returnValue=''}};const navigate=(event:Event)=>{if(dirty)deferNavigation(event,()=>unsavedDialog(title,()=>save(),()=>{const restored=current?snapshotOf(current):blankMachine(t);setEditor(restored);setSavedFingerprint(fingerprint(restored));try{localStorage.removeItem(current?'agro.hsm.draft.'+current.id:'agro.hsm.unsaved.'+robotKey)}catch{}}))};window.addEventListener('beforeunload',beforeUnload);window.addEventListener('agro:navigate',navigate);return()=>{window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('agro:navigate',navigate)}},[dirty,currentFingerprint,title])
 useEffect(()=>{
  if(!document.states.some(s=>s.id===selected)){setSelected(document.initial);setEdgeIndex(null)}
  if(!document.states.some(s=>s.id===scope))setScope(document.initial)
  if(edgeIndex!==null&&!document.transitions[edgeIndex])setEdgeIndex(null)
 },[document,scope,selected,edgeIndex])
 useEffect(()=>{
  const keydown=(event:KeyboardEvent)=>{
   if(!editor.current||!editor.current.getClientRects().length)return
   if(event.defaultPrevented)return
   const target=event.target as HTMLElement,input=target.closest('input,textarea,select,[contenteditable="true"]')
   if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();void save();return}
   if(input)return
   if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){event.preventDefault();undo(event.shiftKey);return}
   if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='y'){event.preventDefault();undo(true);return}
   if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();removeSelection()}
   if(event.key==='Escape'){setAddMenu(false);setPhaseMenu(null);setEdgeIndex(null)}
   if(event.key==='F2'){setInspectorOpen(true);requestAnimationFrame(()=>{nameInput.current?.focus();nameInput.current?.select()})}
  };window.addEventListener('keydown',keydown);return()=>window.removeEventListener('keydown',keydown)
 })
 useEffect(()=>{
  if(!machines.length)return
  const raw=sessionStorage.getItem('atil.flow.reveal');if(!raw)return
  void (async()=>{try{const target=JSON.parse(raw),machine=machines.find(item=>item.id===target.machineId);if(!machine)return;sessionStorage.removeItem('atil.flow.reveal');if(!await loadMachine(machine))return;const state=machine.document.states.find(item=>item.id===target.stateId);if(state){setSelected(state.id);setScope(state.parent||machine.document.initial);setReveal(previous=>({id:state.id,nonce:(previous?.nonce||0)+1}))}setInspectorOpen(true)}catch{sessionStorage.removeItem('atil.flow.reveal')}})()
 },[machines.length])
 const ancestors:MachineState[]=[];let cursor=document.states.find(s=>s.id===scope);while(cursor&&ancestors.length<49){ancestors.unshift(cursor);cursor=document.states.find(s=>s.id===cursor?.parent)}
 const selectedPath=statePath(document,selected)
 const stateTransitions=document.transitions.map((edge,index)=>({edge,index})).filter(({edge})=>selectedPath.includes(edge.source)).sort((left,right)=>selectedPath.indexOf(right.edge.source)-selectedPath.indexOf(left.edge.source))
 const preview=transition?transitionPlan(document,transition,historyEvent?(historyEvent.retained&&historyEvent.entered?[...historyEvent.retained,...historyEvent.entered]:statePath(document,historyEvent.target)):session?.machine_id===current?.id?session?.path:undefined):null
 const branches=transition?eventBranches(document,transition):[]
 const branchOrder=transition&&<div className="wb-property-section wb-branches">
  <div className="wb-section-heading"><h3>{t('事件分支')}</h3><button className="wb-icon-button" aria-label={t('添加条件分支')} disabled={document.transitions.length>=160} onClick={addBranch}>{tinyIcon('plus')}</button></div>
  <p className="wb-subtle-text">{t('按顺序检查条件，其他情况最后处理；全部不满足时交给父状态')}</p>
  {branches.map(({edge,index},position)=><div className={'wb-branch-item'+(edgeIndex===index?' is-current':'')} key={index}><button onClick={()=>setEdgeIndex(index)}><span>{isFallback(edge)?t('其他情况'):t('条件 {0}',{0:position+1})}</span><small>{document.states.find(item=>item.id===edge.target)?.label}</small></button>{!isFallback(edge)&&<div><button aria-label={t('提高分支优先级')} disabled={position===0} onClick={()=>moveBranch(index,-1)}>↑</button><button aria-label={t('降低分支优先级')} disabled={!branches[position+1]||isFallback(branches[position+1].edge)} onClick={()=>moveBranch(index,1)}>↓</button></div>}</div>)}
 </div>
 const stateNames=(identities:string[])=>identities.map(identity=>document.states.find(item=>item.id===identity)?.label||identity).join(' → ')||t('无')
 const referenceUses=(reference:string)=>[...machines.filter(machine=>machine.id!==current?.id).map(machine=>machine.document),document].flatMap(item=>item.states).reduce((count,item)=>count+(['entry','do','exit'] as const).filter(phase=>item[phase]===reference).length,0)
 async function copyPhase(phase:Phase){
  const reference=state?.[phase]
  if(!reference||busyRef.current)return
  const owner=selected
  busyRef.current=true;setBusy('copy');setError('')
  try{
   const endpoint=reference.startsWith('ros:')?`/ros/tasks/${reference.slice(4)}/copy`:`/trees/behaviors/${reference}/copy`
   const copied=await client.request<Json>(endpoint,'POST',{name:(state!.label+' / '+t(phaseLabels[phase])).slice(0,80)})
   if(!alive.current)return
   await refreshCatalog()
   bindPhase(owner,phase,(reference.startsWith('ros:')?'ros:':'')+copied.id)
   setNotice(t('已创建独立副本，点击行为即可编辑'))
  }catch(cause){if(alive.current)setError(errorMessage(cause,t))}
  finally{busyRef.current=false;if(alive.current)setBusy(null)}
 }
 const runtime=session?.machine_id===current?.id?session:null
 useEffect(()=>setHistoryEvent(null),[current?.id,runtime?.id])
 const viewedPath=historyEvent?(historyEvent.retained&&historyEvent.entered?[...historyEvent.retained,...historyEvent.entered]:statePath(document,historyEvent.target||historyEvent.active)):runtime?.path||[]
 const historyPlan=historyEvent?.exited?{exited:historyEvent.exited,retained:historyEvent.retained,entered:historyEvent.entered}:null
 const lineage=(id:string,level=0):ReactNode=>{
  const item=document.states.find(s=>s.id===id);if(!item||level>48)return null
  const sub=children(id),matches=!filter||[...descendants(document,id)].some(key=>document.states.find(s=>s.id===key)?.label.toLowerCase().includes(filter.toLowerCase())),closed=collapsed.has(id)&&!filter
  if(!matches)return null
  return <div key={id} className="wb-outline-group"><div className={'wb-outline-row'+(selected===id&&edgeIndex===null?' is-current':'')+(dragOver===id?' is-drop-target':'')} style={{paddingLeft:8+level*14}} onDragOver={event=>{if(event.dataTransfer.types.includes('application/x-hsm-state')){event.preventDefault();event.stopPropagation()}}} onDragEnter={event=>{event.stopPropagation();if(event.dataTransfer.types.includes('application/x-hsm-state'))setDragOver(id)}} onDragLeave={()=>setDragOver('')} onDrop={event=>dropState(event,id)}>
   <button className={'wb-disclosure'+(closed?' is-closed':'')} aria-label={(closed?t("展开 "):t("折叠 "))+item.label} disabled={!sub.length} onClick={()=>setCollapsed(previous=>{const next=new Set(previous);next.has(id)?next.delete(id):next.add(id);return next})}>{tinyIcon('chevron')}</button>
   <button className="wb-outline-select" draggable={id!==document.initial} onDragStart={event=>{event.dataTransfer.setData('application/x-hsm-state',id);event.dataTransfer.effectAllowed='move'}} onClick={()=>selectState(id,true)} onDoubleClick={()=>openScope(id)} title={item.label}>{tinyIcon(sub.length?'branch':'state')}<span>{item.label}</span>{viewedPath.includes(id)&&<i className="wb-live-dot"/>}{document.states.find(s=>s.id===item.parent)?.initial===id&&<span className="wb-initial-badge" title={t("初始子状态")}>{t("初始")}</span>}</button>
  </div><AnimatePresence initial={false}>{!closed&&<motion.div initial={{height:0,opacity:0}} animate={{height:'auto',opacity:1}} exit={{height:0,opacity:0}} transition={{...springs.spatial,opacity:fade}} style={{overflow:'hidden'}}>{sub.map(child=>lineage(child.id,level+1))}</motion.div>}</AnimatePresence></div>
 }
 const behaviorPorts=(reference:string|undefined)=>{
  const ros=reference?.startsWith('ros:'),task=(ros?rosTasks.find(item=>'ros:'+item.id===reference):definitions.find(item=>item.id===reference)) as Json|undefined
  const tree=task?.document?.trees?.[task?.document?.main_tree_id]
  return {inputs:(ros?task?.inputs:task?.manifest?.parameters||task?.document?.inputs)||{},outputs:(ros?task?.outputs:Object.fromEntries(Object.entries(tree?.ports||{}).filter(([,port])=>(port as Json).direction==='OUTPUT').map(([name,port])=>[name,(port as Json).type])))||{}}
 }
 const phaseBindings=(phase:Phase)=>{
  if(!state?.[phase])return null
  const ports=behaviorPorts(state[phase])
  const sources=document.states.flatMap(source=>(['entry','do','exit'] as Phase[]).flatMap(sourcePhase=>source.id===selected&&sourcePhase===phase?[]:Object.entries(behaviorPorts(source[sourcePhase]).outputs).map(([port,contract])=>({state:source.id,phase:sourcePhase,port,contract:contract as DataContract,label:source.label+' · '+phaseLabels[sourcePhase]+' · '+port}))))
  const connect=(direction:'inputs'|'outputs',port:string,value:string)=>edit(draft=>{
   const item=draft.document.states.find(item=>item.id===selected)!;item.bindings??={};item.bindings[phase]??={};const mapping=item.bindings[phase]![direction]??={}
   if(!value){delete mapping[port];return}
   const source=value.startsWith('@source:')?sources[Number(value.slice(8))]:undefined
   if(source||value==='@new'){
    const base=((source?.port||port).replace(/[^a-z0-9_]/g,'_').replace(/^[^a-z]+/,'')||'data').slice(0,48)
    let variable=source?draft.document.states.find(item=>item.id===source.state)?.bindings?.[source.phase]?.outputs?.[source.port]:undefined
    if(!variable||!(variable in draft.document.variables)){variable=base;let n=2;while(variable in draft.document.variables)variable=base+'_'+n++;draft.document.variables[variable]=null}
    draft.document.variable_contracts??={};draft.document.variable_contracts[variable]=structuredClone(source?.contract||ports[direction][port])
    if(source){const producer=draft.document.states.find(item=>item.id===source.state)!;producer.bindings??={};producer.bindings[source.phase]??={};producer.bindings[source.phase]!.outputs??={};producer.bindings[source.phase]!.outputs![source.port]=variable}
    mapping[port]=variable
   }else mapping[port]=value
  })
  if(!Object.keys(ports.inputs).length&&!Object.keys(ports.outputs).length)return null
  return <details className="wb-phase-data" open><summary>{t("输入与输出")}</summary>{(['inputs','outputs'] as const).map(direction=>!!Object.keys(ports[direction]).length&&<div key={direction}><span className="wb-binding-direction">{t(direction==='inputs'?'输入':'输出')}</span>{Object.entries(ports[direction]).map(([port,raw])=>{
   const contract=raw as DataContract,binding=state.bindings?.[phase]?.[direction]?.[port]||''
   const existing=document.variable_contracts?.[binding],reason=existing?(direction==='inputs'?contractReason(existing,contract):contractReason(contract,existing)):''
   return <div className="wb-port-binding" key={port}><code>{port}</code><small>{contract.extensions?.ros_type||contract.type}{contract.unit&&contract.unit!=='unspecified'?' · '+contract.unit:''}</small><select aria-label={`${phaseLabels[phase]} ${direction} ${port}`} aria-invalid={!!reason} value={binding} onChange={event=>connect(direction,port,event.target.value)}><option value="">{port in document.variables?t('同名变量'):direction==='inputs'?t('任务默认值'):t('不写入变量')}</option>{direction==='outputs'&&<option value="@new">{t('新建输出变量')}</option>}{direction==='inputs'&&!!sources.length&&<optgroup label={t('任务输出')}>{sources.map((source,index)=>{const issue=contractReason(source.contract,contract);return <option key={index} value={'@source:'+index} disabled={!!issue}>{source.label}{issue?' · '+t(issue):''}</option>})}</optgroup>}<optgroup label={t('流程变量')}>{Object.keys(document.variables).map(name=>{const candidate=document.variable_contracts?.[name],issue=candidate?(direction==='inputs'?contractReason(candidate,contract):contractReason(contract,candidate)):'';return <option key={name} value={name} disabled={!!issue}>{name}{issue?' · '+t(issue):candidate?'':' · '+t('类型待确认')}</option>})}</optgroup></select>{reason&&<small className="ros-invalid">{t(reason)}</small>}{direction==='inputs'&&binding&&<small>{t('使用前需由来源任务提供数据')}</small>}</div>
  })}</div>)}<button className="wb-text-button" onClick={()=>setBottom('variables')}>{t("管理状态变量 ")}{tinyIcon('chevron')}</button></details>
 }
 const phaseDefinitions=(phase:Phase)=>definitions.filter(item=>item.id===state?.[phase]||!item.draft_id||!definitions.some(other=>other.id===item.draft_id))
 const phaseEditor=(phase:Phase)=>state&&<div className={'wb-phase'+(phase==='do'?' is-main':'')} key={phase}>
  <div className="wb-phase-heading"><span>{t(phaseLabels[phase])}</span></div>
  <div className="wb-phase-binding"><button className="wb-phase-choice" onClick={()=>state[phase]?openTask(phase):setPhaseMenu(phaseMenu===phase?null:phase)}>{state[phase]?taskLabels[state[phase]!]||t("原行为不可用"):t("添加行为")}</button><button className="wb-icon-button" aria-label={t("选择状态行为")} onClick={()=>{setPhaseMenu(phaseMenu===phase?null:phase);setPhaseQuery('')}}>{tinyIcon('plus')}</button></div>
  {state[phase]&&referenceUses(state[phase]!)>1&&<div className="wb-shared-behavior"><small>{t('被 {0} 处引用，直接编辑会同步影响这些位置',{0:referenceUses(state[phase]!)})}</small><button disabled={!!busy} onClick={()=>void copyPhase(phase)}>{t('复制为独立行为')}</button></div>}
  {phaseBindings(phase)}
  {phaseMenu===phase&&<div className="wb-behavior-picker" role="dialog" aria-label={t("选择状态行为")}>
   <input autoFocus type="search" value={phaseQuery} placeholder={t("搜索任务或行为树")} onChange={event=>setPhaseQuery(event.target.value)}/>
   <p className="wb-picker-context">{state.label} · {t(phaseLabels[phase])}</p>
   <div className="wb-behavior-options">{[
    {label:t('任务'),items:rosTasks.map(task=>({id:'ros:'+task.id,name:task.name,icon:task.icon,detail:task.ros_type||t('尚未选择接口类型')}))},
    {label:t('行为树'),items:phaseDefinitions(phase).map(item=>({id:item.id,name:taskLabels[item.id],icon:undefined,detail:t('组合与调度任务')}))}
   ].map(group=>{const choices=group.items.filter(item=>item.name?.toLowerCase().includes(phaseQuery.toLowerCase()));return <section className="wb-behavior-group" key={group.label}><h4>{group.label}<small>{choices.length}</small></h4>{choices.map(item=><button className="wb-behavior-card" key={item.id} aria-pressed={state[phase]===item.id} onClick={()=>bindPhase(selected,phase,item.id)}>{item.id.startsWith('ros:')?<TaskIcon value={item.icon}/>:tinyIcon('branch')}<span><strong>{item.name}</strong><small>{item.detail}</small></span>{state[phase]===item.id&&tinyIcon('check')}</button>)}{!choices.length&&<p>{t('没有匹配的条目')}</p>}</section>})}</div>
   <div className="wb-phase-create"><button onClick={()=>openTask(phase,'ros')}>{tinyIcon('plus')}{t("新建任务")}</button><button onClick={()=>openTask(phase,'tree')}>{tinyIcon('plus')}{t("新建行为树")}</button></div>
   {state[phase]&&<button className="wb-text-button" onClick={()=>bindPhase(selected,phase,'')}>{t("解除关联")}</button>}
  </div>}
 </div>
 const hasOutline=outlineOpen,hasInspector=inspectorOpen
 return <div ref={editor} className={'hsm-editor hsm-workbench'+(hasOutline?' has-outline':'')+(hasInspector?' has-inspector':'')} >
  <header className="wb-toolbar">
   <div className="wb-toolbar-group"><button className="wb-icon-button" title={t("显示状态目录")} aria-label={t("显示状态目录")} aria-pressed={hasOutline} onClick={()=>{setOutlineOpen(!outlineOpen)}}>{tinyIcon('outline')}</button><div className="wb-document-picker"><StudioSelect label={t('选择状态机')} value={current?.id||draftId} disabled={!!busy} options={[...(!current?[{value:draftId,label:title||t('未命名状态机'),hint:t('尚未保存')}]:[]),...machines.map(machine=>({value:machine.id,label:machine.id===current?.id?title||t('未命名状态机'):machine.name}))]} onChange={id=>{if(id===current?.id||id===draftId)return;const item=machines.find(machine=>machine.id===id);if(item)void loadMachine(item)}}/></div><button className="wb-icon-button" title={t("新建状态机")} aria-label={t("新建状态机")} disabled={!!busy} onClick={create}>{tinyIcon('plus')}</button></div>
   <div className="wb-toolbar-middle"><button title={t("撤销 ⌘Z / Ctrl+Z")} aria-label={t("撤销")} disabled={!historyCount.past} onClick={()=>undo()}>{tinyIcon('undo')}</button><button title={t("重做 ⇧⌘Z / Ctrl+Shift+Z")} aria-label={t("重做")} disabled={!historyCount.future} onClick={()=>undo(true)}>{tinyIcon('redo')}</button><span className="wb-toolbar-rule"/></div>
   <div className="wb-toolbar-group wb-toolbar-end"><span className={'wb-save-state'+(saveFailedAt?' is-error':'')} aria-live="polite">{busy==='save'?t("保存中"):saveFailedAt?t("尚未保存"):dirty?(currentRunning?t("草稿待保存"):t("有未保存修改")):current?t("已保存"):t('尚未保存')}</span><button className="wb-save-button" disabled={!!busy||!loaded||!dirty&&!!current} onClick={()=>void save()}>{t("保存")}</button><button className="wb-save-button" disabled={!!busy||!loaded} onClick={()=>void check()}>{t("校验")}</button><button className="wb-run-button" title={currentRunning?t("取消活动行为并等待停止确认，不执行状态退出任务"):undefined} aria-label={currentRunning?t("取消运行"):t("运行状态机")} disabled={!!busy||!loaded||(!currentRunning&&(!current||dirty||diagnostics.length>0||activeStatus(session?.status)))} onClick={()=>void execute(currentRunning?'stop':'start')}>{tinyIcon(currentRunning?'stop':'play')}<span>{currentRunning?t("取消运行"):t("运行")}</span></button><button className="wb-icon-button" title={t("显示检查器")} aria-label={t("显示检查器")} aria-pressed={inspectorOpen} onClick={()=>setInspectorOpen(!inspectorOpen)}>{tinyIcon('inspect')}</button></div>
  </header>
  <div className="wb-body">
   <AnimatePresence initial={false}>{hasOutline&&<SpatialPanel width="var(--state-outline-width)" className="wb-navigator" aria-label={t("状态目录")}><div className="wb-pane-title"><span>{t("状态目录")}</span><span>{document.states.filter(item=>item.parent).length}</span></div><div className="wb-project-name"><input aria-label={t("状态机名称")} value={title} maxLength={80} onChange={event=>edit(draft=>{draft.title=event.target.value},'title')}/></div><input className="wb-outline-search" type="search" aria-label={t("筛选状态")} placeholder={t("查找状态")} value={filter} onChange={event=>setFilter(event.target.value)}/><div className="wb-state-tree">{lineage(document.initial)}</div><div className="wb-outline-footer"><button onClick={()=>addState()}>{tinyIcon('plus')}{t("添加状态")}</button><button className="wb-icon-button" aria-label={t("更多工程操作")} onClick={()=>setAddMenu(!addMenu)}>•••</button>{addMenu&&<div className="wb-outline-menu"><button onClick={()=>{addState(selected);setAddMenu(false)}}>{t("在选中状态内添加")}</button><button onClick={()=>{setBottom('variables');setAddMenu(false)}}>{t("编辑状态变量")}</button><button className="wb-danger" disabled={!current||currentRunning||!!busy} onClick={()=>{setAddMenu(false);void deleteMachine()}}>{t("删除状态机")}</button></div>}</div></SpatialPanel>}</AnimatePresence>
   <main className={"wb-main"+(historyEvent?" is-history":"")}><div className="wb-document-bar"><nav aria-label={t("画布层级")} className="wb-breadcrumb">{ancestors.map((item,index)=><span key={item.id}>{index>0&&tinyIcon('chevron')}<button aria-current={index===ancestors.length-1?'location':undefined} onClick={()=>openScope(item.id)}>{item.label}</button></span>)}</nav><button className="wb-icon-button" title={t("添加状态")} aria-label={t("添加状态")} onClick={()=>addState()}>{tinyIcon('plus')}</button></div>
    {historyEvent&&<div className="wb-history-banner"><span>{t('正在查看历史转换')} · {historyEvent.event} · {stateNames([historyEvent.source,historyEvent.target].filter(Boolean))}</span><button onClick={()=>setHistoryEvent(null)}>{t('返回实时状态')}</button></div>}
    <HsmCanvas states={document.states} transitions={document.transitions} layout={layout} selected={selected} scope={scope} reveal={reveal} selectedTransition={edgeIndex} onSelect={id=>selectState(id)} onSelectTransition={selectEdge} onEnter={openScope} onReparent={reparent} onCreateIn={(parent,x,y)=>addState(parent,x,y)} onDelete={id=>removeSelection(id,null)} onDeleteTransition={index=>removeSelection(selected,index)} onMakeInitial={id=>{const child=document.states.find(item=>item.id===id);if(child?.parent)changeState(child.parent,{initial:id})}} onMove={(id,x,y)=>edit(draft=>{draft.layout.positions[id]=[x,y]})} onReset={()=>edit(draft=>{for(const item of draft.document.states.filter(s=>s.parent===scope))delete draft.layout.positions[item.id]})} onConnect={connect} onCreate={(x,y)=>addState(scope,x,y)} onRename={(id,label)=>changeState(id,{label})} onOpenPhase={(id,phase)=>{const item=document.states.find(s=>s.id===id);if(item?.[phase])openTask(phase,undefined,id);else{setSelected(id);setEdgeIndex(null);setInspectorOpen(true);setPhaseMenu(phase)}}} activePath={viewedPath} viewingHistory={!!historyEvent} transitionPreview={preview||historyPlan} taskLabels={taskLabels}/>
    <div className="wb-bottom-tabs" role="tablist" aria-label={t("运行与诊断")}>{(['runtime','variables','diagnostics'] as const).map(tab=><button key={tab} role="tab" aria-selected={bottom===tab} onClick={()=>setBottom(bottom===tab?null:tab)}>{tab==='runtime'?t("执行记录"):tab==='variables'?t("变量"):t("诊断")}{tab==='diagnostics'&&diagnostics.length>0&&<span className="wb-count">{diagnostics.length}</span>}</button>)}<span>{t('当前层 {0} · 全部状态 {1} · 转换 {2}',{0:children(scope).length,1:document.states.filter(item=>item.parent).length,2:document.transitions.length})}</span>{bottom&&<button className="wb-icon-button" aria-label={t("收起底部面板")} onClick={()=>setBottom(null)}>{tinyIcon('close')}</button>}</div>
    <AnimatePresence initial={false}>{bottom&&<motion.section initial={{height:0,paddingTop:0,paddingBottom:0,opacity:0}} animate={{height:188,paddingTop:12,paddingBottom:12,opacity:1}} exit={{height:0,paddingTop:0,paddingBottom:0,opacity:0}} transition={{...springs.spatial,opacity:fade}} className="wb-bottom-panel" aria-label={bottom==='runtime'?t("执行记录"):bottom==='variables'?t("状态变量"):t("诊断")}>
     {bottom==='runtime'&&<><div className="wb-runtime-heading"><span className={'wb-live-dot'+(currentRunning?'':' is-idle')}/><strong>{runtime?t(statusLabels[runtime.status]||runtime.status):t("尚未运行")}</strong><span>{runtime?.active?document.states.find(s=>s.id===runtime.active)?.label||runtime.active:t("保存并运行后在此查看状态转换")}</span><button onClick={()=>onNavigate('runtime')}>{t("运行观察 ")}{tinyIcon('chevron')}</button></div>{runtime?.pending_events>0&&<span className="wb-subtle-text">{t("队列中有 ")}{runtime?.pending_events} {t(" 个事件")}</span>}{runtime?.error&&<div className="wb-inline-error">{runtime.error}</div>}{currentRunning&&runtime?.attention?.map((item:Json)=><button className="wb-attention" key={item.instance_id||item.state_id} onClick={()=>{selectState(item.state_id,true);setInspectorOpen(true)}}><strong>{t("行为失败待处理")}</strong><span>{document.states.find(state=>state.id===item.state_id)?.label} · {item.reason}</span><small>{t("定位状态并检查失败转换")}</small></button>)}{runtime?.events?.length>0&&<div className="wb-event-log">{[...(runtime?.events||[])].reverse().slice(0,30).map((entry:Json,index)=><button key={index} aria-pressed={!!historyEvent&&JSON.stringify(historyEvent)===JSON.stringify(entry)} onClick={()=>{setHistoryEvent(entry);const id=entry.target||entry.to||entry.active;if(document.states.some(s=>s.id===id)){selectState(id);setScope(document.initial);setReveal(previous=>({id,nonce:(previous?.nonce||0)+1}))}}}><span>{entry.event||entry.type||t("状态转换")}</span><span>{entry.source?document.states.find(s=>s.id===entry.source)?.label||entry.source:''}{entry.target?' → '+(document.states.find(s=>s.id===entry.target)?.label||entry.target):''}</span><small>{entry.reason||entry.status||''}</small></button>)}</div>}{currentRunning&&<div className="wb-fire-events">{document.transitions.filter((edge,index,all)=>runtime?.path?.includes(edge.source)&&all.findIndex(item=>item.event===edge.event&&runtime?.path?.includes(item.source))===index).map(edge=><button key={edge.event} disabled={!!busy} onClick={()=>void fire(edge.event)}>{t("发送 ")}{edge.event}</button>)}</div>}{runtime?.behaviors?.length>0&&<div className="wb-behavior-status">{runtime?.behaviors.map((behavior:Json)=><details key={behavior.id}><summary><span>{document.states.find(item=>item.id===behavior.state_id)?.label||behavior.state_id} / {t(phaseLabels[behavior.phase as Phase])}</span><strong>{t(statusLabels[behavior.status]||behavior.status)}</strong></summary><button className="wb-behavior-link" onClick={()=>openTask(behavior.phase,undefined,behavior.state_id)}>{taskLabels[behavior.reference]||behavior.reference}{tinyIcon('chevron')}</button>{behavior.error&&<p className="wb-inline-error">{behavior.error}</p>}{behavior.feedback&&<pre className="wb-feedback">{JSON.stringify(behavior.feedback,null,2)}</pre>}</details>)}</div>}</>}
     {bottom==='variables'&&<><div className="wb-variable-list">{Object.entries(document.variables).map(([key,value])=><div className="wb-variable-row" key={key}><code>{key}</code><span>{value===null?t("空值"):Array.isArray(value)?t("数组"):typeof value==='object'?t("对象"):typeof value==='number'?t("数值"):typeof value==='boolean'?t("布尔"):t("文本")}</span><ScalarInput label={key+t(" 初始值")} onValidity={valid=>fieldValidity('variable:'+key,valid)} value={value} onChange={next=>edit(draft=>{draft.document.variables[key]=next},'variable:'+key)}/>{runtime?.variables&&<small title={t("运行值")}>{typeof runtime.variables[key]==='object'?JSON.stringify(runtime.variables[key]):String(runtime.variables[key]??'—')}</small>}<button className="wb-icon-button" aria-label={t("删除变量 ")+key} onClick={()=>edit(draft=>{delete draft.document.variables[key];if(draft.document.variable_contracts)delete draft.document.variable_contracts[key]})}>{tinyIcon('close')}</button></div>)}</div><form className="wb-variable-add" onSubmit={event=>{event.preventDefault();if(!isIdentifier(variableName)||variableName in document.variables){setNotice(t("变量标识需唯一，以小写字母开头，可包含数字和下划线"));return}if(Object.keys(document.variables).length>=64){setNotice(t("最多可声明 64 个变量"));return}edit(draft=>{draft.document.variables[variableName]=variableType==='boolean'?false:variableType==='number'?0:variableType==='null'?null:variableType==='object'?{}:variableType==='array'?[]:''});setVariableName('')}}><input aria-label={t("新变量标识")} placeholder={t("变量标识")} value={variableName} onChange={event=>setVariableName(event.target.value)}/><select aria-label={t("变量类型")} value={variableType} onChange={event=>setVariableType(event.target.value)}><option value="boolean">{t("布尔")}</option><option value="number">{t("数值")}</option><option value="string">{t("文本")}</option><option value="object">{t("对象")}</option><option value="array">{t("数组")}</option><option value="null">{t("空值")}</option></select><button type="submit">{t("添加变量")}</button></form></>}
     {bottom==='diagnostics'&&<div className="wb-check-result" aria-live="polite">
      <div className={'wb-check-summary '+(checkResult?.key===checkKey?checkResult.status:'stale')}><strong>{checkResult?(checkResult.key!==checkKey?t('配置已修改，需要重新校验'):checkResult.message):t('尚未执行完整校验')}</strong><small>{t('校验流程结构、行为引用、参数与通信配置，不连接设备执行')}</small></div>
      <div className="wb-diagnostics">{[...diagnostics,...(checkResult?.key===checkKey?checkResult.issues:[])].map((issue,index)=><button key={index} onClick={()=>locateIssue(issue)}><span>!</span><span>{t(issue.message)}</span>{tinyIcon('chevron')}</button>)}</div>
     </div>}

    </motion.section>}</AnimatePresence>
   </main>
   <AnimatePresence initial={false}>{hasInspector&&<SpatialPanel width="var(--state-inspector-width)" className="wb-inspector" aria-label={t("检查器")}><div className="wb-pane-title"><span>{transition?t("转换检查器"):t("检查器")}</span><button className="wb-icon-button" aria-label={t("关闭检查器")} onClick={()=>setInspectorOpen(false)}>{tinyIcon('close')}</button></div><div className="wb-inspector-scroll">
    {transition?<><div className="wb-inspector-intro"><span className="wb-inspector-symbol">{tinyIcon('branch')}</span><strong>{t("事件转换")}</strong><small>{document.states.find(s=>s.id===transition.source)?.label} → {document.states.find(s=>s.id===transition.target)?.label}</small></div><div className="wb-property-section"><Property label={t('触发来源')}><StudioSelect label={t('触发来源')} value={['completed','failed'].includes(transition.event)?transition.event:'custom'} options={[{value:'completed',label:t('状态期间行为完成'),hint:'completed'},{value:'failed',label:t('状态期间行为失败'),hint:'failed'},{value:'custom',label:t('自定义事件')}]} onChange={value=>changeTransition({event:value==='custom'?'custom_event':value})}/></Property>{!['completed','failed'].includes(transition.event)?<><Property label={t('事件标识')}><input aria-label={t('事件标识')} value={transition.event} maxLength={64} onChange={event=>changeTransition({event:event.target.value})}/></Property><p className="wb-subtle-text">{t('自定义事件需显式发送，error 不会自动代表行为失败')}</p></>:<p className="wb-subtle-text">{t('由状态期间行为自动产生，从行为所属状态向父级查找转换')}</p>}<Property label={t("来源状态")}><select value={transition.source} onChange={event=>changeTransition({source:event.target.value})}>{document.states.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></Property><Property label={t("目标状态")}><select value={transition.target} onChange={event=>changeTransition({target:event.target.value})}>{document.states.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></Property></div>{branchOrder}<div className="wb-property-section"><h3>{t("转换条件")}</h3><Property label={t("比较方式")}><select value={isFallback(transition)?'otherwise':transition.guard?.operator} onChange={event=>{const key=transition.guard?.key||Object.keys(document.variables)[0];changeTransition({guard:{operator:event.target.value,key,value:key?document.variables[key]:undefined}})}}><option value="otherwise">{branches.length>1?t("其他情况"):t("始终允许")}</option><option value="equals">{t("等于")}</option><option value="not_equals">{t("不等于")}</option><option value="greater">{t("大于")}</option><option value="less">{t("小于")}</option></select></Property>{transition.guard?.operator&&!isFallback(transition)&&<><Property label={t("状态变量")}><select value={transition.guard.key||''} onChange={event=>changeTransition({guard:{...transition.guard!,key:event.target.value,value:document.variables[event.target.value]}})}><option value="" disabled>{t("选择变量")}</option>{Object.keys(document.variables).map(key=><option value={key} key={key}>{key}</option>)}</select></Property><Property label={t("比较值")}><ScalarInput key={'guard:'+edgeIndex} label={t("条件比较值")} onValidity={valid=>fieldValidity('guard:'+edgeIndex,valid)} value={transition.guard.value!==undefined?transition.guard.value:transition.guard.key&&transition.guard.key in document.variables?document.variables[transition.guard.key]:''} onChange={value=>changeTransition({guard:{...transition.guard!,value}})}/></Property>{!Object.keys(document.variables).length&&<button className="wb-text-button" onClick={()=>setBottom('variables')}>{t("添加状态变量")}</button>}</>}</div>{preview&&<div className="wb-property-section wb-transition-preview"><h3>{t("转换预览")}</h3><small>{t("未运行时按来源状态的初始路径预览")}</small>{(['exited','retained','entered'] as const).map((phase,index)=><div key={phase}><strong>{t(['依次退出','保持活动','依次进入'][index])}</strong><span>{preview[phase].length?preview[phase].map(id=><button key={id} className="wb-path-state" onClick={()=>selectState(id,true)}>{document.states.find(item=>item.id===id)?.label||id}</button>):t('无')}</span></div>)}<p className="wb-subtle-text">{t('先取消离开状态的持续行为，依次执行退出与进入行为，再启动新状态的持续行为')}</p><p className="wb-subtle-text">{t('保持活动的父状态不重复进出，其持续行为继续运行')}</p>{transition.source===transition.target&&<small>{t("自身转换不重新进入状态")}</small>}</div>}<button className="wb-delete-selection" onClick={()=>removeSelection()}>{t("删除转换")}</button></>:state?<><div className="wb-inspector-intro"><span className="wb-inspector-symbol">{tinyIcon(children(selected).length?'branch':'state')}</span><input ref={nameInput} aria-label={t("状态名称")} value={state.label} maxLength={80} onChange={event=>changeState(selected,{label:event.target.value})}/><small>{selected===document.initial?t("根状态"):children(selected).length?t("复合状态"):t("状态")}</small></div>
     <div className="wb-property-section wb-state-behaviors"><h3>{t("状态行为")}</h3>{(['entry','do','exit'] as const).map(phaseEditor)}<p className="wb-subtle-text">{t('进入或退出行为失败会中止切换，不触发状态期间的失败事件')}</p></div>
     <div className="wb-property-section"><div className="wb-section-heading"><h3>{t("事件转换")}</h3><button className="wb-icon-button" aria-label={t("添加事件转换")} onClick={()=>connect(selected,document.states.find(s=>s.parent===state.parent&&s.id!==selected)?.id||selected)}>{tinyIcon('plus')}</button></div>{stateTransitions.length?<>{[false,true].map(inherited=>{const rows=stateTransitions.filter(({edge})=>(edge.source!==selected)===inherited);return rows.length>0&&<div className="wb-transition-group" key={String(inherited)}><h4>{t(inherited?'继承的转换':'当前状态的转换')}</h4>{rows.map(({edge,index})=>{const localFallback=inherited&&document.transitions.some(other=>other.event===edge.event&&isFallback(other)&&selectedPath.indexOf(other.source)>selectedPath.indexOf(edge.source));return <button className="wb-transition-row" key={index} onClick={()=>selectEdge(index)}><span>{edge.event==='completed'?t('行为完成'):edge.event==='failed'?t('行为失败'):edge.event||t('未命名事件')}</span><small>{inherited?t('继承自 {0}',{0:document.states.find(item=>item.id===edge.source)?.label})+' · ':''}{document.states.find(item=>item.id===edge.target)?.label}{inherited&&<em>{t(localFallback?'当前状态的同名事件由下级处理':'下级未匹配时处理')}</em>}</small>{tinyIcon('chevron')}</button>})}</div>})}<p className="wb-subtle-text">{t('事件从发生状态向上查找，父状态自身行为产生的事件不经过子状态')}</p></>:<p className="wb-subtle-text">{t('点击或拖动左右连接点创建转换')}</p>}</div>
     <div className="wb-property-section"><h3>{t("状态层级")}</h3>{state.parent&&<Property label={t("父状态")}><select value={state.parent} onChange={event=>reparent(selected,event.target.value)}>{document.states.filter(item=>canReparent(document,selected,item.id)).map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></Property>}{children(selected).length>0&&<><Property label={t("初始子状态")}><select value={state.initial||''} onChange={event=>changeState(selected,{initial:event.target.value})}>{children(selected).map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></Property><button className="wb-text-button" onClick={()=>openScope(selected)}>{t("进入子状态 ")}{tinyIcon('chevron')}</button></>}<button className="wb-text-button" onClick={()=>addState(selected)}>{t("添加子状态 ")}{tinyIcon('plus')}</button></div>
     <details className="wb-identity"><summary>{t("状态标识")}</summary><code>{state.id}</code></details>{state.id!==document.initial&&<button className="wb-delete-selection" onClick={()=>removeSelection()}>{t("删除状态")}{children(state.id).length?t("及子状态"):''}</button>}
    </>:<div className="wb-inspector-empty">{t("选择状态或转换以查看属性")}</div>}
   </div></SpatialPanel>}</AnimatePresence>
  </div>
  <footer className={'wb-statusbar'+(error?' has-error':'')}><span className={'wb-live-dot'+(statusConnected?'':' is-error')}/><span>{error||notice||(current?.needs_tree_rebinding?t("部分行为树需要重新关联"):statusConnected?currentRunning?runtime?.attention?.length?t("行为失败待处理"):t("机器人正在执行"):diagnostics.length?t("草稿已保留，运行前需补充配置"):t("就绪"):t("后台暂时无法连接"))}</span>{error&&<button onClick={()=>{setError('');setSaveFailedAt('');if(!loaded)setLoadAttempt(value=>value+1);else if(dirty)void save()}}>{t("重试")}</button>}<span className="wb-status-end">{dirty?currentRunning?t("修改下次执行生效"):t('有修改'):current?t("已保存"):t('尚未保存')}</span></footer>
 </div>
}
