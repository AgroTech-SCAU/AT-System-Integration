import {useLocale} from '../../locale'
import {useEffect,useRef,useState} from 'react'
import {Panel} from '../../components/Foundation'
import {ErrorFields,useOperation,type Json,type PageProps} from '../shared'
const stateName:Record<string,string>={ACCEPTED:'准备运行',RUNNING:'运行中',CANCELING:'正在停止',SUCCEEDED:'执行成功',FAILED:'执行失败',CANCELED:'已取消',UNKNOWN:'结果待核对'}
export default function Records({client,language,observation}:PageProps){
 const {t}=useLocale()

 const [tasks,setTasks]=useState<Json[]>([]),[selected,setSelected]=useState(''),[report,setReport]=useState<Json|null>(null),[logs,setLogs]=useState<Json|null>(null)
 const [query,setQuery]=useState(''),[loading,setLoading]=useState(false),[loadingLogs,setLoadingLogs]=useState(false)
 const selectedRef=useRef(selected);selectedRef.current=selected
 const op=useOperation(language)
 useEffect(()=>{let active=true;const controller=new AbortController();client.request<Json>('/studio/task-runs','GET',undefined,controller.signal).then(t=>{if(active){setTasks(t.tasks);setSelected(old=>t.tasks.some((task:Json)=>task.task_run_id===old)?old:t.tasks.at(-1)?.task_run_id||'')}}).catch(e=>{if(active)op.setError(e)});return()=>{active=false;controller.abort()}},[client,observation])
 useEffect(()=>{
  setReport(null);setLogs(null);op.setError(null)
  if(!selected)return
  let active=true;const controller=new AbortController();setLoading(true);setLoadingLogs(false)
  client.request<Json>(`/tasks/${encodeURIComponent(selected)}/report`,'GET',undefined,controller.signal).then(r=>{if(active){setReport(r);setLogs(r.executor_log)}}).catch(e=>{if(active)op.setError(e)}).finally(()=>{if(active)setLoading(false)})
  return()=>{active=false;controller.abort()}
 },[client,selected])
 async function moreLogs(){
  const identity=selected;setLoadingLogs(true)
  try{const next=await client.request<Json>(`/tasks/${encodeURIComponent(identity)}/logs?offset=${logs?.next_offset||0}&limit=16384`);if(selectedRef.current===identity)setLogs((old:Json|null)=>({...next,text:(old?.text||'')+next.text}))}
  catch(e){if(selectedRef.current===identity)op.setError(e)}finally{if(selectedRef.current===identity)setLoadingLogs(false)}
 }
 const text=JSON.stringify(report,null,2)
 const task=report?.task
 const entries=tasks.map((item,index)=>({...item,task_run_id:String(item.task_run_id),title:String(item.name||t("运行 {0}", {0: index+1})),label:t(stateName[item.state]||item.state)})).reverse().filter(item=>`${item.title} ${item.label} ${item.task_run_id}`.toLowerCase().includes(query.toLowerCase()))
 return <><div className="records-layout"><aside className="records-list" aria-label={t("历史运行")}><input aria-label={t("搜索运行记录")} placeholder={t("搜索状态或执行 ID")} value={query} onChange={e=>setQuery(e.target.value)}/>{entries.map(item=><button key={item.task_run_id} aria-current={selected===item.task_run_id?'true':undefined} onClick={()=>setSelected(item.task_run_id)}><strong>{item.title} · {item.label}</strong><small>{item.task_run_id.slice(-12)}</small></button>)}{!entries.length&&<p className="record-empty">{tasks.length?t("没有匹配的运行"):t("还没有运行记录")}</p>}</aside><section aria-busy={loading}>
 <Panel title={entries.find(item=>item.task_run_id===selected)?.title||t("执行结果")} subtitle={t("选择左侧记录即可查看结果")} icon="runtime">
 {loading?<p role="status">{t("正在读取运行记录")}</p>:task?<><div className="record-summary"><span>{t(stateName[task.state]||task.state)}</span><span>{t("设备停止 · ")}{task.stop_confirmed?t("已确认"):t("尚未确认")}</span></div>{task.error?<div className="error"><strong>{t("执行中遇到问题")}</strong><p>{task.error.reason||JSON.stringify(task.error)}</p></div>:<p className="muted">{task.state==='SUCCEEDED'?t("本次任务已完成"):task.state==='CANCELED'?t("本次任务已取消"):['RUNNING','ACCEPTED','CANCELING'].includes(task.state)?t("本次任务仍在进行，实时状态请查看运行台"):t("本次任务没有附加故障信息")}</p>}
 {task.operations?.some((operation:Json)=>operation.result)&&<><h3>{t("任务结果")}</h3><pre>{JSON.stringify(task.operations.filter((operation:Json)=>operation.result).map((operation:Json)=>operation.result),null,2)}</pre></>}
 <div className="buttons"><button disabled={op.busy} onClick={()=>void op.run(t("复制报告"),async()=>{if(window.agroDesktop)await window.agroDesktop.copyReport(selected);else await navigator.clipboard.writeText(text)})}>{t("复制报告")}</button><button disabled={op.busy} onClick={()=>{if(window.agroDesktop){void op.run(t("导出报告"),async()=>{await window.agroDesktop!.exportReport(selected)});return}const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=selected+'.report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}}>{t("导出报告")}</button></div><details className="studio-advanced"><summary>{t("技术详情 · 执行标识与完整报告")}</summary><pre className="selectable">{text}</pre></details></>:<p className="record-empty">{t("运行任务后，执行结果与故障信息会保存在这里")}</p>}
 </Panel>{logs&&<Panel title={t("执行日志")} subtitle={logs.available?t("按执行顺序显示，继续加载后续内容"):t("本次运行没有可用的执行器日志")}><pre className="selectable record-log">{logs.text}</pre>{logs.available&&<button disabled={loadingLogs} onClick={()=>void moreLogs()}>{loadingLogs?t("正在读取"):logs.eof?t("刷新日志"):t("加载更多日志")}</button>}</Panel>}</section></div><ErrorFields value={op.error}/>{op.dialog()}</>
}
