import {useEffect,useRef,useState} from 'react'
import {ApiError,type ApiClient} from '../api'
import {useLocale} from '../locale'
import {ErrorFields} from './shared'
import StudioSelect from '../components/StudioSelect'
import DisclosureCard from '../components/DisclosureCard'
import {environmentReadiness,runtimeEnvironment,type EnvironmentState,type EnvironmentStatus} from './environment-state'

export type EnvironmentSummary={workspaceId:string;status:EnvironmentStatus;loaded:boolean;checked:boolean;automatic:boolean;selectionPending:boolean;setup:string;python:string;problem:string;reading:boolean}
export default function ExecutionEnvironment({client,workspaceId,epoch,open,onOpenChange,onSummary}:{client:ApiClient;workspaceId?:string;epoch?:unknown;open?:boolean;onOpenChange?:(open:boolean)=>void;onSummary?:(value:EnvironmentSummary)=>void}){
 const {t}=useLocale()
 const [state,setState]=useState<EnvironmentState|null>(null),[python,setPython]=useState(''),[setup,setSetup]=useState('')
 const [busy,setBusy]=useState(''),[error,setError]=useState<unknown>(null)
 const context=useRef<{client:ApiClient;workspaceId?:string}|null>(null)
 useEffect(()=>{
  const controller=new AbortController(),changed=context.current?.client!==client||context.current?.workspaceId!==workspaceId
  if(changed){setState(null);setError(null);setPython('');setSetup('')}
  if(workspaceId)void client.request<EnvironmentState>(`/ros/interface-workspaces/${workspaceId}/environment`,'GET',undefined,controller.signal).then(next=>{
   if(controller.signal.aborted)return
   context.current={client,workspaceId};setState(next)
   if(changed){const selected=runtimeEnvironment(next);setPython(selected.python);setSetup(selected.setup)}
  }).catch(cause=>{if(!controller.signal.aborted)setError(cause)})
  return()=>controller.abort()
 },[client,workspaceId,epoch])
 function chooseSetup(value:string){setSetup(value);setError(null)}
 function choosePython(value:string){setPython(value);setError(null)}
 async function action(kind:string){
  setBusy(kind);setError(null)
  try{
   const next=await client.request<EnvironmentState>(`/ros/interface-workspaces/${workspaceId}/environment/${kind}`,'POST',{python,setup},undefined,kind==='supplement'?300000:90000)
   setState(next)
   const loaded=kind==='load'&&next.loaded&&next.report?.ready
   setPython((loaded?next.active?.python:next.report?.python)||python)
   setSetup((loaded?next.active?.setup:next.report?.setup)||setup)
   window.dispatchEvent(new Event('agro:environment:changed'))
  }catch(cause){setError(cause)}finally{setBusy('')}
 }
 const report=state?.report?.setup===setup&&state.report.python===python?state.report:null
 const errorReason=error instanceof ApiError?(error.details[0]?.reason||t(error.kind==='offline'?'连接暂时不可用，请重试':'运行环境检查未完成')):error instanceof Error?error.message:error?t('运行环境检查未完成'):''
 const readiness=environmentReadiness(state,{setup,python},errorReason)
 const labels:Record<EnvironmentStatus,string>={reading:'正在读取环境配置',loaded:'已加载',checked:'检查通过，运行时自动加载',automatic:'已发现环境，运行时检查加载',modified:'自定义选择尚未应用',missing_setup:'缺少安装环境',missing_python:'缺少可用 Python',failed:'运行环境检查未完成'}
 const problem=readiness.problem?t(readiness.problem):''
 const status=busy?t(busy==='check'?'正在检查环境':busy==='load'?'正在加载环境':'正在准备独立依赖'):t(labels[readiness.status])
 const needsAttention=['missing_setup','missing_python','failed'].includes(readiness.status)
 useEffect(()=>{if(workspaceId)onSummary?.({...readiness,workspaceId,problem})},[workspaceId,readiness.status,readiness.setup,readiness.python,readiness.selectionPending,problem,onSummary])
 const setups=Array.from(new Set([...(state?.setup_candidates||[]),...(state?.setup?[state.setup]:[])]))
 return <><DisclosureCard title={t('运行环境')} status={<span className={needsAttention?'iw-pending':readiness.loaded||readiness.checked?'iw-ready':undefined}>{status}</span>} open={open} onOpenChange={onOpenChange} summary={<span>{readiness.setup?<><code>{readiness.setup}</code><span className="iw-summary-detail">{readiness.python||t('尚未选择 Python 环境')}</span></>:t('离线配置接口与任务时无需加载')}{problem&&<span className="iw-environment-problem iw-pending" role="status">{problem}</span>}</span>} className="iw-environment-card">
  <p className="ros-field-hint">{t(readiness.automatic?'运行台将在准备流程时检查并加载此环境，无需先手动加载':readiness.loaded?'运行台将使用已加载的子系统环境':'每个子系统独立使用自己的环境，运行台根据工作流加载所需依赖')}</p>
  {workspaceId&&state?<fieldset disabled={!!busy}>
   {readiness.selectionPending&&<p className="ros-field-hint" role="status">{t('当前选择尚未应用，运行仍使用上方显示的环境；点击检查并加载后使用当前选择')}</p>}
   <h4>{t('按需操作')}</h4><p className="ros-field-hint">{t('需要自定义环境或提前排查依赖时，再调整并检查；加载操作已包含依赖检查')}</p>
   <label className="field"><span>{t('已构建的安装环境')}</span>{setups.length>0&&<StudioSelect label={t('选择安装环境')} value={setups.includes(setup)?setup:'custom'} options={[...setups.map(value=>({value,label:value})),{value:'custom',label:t('指定其他环境')}]} onChange={value=>chooseSetup(value==='custom'?'':value)}/>}<input data-studio-field="setup" aria-label={t('setup 文件路径')} value={setup} onChange={event=>chooseSetup(event.target.value)} placeholder="/path/to/workspace/install/setup.bash"/></label>
   <p className="ros-field-hint">{t('运行节点时使用此安装环境，源码与接口文件仍可独立离线读取')}</p>
   <label className="field" data-studio-field="python"><span>{t('工作区 Python 环境')}</span><StudioSelect label={t('工作区 Python 环境')} value={state.candidates.includes(python)?python:'custom'} options={[...state.candidates.map(value=>({value,label:value})),{value:'custom',label:t('指定其他环境')}]} onChange={value=>choosePython(value==='custom'?'':value)}/></label>
   {!state.candidates.includes(python)&&<label className="field"><span>{t('Python 可执行文件路径')}</span><input value={python} onChange={event=>choosePython(event.target.value)} placeholder="/path/to/venv/bin/python"/></label>}
   <div className="buttons"><button disabled={!python||!setup} onClick={()=>void action('check')}>{t(busy==='check'?'正在检查环境':'仅检查依赖')}</button><button className={readiness.selectionPending||needsAttention?'primary':undefined} disabled={!python||!setup} onClick={()=>void action('load')}>{t(busy==='load'?'正在加载环境':readiness.loaded?'重新检查并加载':'检查并加载环境')}</button>{report&&['numpy','yaml'].includes(report.missing.split('.')[0]||'')&&<button onClick={()=>void action('supplement')}>{t(busy==='supplement'?'正在准备独立依赖':'补齐独立通信依赖')}</button>}</div>
   {report&&!errorReason&&<p role="status" className={report.ready?'iw-ready':'iw-pending'}>{report.ready?t('通信依赖与接口定义检查通过'):report.reason}</p>}
   <DisclosureCard title={t('环境详情')} summary={readiness.python||t('尚未选择 Python 环境')}><p><code>{readiness.setup||t('尚未选择安装环境')}</code></p>{state.report?.prefixes?.filter(Boolean).map(path=><p key={path}><code>{path}</code></p>)}</DisclosureCard>
  </fieldset>:<p className="ros-field-hint">{t(workspaceId?'正在读取环境配置':'在机器人页面的子系统工作区中检查并加载执行环境')}</p>}
 </DisclosureCard><ErrorFields value={error}/></>
}
