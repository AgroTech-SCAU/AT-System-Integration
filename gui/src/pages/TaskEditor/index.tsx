import {AnimatePresence, motion} from 'motion/react'
import {springs, fade, PresenceLayer} from '../../motion'
import {SpatialPanel} from '../../components/SpatialPanel'
import {useLocale} from '../../locale'
import {useEffect,useRef,useState} from 'react'
import {Field} from '../../components/Foundation'
import {ApiError} from '../../api'
import {ErrorFields,durableIntent,type Json,type PageProps} from '../shared'
import {clone,copyFragment,duplicate,nodeId,positions,remove,reparent,parentOf,pasteFragment,includeSubtrees,restoreSubtrees,translateBranch,orderSibling,canReferenceTree,type EditorValue,type Fragment} from './editor'
import TreeCanvas from './TreeCanvas'
import TreeOutline from './TreeOutline'
import RuntimeTree from './RuntimeTree'
import {nodeLabel} from './labels'
import TaskInputs from './TaskInputs'
import NodeInspector from './NodeInspector'
import BehaviorLibrary from './BehaviorLibrary'
import Icon from './WorkbenchIcon'
import type {Workspace} from '../../types'
import './behavior-workbench.css'

type Props=PageProps&{configured?:boolean;onNavigate?:(page:Workspace)=>void;requestedDefinition?:string;requestKey?:number;browseKey?:number;owner?:{machine_id?:string;state_id:string;phase:string};onRememberReference?:(reference:string)=>void;onBound?:(reference:string)=>void;onBack?:()=>void;contextLabel?:string}
function useWorkbenchOperation(){
 const [busy,setBusy]=useState(false),[phase,setPhase]=useState(''),[error,assignError]=useState<unknown>(null),locked=useRef(false),controller=useRef<AbortController|null>(null),alive=useRef(true)
 function setError(value:unknown){assignError(value instanceof Error&&!(value instanceof ApiError)?new ApiError('response',[{path:'',code:'editor_operation',reason:value.message}]):value)}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort()}},[])
 async function run(title:string,work:(phase:(value:string)=>void,signal:AbortSignal)=>Promise<unknown>){
  if(locked.current)return false
  locked.current=true;controller.current=new AbortController();setBusy(true);setPhase(title);setError(null)
  try{await work(value=>{if(alive.current)setPhase(value)},controller.current.signal);return true}catch(cause){if(alive.current&&!controller.current.signal.aborted)setError(cause);return false}finally{locked.current=false;if(alive.current){setBusy(false);setPhase('')}}
 }
 return {busy,phase,error,setError,run}
}
export default function TaskEditor({client,observation,language,changed,configured,onNavigate,requestedDefinition,requestKey,browseKey,owner,onRememberReference,onBound,onBack,contextLabel}:Props){
 const {t}=useLocale()

 const [definitions,setDefinitions]=useState<Json[]>([]),[models,setModels]=useState<Json|null>(null),[draft,setDraft]=useState<Json|null>(null),[value,setValue]=useState<EditorValue|null>(null)
 const [treeId,setTreeId]=useState(''),[selected,setSelected]=useState(''),[nodeSearch,setNodeSearch]=useState(''),[nodeFilter,setNodeFilter]=useState('all'),[diagnostics,setDiagnostics]=useState<Json[]>([]),[checkFeedback,setCheckFeedback]=useState<{ok:boolean;messages:string[]}|null>(null),[sources,setSources]=useState<Json[]>([])
 const [xml,setXml]=useState(''),[definition,setDefinition]=useState<Json|null>(null),[task,setTask]=useState<Json|null>(null),[dirty,setDirty]=useState(false),[proposal,setProposal]=useState<Json|null>(null),[subtreeName,setSubtreeName]=useState('Extracted'),[advanced,setAdvanced]=useState(''),[view,setView]=useState<'edit'|'run'>('edit'),[taskId,setTaskId]=useState(''),[stale,setStale]=useState(false)
 const [safetyConfirmed,setSafetyConfirmed]=useState(false)
 const [library,setLibrary]=useState<Json[]>([]),[showLibrary,setShowLibrary]=useState(true)
 const [inspectorOpen,setInspectorOpen]=useState(()=>window.matchMedia('(min-width:1101px)').matches),[libraryTab,setLibraryTab]=useState<'nodes'|'structure'>('nodes'),[inspectorTab,setInspectorTab]=useState<'node'|'task'>('node'),[diagnosticsOpen,setDiagnosticsOpen]=useState(false),[paletteOpen,setPaletteOpen]=useState(false),[quickSearch,setQuickSearch]=useState(''),[commandIndex,setCommandIndex]=useState(0),[extractOpen,setExtractOpen]=useState(false),[layoutKey,setLayoutKey]=useState(0),[loaded,setLoaded]=useState(false)
 const root=useRef<HTMLDivElement>(null),history=useRef<{past:EditorValue[];future:EditorValue[]}>({past:[],future:[]}),taskIntent=useRef<string|null>(null),dirtyRef=useRef(false),op=useWorkbenchOperation(),reader=useRef(0),editSequence=useRef(0),lastEdit=useRef({key:'',time:0}),clipboard=useRef<Fragment|null>(null),externalRequest=useRef(''),insertion=useRef<{parent:string;before?:string}|null>(null),treePath=useRef<string[]>([]),returnFocus=useRef<HTMLElement|null>(null)
 const currentValue=useRef(value),currentDraft=useRef(draft)
 currentValue.current=value;currentDraft.current=draft;dirtyRef.current=dirty
 async function load(){
  const [m,d,p,l]=await Promise.all([client.request<Json>('/trees/models'),client.request<Json>('/trees/drafts'),client.request<Json>('/trees/definitions'),client.request<Json>('/trees/library')])
  setModels(m);setDefinitions(p.definitions);setLibrary(l.behaviors);return {drafts:d.drafts as Json[],definitions:p.definitions as Json[]}
 }
 useEffect(()=>{let active=true;load().then(()=>{if(active)setLoaded(true)}).catch(error=>{if(active)op.setError(error)});return()=>{active=false}},[client])
 useEffect(()=>{if(browseKey)void op.run(t('返回行为树列表'),backToLibrary)},[browseKey])
 useEffect(()=>{
  if(!loaded||requestKey===undefined||op.busy)return
  const key=String(requestKey);if(externalRequest.current===key)return;externalRequest.current=key
  void op.run(t("打开状态行为"),async()=>{
   if(dirtyRef.current)await save()
   if(requestedDefinition)await openBehavior(requestedDefinition)
   else await create('general',contextLabel)
   setView('edit');setInspectorTab('node')
  })
 },[loaded,requestKey,requestedDefinition,op.busy])
 useEffect(()=>{
  const unload=(event:BeforeUnloadEvent)=>{if(dirtyRef.current){event.preventDefault();event.returnValue=''}}
  const navigate=(event:Event)=>{if(!root.current?.closest('[hidden]')&&dirtyRef.current&&!window.confirm(t("行为树有未保存的修改，是否离开")))event.preventDefault()}
  window.addEventListener('beforeunload',unload);window.addEventListener('agro:navigate',navigate);window.addEventListener('agro:studio:leave-task',navigate)
  return()=>{window.removeEventListener('beforeunload',unload);window.removeEventListener('agro:navigate',navigate);window.removeEventListener('agro:studio:leave-task',navigate)}
 },[])
 useEffect(()=>{
  if(!value||draft?.document.readonly)return
  const controller=new AbortController(),timer=setTimeout(()=>{client.request<Json>('/trees/validate','POST',{document:value.document,policy:draft?.policy,parameters:value.parameters},controller.signal).then(result=>{if(!controller.signal.aborted){setDiagnostics(result.diagnostics);setSources(result.sources)}}).catch(error=>{if(!controller.signal.aborted)op.setError(error)})},450)
  return()=>{clearTimeout(timer);controller.abort()}
 },[value?.document,value?.parameters,client,draft?.policy])
 useEffect(()=>{
  if(view!=='run')return
  let active=true;const controller=new AbortController(),sequence=++reader.current
  async function read(){try{
   if(taskId){const response=await client.request<Json>(`/tasks/${taskId}`,'GET',undefined,controller.signal);if(active&&sequence===reader.current)setTask(response)}
   else if(taskIntent.current){const found=await client.request<Json>(`/tasks/by-request/${taskIntent.current}`,'GET',undefined,controller.signal);if(active&&found.found)remember(found.task)}
   if(active)setStale(false)
  }catch(error){if(active){setStale(true);op.setError(error)}}}
  void read();return()=>{active=false;controller.abort()}
 },[client,observation,taskId,view])
 useEffect(()=>{const refresh=()=>{void load().catch(op.setError)};window.addEventListener('agro:trees:refresh',refresh);return()=>window.removeEventListener('agro:trees:refresh',refresh)},[client])
 function choose(next:Json,published:Json[]=definitions){
  setShowLibrary(false);setTask(null);setTaskId('');taskIntent.current=null;setDraft(next);setValue({name:next.name||next.layout?.labels?.[next.document.trees[next.document.main_tree_id]?.root_id]||t('未命名行为树'),document:structuredClone(next.document),layout:{positions:{},labels:{},collapsed:[],zoom:1,...structuredClone(next.layout)},parameters:structuredClone(next.parameters||{})});setTreeId(next.document.main_tree_id);setSelected(next.document.trees[next.document.main_tree_id]?.root_id||'');setDirty(false);dirtyRef.current=false;setDiagnostics(next.validation?.diagnostics||[]);setCheckFeedback(null);setDefinition(published.find(item=>item.id===next.published)||null);setXml('');setProposal(null);setExtractOpen(false);treePath.current=[];history.current={past:[],future:[]};editSequence.current++;lastEdit.current={key:'',time:0}
 }
 async function openBehavior(reference:string){
  if(dirtyRef.current)await save()
  const result=await load()
  if(reference.startsWith('draft_'))choose(result.drafts.find(item=>item.id===reference)||await client.request<Json>(`/trees/drafts/${reference}`),result.definitions)
  else{
   const published=result.definitions.find(item=>item.id===reference)||await client.request<Json>(`/trees/definitions/${reference}`)
   const existing=result.drafts.find(item=>item.id===published.draft_id)
   const editable=existing||await client.request<Json>(`/trees/behaviors/${reference}/copy`,'POST',{name:published.name||t('未命名行为树')})
   onRememberReference?.(editable.id)
   choose(editable,result.definitions)
   await load()
  }
  setView('edit')
 }
 async function backToLibrary(){if(dirtyRef.current)await save();setShowLibrary(true);setView('edit');setDiagnosticsOpen(false);await load()}
 async function importFile(file:File){if(file.size>1048576)throw Error(t('文件超过允许大小'));if(dirtyRef.current)await save();choose(await client.request<Json>('/trees/drafts','POST',{xml:await file.text(),template:'general',name:file.name.replace(/\.xml$/i,'').slice(0,80)||t('未命名行为树')}));await load()}
 async function create(template='general',name?:string){
  if(dirtyRef.current)await save()
  const next=await client.request<Json>('/trees/drafts','POST',{template,name:(name||t('未命名行为树')).slice(0,80),owner})
  onRememberReference?.(next.id)
  choose(next);await load()
 }
 function change(work:(next:EditorValue)=>void,mergeKey=''){
  if(!value||draft?.document.readonly)return
  const next=clone(value)
  try{
   work(next)
   if(JSON.stringify(next)===JSON.stringify(value))return
   if(JSON.stringify(next.document)===JSON.stringify(value.document))next.document=value.document
   if(JSON.stringify(next.parameters)===JSON.stringify(value.parameters))next.parameters=value.parameters
   const now=Date.now()
   if(!mergeKey||lastEdit.current.key!==mergeKey||now-lastEdit.current.time>700)history.current.past.push(clone(value))
   history.current.past=history.current.past.slice(-80);history.current.future=[];lastEdit.current={key:mergeKey,time:now};editSequence.current++;setValue(next);setDirty(true);dirtyRef.current=true;setCheckFeedback(null);setProposal(null)
  }catch(error){op.setError(new ApiError('response',[{path:'$.tree',code:'edit_rejected',reason:error instanceof Error?error.message:t("编辑失败")}]))}
 }
 function undo(redo=false){
  if(!value||readonly)return
  const from=redo?history.current.future:history.current.past,to=redo?history.current.past:history.current.future,next=from.pop()
  if(next){to.push(clone(value));const restored=next.document.trees[treeId]?treeId:next.document.main_tree_id;setTreeId(restored);setSelected(next.document.trees[restored].nodes[selected]?selected:next.document.trees[restored].root_id);setProposal(null);setValue(next);setDirty(true);dirtyRef.current=true;setCheckFeedback(null);editSequence.current++;lastEdit.current={key:'',time:0}}
 }
 const tree=value?.document.trees[treeId],node=tree?.nodes[selected],readonly=!!draft?.document.readonly
 const groups=[['tasks',t('任务')],['control',t('执行组织')],['conditions',t('条件判断')],['loops',t('重复与限时')],['subtrees',t('子树')],['helpers',t('辅助节点')]]
 function category(model:Json){if(model.capability_id||model.ros_task_id)return 'tasks';if(model.registration_id==='SubTree')return 'subtrees';if(['Repeat','RetryUntilSuccessful','Timeout','Delay','RunOnce'].includes(model.registration_id))return 'loops';if(model.category?.toUpperCase()==='CONDITION')return 'conditions';if(['AlwaysSuccess','AlwaysFailure','ForceSuccess','ForceFailure','Inverter'].includes(model.registration_id))return 'helpers';return 'control'}
 const editableModels=(Object.values(models?.nodes||{}) as Json[]).filter(model=>model.editable&&!model.library_hidden)
 function group(model:Json){return groups.find(([id])=>id===category(model))?.[1]||t('辅助节点')}
 function title(model:Json){return model.ros_task_id?model.label:t(model.label||nodeLabel(model.registration_id,language))}
 const choices=editableModels.filter(model=>(nodeFilter==='all'||category(model)===nodeFilter)&&(!nodeSearch||`${title(model)} ${model.registration_id} ${model.description||''}`.toLowerCase().includes(nodeSearch.toLowerCase())))
 const quickChoices=editableModels.filter(model=>!quickSearch||`${title(model)} ${model.registration_id} ${model.description||''}`.toLowerCase().includes(quickSearch.toLowerCase()))
 const portModels=Object.fromEntries((Object.values(tree?.nodes||{}) as Json[]).map(n=>[n.editor_id,n.registration_id==='SubTree'?Object.fromEntries(Object.entries(value?.document.trees[n.attributes.ID]?.ports||{}).map(([name,spec]:[string,any])=>[name,{...spec.type,direction:spec.direction}])):models?.nodes[n.registration_id]?.ports||{}]))
 function suggestedBindings(portSpec:Json){
  if(!value||!tree)return [] as {key:string;label:string}[]
  const target=typeof portSpec.type==='object'?{...portSpec,...portSpec.type}:portSpec,options:{key:string;label:string;contract:Json}[]=[]
  for(const [key,contract] of Object.entries(value.document.inputs||{}) as [string,Json][])options.push({key,label:t("任务参数 · {0}", {0: key}),contract})
  for(const [key,port] of Object.entries(tree.ports||{}) as [string,Json][])if(port.direction==='INPUT'||port.direction==='INOUT')options.push({key,label:t("子树输入 · {0}", {0: key}),contract:typeof port.type==='object'?port.type:port})
  for(const item of Object.values(tree.nodes) as Json[]){
   if(item.editor_id===selected)continue
   for(const [name,binding] of Object.entries(item.ports) as [string,Json][]){const spec=portModels[item.editor_id]?.[name];if((spec?.direction==='OUTPUT'||spec?.direction==='INOUT')&&binding.kind==='blackboard_reference'&&binding.key)options.push({key:binding.key,label:`${value.layout.labels[item.editor_id]||models?.nodes[item.registration_id]?.label||nodeLabel(item.registration_id,language)} · ${name.replace(/^out_/,'')}`,contract:typeof spec.type==='object'?spec.type:spec})}
  }
  const seen=new Set<string>()
  return options.filter(candidate=>{if(seen.has(candidate.key))return false;for(const field of ['type','unit','frame_id','clock_domain'])if(target[field]&&candidate.contract[field]!==target[field])return false;seen.add(candidate.key);return true}).map(({key,label})=>({key,label}))
 }
 async function save(){
  const previous=currentDraft.current,snapshot=currentValue.current,sequence=editSequence.current
  if(!previous||!snapshot)return previous
  const next=await client.request<Json>(`/trees/drafts/${previous.id}`,'PUT',{revision:previous.revision,layout_revision:previous.layout_revision,...snapshot})
  if(currentDraft.current?.id===previous.id){setDraft(next);currentDraft.current=next;if(editSequence.current===sequence){setDirty(false);dirtyRef.current=false}}
  await load();return next
 }
 async function checked(){
  const current=dirtyRef.current?await save():currentDraft.current;if(!current)return null
  const result=models?.offline_only?await client.request<Json>('/trees/validate','POST',{document:current.document,policy:current.policy,parameters:current.parameters}):await client.request<Json>(`/trees/drafts/${current.id}/validate`,'POST',{})
  setDiagnostics(result.diagnostics);setSources(result.sources)
  if(result.valid){setCheckFeedback({ok:true,messages:[t("结构和数据校验通过")]})}
  else{const messages=(result.diagnostics||[]).map((issue:Json)=>String(issue.reason||issue.code||t("校验未通过")));setCheckFeedback({ok:false,messages});setDiagnosticsOpen(true);throw new ApiError('response',result.diagnostics.map((issue:Json)=>({path:`${issue.tree_id||'$'}/${issue.editor_id||''}/${issue.port||''}`,code:issue.code,reason:issue.reason})))}
  return current
 }
 async function publish(){
  const sequence=editSequence.current,current=await checked();if(!current)return
  if(sequence!==editSequence.current)throw Error(t("校验期间有新的修改，请再次执行"))
  const next=await client.request<Json>(`/trees/drafts/${current.id}/publish`,'POST',{revision:current.revision,base_snapshot_id:observation?.system.snapshot_id||models?.system_snapshot_id})
  setDefinition(next);await load();return next
 }
 function add(at=selected,registrationId='Sequence',before?:string){
  if(!tree||!models?.nodes[registrationId])return
  change(v=>{
   const target=v.document.trees[treeId],id=nodeId(),ports:Json={},attributes:Json={},spec=models.nodes[registrationId]
   if(spec.capability_id&&!spec.ros_task_id)attributes.role=spec.roles?.[0]||''
   for(const [name,port] of Object.entries(spec.ports||{}) as [string,Json][])if(port.direction==='OUTPUT')ports[name]={kind:'blackboard_reference',key:name.replace(/^out_/,'')+'_'+id.slice(-6),type:{},value:null}
   if(registrationId==='SubTree')attributes.ID=Object.keys(v.document.trees).find(key=>canReferenceTree(v.document,treeId,key))||''
   let parent=at||target.root_id
   if(models.nodes[target.nodes[parent]?.registration_id]?.maximum_children===0)parent=parentOf(target,parent)?.editor_id||target.root_id
   const parentNode=target.nodes[parent],max=models.nodes[parentNode?.registration_id]?.maximum_children
   if(!parentNode||max===0||max>=0&&parentNode.children.length>=max)throw Error(t("当前节点没有可用的子节点位置"))
   target.nodes[id]={editor_id:id,registration_id:registrationId,children:[],ports,attributes}
   parentNode.children.splice(before?Math.max(0,parentNode.children.indexOf(before)):parentNode.children.length,0,id)
   v.layout.positions={...v.layout.positions,...positions(target)}
   if(spec.label)v.layout.labels[id]=spec.label
   v.layout.collapsed=v.layout.collapsed.filter((item:string)=>item!==parent)
   setSelected(id);setInspectorTab('node')
  })
 }
 function moveNode(id:string,parent:string,before?:string){if(tree&&models)change(v=>{const target=v.document.trees[treeId],siblings=target.nodes[parent].children.filter((child:string)=>child!==id),index=before?siblings.indexOf(before):siblings.length;reparent(target,id,parent,models.nodes,index<0?siblings.length:index);v.layout.positions={...v.layout.positions,...positions(target)};v.layout.collapsed=v.layout.collapsed.filter((item:string)=>item!==parent);setSelected(id)})}
 function order(delta:number){change(v=>orderSibling(v.document.trees[treeId],selected,delta,v.layout))}
 function deleteNode(id=selected){if(!tree||id===tree.root_id)return;change(v=>{const target=v.document.trees[treeId],parent=parentOf(target,id);remove(target,id);setSelected(parent?.editor_id||target.root_id)})}
 function duplicateNode(id=selected){if(!tree||!models)return;change(v=>setSelected(duplicate(v.document.trees[treeId],id,portModels,v.layout,models.nodes)))}
 function copy(){if(tree&&value&&node)clipboard.current=includeSubtrees(value.document,copyFragment(tree,selected,value.layout,portModels))}
 function paste(){
  if(!clipboard.current||!tree||!models||!value)return
  const fragment=clipboard.current
  change(v=>{const target=v.document.trees[treeId],parent=models.nodes[node?.registration_id]?.maximum_children===0?parentOf(target,selected)?.editor_id: selected
   if(!parent)throw Error(t("请选择一个控制节点作为粘贴位置"))
   const copied=restoreSubtrees(v.document,fragment)
   const id=pasteFragment(target,copied,parent,v.layout,models.nodes);setSelected(id)
  })
 }
 function openTree(id:string){if(!value?.document.trees[id])return;treePath.current.push(treeId);setTreeId(id);setSelected(value.document.trees[id].root_id);setInspectorTab('node')}
 function openNode(id:string){const item=tree?.nodes[id];if(item?.registration_id==='SubTree')openTree(item.attributes.ID);else{setSelected(id);setInspectorOpen(true);setInspectorTab('node')}}
 function openPalette(parent=selected,before?:string){returnFocus.current=document.activeElement as HTMLElement;insertion.current={parent:parent||tree?.root_id,before};setQuickSearch('');setCommandIndex(0);setPaletteOpen(true)}
 function locate(issue:Json){if(issue.tree_id&&value?.document.trees[issue.tree_id])setTreeId(issue.tree_id);if(issue.editor_id)setSelected(issue.editor_id);setInspectorTab('node');setInspectorOpen(true)}
 useEffect(()=>{
  function keydown(event:KeyboardEvent){
   if(!root.current||root.current.closest('[hidden]')||view!=='edit'||showLibrary)return
   const target=event.target as HTMLElement,typing=!!target.closest('input,textarea,select,[contenteditable=true]'),modifier=event.ctrlKey||event.metaKey,key=event.key.toLowerCase()
   if(modifier&&key==='s'){event.preventDefault();if(!readonly)void op.run(t("保存草稿"),save);return}
   if(modifier&&key==='k'&&!readonly){event.preventDefault();openPalette();return}
   if(typing)return
   if(modifier&&key==='z'){event.preventDefault();undo(event.shiftKey)}
   else if(modifier&&key==='y'){event.preventDefault();undo(true)}
   else if(modifier&&key==='c'){event.preventDefault();copy()}
   else if(modifier&&key==='v'&&!readonly){event.preventDefault();paste()}
   else if(modifier&&key==='d'&&!readonly){event.preventDefault();duplicateNode()}
   else if((key==='delete'||key==='backspace')&&!readonly){event.preventDefault();deleteNode()}
   else if(event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();order(event.key==='ArrowUp'?-1:1)}
   else if(key==='/'&&!readonly){event.preventDefault();openPalette()}
   else if(key==='escape'){setPaletteOpen(false);setExtractOpen(false);setInspectorOpen(false)}
  }
  window.addEventListener('keydown',keydown);return()=>window.removeEventListener('keydown',keydown)
 })
 function remember(next:Json){setTask(next);setTaskId(next.task_run_id);localStorage.setItem('agro.last_task',next.task_run_id)}
 async function cancelTask(phase:(value:string)=>void,signal:AbortSignal){
  if(!task)return;remember(await client.request<Json>(`/tasks/${task.task_run_id}/cancel`,'POST',{}));const deadline=Date.now()+15000
  while(Date.now()<deadline){signal.throwIfAborted();const next=await client.request<Json>(`/tasks/${task.task_run_id}`,'GET',undefined,signal);remember(next);phase(next.stop_confirmed?t("设备停止已确认"):t("正在确认设备停止"));if(!['RUNNING','ACCEPTED','CANCELING'].includes(next.state)){if(!next.stop_confirmed)throw Error(t("节点停止派发，设备停止尚未确认"));return}await new Promise(resolve=>setTimeout(resolve,400))}
  throw Error(t("设备停止尚未确认，请继续观察当前任务"))
 }
 async function start(){
  const prepared=await publish();if(!prepared)return
  const definition=prepared
  const request=durableIntent('tree-start',{definition_id:definition.id,previous:task&&!['RUNNING','ACCEPTED','CANCELING'].includes(task.state)?task.task_run_id:null});taskIntent.current=request;localStorage.setItem('agro.tree_request',request)
  try{remember(await client.request<Json>(`/trees/definitions/${definition.id}/start`,'POST',{request_id:request,confirm_safety:!configured&&safetyConfirmed}))}catch(error){if(error instanceof ApiError&&error.kind==='offline'){const found=await client.request<Json>(`/tasks/by-request/${request}`);if(found.found)remember(found.task);else throw error}else throw error}
  setView('run');await changed()
 }
 async function exportXml(){const current=dirtyRef.current?await save():currentDraft.current;if(!current)return;const result=await client.request<Json>(`/trees/drafts/${current.id}/xml`);if(window.agroDesktop)await window.agroDesktop.exportTreeXml(current.id);else{const url=URL.createObjectURL(new Blob([result.xml],{type:'application/xml'})),anchor=document.createElement('a');anchor.href=url;anchor.download=`${current.document.main_tree_id}.xml`;anchor.click();URL.revokeObjectURL(url)}setXml(result.xml)}
 async function previewExtraction(){if(!value)return;setProposal(await client.request<Json>('/trees/extract','POST',{document:value.document,tree_id:treeId,editor_id:selected,subtree_id:subtreeName}))}
 async function confirmExtraction(){if(!value||!proposal)return;const result=await client.request<Json>('/trees/extract','POST',{document:value.document,tree_id:treeId,editor_id:selected,subtree_id:subtreeName,ports:proposal.proposal});change(v=>{v.document=result.document});setSelected(result.call_id);setExtractOpen(false);setProposal(null)}
 useEffect(()=>{if(paletteOpen)document.getElementById(`bw-command-item-${commandIndex}`)?.scrollIntoView({block:'nearest'})},[paletteOpen,commandIndex])
 useEffect(()=>{
  if(!paletteOpen&&!extractOpen)return
  const previous=returnFocus.current
  return()=>{if(previous?.isConnected)previous.focus({preventScroll:true})}
 },[paletteOpen,extractOpen])
 function trapDialog(event:React.KeyboardEvent){
  if(event.key==='Escape'){event.stopPropagation();setPaletteOpen(false);setExtractOpen(false);return}
  if(event.key!=='Tab')return
  const items=event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]'),first=items[0],last=items[items.length-1]
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
 }
 const mainName=value?.name||t('行为树')
 const titleText=op.busy?op.phase:dirty?t("未保存"):draft?t("已保存"):t("新建行为")
 const needsBackend=Boolean(value&&Object.values(value.document.trees).some((tree:any)=>Object.values(tree.nodes).some((node:any)=>node.registration_id.startsWith('Capability_'))))

 if(showLibrary)return <div ref={root} className="behavior-workbench"><BehaviorLibrary items={library} busy={op.busy} loaded={loaded}
  onOpen={item=>void op.run(t('打开行为树'),()=>openBehavior(item.id))}
  onCreate={name=>op.run(t('新建行为树'),()=>create('general',name))}
  onRename={(item,name)=>op.run(t('重命名行为树'),async()=>{await client.request(`/trees/behaviors/${item.id}`,'PATCH',{name});await load()})}
  onCopy={(item,name)=>op.run(t('复制行为树'),async()=>{await client.request(`/trees/behaviors/${item.id}/copy`,'POST',{name});await load()})}
  onDelete={item=>op.run(t('删除行为树'),async()=>{await client.request(`/trees/behaviors/${item.id}`,'DELETE');if(draft?.id===item.id){setDraft(null);setValue(null)}await load()})}
  onImport={file=>void op.run(t('导入行为树'),()=>importFile(file))}
  error={op.error?<div className="bw-operation-error"><ErrorFields value={op.error}/><button type="button" aria-label={t('关闭错误')} onClick={()=>op.setError(null)}><Icon name="close"/></button></div>:null}/></div>

 return <div ref={root} className={`behavior-workbench${inspectorOpen?' bw-inspector-open':''}`}>
  <header className="bw-toolbar">
   <div className="bw-document-title"><button title={onBack?t('返回状态'):t('返回行为树列表')} aria-label={onBack?t('返回状态'):t('返回行为树列表')} onClick={()=>void op.run(t('保存并返回'),async()=>{if(onBack){if(dirtyRef.current)await save();onBack()}else await backToLibrary()})}><Icon name="back"/></button><Icon name="tree"/><div><strong>{mainName}</strong><span role="status" aria-live="polite">{titleText}</span></div></div>
   <div className="bw-toolbar-actions"><button title={t("撤销 ⌘ Z")} aria-label={t("撤销")} disabled={!history.current.past.length||readonly} onClick={()=>undo()}><Icon name="undo"/></button><button title={t("重做 ⇧ ⌘ Z")} aria-label={t("重做")} disabled={!history.current.future.length||readonly} onClick={()=>undo(true)}><Icon name="redo"/></button><i/>
    <button disabled={op.busy||readonly||!draft} onClick={()=>void op.run(t("保存草稿"),save)}>{t("保存")}</button><button disabled={op.busy||readonly||!draft} onClick={()=>void op.run(t("检查结构和数据"),checked)}><Icon name="check"/><span className="bw-tool-label">{t("校验")}</span></button>{onBound&&<button className="bw-publish" disabled={op.busy||readonly||!draft} onClick={()=>void op.run(t("保存状态行为"),async()=>{const saved=await save();if(saved)onBound(saved.id)})}>{t("保存并使用")}</button>}
   </div>
  </header>
  <div className="bw-documentbar"><div className="bw-breadcrumb">{contextLabel&&<><span>{contextLabel}</span><Icon name="chevron"/></>}{treePath.current.length>0&&<button onClick={()=>{const id=treePath.current.pop()!;setTreeId(id);setSelected(value!.document.trees[id].root_id)}}><Icon name="back"/></button>}<span>{t("行为树")}</span>{tree&&<><Icon name="chevron"/><select aria-label={t("当前子树")} value={treeId} onChange={event=>{treePath.current=[];setTreeId(event.target.value);setSelected(value!.document.trees[event.target.value].root_id)}}>{Object.keys(value!.document.trees).map(id=><option key={id}>{id}</option>)}</select></>}</div>
   <div className="bw-view-toggle"><button aria-pressed={view==='edit'} onClick={()=>setView('edit')}>{t("编排")}</button><button aria-pressed={view==='run'} onClick={()=>setView('run')}>{t('试运行')}</button></div>
   <details className="bw-menu"><summary aria-label={t("文档操作")}><Icon name="more"/></summary><div className="bw-menu-content"><button disabled={!draft||readonly||op.busy} onClick={()=>void op.run(t("导出 XML"),exportXml)}>{t("导出 XML")}</button>{draft&&<button disabled={op.busy} onClick={()=>void op.run(t("重新加载"),async()=>{if(dirtyRef.current&&!window.confirm(t("重新加载将放弃尚未保存的修改")))return;choose(await client.request<Json>(`/trees/drafts/${draft.id}`));await load()})}>{t("重新加载草稿")}</button>}</div></details>
  </div>
  {((!configured&&needsBackend)||models?.offline_only)&&<div className="bw-notice"><span>{!configured&&needsBackend?t("设计内容可离线保存，执行前需要应用机器人配置"):t("离线设计可保存并关联，执行前检查运行环境")}</span>{!configured&&needsBackend&&onNavigate&&<button onClick={()=>onNavigate('system')}>{t("打开机器人配置 ")}<Icon name="arrow"/></button>}</div>}

  {view==='run'?<div className="bw-runtime">{!configured&&<label className="bw-safety-confirm"><input type="checkbox" checked={safetyConfirmed} onChange={event=>setSafetyConfirmed(event.target.checked)}/><span>{t("已确认设备急停、动作取消与通信失联保护可用")}</span></label>}<div className="bw-runtime-toolbar"><button disabled={op.busy||!draft||(configured?observation?.system.state!=='READY':!safetyConfirmed)||observation?.control.mode!=='STANDBY'} onClick={()=>void op.run(t("启动行为"),start)}><Icon name="play"/>{t('试运行当前行为树')}</button><button disabled={op.busy||!task||!['RUNNING','ACCEPTED','CANCELING'].includes(task.state)} onClick={()=>void op.run(t("取消任务"),cancelTask)}>{t("取消任务")}</button></div>{dirty&&<div className="bw-notice">{t("执行前将保存并检查当前修改")}</div>}{stale&&<p className="bw-field-error">{t("连接中断 · 恢复后继续观察当前任务")}</p>}{task?<RuntimeTree task={task} language={language}/>:<div className="bw-empty"><Icon name="play"/><h3>{t("等待运行")}</h3><p>{t('试运行当前行为树，或前往运行台查看完整记录')}</p></div>}</div>:tree&&value&&models?<>
   {readonly&&<div className="bw-notice">{t("导入的 XML 含有未支持节点 · 当前为只读")}</div>}
   <div className="bw-workspace">
    <aside className="bw-library"><div className="bw-pane-tabs"><button aria-pressed={libraryTab==='nodes'} onClick={()=>setLibraryTab('nodes')}>{libraryTab==='nodes'&&<motion.span layoutId="tree-library-tab" className="workspace-selection" transition={springs.quick}/>}<span>{t("节点库")}</span></button><button aria-pressed={libraryTab==='structure'} onClick={()=>setLibraryTab('structure')}>{libraryTab==='structure'&&<motion.span layoutId="tree-library-tab" className="workspace-selection" transition={springs.quick}/>}<span>{t("结构")}</span></button></div>
     {libraryTab==='nodes'?<><div className="bw-library-search"><Icon name="search"/><input aria-label={t("搜索节点")} type="search" placeholder={t("搜索节点")} value={nodeSearch} onChange={event=>setNodeSearch(event.target.value)}/></div><div className="bw-library-filters">{[['all',t('全部')],...groups].map(([id,label])=><button key={id} aria-pressed={nodeFilter===id} onClick={()=>setNodeFilter(id)}>{label}</button>)}</div><div className="bw-palette-list">{groups.map(([key,label])=>{const items=choices.filter(choice=>category(choice)===key);return items.length?<section className="bw-palette-group" key={key}><h4>{label}</h4>{items.map(choice=><div key={choice.registration_id} className="bw-palette-item" draggable={!readonly} onDragStart={event=>{event.dataTransfer.setData('application/x-agro-node',choice.registration_id);event.dataTransfer.effectAllowed='copy'}} onDoubleClick={()=>add(selected,choice.registration_id)} title={t(choice.description||title(choice))}><Icon name={choice.ros_task_id||choice.capability_id?'play':'tree'}/><div><span>{title(choice)}</span><small>{group(choice)}</small></div><button aria-label={t("添加{0}", {0: title(choice)})} title={t("添加到当前节点")} disabled={readonly} onClick={()=>add(selected,choice.registration_id)}><Icon name="plus"/></button></div>)}</section>:null})}{!choices.length&&<p className="bw-muted">{t("没有匹配节点")}</p>}</div><div className="bw-library-foot">{t("拖到画布连接处插入")}</div></>:<div className="bw-outline-wrap"><TreeOutline tree={tree} labels={value.layout.labels} selected={selected} onSelect={id=>{setSelected(id);setInspectorTab('node')}} onAdd={add} onReparent={moveNode} disabled={readonly}/></div>}
    </aside>
    <main className="bw-graph"><div className="bw-graph-toolbar"><button disabled={readonly} onClick={()=>openPalette()}><Icon name="plus"/>{t("添加节点 ")}<kbd>⌘ K</kbd></button><span/><button className="bw-inspector-toggle" title={t("节点属性")} onClick={()=>setInspectorOpen(!inspectorOpen)}><Icon name="settings"/>{t("属性")}</button><button title={t("自动整理当前子树")} disabled={readonly} onClick={()=>{change(v=>{v.layout.positions={...v.layout.positions,...positions(tree)}});setLayoutKey(key=>key+1)}}><Icon name="layers"/>{t("整理")}</button></div>
     <TreeCanvas language={language} tree={tree} layout={value.layout} models={models.nodes} viewKey={`${draft?.id}:${treeId}`} layoutKey={layoutKey} selected={selected} onSelect={id=>{setSelected(id);setInspectorTab('node')}} onOpen={openNode} onInsert={readonly?undefined:add} onReparent={readonly?undefined:moveNode} onAddAt={readonly?undefined:openPalette} onDelete={readonly?undefined:deleteNode} onDuplicate={readonly?undefined:duplicateNode} onMove={readonly?undefined:(id,x,y)=>change(v=>translateBranch(v.document.trees[treeId],id,v.layout,x,y))} bindings={sources.filter(source=>source.editor_id===selected)} portModels={portModels} diagnostics={diagnostics.filter(issue=>!issue.tree_id||issue.tree_id===treeId)}/>
    </main>
    <AnimatePresence initial={false}>{inspectorOpen&&<SpatialPanel width="var(--tree-inspector-width)" className="bw-inspector"><div className="bw-pane-tabs"><button aria-pressed={inspectorTab==='node'} onClick={()=>setInspectorTab('node')}>{inspectorTab==='node'&&<motion.span layoutId="tree-inspector-tab" className="workspace-selection" transition={springs.quick}/>}<span>{t("节点属性")}</span></button><button aria-pressed={inspectorTab==='task'} onClick={()=>setInspectorTab('task')}>{inspectorTab==='task'&&<motion.span layoutId="tree-inspector-tab" className="workspace-selection" transition={springs.quick}/>}<span>{t('行为树设置')}</span></button><button className="bw-inspector-close" aria-label={t("关闭属性")} onClick={()=>setInspectorOpen(false)}><Icon name="close"/></button></div><div className="bw-inspector-scroll">
     {inspectorTab==='node'?<NodeInspector value={value} treeId={treeId} selected={selected} models={models} readonly={readonly} diagnostics={diagnostics.filter(issue=>!issue.tree_id||issue.tree_id===treeId)} language={language} change={change} onReparent={moveNode} onOrder={order} onDuplicate={duplicateNode} onDelete={deleteNode} onOpen={openNode} onExtract={()=>{returnFocus.current=document.activeElement as HTMLElement;let name='Extracted',index=1;while(value.document.trees[name])name=`Extracted_${index++}`;setSubtreeName(name);setProposal(null);setExtractOpen(true)}} bindings={suggestedBindings}/>:<><div className="bw-inspector-heading"><span className="bw-eyebrow">{t("行为定义")}</span><h3>{t('行为树设置')}</h3></div><div className="bw-inspector-section"><Field label={t('行为树名称')}><input disabled={readonly} value={value.name||''} maxLength={80} placeholder={t('输入行为树名称')} onChange={event=>change(v=>{v.name=event.target.value},'behavior.name')}/></Field><Field label={t("执行根树")}><select disabled={readonly} value={value.document.main_tree_id} onChange={event=>change(v=>{v.document.main_tree_id=event.target.value})}>{Object.keys(value.document.trees).map(id=><option key={id}>{id}</option>)}</select></Field></div><div className="bw-task-inputs"><TaskInputs specs={value.document.inputs||{}} values={value.parameters} disabled={readonly} onChange={(inputs,parameters)=>change(v=>{v.document.inputs=inputs;v.parameters=parameters})}/></div><details className="bw-inspector-section"><summary>{t("子树端口与数据声明")}</summary><Field label={t("端口声明 JSON")}><textarea disabled={readonly} value={advanced} placeholder={JSON.stringify({inputs:value.document.inputs||{},ports:tree.ports},null,2)} onChange={event=>setAdvanced(event.target.value)}/></Field><button disabled={readonly||!advanced.trim()} onClick={()=>{try{const next=JSON.parse(advanced);change(v=>{v.document.inputs=next.inputs||{};v.document.trees[treeId].ports=next.ports||{}});setAdvanced('')}catch{op.setError(Error(t("端口声明不是有效的 JSON")))}}}>{t("应用声明")}</button></details>{(xml||readonly)&&<details className="bw-inspector-section"><summary>XML</summary><pre>{readonly?value.document.original_xml:xml}</pre></details>}</>}
    </div></SpatialPanel>}</AnimatePresence>
   </div>
  </>:<div className="bw-empty"><Icon name="tree"/><h3>{t("从一个行为开始")}</h3><p>{t("连接机器人任务，编排执行顺序")}</p><button className="bw-publish" disabled={op.busy||!loaded} onClick={()=>void op.run(t("新建行为"),()=>create())}><Icon name="plus"/>{t("新建行为树")}</button></div>}
  {diagnosticsOpen&&<div className="bw-diagnostics"><header><strong>{diagnostics.length?t("{0} 项待处理", {0: diagnostics.length}):t("结构与数据")}</strong><button aria-label={t("关闭诊断")} onClick={()=>setDiagnosticsOpen(false)}><Icon name="close"/></button></header>{diagnostics.length?diagnostics.map((issue,index)=><button className="bw-diagnostic" key={index} onClick={()=>locate(issue)}><span className={issue.severity==='warning'?'bw-pending-dot':'bw-issue-dot'}/><span>{t(issue.reason)}</span><small>{issue.port||issue.tree_id}</small><Icon name="chevron"/></button>):<p>{t('未发现结构问题，运行前仍会检查执行条件')}</p>}<details><summary>{t("数据来源")}</summary><pre>{JSON.stringify(sources,null,2)}</pre></details></div>}
  {op.error&&<div className="bw-operation-error"><ErrorFields value={op.error}/><button aria-label={t("关闭错误")} onClick={()=>op.setError(null)}><Icon name="close"/></button></div>}
  <footer className="bw-statusbar"><button onClick={()=>setDiagnosticsOpen(!diagnosticsOpen)}><span className={diagnostics.some(issue=>issue.severity==='error')?'bw-issue-dot':diagnostics.length?'bw-pending-dot':'bw-status-dot'}/>{diagnostics.length?t("{0} 项待处理", {0: diagnostics.length}):checkFeedback?.ok?t("校验通过"):t("结构检查")}</button><span>{tree?t("{0} 个节点", {0: Object.keys(tree.nodes).length}):''}</span><span className="bw-status-end">{readonly?t('只读'):dirty?t('未保存'):draft?t('已保存'):''}</span></footer>
  <AnimatePresence>{paletteOpen&&<PresenceLayer initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} transition={fade} className="bw-popover-backdrop" onPointerDown={()=>setPaletteOpen(false)}><motion.div initial={{opacity:0,y:-5,scale:.99}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:-3,scale:.995}} transition={springs.quick} className="bw-command" role="dialog" aria-modal="true" aria-label={t("添加节点")} onKeyDown={trapDialog} onPointerDown={event=>event.stopPropagation()}><div className="bw-command-search"><Icon name="search"/><input autoFocus aria-label={t("查找要插入的节点")} placeholder={t("查找动作或流程节点")} value={quickSearch} onChange={event=>{setQuickSearch(event.target.value);setCommandIndex(0)}} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setCommandIndex(index=>Math.max(0,Math.min(quickChoices.length-1,index+(event.key==='ArrowDown'?1:-1))))}if(event.key==='Enter'&&quickChoices[commandIndex]){event.preventDefault();add(insertion.current?.parent,quickChoices[commandIndex].registration_id,insertion.current?.before);setPaletteOpen(false)}if(event.key==='Escape')setPaletteOpen(false)}}/><kbd>Esc</kbd></div><div className="bw-command-list">{quickChoices.map((choice,index)=><button id={`bw-command-item-${index}`} className={commandIndex===index?'is-highlighted':''} onPointerMove={()=>setCommandIndex(index)} key={choice.registration_id} onClick={()=>{add(insertion.current?.parent,choice.registration_id,insertion.current?.before);setPaletteOpen(false)}}><Icon name={choice.capability_id||choice.ros_task_id?'play':'tree'}/><div><span>{title(choice)}</span><small>{t(choice.description||group(choice))}</small></div><Icon name="plus"/></button>)}{!quickChoices.length&&<p>{t("没有匹配节点")}</p>}</div><footer>{insertion.current?.before?t("插入到当前连接"):t("添加到当前流程")}</footer></motion.div></PresenceLayer>}</AnimatePresence>
  <AnimatePresence>{extractOpen&&<PresenceLayer initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} transition={fade} className="bw-popover-backdrop" onPointerDown={()=>setExtractOpen(false)}><motion.div initial={{opacity:0,y:8,scale:.985}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:5,scale:.99}} transition={springs.panel} className="bw-extract" role="dialog" aria-modal="true" aria-label={t("提取子树")} onKeyDown={trapDialog} onPointerDown={event=>event.stopPropagation()}><header><h3>{t("提取子树")}</h3><button aria-label={t("关闭")} onClick={()=>setExtractOpen(false)}><Icon name="close"/></button></header><p>{t("保留跨边界的数据输入与输出")}</p><Field label={t("子树标识")}><input autoFocus value={subtreeName} onChange={event=>{setSubtreeName(event.target.value);setProposal(null)}}/></Field>{proposal&&<div className="bw-extract-ports">{Object.entries(proposal.proposal||{}).map(([name,spec]:[string,any])=><div key={name}><strong>{name}</strong><span>{spec.direction} · {spec.type?.type||spec.type}</span></div>)}{!Object.keys(proposal.proposal||{}).length&&<p>{t("没有跨边界端口")}</p>}</div>}<footer><button onClick={()=>setExtractOpen(false)}>{t("取消")}</button><button className="bw-publish" disabled={op.busy||readonly||!subtreeName.trim()} onClick={()=>void op.run(proposal?t("提取子树"):t("分析数据边界"),proposal?confirmExtraction:previewExtraction)}>{proposal?t("确认提取"):t("检查端口")}</button></footer></motion.div></PresenceLayer>}</AnimatePresence>
 </div>
}
