import {useEffect,useRef,useState} from 'react'
import {ApiError,type ApiClient} from '../api'
import {useLocale} from '../locale'
import {ErrorFields} from './shared'
import StudioSelect from '../components/StudioSelect'
import DisclosureCard from '../components/DisclosureCard'

type Active={workspace_id:string;name:string;python:string;setup:string}
type State={setup:string;setup_candidates?:string[];candidates:string[];loaded:boolean;active:Active|null;report:null|{ready:boolean;setup:string;python:string;reason:string;missing:string;interface_count?:number;prefixes?:string[]}}
export default function ExecutionEnvironment({client,workspaceId,epoch}:{client:ApiClient;workspaceId?:string;epoch?:unknown}){
 const {t}=useLocale()
 const [state,setState]=useState<State|null>(null),[python,setPython]=useState(''),[setup,setSetup]=useState('')
 const [busy,setBusy]=useState(''),[error,setError]=useState<unknown>(null)
 const context=useRef<{client:ApiClient;workspaceId?:string}|null>(null)
 useEffect(()=>{
  const controller=new AbortController(),changed=context.current?.client!==client||context.current?.workspaceId!==workspaceId
  if(changed){setState(null);setError(null);setPython('');setSetup('')}
  if(workspaceId)void client.request<State>(`/ros/interface-workspaces/${workspaceId}/environment`,'GET',undefined,controller.signal).then(next=>{
   if(controller.signal.aborted)return
   context.current={client,workspaceId};setState(next)
   if(changed){setPython(next.report?.python||next.active?.python||next.candidates[0]||'');setSetup(next.report?.setup||next.active?.setup||next.setup||'')}
  }).catch(cause=>{if(!controller.signal.aborted)setError(cause)})
  return()=>controller.abort()
 },[client,workspaceId,epoch])
 function chooseSetup(value:string){setSetup(value);setError(null)}
 function choosePython(value:string){setPython(value);setError(null)}
 async function action(kind:string){
  setBusy(kind);setError(null)
  try{
   const next=await client.request<State>(`/ros/interface-workspaces/${workspaceId}/environment/${kind}`,'POST',{python,setup},undefined,kind==='supplement'?300000:90000)
   setState(next)
   const loaded=kind==='load'&&next.loaded&&next.report?.ready
   setPython((loaded?next.active?.python:next.report?.python)||python)
   setSetup((loaded?next.active?.setup:next.report?.setup)||setup)
   window.dispatchEvent(new Event('agro:environment:changed'))
  }catch(cause){setError(cause)}finally{setBusy('')}
 }
 const report=state?.report?.setup===setup&&state.report.python===python?state.report:null
 const loaded=!!state?.loaded&&state.active?.setup===setup&&state.active?.python===python
 const errorReason=error instanceof ApiError?(error.details[0]?.reason||t(error.kind==='offline'?'连接暂时不可用，请重试':'运行环境检查未完成')):error instanceof Error?error.message:error?t('运行环境检查未完成'):''
 const failedReason=errorReason||(report&&!report.ready?report.reason:'')
 const status=busy?t(busy==='check'?'正在检查环境':busy==='load'?'正在加载环境':'正在准备独立依赖'):failedReason?t('运行依赖待补充'):loaded?t('已配置'):report?.ready?t('检查通过，尚未加载'):state?.report?t('环境已修改，请重新检查'):t('尚未配置运行环境')
 const setups=Array.from(new Set([...(state?.setup_candidates||[]),...(state?.setup?[state.setup]:[])]))
 return <><DisclosureCard title={t('运行环境')} status={<span className={loaded&&!failedReason&&!busy?'iw-ready':'iw-pending'}>{status}</span>} summary={<span>{setup?<code>{setup}</code>:t('离线配置接口与任务时无需加载')}{failedReason&&<span className="iw-environment-problem iw-pending" role="status">{failedReason}</span>}</span>} className="iw-environment-card">
  <p className="ros-field-hint">{t('每个子系统独立使用自己的环境，运行台根据工作流加载所需依赖')}</p>
  {workspaceId&&state?<fieldset disabled={!!busy}>
   <label className="field"><span>{t('已构建的安装环境')}</span>{setups.length>0&&<StudioSelect label={t('选择安装环境')} value={setups.includes(setup)?setup:'custom'} options={[...setups.map(value=>({value,label:value})),{value:'custom',label:t('指定其他环境')}]} onChange={value=>chooseSetup(value==='custom'?'':value)}/>}<input aria-label={t('setup 文件路径')} value={setup} onChange={event=>chooseSetup(event.target.value)} placeholder="/path/to/workspace/install/setup.bash"/></label>
   <p className="ros-field-hint">{t('运行节点时使用此安装环境，源码与接口文件仍可独立离线读取')}</p>
   <label className="field"><span>{t('工作区 Python 环境')}</span><StudioSelect label={t('工作区 Python 环境')} value={state.candidates.includes(python)?python:'custom'} options={[...state.candidates.map(value=>({value,label:value})),{value:'custom',label:t('指定其他环境')}]} onChange={value=>choosePython(value==='custom'?'':value)}/></label>
   {!state.candidates.includes(python)&&<label className="field"><span>{t('Python 可执行文件路径')}</span><input value={python} onChange={event=>choosePython(event.target.value)} placeholder="/path/to/venv/bin/python"/></label>}
   <div className="buttons"><button disabled={!python||!setup} onClick={()=>void action('check')}>{t(busy==='check'?'正在检查环境':'检查依赖')}</button><button className="primary" disabled={!python||!setup} onClick={()=>void action('load')}>{t(busy==='load'?'正在加载环境':loaded?'重新加载执行环境':'加载执行环境')}</button>{report&&['numpy','yaml'].includes(report.missing.split('.')[0]||'')&&<button onClick={()=>void action('supplement')}>{t(busy==='supplement'?'正在准备独立依赖':'补齐独立通信依赖')}</button>}</div>
   {!setup&&<p className="ros-field-hint">{t('此来源仅提供接口定义，运行前需选择已构建的工作区')}</p>}
   {report&&!errorReason&&<p role="status" className={report.ready?'iw-ready':'iw-pending'}>{report.ready?t('通信依赖与接口定义检查通过'):report.reason}</p>}
   <DisclosureCard title={t('环境详情')} summary={python||t('尚未选择 Python 环境')}><p><code>{setup||t('尚未选择安装环境')}</code></p>{report?.prefixes?.filter(Boolean).map(path=><p key={path}><code>{path}</code></p>)}</DisclosureCard>
  </fieldset>:<p className="ros-field-hint">{t(workspaceId?'正在读取环境配置':'在机器人页面的子系统工作区中检查并加载执行环境')}</p>}
 </DisclosureCard><ErrorFields value={error}/></>
}
