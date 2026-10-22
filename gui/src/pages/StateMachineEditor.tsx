import {useCallback,useEffect,useMemo,useRef,useState,type DragEvent,type ReactNode} from 'react'
import HsmCanvas,{automaticHsmLayout} from './HsmCanvas'
import type {RosTask} from './RosTaskLibrary'
import {guideCompleted} from '../guide/courses'
import {ApiError} from '../api'
import type {Json,PageProps} from './shared'
import type {Workspace} from '../types'
import {activeStatus,blankMachine,canReparent,descendants,diagnoseMachine,fingerprint,isIdentifier,normalizeInitials,snapshotOf,type Diagnostic,type MachineSnapshot,type MachineState,type SavedMachine,type Scalar,type Transition} from './hsm-model'
import './hsm-workbench.css'

type Phase='entry'|'do'|'exit'
export type OpenStateTask={kind:'ros'|'tree';reference?:string;stateId:string;stateLabel:string;phase:Phase;machineId?:string}
type Props=PageProps & {onNavigate:(page:Workspace)=>void;onOpenRos:()=>void;onOpenTask?:(request:OpenStateTask)=>void}
const phaseLabels={entry:'Entry',do:'Do',exit:'Exit'}
const statusLabels:Record<string,string>={ENTERING:'进入状态',RUNNING:'运行中',TRANSITIONING:'切换状态',STOPPING:'正在停止',STOPPED:'已停止',SUCCEEDED:'已完成',FAILED:'执行失败',UNKNOWN:'状态待确认',CANCELED:'已取消'}
const errorMessage=(error:unknown)=>error instanceof ApiError?error.kind==='offline'?'无法连接后台，修改仍保留在当前草稿':error.kind==='unauthorized'?'后台连接已失效，请重新连接':error.details.map(detail=>detail.reason).join(' · '):error instanceof Error?error.message:'操作未完成，请重试'
const setting=(key:string,fallback:boolean)=>{try{return localStorage.getItem(key)==='true'||localStorage.getItem(key)===null&&fallback}catch{return fallback}}
const tinyIcon=(kind:'outline'|'inspect'|'undo'|'redo'|'play'|'stop'|'plus'|'chevron'|'close'|'state'|'branch'|'check'|'focus')=><svg viewBox="0 0 20 20" aria-hidden="true">{kind==='outline'?<><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M8 3 V17"/></>:kind==='inspect'?<><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M12 3 V17"/></>:kind==='undo'?<><path d="M7 5 L3 9 L7 13"/><path d="M3 9 H11 Q16 9 16 14"/></>:kind==='redo'?<><path d="M13 5 L17 9 L13 13"/><path d="M17 9 H9 Q4 9 4 14"/></>:kind==='play'?<path d="M6 4 L16 10 L6 16 Z"/>:kind==='stop'?<rect x="5" y="5" width="10" height="10" rx="2"/>:kind==='plus'?<path d="M10 4 V16 M4 10 H16"/>:kind==='chevron'?<path d="M8 5 L13 10 L8 15"/>:kind==='close'?<path d="M5 5 L15 15 M15 5 L5 15"/>:kind==='branch'?<><rect x="2" y="3" width="6" height="5" rx="1.5"/><rect x="12" y="12" width="6" height="5" rx="1.5"/><path d="M5 8 V14 H12"/></>:kind==='check'?<path d="M4 10 L8 14 L16 5"/>:kind==='focus'?<><path d="M3 7 V3 H7 M13 3 H17 V7 M17 13 V17 H13 M7 17 H3 V13"/></>:<rect x="4" y="4" width="12" height="12" rx="4"/>}</svg>

function Property({label,children}:{label:string;children:ReactNode}){return <label className="wb-property"><span>{label}</span>{children}</label>}
function ScalarInput({value,onChange,label,onValidity}:{value:Scalar;onChange:(value:Scalar)=>void;label:string;onValidity?:(valid:boolean)=>void}){
 const textValue=typeof value==='object'&&value!==null?JSON.stringify(value,null,2):String(value??'null')
 const [text,setText]=useState(textValue),[invalid,setInvalid]=useState(false)
 useEffect(()=>{setText(textValue);setInvalid(false);onValidity?.(true)},[textValue])
 if(typeof value==='boolean')return <select aria-label={label} value={String(value)} onChange={event=>onChange(event.target.value==='true')}><option value="false">false</option><option value="true">true</option></select>
 if(value===null)return <input aria-label={label} disabled value="null"/>
 if(typeof value==='object')return <div className="wb-json-field"><textarea aria-label={label} aria-invalid={invalid} rows={3} value={text} onChange={event=>{setText(event.target.value);try{const next=JSON.parse(event.target.value);if(next===null||typeof next!=='object')throw Error();setInvalid(false);onValidity?.(true);onChange(next)}catch{setInvalid(true);onValidity?.(false)}}}/>{invalid&&<small>需要有效的 JSON 对象或数组</small>}</div>
 return <input aria-label={label} type={typeof value==='number'?'number':'text'} step="any" value={typeof value==='number'?text:value} aria-invalid={invalid} onChange={event=>{if(typeof value==='number'){setText(event.target.value);if(event.target.value===''||!Number.isFinite(Number(event.target.value))){setInvalid(true);onValidity?.(false);return}setInvalid(false);onValidity?.(true);onChange(Number(event.target.value))}else onChange(event.target.value)}}/>
}

