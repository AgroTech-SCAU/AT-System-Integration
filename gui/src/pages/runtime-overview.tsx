import {useRef,useState} from 'react'
import DisclosureCard from '../components/DisclosureCard'
import {useLocale} from '../locale'
import {active} from './runtime-activity'
import {elapsedText,feedbackFields,groupedEvents,metricText,runtimeStatusNames,valueAt} from './runtime-model'
import type {Json} from './shared'

const phaseName=(phase:string)=>phase==='entry'?'进入时':phase==='exit'?'离开时':'状态期间'
const eventName=(event:string)=>event==='completed'?'任务完成':event==='failed'?'任务失败':event==='started'?'开始运行':event
export function FlowOverview({run,machine,taskLabels,preparing=false,stopping=false,failedPreparation=false,preparationCancelled=false,job,deployment,now,historical=false,onInspect,onOpenState}:{
 run:Json|null;machine?:Json|null;taskLabels:Record<string,string>;preparing?:boolean;stopping?:boolean;failedPreparation?:boolean;preparationCancelled?:boolean;job?:Json|null;deployment?:Json|null;now:number;historical?:boolean;onInspect:(behavior:Json)=>void;onOpenState:(stateId:string)=>void
}){
 const {t}=useLocale(),current=useRef<HTMLElement>(null)
 const states:Json[]=machine?.document?.states||[],state=states.find(item=>item.id===run?.active),view=machine?.layout?.runtime_view||{}
 const running=!!run&&active(run.status),review=run?.status==='UNKNOWN'
 const phase=stopping||run?.status==='STOPPING'?'stop':preparing?'prepare':failedPreparation||preparationCancelled?'result':running?'execute':run?'result':'idle'
 const outcome=run?.status==='SUCCEEDED'?view.outcomes?.[run.active]:null
 const behaviors:Json[]=run?.behaviors||[],live=behaviors.filter(item=>active(item.status)||item.status==='UNKNOWN')
 const lastFeedback=[...behaviors].reverse().find(item=>feedbackFields(item.feedback).length)
 const branches:Json[]=(machine?.document?.transitions||[]).filter((edge:Json)=>run?.path?.includes(edge.source))
 const stateLabel=(id:string)=>states.find(item=>item.id===id)?.label||id
 const stopped=['STOPPED','CANCELED'].includes(run?.status),failed=run?.status==='FAILED'
 const title=phase==='prepare'?t('正在准备工作流'):phase==='stop'?t('正在停止并确认设备状态'):preparationCancelled?t('准备已取消'):failedPreparation?t('工作流准备失败'):review?t('本次流程需要核对设备'):stopped?t('本次流程已停止'):failed?t('本次流程执行失败'):run?.status==='SUCCEEDED'?outcome?.title||t('本次流程已完成'):state?.label||machine?.name||t('尚未运行')
 const description=phase==='prepare'?t('检查定义、执行环境与所需模块'):phase==='stop'?t('等待活动任务停止确认，随后完成本次停止请求'):preparationCancelled?t('工作流尚未开始；子系统已停止'):failedPreparation?t('尚未进入工作流执行，请查看失败原因与模块日志'):review?t('执行结果或停止状态待确认，请核对设备后处理停止确认'):stopped?t('停止时状态：{0}；本次执行不会继续，可查看下方反馈与完整结果',{0:state?.label||run?.active||t('未记录状态')}):failed?t('失败时状态：{0}；请查看失败原因、任务反馈与运行时间线',{0:state?.label||run?.active||t('未记录状态')}):run?.status==='SUCCEEDED'?outcome?.description||t('本次执行已结束，可展开事件与任务详情'):view.states?.[state?.id]?.description||
  (running?(live.length?t('以下任务正在执行，反馈来自执行器'):t('当前没有执行中的任务，正在等待事件或状态转换')):t('检查配置并开始运行后，在这里查看当前步骤与实际反馈'))
 const end=run?.finished_at||(running?undefined:run?.updated_at||'')
 return <>
  <section className={'runtime-overview'+(review?' needs-review':'')} aria-label={t('运行概览')}>
   <ol className="runtime-phases" aria-label={t('运行阶段')}>{[['prepare','准备'],['execute','执行与等待'],['stop','停止'],['result','结果']].map(([id,label])=><li key={id} aria-current={phase===id?'step':undefined} className={id==='stop'&&phase!=='stop'?'optional':''}>{t(label)}{id==='stop'&&phase!=='stop'&&<small>{t('按需')}</small>}</li>)}</ol>
   <div className="runtime-summary-heading"><div><small>{historical?t('保存的执行记录'):t('当前执行')}</small><h2>{title}</h2><p>{description}</p></div><span className={'runtime-status status-'+(failedPreparation?'FAILED':run?.status||phase)}>{phase==='stop'?t('正在停止'):preparing?t('准备执行'):preparationCancelled?t('准备已取消'):failedPreparation?t('准备失败'):t(runtimeStatusNames[run?.status]||'尚未运行')}</span></div>
   {(preparing||stopping||failedPreparation)&&<PreparationSummary deployment={deployment} job={job} now={now} stopping={stopping} failed={failedPreparation}/>}
   {!preparing&&!failedPreparation&&run&&<div className="runtime-summary-facts"><span>{t('流程耗时')} <strong>{elapsedText(run.started_at,end,now,t('未记录时间'))}</strong></span>{running&&<span>{t('当前步骤耗时')} <strong>{elapsedText(run.state_entered_at,undefined,now,t('未记录时间'))}</strong></span>}<span>{t('事件数量')} <strong>{run.events?.length||0}</strong></span></div>}
   {!preparing&&!failedPreparation&&run&&(view.badges?.length>0||view.metrics?.length>0)&&<div className="runtime-metrics">{(view.badges||[]).map((spec:Json,index:number)=><div className="runtime-badge" key={'badge:'+index}><span>{spec.label}</span><strong>{metricText(run.variables,spec,t('待提供'))}</strong></div>)}{(view.metrics||[]).map((spec:Json,index:number)=><div key={'metric:'+index}><span>{spec.label}</span><strong>{metricText(run.variables,spec,t('待提供'))}</strong></div>)}</div>}
   {phase==='result'&&!failedPreparation&&!historical&&deployment&&<p className="runtime-subsystem-state">{deployment.modules?.some((module:Json)=>module.process?.running===true)?t(run?.status==='SUCCEEDED'?'流程已完成，子系统仍在运行':'流程已结束，子系统仍在运行'):deployment.state==='STOPPED'?t('子系统已停止'):deployment.state==='UNKNOWN'?t('子系统停止状态待确认'):!deployment.modules?.length?t('此工作流没有由软件管理的子系统'):t('正在核对子系统状态')}</p>}
   {review&&<p className="runtime-review-note">{t('执行结果或停止状态需要核对，确认前不能开始新的运行')}</p>}
   {run?.error&&<p className="runtime-error">{typeof run.error==='string'?run.error:run.error.reason||JSON.stringify(run.error)}</p>}
   {!preparing&&running&&<button className="runtime-locate" onClick={()=>current.current?.scrollIntoView({block:'center',behavior:'smooth'})}>{t('定位当前步骤')}</button>}
  </section>
  {(run?.attention||[]).map((item:Json)=><section className="runtime-attention" role="alert" key={item.instance_id||item.state_id}><strong>{t('行为失败待处理')}</strong><span>{stateLabel(item.state_id)}</span><p>{item.reason}</p><button onClick={()=>onOpenState(item.state_id)}>{t('定位失败状态')}</button></section>)}
  {!preparing&&!failedPreparation&&!preparationCancelled&&<section ref={current} className="runtime-current-tasks" aria-label={t('当前任务')}><header><h3>{running?t('当前任务'):t('执行结果')}</h3>{live.length>0&&<span>{t('活动任务 {0}',{0:live.length})}</span>}</header>
   {live.map(behavior=><article className="runtime-task-card" key={behavior.id}><div className="runtime-task-heading"><div><small>{stateLabel(behavior.state_id)} · {t(phaseName(behavior.phase))}</small><strong>{taskLabels[behavior.reference]||behavior.reference}</strong></div><span>{t(runtimeStatusNames[behavior.status]||behavior.status)}</span></div><div className="runtime-task-time">{t('任务耗时')} {elapsedText(behavior.started_at,behavior.finished_at||(['UNKNOWN'].includes(behavior.status)?behavior.updated_at:undefined),now,t('未记录时间'))}</div><Feedback feedback={behavior.feedback}/>{behavior.error&&<p className="runtime-error">{typeof behavior.error==='string'?behavior.error:behavior.error.reason||JSON.stringify(behavior.error)}</p>}<div className="buttons"><button onClick={()=>onInspect(behavior)}>{t('查看任务详情')}</button><button onClick={()=>onOpenState(behavior.state_id)}>{t('在编排中打开')}</button></div></article>)}
   {!live.length&&<p className="runtime-muted">{running?t('当前没有执行中的任务，正在等待事件或状态转换'):run?t('执行已结束，完整结果保留在变量、事件与任务明细中'):t('工作流尚未开始')}</p>}
   {lastFeedback&&!live.some(item=>item.id===lastFeedback.id)&&<div className="runtime-last-feedback"><small>{t('最近任务反馈')} · {taskLabels[lastFeedback.reference]||lastFeedback.reference}</small><Feedback feedback={lastFeedback.feedback}/></div>}
  </section>}
  {!preparing&&running&&branches.length>0&&<DisclosureCard title={t('后续分支')} summary={t('仅在事件发生且条件满足后进入对应状态')}><ul className="runtime-branches">{branches.map((edge,index)=><li key={index}><strong>{stateLabel(edge.target)}</strong><span>{stateLabel(edge.source)} · {t(eventName(edge.event))}</span><small>{guardText(edge.guard,t)}</small></li>)}</ul></DisclosureCard>}
 </>
}
function guardText(guard:Json|undefined,t:(text:string)=>string){
 if(!guard||guard.operator==='always')return t('收到事件后允许转换')
 if(guard.operator==='otherwise')return t('其他条件均未满足时转换')
 const names:Record<string,string>={equals:'等于',not_equals:'不等于',greater:'大于',less:'小于'}
 return guard.key+' '+t(names[guard.operator]||guard.operator)+' '+JSON.stringify(guard.value)
}
export function Feedback({feedback}:{feedback:unknown}){
 const {t}=useLocale(),fields=feedbackFields(feedback),labels:Record<string,string>={stage:'执行器阶段',message:'执行器反馈',reason:'原因',progress:'任务反馈进度',success:'成功',status_code:'状态码'}
 return fields.length?<dl className="runtime-feedback-fields">{fields.map(([key,value])=><div key={key}><dt>{t(labels[key]||key)}</dt><dd>{String(value)}</dd></div>)}</dl>:<p className="runtime-muted">{t('尚无执行器反馈')}</p>
}
export function PreparationSummary({deployment,job,now,stopping=false,failed=false}:{deployment?:Json|null;job?:Json|null;now:number;stopping?:boolean;failed?:boolean}){
 const {t}=useLocale(),context=job?.context,measured=deployment?.progress,progress=stopping||!context||measured?.kind===context.kind&&measured?.reference===context.reference?measured||{}:{},phases:Record<string,string>={checking:'核对启动计划',environment:'加载执行环境',probing:'检查启动入口',start:'启动模块',wait:'等待模块就绪',ready:'所需子系统已就绪',cancel:'正在取消活动任务',confirm_stop:'等待工作流停止确认',stop:'正在停止子系统',stopped:'子系统已停止',failed:'子系统准备失败'}
 const start=progress.started_at||job?.started_at,end=failed?job?.finished_at||progress.updated_at:undefined,deadline=Date.parse(progress.deadline_at),submitting=!stopping&&!failed&&!progress.phase&&!job,errors=[job?.error?.reason,...(job?.error?.errors||[]).map((item:Json)=>item.reason),failed?deployment?.reason:null].filter((value,index,all)=>value&&all.indexOf(value)===index)
 return <div className="runtime-preparation-summary" role="status"><strong>{t(failed?'子系统准备失败':submitting?'正在提交准备':phases[progress.phase]||(stopping?'正在停止工作流与子系统':'正在准备工作流'))}</strong>{progress.current?.name&&<p>{t('当前处理：{0}',{0:progress.current.name})}</p>}<div className="runtime-summary-facts">{Number.isFinite(progress.completed)&&Number.isFinite(progress.total)&&progress.total>0&&<span>{t('当前阶段已完成 {0} / {1} 项',{0:progress.completed,1:progress.total})}</span>}{start&&<span>{t(stopping?'停止耗时':'准备耗时')} <strong>{elapsedText(start,end,now,t('未记录时间'))}</strong></span>}{Number.isFinite(deadline)&&<span>{t('等待截止时间')} <strong>{new Date(deadline).toLocaleTimeString()}</strong>{!failed&&<> · {now<deadline?t('剩余 {0} 秒',{0:Math.ceil((deadline-now)/1000)}):t('已到等待期限，等待结果确认')}</>}</span>}</div>{progress.health?.missing?.length>0&&<div className="runtime-waiting"><strong>{t('尚未满足的条件')}</strong><ul>{progress.health.missing.map((item:unknown,index:number)=><li key={index}>{typeof item==='string'?item:JSON.stringify(item)}</li>)}</ul></div>}{errors.map((reason,index)=><p className="runtime-error" key={index}>{reason}</p>)}</div>
}
export function RuntimeTimeline({run,states,onSelect}:{run:Json;states:Json[];onSelect?:(index:number)=>void}){
 const {t}=useLocale(),[full,setFull]=useState(false),events:Json[]=run.events||[],groups=groupedEvents(events)
 const view=run.definition?.layout?.runtime_view||{},specs:Json[]=[...(view.badges||[]),...(view.metrics||[])]
 const changedMetrics=(event:Json)=>specs.filter(spec=>valueAt(event.changes,spec.path)!==undefined).map(spec=>spec.label+' · '+metricText(event.changes,spec,t('待提供')))
 const label=(id:string)=>states.find(item=>item.id===id)?.label||id||t('流程')
 const row=(event:Json,index:number)=><li key={event.sequence??index}><button onClick={()=>onSelect?.(index)} disabled={!onSelect}><span className="runtime-event-index">{event.sequence??index+1}</span><span><strong>{label(event.source)} → {label(event.target)}</strong><small>{t(eventName(event.event||event.type||''))} {event.handled_by&&event.handled_by!==event.source?' · '+t('由 {0} 处理',{0:label(event.handled_by)}):''}</small>{event.reason&&<small>{event.reason}</small>}{changedMetrics(event).map((text,index)=><small key={index}>{text}</small>)}</span><time title={event.timestamp}>{event.timestamp?new Date(event.timestamp).toLocaleTimeString():t('未记录时间')}</time></button></li>
 return <DisclosureCard title={t('运行时间线')} count={events.length} summary={t('重复转换已合并，展开可查看每一次事件')}>
  <div className="buttons"><button onClick={()=>setFull(!full)}>{t(full?'合并重复转换':'展开完整记录')}</button></div>
  <ol className="runtime-timeline">{full?events.map(row):groups.map(group=>group.repeats===1?row(group.events[0],group.start):<li key={'group:'+group.start}><details><summary><strong>{t('重复转换 {0} 轮',{0:group.repeats})}</strong><span>{group.events.slice(0,group.length).map(event=>label(event.target)).join(' → ')}</span><small>{t('共 {0} 次事件',{0:group.events.length})}</small><small>{[...new Set(group.events.flatMap(changedMetrics))].slice(-3).join(' · ')}</small></summary><ol>{group.events.map((event,index)=>row(event,group.start+index))}</ol></details></li>)}</ol>
  {!events.length&&<p className="runtime-muted">{t('本次运行尚无状态转换')}</p>}
 </DisclosureCard>
}
