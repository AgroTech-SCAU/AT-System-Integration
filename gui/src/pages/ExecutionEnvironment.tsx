import {useEffect,useState} from 'react'
import type {ApiClient} from '../api'
import {useLocale} from '../locale'
import {ErrorFields} from './shared'
import StudioSelect from '../components/StudioSelect'

type Active={workspace_id:string;name:string;python:string;setup:string}
type State={setup:string;candidates:string[];loaded:boolean;active:Active|null;report:null|{ready:boolean;python:string;reason:string;missing:string;interface_count?:number;prefixes?:string[]}}
export default function ExecutionEnvironment({client,workspaceId,epoch}:{client:ApiClient;workspaceId?:string;epoch?:unknown}){
 const {t}=useLocale()
 const [state,setState]=useState<State|null>(null),[active,setActive]=useState<Active|null>(null),[python,setPython]=useState('')
 const [busy,setBusy]=useState(''),[error,setError]=useState<unknown>(null)
 useEffect(()=>{
  const controller=new AbortController();setState(null);setActive(null);setError(null)
  async function read(){
   if(workspaceId){const next=await client.request<State>(`/ros/interface-workspaces/${workspaceId}/environment`,'GET',undefined,controller.signal);if(controller.signal.aborted)return;setState(next);setPython(next.report?.python||next.candidates[0]||'');setActive(next.active)}
   else{setActive(null)}
  }
  void read().catch(cause=>{if(!controller.signal.aborted)setError(cause)});return()=>controller.abort()
 },[client,workspaceId,epoch])
 async function action(kind:string){
  setBusy(kind);setError(null)
  try{const next=await client.request<State>(`/ros/interface-workspaces/${workspaceId}/environment/${kind}`,'POST',{python},undefined,kind==='supplement'?300000:90000);setState(next);setActive(next.active);setPython(next.report?.python||python);window.dispatchEvent(new Event('agro:environment:changed'))}catch(cause){setError(cause)}finally{setBusy('')}
 }
 return <section className="ros-stop-message"><h3>{t('工作区执行环境')}</h3><p>{active?t('此子系统的执行环境已配置：{0}',{0:active.name}):t('尚未加载执行环境，仍可离线配置任务')}</p>{workspaceId&&state&&<>
 <p>{t('加载此工作区已有依赖，供通信与启动模块使用，不启动设备节点')}</p>
 {!state.setup?<p className="ros-field-hint">{t('此来源仅提供接口定义，运行前需选择已构建的工作区')}</p>:<fieldset disabled={!!busy}>
 <label className="field"><span>{t('工作区 Python 环境')}</span><StudioSelect label={t('工作区 Python 环境')} value={state.candidates.includes(python)?python:'custom'} options={[...state.candidates.map(value=>({value,label:value})),{value:'custom',label:t('指定其他环境')}]} onChange={value=>setPython(value==='custom'?'':value)}/></label>
 {!state.candidates.includes(python)&&<label className="field"><span>{t('Python 可执行文件路径')}</span><input value={python} onChange={event=>setPython(event.target.value)} placeholder="/path/to/venv/bin/python"/></label>}
 <div className="buttons"><button disabled={!python} onClick={()=>void action('check')}>{t(busy==='check'?'正在检查环境':'检查依赖')}</button><button className="primary" disabled={!python} onClick={()=>void action('load')}>{t(busy==='load'?'正在加载环境':state.loaded?'重新加载执行环境':'加载执行环境')}</button>{['numpy','yaml'].includes(state.report?.missing.split('.')[0]||'')&&<button onClick={()=>void action('supplement')}>{t(busy==='supplement'?'正在准备独立依赖':'补齐独立通信依赖')}</button>}</div>
 <p className="ros-field-hint">{t('每个子系统独立使用自己的环境，运行台根据工作流加载所需依赖')}</p>
 {state.report&&<p role="status" className={state.report.ready?'iw-ready':'iw-pending'}>{state.report.ready?t('通信依赖与接口定义检查通过'):state.report.reason}</p>}
 {state.loaded&&<p className="iw-ready">{t('已加载，运行任务时使用此环境')}</p>}
 <details><summary>{t('环境详情')}</summary><p><code>{state.setup}</code></p>{state.report?.prefixes?.filter(Boolean).map(path=><p key={path}><code>{path}</code></p>)}</details>
 </fieldset>}</>}{!workspaceId&&<p className="ros-field-hint">{t('在机器人页面的子系统工作区中检查并加载执行环境')}</p>}<ErrorFields value={error}/></section>
}