export default function StateMachineEditor({client,onNavigate,onOpenRos,onOpenTask}:Props){
 const [loadAttempt,setLoadAttempt]=useState(0)
 const [machines,setMachines]=useState<SavedMachine[]>([]),[definitions,setDefinitions]=useState<Json[]>([]),[rosTasks,setRosTasks]=useState<RosTask[]>([])
 const [current,setCurrent]=useState<SavedMachine|null>(null),[snapshot,setSnapshot]=useState<MachineSnapshot>(blankMachine),snapshotRef=useRef(snapshot)
 const [savedFingerprint,setSavedFingerprint]=useState(()=>fingerprint(blankMachine())),[loaded,setLoaded]=useState(false)
 const [selected,setSelected]=useState('idle'),[edgeIndex,setEdgeIndex]=useState<number|null>(null),[scope,setScope]=useState('workflow')
 const [focused,setFocused]=useState(()=>setting('agro.studio.focused',false)),[outlineOpen,setOutlineOpen]=useState(true),[inspectorOpen,setInspectorOpen]=useState(()=>!setting('agro.studio.focused',false))
 const [collapsed,setCollapsed]=useState<Set<string>>(new Set()),[filter,setFilter]=useState(''),[dragOver,setDragOver]=useState('')
 const [bottom,setBottom]=useState<'runtime'|'variables'|'diagnostics'|null>(null),[session,setSession]=useState<Json|null>(null),[statusConnected,setStatusConnected]=useState(true)
 const [notice,setNotice]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState<'save'|'run'|'delete'|null>(null),busyRef=useRef(false)
 const [variableName,setVariableName]=useState(''),[variableType,setVariableType]=useState('boolean'),[addMenu,setAddMenu]=useState(false),[phaseMenu,setPhaseMenu]=useState<Phase|null>(null)
 const [invalidFields,setInvalidFields]=useState<Record<string,boolean>>({})
 const [saveFailedAt,setSaveFailedAt]=useState(''),[historyCount,setHistoryCount]=useState({past:0,future:0})
 const history=useRef<{past:MachineSnapshot[];future:MachineSnapshot[];key:string;at:number}>({past:[],future:[],key:'',at:0})
 const editor=useRef<HTMLDivElement>(null),nameInput=useRef<HTMLInputElement>(null),alive=useRef(true),epoch=useRef(0)
 const {document,layout,title}=snapshot,currentFingerprint=fingerprint(snapshot),dirty=currentFingerprint!==savedFingerprint
 const state=document.states.find(s=>s.id===selected),transition=edgeIndex===null?undefined:document.transitions[edgeIndex]
 const currentRunning=activeStatus(session?.status)&&session?.machine_id===current?.id
 const children=(id:string)=>document.states.filter(s=>s.parent===id)
 const references=useMemo(()=>new Set([...rosTasks.map(task=>'ros:'+task.id),...definitions.map(item=>String(item.id))]),[rosTasks,definitions])
 const diagnostics=useMemo<Diagnostic[]>(()=>[...diagnoseMachine(snapshot,references),...Object.keys(invalidFields).filter(key=>invalidFields[key]&&(key.startsWith('variable:')?key.slice(9) in document.variables:key==='guard:'+edgeIndex)).map(key=>({message:key.startsWith('variable:')?`变量 ${key.slice(9)} 的格式需要修正`:'转换条件值的格式需要修正'}))],[snapshot,references,invalidFields,edgeIndex])
 const fieldValidity=(key:string,valid:boolean)=>setInvalidFields(previous=>Boolean(previous[key])===!valid?previous:{...previous,[key]:!valid})
 const taskLabels=useMemo(()=>Object.fromEntries([...rosTasks.map(task=>['ros:'+task.id,task.name]),...definitions.map(item=>[item.id,item.name||item.layout?.labels?.[item.document?.trees?.[item.document?.main_tree_id]?.root_id]||item.document?.main_tree_id||'行为树'])]),[rosTasks,definitions])
 const setEditor=useCallback((next:MachineSnapshot)=>{snapshotRef.current=next;setSnapshot(next)},[])
 const resetHistory=()=>{history.current={past:[],future:[],key:'',at:0};setHistoryCount({past:0,future:0});setInvalidFields({})}
 const edit=useCallback((transform:(draft:MachineSnapshot)=>void,key='')=>{
  const before=snapshotRef.current,next=structuredClone(before);transform(next)
  if(fingerprint(before)===fingerprint(next))return
  const h=history.current,now=Date.now()
  if(!key||h.key!==key||now-h.at>650){h.past=[...h.past.slice(-79),before]}
  h.future=[];h.key=key;h.at=now;setHistoryCount({past:h.past.length,future:0});setEditor(next);setNotice('');setSaveFailedAt('')
 },[setEditor])
 const selectState=(id:string,reveal=false)=>{setSelected(id);setEdgeIndex(null);setPhaseMenu(null);if(reveal){const item=document.states.find(s=>s.id===id);if(item)setScope(item.parent||item.id)}if(focused)setInspectorOpen(false)}
 const selectEdge=(index:number)=>{setEdgeIndex(index);setPhaseMenu(null);setInspectorOpen(true)}
 const openScope=(id:string)=>{setScope(id);setSelected(id);setEdgeIndex(null);setPhaseMenu(null)}
 const undo=useCallback((redo=false)=>{
  const h=history.current,source=redo?h.future:h.past;if(!source.length)return
  const next=source.pop()!;if(redo)h.past.push(snapshotRef.current);else h.future.push(snapshotRef.current)
  h.key='';setEditor(next);setEdgeIndex(null);setNotice('');setSaveFailedAt('');setHistoryCount({past:h.past.length,future:h.future.length})
 },[setEditor])
 function changeState(id:string,updates:Partial<MachineState>){edit(draft=>{draft.document.states=draft.document.states.map(s=>s.id===id?{...s,...updates}:s)},'state:'+id+':'+Object.keys(updates).join(','))}
 function changeTransition(updates:Partial<Transition>){if(edgeIndex===null)return;edit(draft=>{draft.document.transitions[edgeIndex]={...draft.document.transitions[edgeIndex],...updates}},'edge:'+edgeIndex+':'+Object.keys(updates).join(','))}
 function freezePositions(draft:MachineSnapshot){draft.layout.positions={...automaticHsmLayout(draft.document.states).positions,...draft.layout.positions}}
 function removeSelection(){
  if(edgeIndex!==null){edit(draft=>{draft.document.transitions.splice(edgeIndex,1)});setEdgeIndex(null);return}
  if(!state||state.id===document.initial)return
  const doomed=descendants(document,state.id),parent=state.parent||document.initial
  edit(draft=>{freezePositions(draft);draft.document=normalizeInitials({...draft.document,states:draft.document.states.filter(s=>!doomed.has(s.id)),transitions:draft.document.transitions.filter(t=>!doomed.has(t.source)&&!doomed.has(t.target))});draft.layout.positions=Object.fromEntries(Object.entries(draft.layout.positions).filter(([id])=>!doomed.has(id)))})
  setSelected(parent);if(doomed.has(scope))setScope(parent)
 }
 function addState(parent=scope,x?:number,y?:number){
  if(document.states.length>=48){setNotice('最多可添加 48 个状态');return}
  const id='state_'+crypto.randomUUID().slice(0,8)
  edit(draft=>{freezePositions(draft);draft.document.states.push({id,label:'新状态',parent});draft.document=normalizeInitials(draft.document);if(x!==undefined&&y!==undefined)draft.layout.positions[id]=[x,y];else{const occupied=draft.document.states.filter(item=>item.parent===parent&&item.id!==id).map(item=>draft.layout.positions[item.id]);for(let index=0;index<100;index++){const point:[number,number]=[70+index%3*284,86+Math.floor(index/3)*182];if(!occupied.some(position=>Math.abs(position[0]-point[0])<220&&Math.abs(position[1]-point[1])<115)){draft.layout.positions[id]=point;break}}}})
  setSelected(id);setEdgeIndex(null);setScope(parent);setInspectorOpen(true);setAddMenu(false);setCollapsed(previous=>{const next=new Set(previous);next.delete(parent);return next});requestAnimationFrame(()=>{nameInput.current?.focus();nameInput.current?.select()})
 }
 function connect(source:string,target:string){
  if(document.transitions.length>=160){setNotice('最多可添加 160 条转换');return}
  let event='completed',suffix=1
  while(document.transitions.some(edge=>edge.source===source&&edge.event===event))event='event_'+suffix++
  const index=document.transitions.length
  edit(draft=>{draft.document.transitions.push({source,target,event,guard:{operator:'always'}})})
  setSelected(source);setEdgeIndex(index);setInspectorOpen(true);guideCompleted('hsm:transition-added')
 }
 function reparent(child:string,parent:string){
  if(!canReparent(document,child,parent)){setNotice('无法移动到自身或下级状态');return}
  edit(draft=>{freezePositions(draft);draft.document=normalizeInitials({...draft.document,states:draft.document.states.map(s=>s.id===child?{...s,parent}:s)});delete draft.layout.positions[child]})
  setScope(parent);setSelected(child);setEdgeIndex(null)
 }
 function dropState(event:DragEvent,parent:string){event.preventDefault();event.stopPropagation();setDragOver('');const child=event.dataTransfer.getData('application/x-hsm-state');if(child)reparent(child,parent)}
 function bindPhase(stateId:string,phase:Phase,reference:string){changeState(stateId,{[phase]:reference||undefined});if(reference&&phase==='do')guideCompleted('hsm:tree-bound')}
 function openTask(phase:Phase,kind?:'ros'|'tree',stateId=selected){
  const item=document.states.find(s=>s.id===stateId);if(!item)return
  const reference=item[phase];setSelected(stateId);setEdgeIndex(null);setPhaseMenu(null)
  if(onOpenTask){onOpenTask({kind:kind||(reference?.startsWith('ros:')?'ros':'tree'),reference:kind?undefined:reference,stateId:item.id,stateLabel:item.label,phase,machineId:current?.id})}
  else if(kind==='ros'||reference?.startsWith('ros:'))onOpenRos()
  else{setInspectorOpen(true);setPhaseMenu(phase)}
 }
 function loadMachine(machine:SavedMachine,restore=true){
  if(dirty&&loaded&&!window.confirm('当前草稿尚未保存，切换后放弃这些修改'))return
  let next=snapshotOf(machine);const base=fingerprint(next);let recovered=false
  if(restore){try{const cached=JSON.parse(localStorage.getItem('agro.hsm.draft.'+machine.id)||'null');if(cached?.base===base&&cached?.snapshot){next=cached.snapshot;recovered=true}}catch{}}
  setCurrent(machine);setEditor(next);setSavedFingerprint(base);setSelected(next.document.states.find(s=>s.parent)?.id||next.document.initial);setScope(next.document.initial);setEdgeIndex(null);setError('');setSaveFailedAt('');setNotice(recovered?'已恢复本地未保存草稿':'');resetHistory()
 }
 function create(){
  if(dirty&&!window.confirm('当前草稿尚未保存，继续后放弃这些修改'))return
  const next=blankMachine();setCurrent(null);setEditor(next);setSavedFingerprint('');setSelected('idle');setScope('workflow');setEdgeIndex(null);setError('');setNotice('新建草稿尚未保存');setSaveFailedAt('');resetHistory()
 }
 async function refreshCatalog(){
  const [machineData,treeData,taskData]=await Promise.all([client.request<Json>('/state-machines'),client.request<Json>('/trees/definitions'),client.request<Json>('/ros/tasks')])
  if(!alive.current)return
  setMachines(machineData.machines||[]);setDefinitions(treeData.definitions||[]);setRosTasks(taskData.tasks||[])
 }
 async function save(manual=true){
  if(busyRef.current)return false
  if(currentRunning){if(manual)setNotice('运行中的定义暂不覆盖，停止后会保存草稿');return false}
  if(diagnostics.length){if(manual){setBottom('diagnostics');setNotice('先修复诊断中的项目，再保存草稿')}return false}
  const submitted=structuredClone(snapshotRef.current),submittedFingerprint=fingerprint(submitted),generation=epoch.current
  busyRef.current=true;setBusy('save');setError('')
  try{
   const saved=await client.request<SavedMachine>('/state-machines','POST',{id:current?.id||null,name:submitted.title,document:submitted.document,layout:submitted.layout})
   if(!alive.current||generation!==epoch.current)return false
   setCurrent(saved);setMachines(previous=>[...previous.filter(item=>item.id!==saved.id),saved]);setSavedFingerprint(submittedFingerprint);setSaveFailedAt('');setNotice(manual?'已保存':'');guideCompleted('hsm:saved')
   try{localStorage.removeItem('agro.hsm.draft.'+saved.id)}catch{}
   return true
  }catch(cause){if(alive.current&&generation===epoch.current){setError(errorMessage(cause));setSaveFailedAt(submittedFingerprint)}return false}
  finally{busyRef.current=false;if(alive.current)setBusy(null)}
 }
 async function execute(action:'start'|'stop'){
  if(busyRef.current)return
  if(action==='start'&&(!current||dirty)){setNotice('先保存草稿，再运行状态机');return}
  busyRef.current=true;setBusy('run');setError('');setBottom('runtime')
  try{
   let body:Json={mode:'auto'}
   if(action==='start'){
    const systems=await client.request<Json>('/robot-systems'),robot=systems.systems?.find((item:Json)=>item.id===systems.selected_id)
    if(robot&&!robot.configured){if(!window.confirm('此操作会向机器人发送真实命令，请确认设备急停和通信失联保护可用'))return;body={mode:'auto',confirm_safety:true}}
   }
   await client.request(action==='start'?`/state-machines/${current!.id}/start`:'/state-machines/stop','POST',body)
   const status=await client.request<Json>('/state-machines/status');setSession(status.session);setNotice(action==='start'?'启动请求已提交':'停止请求已提交，正在等待停止确认')
  }catch(cause){setError(errorMessage(cause))}finally{busyRef.current=false;setBusy(null)}
 }
 async function fire(event:string){
  if(busyRef.current)return;busyRef.current=true;setBusy('run');setError('')
  try{await client.request('/state-machines/event','POST',{event,variables:{}});const status=await client.request<Json>('/state-machines/status');setSession(status.session);setNotice('已提交事件 '+event)}catch(cause){setError(errorMessage(cause))}finally{busyRef.current=false;setBusy(null)}
 }
 async function deleteMachine(){
  if(!current||busyRef.current||!window.confirm(`删除状态机「${title}」及其保存定义`))return
  busyRef.current=true;setBusy('delete');setError('')
  try{await client.request(`/state-machines/${current.id}`,'DELETE');setMachines(previous=>previous.filter(item=>item.id!==current.id));const next=blankMachine();setCurrent(null);setEditor(next);setSavedFingerprint('');setSelected('idle');setScope('workflow');setEdgeIndex(null);setNotice('定义已删除');resetHistory()}catch(cause){setError(errorMessage(cause))}finally{busyRef.current=false;setBusy(null)}
 }
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 useEffect(()=>{
  let valid=true;const generation=++epoch.current;setLoaded(false)
  Promise.all([client.request<Json>('/state-machines'),client.request<Json>('/trees/definitions'),client.request<Json>('/ros/tasks')]).then(([machineData,treeData,taskData])=>{
   if(!valid||generation!==epoch.current)return
   setMachines(machineData.machines||[]);setDefinitions(treeData.definitions||[]);setRosTasks(taskData.tasks||[])
   const latest=(machineData.machines as SavedMachine[])?.at(-1)
   if(latest){let next=snapshotOf(latest);const base=fingerprint(next);try{const cached=JSON.parse(localStorage.getItem('agro.hsm.draft.'+latest.id)||'null');if(cached?.base===base&&cached?.snapshot){next=cached.snapshot;setNotice('已恢复本地未保存草稿')}}catch{}setCurrent(latest);setEditor(next);setSavedFingerprint(base);setSelected(next.document.states.find(s=>s.parent)?.id||next.document.initial);setScope(next.document.initial)}
   else{const next=blankMachine();setCurrent(null);setEditor(next);setSavedFingerprint('');setSelected('idle');setScope(next.document.initial)}
   resetHistory();setLoaded(true);setError('')
  }).catch(cause=>{if(valid)setError(errorMessage(cause))})
  return()=>{valid=false}
 },[client,loadAttempt,setEditor])
 useEffect(()=>{
  let valid=true,timer=0
  const refresh=async()=>{try{const result=await client.request<Json>('/state-machines/status');if(valid){setSession(result.session);setStatusConnected(true)}}catch{if(valid)setStatusConnected(false)}finally{if(valid)timer=window.setTimeout(refresh,1200)}}
  void refresh();return()=>{valid=false;clearTimeout(timer)}
 },[client])
 useEffect(()=>{
  const refresh=()=>{void refreshCatalog().catch(cause=>setError(errorMessage(cause)))}
  const bind=(event:Event)=>{const detail=(event as CustomEvent<{stateId:string;phase:Phase;reference:string;machineId?:string}>).detail;if(!detail||!['entry','do','exit'].includes(detail.phase)||!snapshotRef.current.document.states.some(s=>s.id===detail.stateId)||detail.machineId&&detail.machineId!==current?.id)return;edit(draft=>{draft.document.states=draft.document.states.map(s=>s.id===detail.stateId?{...s,[detail.phase]:detail.reference}:s)});setSelected(detail.stateId);setEdgeIndex(null);setNotice('已关联状态行为');refresh()}
  window.addEventListener('agro:hsm:refresh',refresh);window.addEventListener('agro:ros:refresh',refresh);window.addEventListener('agro:studio:bind',bind)
  return()=>{window.removeEventListener('agro:hsm:refresh',refresh);window.removeEventListener('agro:ros:refresh',refresh);window.removeEventListener('agro:studio:bind',bind)}
 },[client,current?.id,edit])
 useEffect(()=>{try{localStorage.setItem('agro.studio.focused',String(focused))}catch{}},[focused])
 useEffect(()=>{
  if(!current||!loaded)return
  try{if(dirty)localStorage.setItem('agro.hsm.draft.'+current.id,JSON.stringify({base:savedFingerprint,snapshot}));else localStorage.removeItem('agro.hsm.draft.'+current.id)}catch{}
 },[current?.id,currentFingerprint,savedFingerprint,dirty,loaded])
 useEffect(()=>{
  if(!loaded||!current||!dirty||currentRunning||diagnostics.length||saveFailedAt===currentFingerprint||busy)return
  const timer=window.setTimeout(()=>{void save(false)},1100);return()=>clearTimeout(timer)
 },[loaded,current?.id,currentFingerprint,dirty,currentRunning,diagnostics.length,saveFailedAt,busy])
 useEffect(()=>{const beforeUnload=(event:BeforeUnloadEvent)=>{if(dirty){event.preventDefault();event.returnValue=''}};const navigate=(event:Event)=>{if(dirty&&!window.confirm('状态机有未保存的修改，是否离开'))event.preventDefault()};window.addEventListener('beforeunload',beforeUnload);window.addEventListener('agro:navigate',navigate);return()=>{window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('agro:navigate',navigate)}},[dirty])
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
 const ancestors:MachineState[]=[];let cursor=document.states.find(s=>s.id===scope);while(cursor&&ancestors.length<49){ancestors.unshift(cursor);cursor=document.states.find(s=>s.id===cursor?.parent)}
 const stateTransitions=document.transitions.map((edge,index)=>({edge,index})).filter(({edge})=>edge.source===selected)
 const runtime=session?.machine_id===current?.id?session:null
 const lineage=(id:string,level=0):ReactNode=>{
  const item=document.states.find(s=>s.id===id);if(!item||level>48)return null
  const sub=children(id),matches=!filter||[...descendants(document,id)].some(key=>document.states.find(s=>s.id===key)?.label.toLowerCase().includes(filter.toLowerCase())),closed=collapsed.has(id)&&!filter
  if(!matches)return null
  return <div key={id} className="wb-outline-group"><div className={'wb-outline-row'+(selected===id&&edgeIndex===null?' is-current':'')+(dragOver===id?' is-drop-target':'')} style={{paddingLeft:8+level*14}} onDragOver={event=>{if(event.dataTransfer.types.includes('application/x-hsm-state')){event.preventDefault();event.stopPropagation()}}} onDragEnter={event=>{event.stopPropagation();if(event.dataTransfer.types.includes('application/x-hsm-state'))setDragOver(id)}} onDragLeave={()=>setDragOver('')} onDrop={event=>dropState(event,id)}>
   <button className={'wb-disclosure'+(closed?' is-closed':'')} aria-label={(closed?'展开 ':'折叠 ')+item.label} disabled={!sub.length} onClick={()=>setCollapsed(previous=>{const next=new Set(previous);next.has(id)?next.delete(id):next.add(id);return next})}>{tinyIcon('chevron')}</button>
   <button className="wb-outline-select" draggable={id!==document.initial} onDragStart={event=>{event.dataTransfer.setData('application/x-hsm-state',id);event.dataTransfer.effectAllowed='move'}} onClick={()=>selectState(id,true)} onDoubleClick={()=>openScope(id)} title={item.label}>{tinyIcon(sub.length?'branch':'state')}<span>{item.label}</span>{runtime?.path?.includes(id)&&<i className="wb-live-dot"/>}{document.states.find(s=>s.id===item.parent)?.initial===id&&<span className="wb-initial-badge" title="初始子状态">初始</span>}</button>
  </div>{!closed&&sub.map(child=>lineage(child.id,level+1))}</div>
 }
 const phaseBindings=(phase:Phase)=>{
  if(!state?.[phase])return null
  const ref=state[phase]!,ros=ref.startsWith('ros:'),task=(ros?rosTasks.find(item=>'ros:'+item.id===ref):definitions.find(item=>item.id===ref)) as Json|undefined
  const rootTree=task?.document?.trees?.[task?.document?.main_tree_id]
  const inputs=Object.keys(ros?task?.inputs||{}:task?.manifest?.parameters||task?.document?.inputs||{})
  const outputs=Object.keys(ros?task?.outputs||{}:Object.fromEntries(Object.entries(rootTree?.ports||{}).filter(([,port])=>(port as Json).direction==='OUTPUT')))
  const directions=([{key:'inputs',label:'输入',names:inputs},{key:'outputs',label:'输出',names:outputs}] as const).map(direction=>({...direction,names:[...new Set([...direction.names,...Object.keys(state.bindings?.[phase]?.[direction.key]||{})])]}))
  if(!directions.some(direction=>direction.names.length))return null
  return <details className="wb-phase-data"><summary>输入与输出</summary>{directions.filter(direction=>direction.names.length).map(direction=><div key={direction.key}><span className="wb-binding-direction">{direction.label}</span>{direction.names.map(port=><label className="wb-port-binding" key={port}><code title={port}>{port}</code><select aria-label={`${phaseLabels[phase]} ${direction.label} ${port}`} value={state.bindings?.[phase]?.[direction.key]?.[port]||''} onChange={event=>{const variable=event.target.value;edit(draft=>{const item=draft.document.states.find(item=>item.id===selected)!;item.bindings??={};item.bindings[phase]??={};const mapping=item.bindings[phase]![direction.key]??={};if(variable)mapping[port]=variable;else delete mapping[port]})}}><option value="">{port in document.variables?'同名变量':direction.key==='inputs'?'任务默认值':'不写入变量'}</option>{Object.keys(document.variables).map(name=><option key={name} value={name}>{name}</option>)}</select></label>)}</div>)}<button className="wb-text-button" onClick={()=>setBottom('variables')}>管理状态变量 {tinyIcon('chevron')}</button></details>
 }
 const phaseDefinitions=(phase:Phase)=>{const bound=definitions.find(item=>item.id===state?.[phase]);return definitions.filter((item,index,all)=>bound&&item.draft_id===bound.draft_id?item.id===bound.id:!all.slice(index+1).some(other=>(other.draft_id||other.id)===(item.draft_id||item.id)))}
 const phaseEditor=(phase:Phase)=>state&&<div className={'wb-phase'+(phase==='do'?' is-main':'')} key={phase}>
  <div className="wb-phase-heading"><span>{phaseLabels[phase]}</span><small>{phase==='entry'?'进入时':phase==='do'?'持续行为':'离开时'}</small></div>
  <div className="wb-phase-binding"><select aria-label={phase+' 关联任务'} value={state[phase]||''} onChange={event=>bindPhase(selected,phase,event.target.value)}><option value="">未关联</option>{state[phase]&&!references.has(state[phase]!)&&<option value={state[phase]}>原任务不可用</option>}<optgroup label="ROS 任务">{rosTasks.map(task=><option key={task.id} value={'ros:'+task.id}>{task.name}</option>)}</optgroup><optgroup label="行为树">{phaseDefinitions(phase).map(item=><option key={item.id} value={item.id}>{taskLabels[item.id]}</option>)}</optgroup></select><button className="wb-icon-button" aria-label={state[phase]?'编辑 '+phaseLabels[phase]+' 行为':'创建 '+phaseLabels[phase]+' 行为'} title={state[phase]?'打开行为':'创建行为'} onClick={()=>state[phase]?openTask(phase):setPhaseMenu(phaseMenu===phase?null:phase)}>{tinyIcon(state[phase]?'chevron':'plus')}</button></div>
  {phaseBindings(phase)}
  {phaseMenu===phase&&<div className="wb-phase-create"><button onClick={()=>openTask(phase,'tree')}>{tinyIcon('branch')}新建行为树</button><button onClick={()=>openTask(phase,'ros')}>{tinyIcon('state')}新建 ROS 任务</button></div>}
 </div>
 const focusMode=()=>{setFocused(previous=>!previous);setInspectorOpen(focused);setOutlineOpen(focused)}
 const hasOutline=!focused&&outlineOpen,hasInspector=!focused&&inspectorOpen
 return <div ref={editor} className={'hsm-editor hsm-workbench'+(focused?' is-focused':'')+(hasOutline?' has-outline':'')+(hasInspector?' has-inspector':'')+(focused&&inspectorOpen?' has-floating-inspector':'')} data-guide="task-hsm-workspace">
  <header className="wb-toolbar">
   <div className="wb-toolbar-group"><button className="wb-icon-button" title="显示状态目录" aria-label="显示状态目录" aria-pressed={hasOutline} onClick={()=>{if(focused){setFocused(false);setOutlineOpen(true)}else setOutlineOpen(!outlineOpen)}}>{tinyIcon('outline')}</button><div className="wb-document-picker"><select aria-label="选择状态机" value={current?.id||''} disabled={!!busy} onChange={event=>{const item=machines.find(machine=>machine.id===event.target.value);if(item)loadMachine(item)}}><option value="">新建草稿</option>{machines.map(machine=><option key={machine.id} value={machine.id}>{machine.name}</option>)}</select></div><button className="wb-icon-button" title="新建状态机" aria-label="新建状态机" disabled={!!busy} onClick={create}>{tinyIcon('plus')}</button></div>
   <div className="wb-toolbar-middle"><button title="撤销 ⌘Z / Ctrl+Z" aria-label="撤销" disabled={!historyCount.past} onClick={()=>undo()}>{tinyIcon('undo')}</button><button title="重做 ⇧⌘Z / Ctrl+Shift+Z" aria-label="重做" disabled={!historyCount.future} onClick={()=>undo(true)}>{tinyIcon('redo')}</button><span className="wb-toolbar-rule"/><button className="wb-mode-button" title={focused?'切换为精密工作台':'切换为专注画布'} aria-pressed={focused} onClick={focusMode}>{tinyIcon('focus')}<span>{focused?'专注画布':'精密工作台'}</span></button></div>
   <div className="wb-toolbar-group wb-toolbar-end"><span className={'wb-save-state'+(saveFailedAt?' is-error':'')} aria-live="polite">{busy==='save'?'保存中':saveFailedAt?'尚未保存':dirty?(currentRunning?'草稿待保存':'有未保存修改'):current?'已保存':'新建草稿'}</span><button data-guide="task-hsm-save" className="wb-save-button" disabled={!!busy||!loaded||!dirty&&!!current||currentRunning} onClick={()=>void save()}>保存</button><button className="wb-run-button" aria-label={currentRunning?'停止状态机':'运行状态机'} disabled={!!busy||!loaded||(!currentRunning&&(!current||dirty||diagnostics.length>0||activeStatus(session?.status)))} onClick={()=>void execute(currentRunning?'stop':'start')}>{tinyIcon(currentRunning?'stop':'play')}<span>{currentRunning?'停止':'运行'}</span></button><button className="wb-icon-button" title="显示检查器" aria-label="显示检查器" aria-pressed={inspectorOpen} onClick={()=>setInspectorOpen(!inspectorOpen)}>{tinyIcon('inspect')}</button></div>
  </header>
  <div className="wb-body">
   {hasOutline&&<aside className="wb-navigator" aria-label="状态目录"><div className="wb-pane-title"><span>工程</span><span>{document.states.length}</span></div><div className="wb-project-name"><input aria-label="状态机名称" value={title} maxLength={80} onChange={event=>edit(draft=>{draft.title=event.target.value},'title')}/></div><input className="wb-outline-search" type="search" aria-label="筛选状态" placeholder="查找状态" value={filter} onChange={event=>setFilter(event.target.value)}/><div className="wb-state-tree" data-guide="hsm-state-tree">{lineage(document.initial)}</div><div className="wb-outline-footer"><button data-guide="hsm-add-state" onClick={()=>addState()}>{tinyIcon('plus')}添加状态</button><button className="wb-icon-button" aria-label="更多工程操作" onClick={()=>setAddMenu(!addMenu)}>•••</button>{addMenu&&<div className="wb-outline-menu"><button onClick={()=>{addState(selected);setAddMenu(false)}}>在选中状态内添加</button><button onClick={()=>{setBottom('variables');setAddMenu(false)}}>编辑状态变量</button><button className="wb-danger" disabled={!current||currentRunning||!!busy} onClick={()=>{setAddMenu(false);void deleteMachine()}}>删除状态机</button></div>}</div></aside>}
   <main className="wb-main"><div className="wb-document-bar"><nav aria-label="画布层级" className="wb-breadcrumb">{ancestors.map((item,index)=><span key={item.id}>{index>0&&tinyIcon('chevron')}<button aria-current={index===ancestors.length-1?'location':undefined} onClick={()=>openScope(item.id)}>{item.label}</button></span>)}</nav><button className="wb-icon-button" title="添加状态" aria-label="添加状态" onClick={()=>addState()}>{tinyIcon('plus')}</button></div>
    <HsmCanvas states={document.states} transitions={document.transitions} layout={layout} selected={selected} scope={scope} selectedTransition={edgeIndex} onSelect={id=>selectState(id)} onSelectTransition={selectEdge} onEnter={openScope} onMove={(id,x,y)=>edit(draft=>{draft.layout.positions[id]=[x,y]})} onReset={()=>edit(draft=>{for(const item of draft.document.states.filter(s=>s.parent===scope))delete draft.layout.positions[item.id]})} onConnect={connect} onCreate={(x,y)=>addState(scope,x,y)} onRename={(id,label)=>changeState(id,{label})} onOpenPhase={(id,phase)=>{const item=document.states.find(s=>s.id===id);if(item?.[phase])openTask(phase,undefined,id);else{setSelected(id);setEdgeIndex(null);setInspectorOpen(true);setPhaseMenu(phase)}}} activePath={runtime?.path||[]} taskLabels={taskLabels}/>
    {focused&&!inspectorOpen&&<div className="wb-context-strip"><button className="wb-context-selection" onClick={()=>setInspectorOpen(true)}>{tinyIcon(transition?'branch':'state')}<strong>{transition?transition.event:state?.label||title}</strong><small>{transition?'事件转换':state?children(state.id).length?'复合状态':'状态':'状态机'}</small></button>{state&&!transition&&<button className="wb-context-behavior" onClick={()=>{if(state.do)openTask('do');else{setInspectorOpen(true);setPhaseMenu('do')}}}><span>Do</span>{state.do?taskLabels[state.do]||'关联行为':'添加行为'}{tinyIcon('chevron')}</button>}<button className="wb-context-inspect" onClick={()=>setInspectorOpen(true)}>检查器 {tinyIcon('chevron')}</button></div>}
    <div className="wb-bottom-tabs" role="tablist" aria-label="运行与诊断">{(['runtime','variables','diagnostics'] as const).map(tab=><button key={tab} role="tab" aria-selected={bottom===tab} onClick={()=>setBottom(bottom===tab?null:tab)}>{tab==='runtime'?'执行记录':tab==='variables'?'变量':'诊断'}{tab==='diagnostics'&&diagnostics.length>0&&<span className="wb-count">{diagnostics.length}</span>}</button>)}<span>{children(scope).length} 个状态 · {document.transitions.length} 条转换</span>{bottom&&<button className="wb-icon-button" aria-label="收起底部面板" onClick={()=>setBottom(null)}>{tinyIcon('close')}</button>}</div>
    {bottom&&<section className="wb-bottom-panel" aria-label={bottom==='runtime'?'执行记录':bottom==='variables'?'状态变量':'诊断'}>
     {bottom==='runtime'&&<><div className="wb-runtime-heading"><span className={'wb-live-dot'+(currentRunning?'':' is-idle')}/><strong>{runtime?statusLabels[runtime.status]||runtime.status:'尚未运行'}</strong><span>{runtime?.active?document.states.find(s=>s.id===runtime.active)?.label||runtime.active:'保存并运行后在此查看状态转换'}</span><button onClick={()=>onNavigate('runtime')}>运行观察 {tinyIcon('chevron')}</button></div>{runtime?.pending_events>0&&<span className="wb-subtle-text">队列中有 {runtime?.pending_events} 个事件</span>}{runtime?.error&&<div className="wb-inline-error">{runtime.error}</div>}{runtime?.events?.length>0&&<div className="wb-event-log">{[...(runtime?.events||[])].reverse().slice(0,30).map((entry:Json,index)=><button key={index} onClick={()=>{const id=entry.target||entry.to||entry.active;if(document.states.some(s=>s.id===id))selectState(id,true)}}><span>{entry.event||entry.type||'状态转换'}</span><span>{entry.source?document.states.find(s=>s.id===entry.source)?.label||entry.source:''}{entry.target?' → '+(document.states.find(s=>s.id===entry.target)?.label||entry.target):''}</span><small>{entry.reason||entry.status||''}</small></button>)}</div>}{currentRunning&&<div className="wb-fire-events">{document.transitions.filter(edge=>runtime?.path?.includes(edge.source)).map(edge=><button key={edge.source+edge.event} disabled={!!busy} onClick={()=>void fire(edge.event)}>发送 {edge.event}</button>)}</div>}{runtime?.ros_feedback&&<pre className="wb-feedback">{JSON.stringify(runtime.ros_feedback,null,2)}</pre>}</>}
     {bottom==='variables'&&<><div className="wb-variable-list">{Object.entries(document.variables).map(([key,value])=><div className="wb-variable-row" key={key}><code>{key}</code><span>{value===null?'空值':Array.isArray(value)?'数组':typeof value==='object'?'对象':typeof value==='number'?'数值':typeof value==='boolean'?'布尔':'文本'}</span><ScalarInput label={key+' 初始值'} onValidity={valid=>fieldValidity('variable:'+key,valid)} value={value} onChange={next=>edit(draft=>{draft.document.variables[key]=next},'variable:'+key)}/>{runtime?.variables&&<small title="运行值">{typeof runtime.variables[key]==='object'?JSON.stringify(runtime.variables[key]):String(runtime.variables[key]??'—')}</small>}<button className="wb-icon-button" aria-label={'删除变量 '+key} onClick={()=>edit(draft=>{delete draft.document.variables[key]})}>{tinyIcon('close')}</button></div>)}</div><form className="wb-variable-add" onSubmit={event=>{event.preventDefault();if(!isIdentifier(variableName)||variableName in document.variables){setNotice('变量标识需唯一，以小写字母开头，可包含数字和下划线');return}if(Object.keys(document.variables).length>=64){setNotice('最多可声明 64 个变量');return}edit(draft=>{draft.document.variables[variableName]=variableType==='boolean'?false:variableType==='number'?0:variableType==='null'?null:variableType==='object'?{}:variableType==='array'?[]:''});setVariableName('')}}><input aria-label="新变量标识" placeholder="变量标识" value={variableName} onChange={event=>setVariableName(event.target.value)}/><select aria-label="变量类型" value={variableType} onChange={event=>setVariableType(event.target.value)}><option value="boolean">布尔</option><option value="number">数值</option><option value="string">文本</option><option value="object">对象</option><option value="array">数组</option><option value="null">空值</option></select><button type="submit">添加变量</button></form></>}
     {bottom==='diagnostics'&&(diagnostics.length?<div className="wb-diagnostics">{diagnostics.map((issue,index)=><button key={index} onClick={()=>{if(issue.stateId)selectState(issue.stateId,true);if(issue.edgeIndex!==undefined)selectEdge(issue.edgeIndex);setInspectorOpen(true)}}><span>!</span><span>{issue.message}</span>{tinyIcon('chevron')}</button>)}</div>:<div className="wb-diagnostics-clear">{tinyIcon('check')}结构与任务引用检查通过</div>)}
    </section>}
   </main>
   {(hasInspector||focused&&inspectorOpen)&&<aside className="wb-inspector" aria-label="检查器"><div className="wb-pane-title"><span>{transition?'转换检查器':'检查器'}</span><button className="wb-icon-button" aria-label="关闭检查器" onClick={()=>setInspectorOpen(false)}>{tinyIcon('close')}</button></div><div className="wb-inspector-scroll">
    {transition?<><div className="wb-inspector-intro"><span className="wb-inspector-symbol">{tinyIcon('branch')}</span><strong>事件转换</strong><small>{document.states.find(s=>s.id===transition.source)?.label} → {document.states.find(s=>s.id===transition.target)?.label}</small></div><div className="wb-property-section" data-guide="hsm-transitions"><Property label="事件标识"><input autoFocus aria-label="事件标识" value={transition.event} maxLength={64} onChange={event=>changeTransition({event:event.target.value})}/></Property><Property label="来源状态"><select value={transition.source} onChange={event=>changeTransition({source:event.target.value})}>{document.states.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></Property><Property label="目标状态"><select value={transition.target} onChange={event=>changeTransition({target:event.target.value})}>{document.states.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></Property></div><div className="wb-property-section"><h3>转换条件</h3><Property label="比较方式"><select value={transition.guard?.operator||'always'} onChange={event=>{const key=transition.guard?.key||Object.keys(document.variables)[0];changeTransition({guard:{operator:event.target.value,key,value:key?document.variables[key]:undefined}})}}><option value="always">始终允许</option><option value="equals">等于</option><option value="not_equals">不等于</option><option value="greater">大于</option><option value="less">小于</option></select></Property>{transition.guard?.operator&&transition.guard.operator!=='always'&&<><Property label="状态变量"><select value={transition.guard.key||''} onChange={event=>changeTransition({guard:{...transition.guard!,key:event.target.value,value:document.variables[event.target.value]}})}><option value="" disabled>选择变量</option>{Object.keys(document.variables).map(key=><option value={key} key={key}>{key}</option>)}</select></Property><Property label="比较值"><ScalarInput key={'guard:'+edgeIndex} label="条件比较值" onValidity={valid=>fieldValidity('guard:'+edgeIndex,valid)} value={transition.guard.value!==undefined?transition.guard.value:transition.guard.key&&transition.guard.key in document.variables?document.variables[transition.guard.key]:''} onChange={value=>changeTransition({guard:{...transition.guard!,value}})}/></Property>{!Object.keys(document.variables).length&&<button className="wb-text-button" onClick={()=>setBottom('variables')}>添加状态变量</button>}</>}</div><button className="wb-delete-selection" onClick={removeSelection}>删除转换</button></>:state?<><div className="wb-inspector-intro"><span className="wb-inspector-symbol">{tinyIcon(children(selected).length?'branch':'state')}</span><input ref={nameInput} aria-label="状态名称" value={state.label} maxLength={80} onChange={event=>changeState(selected,{label:event.target.value})}/><small>{selected===document.initial?'根状态':children(selected).length?'复合状态':'状态'}</small></div>
     <div className="wb-property-section wb-state-behaviors" data-guide="hsm-lifecycle"><h3>状态行为</h3>{(['entry','do','exit'] as const).map(phaseEditor)}</div>
     <div className="wb-property-section" data-guide="hsm-transitions"><div className="wb-section-heading"><h3>事件转换</h3><button className="wb-icon-button" aria-label="添加事件转换" onClick={()=>connect(selected,document.states.find(s=>s.parent===state.parent&&s.id!==selected)?.id||selected)}>{tinyIcon('plus')}</button></div>{stateTransitions.length?stateTransitions.map(({edge,index})=><button className="wb-transition-row" key={index} onClick={()=>selectEdge(index)}><span>{edge.event||'未命名事件'}</span><small>{document.states.find(s=>s.id===edge.target)?.label}</small>{tinyIcon('chevron')}</button>):<p className="wb-subtle-text">从画布端点拖动创建转换</p>}</div>
     <div className="wb-property-section"><h3>状态层级</h3>{state.parent&&<Property label="父状态"><select value={state.parent} onChange={event=>reparent(selected,event.target.value)}>{document.states.filter(item=>canReparent(document,selected,item.id)).map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></Property>}{children(selected).length>0&&<><Property label="初始子状态"><select value={state.initial||''} onChange={event=>changeState(selected,{initial:event.target.value})}>{children(selected).map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></Property><button className="wb-text-button" onClick={()=>openScope(selected)}>进入子状态 {tinyIcon('chevron')}</button></>}<button className="wb-text-button" onClick={()=>addState(selected)}>添加子状态 {tinyIcon('plus')}</button></div>
     <details className="wb-identity"><summary>状态标识</summary><code>{state.id}</code></details>{state.id!==document.initial&&<button className="wb-delete-selection" onClick={removeSelection}>删除状态{children(state.id).length?'及子状态':''}</button>}
    </>:<div className="wb-inspector-empty">选择状态或转换以查看属性</div>}
   </div></aside>}
  </div>
  <footer className={'wb-statusbar'+(error?' has-error':'')}><span className={'wb-live-dot'+(statusConnected?'':' is-error')}/><span>{error||notice||(current?.needs_tree_rebinding?'部分行为树需要重新关联':statusConnected?currentRunning?'机器人正在执行':'就绪':'后台暂时无法连接')}</span>{error&&<button onClick={()=>{setError('');setSaveFailedAt('');if(!loaded)setLoadAttempt(value=>value+1);else if(dirty)void save()}}>重试</button>}<span className="wb-status-end">{dirty?currentRunning?'停止后保存':'草稿':current?'已保存':'新建草稿'}</span></footer>
 </div>
}
