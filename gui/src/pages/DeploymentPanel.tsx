import {useEffect,useState} from 'react'
import type {ApiClient} from '../api'
import {useLocale} from '../locale'
import {ErrorFields,waitJob,type Json} from './shared'

export default function DeploymentPanel({client,kind,reference}:{client:ApiClient;kind:string;reference:string}){
 const {t}=useLocale(),[plan,setPlan]=useState<Json|null>(null),[status,setStatus]=useState<Json|null>(null),[error,setError]=useState<unknown>(null),[logs,setLogs]=useState(''),[busy,setBusy]=useState(false)
 useEffect(()=>{setPlan(null);setError(null);if(!reference)return;const controller=new AbortController();void client.request<Json>('/deployment/plan','POST',{kind,reference},controller.signal).then(setPlan).catch(e=>{if(!controller.signal.aborted)setError(e)});return()=>controller.abort()},[client,kind,reference])
 useEffect(()=>{let alive=true,timer=0;async function read(){try{const value=await client.request<Json>('/deployment/status');if(alive)setStatus(value)}catch{}finally{if(alive)timer=window.setTimeout(read,1500)}}void read();return()=>{alive=false;clearTimeout(timer)}},[client])
 async function stop(){setBusy(true);setError(null);try{const job=await client.request<Json>('/deployment/stop','POST',{});await waitJob(client,job.management_job_id,()=>{},undefined,300000);setStatus(await client.request<Json>('/deployment/status'))}catch(cause){setError(cause)}finally{setBusy(false)}}
 const phases:Record<string,string>={STOPPED:'子系统尚未启动',PREPARING:'正在检查依赖',STARTING:'正在启动子系统',READY:'所需子系统已就绪',FAILED:'子系统准备失败',UNKNOWN:'子系统停止待确认'}
 return <details className="deployment-panel"><summary>{t(phases[status?.state]||'子系统启动计划')} · {plan?.modules?.length||0} {t('个模块')}</summary><p>{t('开始运行时自动准备以下模块，取消工作流后可保留子系统继续调试')}</p>{plan?.modules?.map((module:Json)=><div key={module.id} className="ros-resource-row"><strong>{module.name}</strong><small>{module.package} / {module.executable||module.plugin}</small><span>{status?.modules?.find((v:Json)=>v.id===module.id)?.state||t('待启动')}</span><button onClick={async()=>{try{setLogs((await client.request<Json>('/deployment/modules/'+module.id+'/logs')).text||t('暂无启动日志'))}catch(cause){setError(cause)}}}>{t('查看日志')}</button></div>)}{plan?.issues?.map((v:Json,i:number)=><p className="error" key={i}>{v.reason}</p>)}{status?.reason&&<p className="error">{status.reason}</p>}{logs&&<pre className="ros-code">{logs}</pre>}<button disabled={busy||!status?.modules?.length&&status?.state!=='STARTING'&&status?.state!=='PREPARING'} onClick={()=>void stop()}>{t('停止工作流与子系统')}</button><ErrorFields value={error}/></details>
}
