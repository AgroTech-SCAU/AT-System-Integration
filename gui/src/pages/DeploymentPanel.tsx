import {useEffect,useRef,useState} from 'react'
import type {ApiClient} from '../api'
import DisclosureCard from '../components/DisclosureCard'
import {useLocale} from '../locale'
import {locateStudio,type StudioLocation} from '../studio-links'
import {ErrorFields,waitJob,type Json} from './shared'

export default function DeploymentPanel({client,kind,reference,onReady,running=false}:{client:ApiClient;kind:string;reference:string;onReady?:(ready:boolean)=>void;running?:boolean}){
 const {t}=useLocale(),[report,setReport]=useState<Json|null>(null),[status,setStatus]=useState<Json|null>(null),[error,setError]=useState<unknown>(null),[logs,setLogs]=useState(''),[busy,setBusy]=useState(false),[checking,setChecking]=useState(false),[open,setOpen]=useState(false),[epoch,setEpoch]=useState(0)
 const notify=useRef(onReady);notify.current=onReady
 useEffect(()=>{
  setReport(null);setError(null);setLogs('');notify.current?.(false)
  if(!reference)return
  const controller=new AbortController();setChecking(true)
  void client.request<Json>('/deployment/readiness','POST',{kind,reference},controller.signal,30000).then(value=>{if(!controller.signal.aborted){setReport(value);notify.current?.(value.prepare_ready===true)}}).catch(cause=>{if(!controller.signal.aborted)setError(cause)}).finally(()=>{if(!controller.signal.aborted)setChecking(false)})
  return()=>controller.abort()
 },[client,kind,reference,epoch])
 useEffect(()=>{const refresh=()=>setEpoch(value=>value+1);for(const event of ['agro:environment:changed','agro:modules:changed','agro:ros:refresh','agro:hsm:refresh','agro:trees:refresh'])window.addEventListener(event,refresh);return()=>{for(const event of ['agro:environment:changed','agro:modules:changed','agro:ros:refresh','agro:hsm:refresh','agro:trees:refresh'])window.removeEventListener(event,refresh)}},[])
 useEffect(()=>{let alive=true,timer=0;async function read(){try{const value=await client.request<Json>('/deployment/status');if(alive)setStatus(value)}catch{}finally{if(alive)timer=window.setTimeout(read,1500)}}void read();return()=>{alive=false;clearTimeout(timer)}},[client])
 async function stop(){setBusy(true);setError(null);try{const job=await client.request<Json>('/deployment/stop','POST',{});await waitJob(client,job.management_job_id,()=>{},undefined,300000);setStatus(await client.request<Json>('/deployment/status'));setEpoch(value=>value+1)}catch(cause){setError(cause)}finally{setBusy(false)}}
 const phases:Record<string,string>={STOPPED:'子系统尚未启动',PREPARING:'正在检查依赖',STARTING:'正在启动子系统',READY:'所需子系统已就绪',FAILED:'子系统准备失败',UNKNOWN:'子系统停止待确认'}
 const issues=[...(report?.design_issues||[]),...(report?.execution_issues||[])]
 const pending=!!error||issues.length>0||['FAILED','UNKNOWN'].includes(status?.state)
 const returnTo:StudioLocation={page:'runtime',...(kind==='flow'?{machineId:reference}:{treeId:reference})}
 const configure=(location:StudioLocation)=>locateStudio({...location,returnTo})
 const summary=checking?t('正在检查已保存配置'):report?t('{0} · {1}',{0:t(report.offline_ready?'离线定义已通过':'离线定义待补充'),1:t(report.prepare_ready?'启动配置可用':'运行配置待补充')}):t('选择工作流后显示具体缺项')
 const nextAction=running?'工作流正在执行，当前状态与结果见下方运行视图':!reference?'先选择要运行的工作流':checking?'正在核对定义与启动配置，此时不会启动设备':error?'配置读取未完成，可重新查看运行检查':!report?'查看运行检查以确认当前缺项':!report.offline_ready?'先补齐定义与数据对接，再准备运行':!report.prepare_ready?'按缺项前往配置，修正后返回当前工作流':status?.state==='PREPARING'?'正在检查并加载执行环境，随后准备启动模块':status?.state==='STARTING'?'正在按依赖顺序启动模块并等待就绪':status?.state==='FAILED'?'启动准备未完成，请展开查看原因与模块日志':status?.state==='UNKNOWN'?'子系统停止状态待核对，请先查看运行检查':'点击开始运行后，检查依赖并准备所需模块，再执行工作流'
 return <DisclosureCard className="deployment-plan" title={t('运行准备')} open={open} onOpenChange={setOpen} count={issues.length} summary={<span className="deployment-readiness-summary"><span>{summary}</span><span>{t(nextAction)}</span></span>} actions={<><button disabled={checking||!reference} onClick={()=>{setOpen(true);setEpoch(value=>value+1)}}>{t(checking?'正在检查配置':'查看运行检查')}</button><button disabled={busy||!status?.modules?.length&&status?.state!=='STARTING'&&status?.state!=='PREPARING'} onClick={()=>void stop()}>{t('停止工作流与子系统')}</button></>} status={pending?<span style={{color:'var(--red)'}}>{t('有 {0} 项需要处理',{0:issues.length||1})}</span>:report?<span>{t('配置已通过')}</span>:undefined}>
 <p className="muted">{t('保存保留任务与流程定义，离线检查核对结构和数据对接；开始运行后再确认依赖、实际通信与健康状态')}</p>
 {issues.map((issue:Json,index:number)=><div className="list-card" key={index}><div><strong>{t(issue.reason)}</strong>{issue.path&&<small>{issue.path}</small>}</div>{issue.target&&<button onClick={()=>void configure(issue.target as StudioLocation)}>{t('前往配置')}</button>}</div>)}
 {report?.execution_notes?.map((note:Json,index:number)=><div className="list-card" key={'note-'+index}><div><strong>{note.name}</strong><small>{t(note.reason)}</small></div><button onClick={()=>void configure(note.target as StudioLocation)}>{t('查看环境')}</button></div>)}
 {report?.offline_ready&&report?.prepare_ready&&<p role="status">{t('已保存配置检查通过，确认设备环境后可开始运行')}</p>}
 <DisclosureCard title={t('所需启动模块')} count={report?.modules?.length||0} summary={t(phases[status?.state]||'子系统启动计划')}>
 {report?.modules?.map((module:Json)=><DisclosureCard key={module.id} title={module.name} summary={[module.package,module.executable||module.plugin].filter(Boolean).join(' / ')} status={t(status?.modules?.find((value:Json)=>value.id===module.id)?.state||'待启动')}><p>{t(({process:'仅确认进程存活',interfaces:'接口已发现',healthy:'健康条件已满足',oneshot:'初始化已完成'} as Record<string,string>)[status?.modules?.find((value:Json)=>value.id===module.id)?.health?.level]||'尚未检查健康条件')}</p><div className="buttons"><button onClick={()=>void configure({page:'overview',workspaceId:module.workspace_id,section:'modules'})}>{t('配置此启动模块')}</button><button onClick={async()=>{try{setLogs((await client.request<Json>('/deployment/modules/'+module.id+'/logs')).text||t('暂无启动日志'))}catch(cause){setError(cause)}}}>{t('查看日志')}</button></div></DisclosureCard>)}
 {!report?.modules?.length&&<p className="muted">{t('此工作流没有由软件管理的启动模块')}</p>}
 </DisclosureCard>
 {status?.reason&&<p className="error">{status.reason}</p>}{logs&&<DisclosureCard title={t('执行日志')} defaultOpen><pre className="ros-code">{logs}</pre></DisclosureCard>}<ErrorFields value={error}/></DisclosureCard>
}
