import {useEffect,useRef,useState} from 'react'
import {ApiError,type ApiClient} from '../api'
import {deferNavigation,reportError} from '../components/StudioDialogs'
import {useLocale} from '../locale'
import {prepareRobot,type WorkflowPreparation as Workflow} from './prepareRobot'
import {PreparationSummary} from './runtime-overview'
import {waitJob,type Json} from './shared'
import './workflow-preparation.css'

type Phase='preparing'|'starting'|'stopping'|'canceled'|'failed'
type Snapshot={serial:number;phase:Phase;workflow:Workflow|null;job:Json|null;deployment:Json|null;error:unknown;outcomeUnconfirmed:boolean;statusUnavailable:boolean;startedAt:string}
type Attempt={serial:number;identity:string;controller:AbortController;submission:Promise<unknown>;snapshot:Snapshot;stopping?:Promise<boolean>}

export function useWorkflowPreparation(client:ApiClient,identity:string){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null)
 const current=useRef<Attempt|null>(null),serial=useRef(0),mounted=useRef(false)
 function update(attempt:Attempt,patch:Partial<Snapshot>){
  attempt.snapshot={...attempt.snapshot,...patch}
  if(mounted.current&&current.current===attempt)setSnapshot(attempt.snapshot)
 }
 async function stop(attempt=current.current):Promise<boolean>{
  if(!attempt)return true
  if(attempt.stopping)return attempt.stopping
  attempt.controller.abort()
  update(attempt,{phase:'stopping',job:null,error:null,outcomeUnconfirmed:false})
  const stopping=(async()=>{
   try{
    // A slow acceptance response must settle before Stop can overtake that request
    await attempt.submission.catch(()=>{})
    const accepted=await client.request<Json>('/deployment/stop','POST',{})
    await waitJob(client,accepted.management_job_id,()=>{},undefined,300000,job=>update(attempt,{job}))
    const deployment=await client.request<Json>('/deployment/status')
    update(attempt,{phase:'canceled',deployment})
    if(current.current===attempt)current.current=null
    window.dispatchEvent(new Event('agro:ros:refresh'))
    return true
   }catch(error){
    update(attempt,{phase:'failed',error})
    if(!mounted.current)reportError(error)
    return false
   }
  })()
  attempt.stopping=stopping
  const stopped=await stopping
  if(!stopped)attempt.stopping=undefined
  return stopped
 }
 const stopRef=useRef(stop);stopRef.current=stop
 useEffect(()=>{
  mounted.current=true
  return()=>{mounted.current=false;if(current.current&&!current.current.controller.signal.aborted)void stopRef.current(current.current)}
 },[client])
 useEffect(()=>{if(current.current&&current.current.identity!==identity&&!current.current.controller.signal.aborted)void stopRef.current(current.current)},[identity])
 useEffect(()=>{
  const leave=(event:Event)=>{
   const attempt=current.current
   // Failed Stop must leave the runtime recovery page reachable
   if(attempt&&(!attempt.controller.signal.aborted||attempt.stopping))deferNavigation(event,()=>stopRef.current())
  }
  window.addEventListener('agro:navigate',leave)
  window.addEventListener('agro:studio:leave-task',leave)
  return()=>{window.removeEventListener('agro:navigate',leave);window.removeEventListener('agro:studio:leave-task',leave)}
 },[])
 const busy=!!snapshot&&['preparing','starting','stopping'].includes(snapshot.phase)
 useEffect(()=>{
  const attempt=current.current
  if(!busy||!attempt)return
  const controller=new AbortController();let timer=0
  const read=async()=>{
   try{const deployment=await client.request<Json>('/deployment/status','GET',undefined,controller.signal);if(!controller.signal.aborted)update(attempt,{deployment,statusUnavailable:false})}
   catch{if(!controller.signal.aborted)update(attempt,{statusUnavailable:true})}
   finally{if(!controller.signal.aborted)timer=window.setTimeout(read,1000)}
  }
  void read()
  return()=>{controller.abort();clearTimeout(timer)}
 },[client,snapshot?.serial,busy])

 async function run<T>(workflow:Workflow|(()=>Promise<Workflow|null>),start:(workflow:Workflow)=>Promise<T>):Promise<{result:T}|null>{
  if(!mounted.current)return null
  if(current.current)throw Error('请先完成当前准备或停止操作')
  const attempt:Attempt={serial:++serial.current,identity,controller:new AbortController(),submission:Promise.resolve(),snapshot:{serial:serial.current,phase:'preparing',workflow:null,job:null,deployment:null,error:null,outcomeUnconfirmed:false,statusUnavailable:false,startedAt:new Date().toISOString()}}
  current.current=attempt;update(attempt,{})
  const signal=attempt.controller.signal
  let dispatched=false,outcomeUnconfirmed=false
  try{
   const selected=typeof workflow==='function'?await workflow():workflow
   signal.throwIfAborted()
   if(!selected){setSnapshot(null);return null}
   update(attempt,{workflow:selected})
   await prepareRobot(client,selected,job=>{if(!signal.aborted)update(attempt,{job})},{signal,onSubmitting:pending=>{attempt.submission=pending}})
   signal.throwIfAborted()
   update(attempt,{phase:'starting'})
   // Dispatch synchronously after the cancellation check; Stop also observes this request
   dispatched=true
   const pending=start(selected)
   attempt.submission=pending
   const result=await pending
   signal.throwIfAborted()
   if(mounted.current)setSnapshot(null)
   return {result}
  }catch(error){
   if(signal.aborted)return null
   outcomeUnconfirmed=dispatched&&error instanceof ApiError&&(error.kind==='offline'||error.details.some(issue=>issue.code==='observation_timeout'))
   update(attempt,{phase:'failed',error,outcomeUnconfirmed})
   throw error
  }finally{
   if(attempt.stopping)await attempt.stopping
   if(!signal.aborted&&!outcomeUnconfirmed&&current.current===attempt)current.current=null
  }
 }
 return {run,cancel:()=>stop(),busy,snapshot,canCancel:!!current.current}
}

