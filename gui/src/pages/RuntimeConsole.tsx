import {useEffect,useRef,useState} from 'react'
import DisclosureCard from '../components/DisclosureCard'
import DeploymentPanel from './DeploymentPanel'
import {takeStudioLocation,type StudioLocation} from '../studio-links'
import StopRecovery from './StopRecovery'
import {reportError as showError} from '../components/StudioDialogs'
import {useLocale} from '../locale'
import {prepareRobot} from './prepareRobot'
import {active,runtimeActivity} from './runtime-activity'
import {canceledPreparation,elapsedText,matchingPreparation,preparationFailed,runtimeStatusNames,terminalJob} from './runtime-model'
import {Feedback,FlowBranches,FlowOverview,PreparationSummary,RuntimeTimeline} from './runtime-overview'
import {Icon} from '../components/Icon'
import HsmCanvas from './HsmCanvas'
import RuntimeTree from './TaskEditor/RuntimeTree'
import Records from './Records'
import {ApiError} from '../api'
import {waitJob,type Json,type PageProps} from './shared'
import type {Workspace} from '../types'

export default function RuntimeConsole({client,observation,language,onNavigate,initialHistory=false,robotId}:PageProps&{onNavigate:(page:Workspace)=>void;initialHistory?:boolean;robotId?:string}){
 const {t}=useLocale()
 const [tab,setTab]=useState<'flow'|'tree'|'history'>(initialHistory?'history':'flow')
 const [machines,setMachines]=useState<Json[]>([]),[definitions,setDefinitions]=useState<Json[]>([]),[rosTasks,setRosTasks]=useState<Json[]>([])
 const [flowRuns,setFlowRuns]=useState<Json[]>([]),[taskRuns,setTaskRuns]=useState<Json[]>([])
 const [flowId,setFlowId]=useState(''),[treeId,setTreeId]=useState(''),[session,setSession]=useState<Json|null>(null)
 const [task,setTask]=useState<Json|null>(null),[history,setHistory]=useState<Json|null>(null),[selected,setSelected]=useState(''),[historyEvent,setHistoryEvent]=useState(-1)
 const [configurationReady,setConfigurationReady]=useState(false),[statusConnected,setStatusConnected]=useState(false),[confirmed,setConfirmed]=useState(false)
 const [busy,setBusy]=useState(false),[stopBusy,setStopBusy]=useState(false),[launchPhase,setLaunchPhase]=useState<'prepare'|'start'|null>(null)
 const [deployment,setDeployment]=useState<Json|null>(null),[jobs,setJobs]=useState<Json[]>([]),[preparationJob,setPreparationJob]=useState<Json|null>(null)
 const [preparationAttempt,setPreparationAttempt]=useState<Json|null>(null),[stopStartedAt,setStopStartedAt]=useState('')
 const [error,setError]=useState(''),[connectionError,setConnectionError]=useState(''),[message,setMessage]=useState('')
 const [event,setEvent]=useState(''),[variables,setVariables]=useState('{}'),[showRecords,setShowRecords]=useState(false),[inspected,setInspected]=useState<Json|null>(null)
 const [graphOpen,setGraphOpen]=useState(false),[reveal,setReveal]=useState<{id:string;nonce:number}>(),[now,setNow]=useState(Date.now())
 const alive=useRef(true),lock=useRef(false),stopLock=useRef(false),stopRequested=useRef(false),locationRequest=useRef<AbortController|null>(null),graph=useRef<HTMLElement>(null)
 const reportError=(cause:unknown)=>{showError(cause);setError(cause instanceof ApiError?cause.details.map(item=>t(item.reason)).join(' · ')||t('连接暂时不可用'):String(cause))}
 useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[])
 useEffect(()=>{if(!message)return;const timer=window.setTimeout(()=>setMessage(''),5000);return()=>clearTimeout(timer)},[message])
 useEffect(()=>{
  const accept=async(location:StudioLocation|null)=>{
   if(!location||location.page!=='runtime'||location.robotId&&location.robotId!==robotId)return
   locationRequest.current?.abort();setSelected('');setInspected(null)
   if(location.runId){
    const controller=new AbortController();locationRequest.current=controller
    const flow=location.runId.startsWith('session_')
    if(flow){setTab('history');setShowRecords(false);setHistoryEvent(-1);setHistory(null)}else{setTab('tree');setTask(null)}
    try{const run=await client.request<Json>((flow?'/studio/flow-runs/':'/tasks/')+location.runId,'GET',undefined,controller.signal);if(controller.signal.aborted||!alive.current)return;if(flow)setHistory(run);else setTask(run)}catch(cause){if(!controller.signal.aborted&&alive.current)reportError(cause)}
   }else if(location.machineId){setFlowId(location.machineId);setTab('flow')}
   else if(location.treeId){setTreeId(location.treeId);setTab('tree')}
  }
  void accept(takeStudioLocation(robotId,'runtime'))
  const receive=(event:Event)=>{const location=(event as CustomEvent<StudioLocation>).detail;if(location.page==='runtime'){takeStudioLocation(robotId,'runtime');void accept(location)}}
  window.addEventListener('agro:studio:located',receive)
  return()=>{locationRequest.current?.abort();window.removeEventListener('agro:studio:located',receive)}
 },[robotId,client])
 useEffect(()=>{
  alive.current=true;let timer=0;const controller=new AbortController()
  const read=async()=>{
   try{
    const [m,d,s,tr,fr,r,dep,j]=await Promise.all([
     client.request<Json>('/state-machines','GET',undefined,controller.signal),client.request<Json>('/trees/behaviors','GET',undefined,controller.signal),
     client.request<Json>('/state-machines/status','GET',undefined,controller.signal),client.request<Json>('/studio/task-runs','GET',undefined,controller.signal),
     client.request<Json>('/studio/flow-runs','GET',undefined,controller.signal),client.request<Json>('/ros/tasks','GET',undefined,controller.signal),
     client.request<Json>('/deployment/status','GET',undefined,controller.signal),client.request<Json>('/management/jobs','GET',undefined,controller.signal)])
    if(!alive.current)return
    setMachines(m.machines||[]);setDefinitions(d.definitions||[])
    setSession(s.session);setTaskRuns(tr.tasks||[]);setFlowRuns(fr.runs||[]);setRosTasks(r.tasks||[]);setDeployment(dep);setJobs(j.jobs||[])
    setPreparationJob(previous=>previous?j.jobs?.find((job:Json)=>job.id===previous.id)||previous:null)
    setFlowId(old=>old||m.machines?.[0]?.id||'');setTreeId(old=>old||d.definitions?.find((item:Json)=>!item.draft_id)?.id||'')
    setStatusConnected(true);setConnectionError('')
   }catch{if(alive.current){setStatusConnected(false);setConnectionError(t('运行状态读取中断，保留上次状态；恢复连接后继续观察'))}}
   finally{if(alive.current)timer=window.setTimeout(read,1200)}
  }
  void read();return()=>{alive.current=false;controller.abort();clearTimeout(timer)}
 },[client])
 useEffect(()=>{
  if(!task?.task_run_id)return
  const identity=task.task_run_id,controller=new AbortController();let valid=true,timer=0
  const read=async()=>{try{const next=await client.request<Json>('/tasks/'+identity,'GET',undefined,controller.signal);if(valid)setTask(previous=>previous?.task_run_id===identity?next:previous)}catch{}finally{if(valid)timer=window.setTimeout(read,1000)}}
  void read();return()=>{valid=false;controller.abort();clearTimeout(timer)}
 },[task?.task_run_id,client])
 async function action(work:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');try{await work()}catch(cause){reportError(cause)}finally{lock.current=false;if(alive.current)setBusy(false)}}
 function updateTaskRun(next:Json){setTaskRuns(previous=>previous.some(run=>run.task_run_id===next.task_run_id)?previous.map(run=>run.task_run_id===next.task_run_id?{...run,...next}:run):[...previous,next])}
 const kind=tab==='tree'?'tree':'flow',reference=kind==='tree'?treeId:flowId
 const referenceAliases=[reference,...(kind==='tree'?definitions.filter(item=>item.draft_id===reference).map(item=>item.id):[])]
 const selectableDefinitions=definitions.filter(item=>!item.draft_id||!definitions.some(other=>other.id===item.draft_id))
 const remotePreparation=matchingPreparation(jobs,kind,referenceAliases,robotId)
 const localPreparation=preparationJob&&preparationJob.context?.kind===kind&&referenceAliases.includes(preparationJob.context.reference)?preparationJob:null
 const attempt=preparationAttempt?.kind===kind&&referenceAliases.includes(preparationAttempt.reference)?preparationAttempt:null
 const currentJob=[localPreparation,remotePreparation].filter((job):job is Json=>!!job&&(!attempt||Date.parse(job.started_at)>=Date.parse(attempt.started_at))).sort((a,b)=>(Date.parse(b.started_at)||0)-(Date.parse(a.started_at)||0))[0]||null
 const preparing=launchPhase!==null||!!currentJob&&!terminalJob(currentJob)
 const deploymentBusy=['PREPARING','STARTING','STOPPING'].includes(deployment?.state||'')
 const stopping=stopBusy||deployment?.state==='STOPPING'
 const displayCutoff=stopping?stopStartedAt:currentJob?.started_at||attempt?.started_at
 const staleProgress=!!displayCutoff&&!(Date.parse(deployment?.progress?.started_at)>=Date.parse(displayCutoff))
 const displayedDeployment=staleProgress&&deployment?{...deployment,progress:null,reason:null,state:stopping?'STOPPING':preparing?'PREPARING':currentJob?.phase==='completed'?'READY':deployment.state}:deployment
 const activity=runtimeActivity(session,taskRuns)
 const systemBusy=['STARTING','STOPPING'].includes(observation?.system.state||'')
 const launchBlocked=activity.blocked||preparing||deploymentBusy||systemBusy
 async function start(){
  stopRequested.current=false;setInspected(null);setHistoryEvent(-1);setPreparationJob(null);setPreparationAttempt({kind,reference,started_at:new Date().toISOString()});setLaunchPhase('prepare')
  let selectedReference=reference
  try{
   if(kind==='tree'&&selectedReference.startsWith('draft_')){
    const draft=await client.request<Json>(`/trees/drafts/${selectedReference}`)
    const frozen=await client.request<Json>(`/trees/drafts/${selectedReference}/publish`,'POST',{revision:draft.revision,base_snapshot_id:observation?.system.snapshot_id})
    selectedReference=frozen.id
   }
   await prepareRobot(client,{kind,reference:selectedReference,confirm_safety:confirmed},(job:Json)=>setPreparationJob({...job,context:job.context||{kind,reference:selectedReference,robot_system_id:robotId}}))
   if(stopRequested.current)return
   setLaunchPhase('start')
   if(kind==='flow'){
    await client.request(`/state-machines/${selectedReference}/start`,'POST',{mode:'auto',confirm_safety:confirmed},undefined,120000)
    setSession((await client.request<Json>('/state-machines/status')).session)
   }else{
    const request='request_'+crypto.randomUUID().replaceAll('-','')
    let next:Json
    try{next=await client.request<Json>(`/trees/definitions/${selectedReference}/start`,'POST',{request_id:request,confirm_safety:confirmed},undefined,120000)}
    catch(cause){if(!(cause instanceof ApiError)||cause.kind!=='offline')throw cause;const found=await client.request<Json>('/tasks/by-request/'+request);if(!found.found)throw cause;next=found.task}
    updateTaskRun(next);setTask(next)
   }
   setMessage(t('运行请求已提交'))
  }catch(cause){if(!stopRequested.current)throw cause}
  finally{if(alive.current)setLaunchPhase(null)}
 }
 async function cancel(){
  if(activity.flow&&active(activity.flow.status)){await client.request('/state-machines/stop','POST',{});setSession((await client.request<Json>('/state-machines/status')).session)}
  else if(activity.task&&active(activity.task.state)){const next=await client.request<Json>(`/tasks/${activity.task.task_run_id}/cancel`,'POST',{});updateTaskRun(next);setTask(previous=>previous?.task_run_id===next.task_run_id?next:previous)}
  setMessage(t('取消请求已提交，等待设备确认'))
 }
 async function stopAll(){
  if(stopLock.current)return;stopLock.current=true;stopRequested.current=true;setStopStartedAt(new Date().toISOString());setStopBusy(true);setError('');setMessage('')
  try{
   const accepted=await client.request<Json>('/deployment/stop','POST',{})
   await waitJob(client,accepted.management_job_id,()=>{},undefined,300000)
   setDeployment(await client.request<Json>('/deployment/status'));setMessage(t('工作流与子系统已停止'))
  }catch(cause){reportError(cause)}finally{stopLock.current=false;if(alive.current)setStopBusy(false)}
 }
 async function showActivity(){
  locationRequest.current?.abort();setSelected('');setInspected(null)
  if(activity.flow){setFlowId(activity.flow.machine_id);setTab('flow')}
  else if(activity.task){setTab('tree');setTask(await client.request<Json>('/tasks/'+activity.task.task_run_id))}
 }
 async function inspectBehavior(behavior:Json){setInspected(behavior);if(behavior.task_run_id)setTask(await client.request<Json>('/tasks/'+behavior.task_run_id))}
 const selectedSession=session?.machine_id===flowId?session:null
 const flowRunCutoff=kind==='flow'?currentJob?.started_at||attempt?.started_at:undefined
 const previousSession=!!flowRunCutoff&&!(Date.parse(selectedSession?.started_at)>=Date.parse(flowRunCutoff))
 const shownSession=tab==='history'?history:preparing&&!stopping||previousSession?null:selectedSession
 const preparationCancelled=tab!=='history'&&!preparing&&!stopping&&canceledPreparation(currentJob,jobs,displayedDeployment,kind==='tree'?task:selectedSession)
 const failedPreparation=tab!=='history'&&!preparing&&!stopping&&!preparationCancelled&&preparationFailed(currentJob,displayedDeployment,kind==='tree'?task:shownSession,kind,referenceAliases)
 const machine=shownSession?.definition||machines.find(item=>item.id===flowId)||null
 const states:Json[]=machine?.document?.states||[]
 const taskLabels:Record<string,string>={}
 for(const definition of definitions){const doc=definition.document;taskLabels[definition.id]=definition.name||definition.layout?.labels?.[doc?.trees?.[doc.main_tree_id]?.root_id]||doc?.main_tree_id||definition.id}
 for(const entry of rosTasks)taskLabels['ros:'+entry.id]=entry.name
 for(const [ref,entry] of Object.entries(shownSession?.dependencies||{}) as [string,Json][]){taskLabels[ref]=entry.name||entry.document?.main_tree_id||ref}
 let path:string[]=shownSession?.path||[]
 if(tab==='history'&&historyEvent>=0&&history?.events?.[historyEvent]){
  path=[];let id=history.events[historyEvent].target
  for(let depth=0;id&&depth<50;depth++){path.unshift(id);id=states.find(state=>state.id===id)?.parent}
 }
 const selectedState=states.find(item=>item.id===(selected||shownSession?.active))
 const inspectedBehavior=(shownSession?.behaviors||[]).find((item:Json)=>item.id===inspected?.id)||inspected
 const relevantBehaviors:Json[]=shownSession?.behaviors||[]
 const editable=tab==='flow'&&shownSession&&active(shownSession.status)&&shownSession.status!=='STOPPING'
 function openState(stateId:string){sessionStorage.setItem('atil.flow.reveal',JSON.stringify({machineId:machine?.id,stateId}));onNavigate('editor')}
 function locateState(){if(!shownSession?.active)return;setGraphOpen(true);setSelected(shownSession.active);setReveal(previous=>({id:shownSession.active,nonce:(previous?.nonce||0)+1}));requestAnimationFrame(()=>graph.current?.scrollIntoView({block:'start',behavior:'smooth'}))}
 const runtimeStatus=!statusConnected?t('运行状态待刷新'):stopping?t('正在停止'):preparing?t('准备执行'):activity.status?t(runtimeStatusNames[activity.status]||activity.status):preparationCancelled?t('准备已取消'):failedPreparation?t('准备失败'):t(runtimeStatusNames[(tab==='tree'?taskRuns.at(-1)?.state:session?.status)||'']||'尚未运行')
 const canStop=stopBusy||preparing||deploymentBusy||!!deployment?.modules?.length||activity.blocked
 return <div className="run-console runtime-console-v2">
  <header className="run-console-header"><nav aria-label={t('运行视图')}>{[['flow','状态流程'],['tree','行为树'],['history','运行记录']].map(([id,label])=><button key={id} aria-current={tab===id?'page':undefined} onClick={()=>{locationRequest.current?.abort();setTab(id as typeof tab);setSelected('');setInspected(null)}}>{t(label)}</button>)}</nav><div className="buttons"><span className={'run-state '+(activity.blocked||preparing?'live':'')}>{runtimeStatus}</span>{activity.blocked&&<button disabled={busy} onClick={()=>void action(showActivity)}>{t('查看活动执行')}</button>}<button disabled={busy||!activity.canCancel} title={t('取消活动任务并保留子系统')} onClick={()=>void action(cancel)}><Icon name="stop"/>{t('取消运行')}</button><button disabled={stopBusy||!canStop} onClick={()=>void stopAll()}>{t(stopBusy?'正在停止':'停止工作流与子系统')}</button><button onClick={()=>onNavigate('editor')}>{t('返回编排')}</button></div></header>
  {tab!=='history'&&<div className="run-launch"><label className="field"><span>{t(kind==='flow'?'选择状态流程':'选择行为树')}</span><select aria-label={t(kind==='flow'?'运行状态流程':'运行行为树')} value={reference} disabled={busy||launchBlocked} onChange={event=>{kind==='flow'?setFlowId(event.target.value):setTreeId(event.target.value);setSelected('');setInspected(null);setPreparationJob(null)}}><option value="">{t('请选择')}</option>{(kind==='flow'?machines:selectableDefinitions).map(item=><option key={item.id} value={item.id}>{kind==='flow'?item.name:taskLabels[item.id]}</option>)}</select></label><div className="run-launch-actions"><label className="toggle"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/><span>{t('已确认设备环境安全')}</span></label><button className="primary" disabled={busy||!statusConnected||launchBlocked||!confirmed||!configurationReady||!reference} onClick={()=>void action(start)}><Icon name="play"/>{t(preparing?'正在准备':'开始运行')}</button></div></div>}
  <div className="runtime-main-scroll" tabIndex={0} aria-label={t('运行内容')}>
   <div className="runtime-workspace">
    {connectionError&&<p className="runtime-connection-note" role="status">{connectionError}</p>}
    {(error||message)&&<div className={error?'run-feedback error':'run-feedback'} role="status"><span>{error||message}</span><button aria-label={t('关闭提示')} onClick={()=>{setError('');setMessage('')}}>×</button></div>}
    {tab!=='history'&&<DeploymentPanel client={client} kind={kind} reference={reference} running={activity.blocked} onReady={setConfigurationReady} managementJob={stopping?null:currentJob} deploymentStatus={displayedDeployment} onStop={()=>void stopAll()} stopping={stopBusy} preparationCancelled={preparationCancelled}/>}
    {tab==='history'&&<><div className="runtime-history-heading"><h2>{t('运行记录')}</h2><button onClick={()=>{setShowRecords(!showRecords);setHistory(null)}}>{t(showRecords?'查看状态流程记录':'查看任务执行记录')}</button></div>{!showRecords&&<DisclosureCard title={t('选择运行记录')} count={flowRuns.length} summary={history?.definition?.name||t('选择保存的流程执行记录')}><div className="runtime-run-picker">{[...flowRuns].reverse().map(run=><button key={run.id} aria-pressed={history?.id===run.id} onClick={()=>void action(async()=>{setHistoryEvent(-1);setSelected('');setInspected(null);setHistory(await client.request<Json>('/studio/flow-runs/'+run.id))})}><strong>{run.name}</strong><span>{t(runtimeStatusNames[run.status]||run.status)} · {run.sequence}</span></button>)}</div></DisclosureCard>}</>}
    {tab==='tree'?<>
     <DisclosureCard title={t('最近任务')} count={taskRuns.length} summary={task?.name||t('选择任务查看冻结的执行内容')}><div className="runtime-run-picker">{[...taskRuns].reverse().map(run=><button key={run.task_run_id} aria-pressed={task?.task_run_id===run.task_run_id} onClick={()=>void action(async()=>setTask(await client.request<Json>('/tasks/'+run.task_run_id)))}><strong>{run.name}</strong><span>{t(runtimeStatusNames[run.state]||run.state)}</span></button>)}</div></DisclosureCard>
     <TaskOverview task={(preparing&&!stopping)||failedPreparation||preparationCancelled?null:task} preparing={preparing&&!stopping} stopping={stopping} failedPreparation={failedPreparation} preparationCancelled={preparationCancelled} deployment={displayedDeployment} job={stopping?null:currentJob} now={now}/>
     {task&&<><StopRecovery client={client} run={task} onRecovered={next=>{setTask(next);updateTaskRun(next);window.dispatchEvent(new Event('agro:ros:refresh'))}}/><DisclosureCard title={t('行为树视图')} summary={t('查看节点状态、子树与执行数据')}><div className="runtime-tree-pane"><RuntimeTree task={task} language={language}/></div></DisclosureCard><DisclosureCard title={t('任务原始数据')}><pre>{JSON.stringify(task,null,2)}</pre></DisclosureCard></>}
    </>:tab==='history'&&showRecords?<div className="runtime-records"><Records client={client} observation={observation} language={language} changed={async()=>{}}/></div>:<>
     {tab==='history'&&!history?<div className="runtime-empty"><h2>{t('选择一条运行记录')}</h2><p>{t('历史视图使用执行时保存的定义与数据')}</p></div>:<>
      <FlowOverview run={preparing&&!stopping&&tab==='flow'?null:shownSession} machine={preparing&&!stopping&&tab==='flow'?machines.find(item=>item.id===flowId):machine} taskLabels={taskLabels} preparing={preparing&&!stopping&&tab==='flow'} stopping={stopping&&tab==='flow'} failedPreparation={failedPreparation} preparationCancelled={preparationCancelled} deployment={tab==='history'?null:displayedDeployment} job={stopping?null:currentJob} now={now} historical={tab==='history'} onInspect={behavior=>void action(()=>inspectBehavior(behavior))} onOpenState={openState}/>
      {shownSession&&<StopRecovery client={client} run={shownSession} onRecovered={next=>{if(tab==='history'){const identity=shownSession.id;void action(async()=>{const restored=await client.request<Json>('/studio/flow-runs/'+identity);setHistory(previous=>previous?.id===identity?restored:previous)})}else setSession(next);window.dispatchEvent(new Event('agro:ros:refresh'))}}/>}
      {machine&&<section ref={graph} className="runtime-graph-section"><DisclosureCard title={t('状态图')} open={graphOpen} onOpenChange={setGraphOpen} summary={path.map(id=>states.find(item=>item.id===id)?.label||id).join(' → ')||machine.name} actions={shownSession?.active&&<button onClick={locateState}>{t('定位当前状态')}</button>}><div className="run-flow-view hsm-workbench runtime-flow-graph"><HsmCanvas readOnly states={states as any} transitions={machine.document.transitions} layout={machine.layout} scope={machine.document.initial} selected={selected||shownSession?.active||''} onSelect={setSelected} onMove={()=>{}} onReset={()=>{}} activePath={path} runtime={tab==='history'?null:shownSession} viewingHistory={tab==='history'} taskLabels={taskLabels} reveal={reveal}/></div>{selectedState&&<div className="runtime-selected-state"><strong>{selectedState.label}</strong><button onClick={()=>openState(selectedState.id)}>{t('在编排中打开')}</button><p>{machine.layout?.runtime_view?.states?.[selectedState.id]?.description}</p>{(['entry','do','exit'] as const).map(phase=><p key={phase}>{t(phase==='entry'?'进入时':phase==='do'?'状态期间':'离开时')} · {taskLabels[selectedState[phase]]||selectedState[phase]||t('未设置行为')}</p>)}</div>}</DisclosureCard></section>}
      {!(preparing&&!stopping&&tab==='flow')&&<FlowBranches run={shownSession} machine={machine}/>}
      {shownSession&&<><RuntimeTimeline run={shownSession} states={states} onSelect={tab==='history'?index=>setHistoryEvent(index):undefined}/>
       {tab==='history'&&historyEvent>=0&&<button onClick={()=>setHistoryEvent(-1)}>{t('查看最终状态')}</button>}
       <DisclosureCard title={t('行为明细')} count={relevantBehaviors.length} summary={t('每次任务执行的状态、耗时与原始反馈')}><div className="runtime-behavior-list">{relevantBehaviors.map(behavior=><article key={behavior.id}><div><strong>{states.find(item=>item.id===behavior.state_id)?.label||behavior.state_id} · {t(behavior.phase==='entry'?'进入时':behavior.phase==='exit'?'离开时':'状态期间')}</strong><span>{taskLabels[behavior.reference]||behavior.reference}</span><small>{t(runtimeStatusNames[behavior.status]||behavior.status)} · {elapsedText(behavior.started_at,behavior.finished_at||(active(behavior.status)?undefined:behavior.updated_at||''),now,t('未记录时间'))}</small></div><button onClick={()=>void action(()=>inspectBehavior(behavior))}>{t('查看任务详情')}</button></article>)}</div></DisclosureCard>
       {inspectedBehavior&&<DisclosureCard title={t('所选任务详情')} defaultOpen summary={taskLabels[inspectedBehavior.reference]||inspectedBehavior.reference}><Feedback feedback={inspectedBehavior.feedback}/>{inspectedBehavior.error&&<p className="runtime-error">{String(inspectedBehavior.error)}</p>}{inspectedBehavior.task_run_id&&task&&task.task_run_id===inspectedBehavior.task_run_id&&<div className="runtime-tree-pane"><RuntimeTree task={task} language={language}/></div>}<pre>{JSON.stringify(inspectedBehavior,null,2)}</pre><button onClick={()=>setInspected(null)}>{t('关闭任务详情')}</button></DisclosureCard>}
       {editable&&<DisclosureCard title={t('发送事件')} summary={t('需要人工事件或变量输入时使用')}><div className="runtime-event-controls"><label className="field"><span>{t('事件名称')}</span><input value={event} onChange={e=>setEvent(e.target.value)}/></label><label className="field"><span>{t('事件变量 JSON')}</span><textarea value={variables} onChange={e=>setVariables(e.target.value)} rows={3}/></label><button disabled={!event||busy} onClick={()=>void action(async()=>{const value=JSON.parse(variables);if(!value||Array.isArray(value)||typeof value!=='object')throw Error(t('变量需要 JSON 对象'));await client.request('/state-machines/event','POST',{event,variables:value});setMessage(t('事件已提交'))})}>{t('发送事件')}</button></div></DisclosureCard>}
       <DisclosureCard title={t(tab==='history'?'结束时的变量':'当前变量')} count={Object.keys(shownSession.variables||{}).length}><pre>{JSON.stringify(shownSession.variables||{},null,2)}</pre></DisclosureCard>
       <DisclosureCard title={t('流程原始数据')} summary={t('查看保存定义、事件与执行上下文')}><pre>{JSON.stringify(shownSession,null,2)}</pre></DisclosureCard>
      </>}
     </>}
    </>}
   </div>
  </div>
 </div>
}
function TaskOverview({task,preparing,stopping,failedPreparation,preparationCancelled,deployment,job,now}:{task:Json|null;preparing:boolean;stopping:boolean;failedPreparation:boolean;preparationCancelled:boolean;deployment:Json|null;job:Json|null;now:number}){
 const {t}=useLocale(),operations:Json[]=task?.operations||[],current=operations.filter(item=>active(item.state)||item.state==='UNKNOWN')
 const frozen=task?.snapshot?.definition,taskName=task?.name||frozen?.name||frozen?.task_name||frozen?.document?.main_tree_id
 const operationName=(operation:Json)=>{const node=frozen?.node_mapping?.find((item:Json)=>item.operation_node_id===operation.node_id);return frozen?.layout?.labels?.[node?.editor_id]||node?.editor_id||operation.node_id||operation.operation_id}
 return <section className="runtime-overview"><div className="runtime-summary-heading"><div><small>{t('行为树执行')}</small><h2>{stopping?t('正在停止并确认设备状态'):preparing?t('正在准备工作流'):preparationCancelled?t('准备已取消'):failedPreparation?t('工作流准备失败'):taskName||t('尚未运行')}</h2><p>{preparing?t('检查定义、执行环境与所需模块'):preparationCancelled?t('工作流尚未开始；子系统已停止'):failedPreparation?t('尚未进入工作流执行，请查看失败原因与模块日志'):t('查看当前任务及执行器返回的反馈')}</p></div><span className={'runtime-status'+(failedPreparation?' status-FAILED':'')}>{stopping?t('正在停止'):preparing?t('准备执行'):preparationCancelled?t('准备已取消'):failedPreparation?t('准备失败'):t(runtimeStatusNames[task?.state]||'尚未运行')}</span></div>{(preparing||stopping||failedPreparation)&&<PreparationSummary deployment={deployment} job={job} now={now} stopping={stopping} failed={failedPreparation}/>} {task&&<><div className="runtime-summary-facts"><span>{t('任务耗时')} {elapsedText(task.started_at,task.finished_at||(active(task.state)?undefined:task.updated_at||''),now,t('未记录时间'))}</span><span>{t('设备停止')} · {t(task.stop_confirmed?'已确认':'未确认')}</span></div>{task.error&&<p className="runtime-error">{task.error.reason||JSON.stringify(task.error)}</p>}{current.map(operation=><article className="runtime-task-card" key={operation.operation_id}><strong>{operationName(operation)}</strong><span>{t(runtimeStatusNames[operation.state]||operation.state)}</span><Feedback feedback={operation.feedback}/></article>)}{!current.length&&<p className="runtime-muted">{t(active(task.state)?'正在等待行为树节点反馈':'本次任务执行已结束')}</p>}</>}</section>
}
