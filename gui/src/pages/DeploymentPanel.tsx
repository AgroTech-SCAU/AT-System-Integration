import {useEffect,useState} from 'react'
import type {ApiClient} from '../api'
import DisclosureCard from '../components/DisclosureCard'
import {useLocale} from '../locale'
import {ErrorFields,waitJob,type Json} from './shared'

export default function DeploymentPanel({client,kind,reference}:{client:ApiClient;kind:string;reference:string}){
 const {t}=useLocale(),[plan,setPlan]=useState<Json|null>(null),[status,setStatus]=useState<Json|null>(null),[error,setError]=useState<unknown>(null),[logs,setLogs]=useState(''),[busy,setBusy]=useState(false)
 useEffect(()=>{setPlan(null);setError(null);setLogs('');if(!reference)return;const controller=new AbortController();void client.request<Json>('/deployment/plan','POST',{kind,reference},controller.signal).then(setPlan).catch(e=>{if(!controller.signal.aborted)setError(e)});return()=>controller.abort()},[client,kind,reference])
 useEffect(()=>{let alive=true,timer=0;async function read(){try{const value=await client.request<Json>('/deployment/status');if(alive)setStatus(value)}catch{}finally{if(alive)timer=window.setTimeout(read,1500)}}void read();return()=>{alive=false;clearTimeout(timer)}},[client])
 async function stop(){setBusy(true);setError(null);try{const job=await client.request<Json>('/deployment/stop','POST',{});await waitJob(client,job.management_job_id,()=>{},undefined,300000);setStatus(await client.request<Json>('/deployment/status'))}catch(cause){setError(cause)}finally{setBusy(false)}}
 const phases:Record<string,string>={STOPPED:'子系统尚未启动',PREPARING:'正在检查依赖',STARTING:'正在启动子系统',READY:'所需子系统已就绪',FAILED:'子系统准备失败',UNKNOWN:'子系统停止待确认'}
 const pending=!!error||!!plan?.issues?.length||['FAILED','UNKNOWN'].includes(status?.state)
 return <DisclosureCard className="deployment-plan" title={t(phases[status?.state]||'子系统启动计划')} count={plan?.modules?.length||0} summary={t('开始运行时自动准备以下模块，取消工作流后可保留子系统继续调试')} actions={<button disabled={busy||!status?.modules?.length&&status?.state!=='STARTING'&&status?.state!=='PREPARING'} onClick={()=>void stop()}>{t('停止工作流与子系统')}</button>} status={pending?<span style={{color:'var(--red)'}}>{t('配置待核对')}</span>:undefined}>
 {plan?.modules?.map((module:Json)=><DisclosureCard key={module.id} title={module.name} summary={[module.package,module.executable||module.plugin].filter(Boolean).join(' / ')} status={t(status?.modules?.find((v:Json)=>v.id===module.id)?.state||'待启动')}><p>{t(({process:'仅确认进程存活',interfaces:'接口已发现',healthy:'健康条件已满足',oneshot:'初始化已完成'} as Record<string,string>)[status?.modules?.find((v:Json)=>v.id===module.id)?.health?.level]||'尚未检查健康条件')}</p><button onClick={async()=>{try{setLogs((await client.request<Json>('/deployment/modules/'+module.id+'/logs')).text||t('暂无启动日志'))}catch(cause){setError(cause)}}}>{t('查看日志')}</button></DisclosureCard>)}
 {plan?.issues?.map((v:Json,i:number)=><p className="error" key={i}>{v.reason}</p>)}{status?.reason&&<p className="error">{status.reason}</p>}{logs&&<DisclosureCard title={t('执行日志')} defaultOpen><pre className="ros-code">{logs}</pre></DisclosureCard>}<ErrorFields value={error}/></DisclosureCard>
}