export default function WorkflowPreparation({preparation}:{preparation:ReturnType<typeof useWorkflowPreparation>}){
 const {t}=useLocale(),[now,setNow]=useState(Date.now()),snapshot=preparation.snapshot
 useEffect(()=>{if(!preparation.busy)return;const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[preparation.busy])
 if(!snapshot)return null
 const stopping=snapshot.phase==='stopping',failed=snapshot.phase==='failed',canceled=snapshot.phase==='canceled'
 const error=snapshot.error as {details?:{reason:string}[];message?:string}|null
 const reason=error instanceof ApiError&&error.kind==='offline'?t(snapshot.outcomeUnconfirmed?'连接中断，运行请求结果尚未确认':'无法连接 Studio 服务'):error?.details?.map(item=>t(item.reason)).join(' · ')||error?.message||''
 const measured=snapshot.deployment?.progress
 const matching=measured&&Date.parse(measured.started_at)>=Date.parse(snapshot.startedAt)
 const deployment=snapshot.deployment?{...snapshot.deployment,progress:matching?measured:null}:null
 const job=snapshot.job||{started_at:snapshot.startedAt,context:snapshot.workflow}
 return <section className="workflow-preparation" aria-label={t('工作流准备')}>
  <header><strong>{t(stopping?'正在取消准备并停止子系统':canceled?'准备已取消':snapshot.outcomeUnconfirmed?'运行请求结果尚未确认':failed?'准备或停止未完成':snapshot.phase==='starting'?'正在提交运行请求':'正在准备工作流')}</strong>{preparation.canCancel&&<button disabled={stopping} onClick={()=>void preparation.cancel()}>{t(stopping?'正在停止':snapshot.outcomeUnconfirmed?'停止工作流与子系统':failed?'重试停止子系统':'取消准备并停止子系统')}</button>}</header>
  {!canceled&&<PreparationSummary deployment={deployment} job={job} now={now} stopping={stopping} failed={failed}/>}
  {snapshot.statusUnavailable&&preparation.busy&&<p role="status">{t('准备状态暂时无法更新，保留上次进度；恢复连接后继续观察')}</p>}
  {reason&&<p className="runtime-error" role="alert">{reason}</p>}
  {failed&&preparation.canCancel&&<p>{t('停止未确认时，可到运行台核对设备状态')}</p>}
  {canceled?<p>{t('本次启动已取消，子系统已停止')}</p>:preparation.busy&&<p>{t('切换任务或离开页面会取消尚未完成的准备')}</p>}
 </section>
}
