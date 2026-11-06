import type {Json} from './shared'

export const runtimeStatusNames:Record<string,string>={ACCEPTED:'准备执行',ENTERING:'进入状态',RUNNING:'运行中',TRANSITIONING:'正在切换',STOPPING:'正在停止',STOPPED:'已停止',SUCCEEDED:'执行成功',FAILED:'执行失败',CANCELED:'已取消',CANCELING:'正在停止',UNKNOWN:'需要核对设备'}
export const terminalJob=(job:Json)=>['completed','failed','rolled_back','blocked'].includes(job.phase)
export function preparationFailed(job:Json|null,deployment:Json|null,run:Json|null,kind:string,references:string[]){
 const afterRun=(time:unknown)=>!run||typeof time==='string'&&Date.parse(time)>=(Date.parse(run.started_at)||0)
 return !!job&&['failed','blocked','rolled_back'].includes(job.phase)&&afterRun(job.started_at)||
  deployment?.state==='FAILED'&&deployment.progress?.kind===kind&&references.includes(deployment.progress.reference)&&afterRun(deployment.progress.started_at)
}
export function canceledPreparation(job:Json|null,jobs:Json[],deployment:Json|null,run:Json|null){
 if(job?.action!=='prepare_subsystems'||job.phase!=='failed'||deployment?.state!=='STOPPED'||deployment.modules?.some((module:Json)=>module.process?.running===true))return false
 const started=Date.parse(job.started_at),finished=Date.parse(job.finished_at),context=job.context
 if(!Number.isFinite(started)||!Number.isFinite(finished)||!context?.kind||!context.reference||!context.robot_system_id||deployment.robot_system_id!==context.robot_system_id||run&&(run.status==='UNKNOWN'||run.state==='UNKNOWN'||run.stop_confirmed===false||Date.parse(run.started_at)>=started))return false
 const during=(time:unknown)=>typeof time==='string'&&Date.parse(time)>=started&&Date.parse(time)<=finished
 const matches=(progress:Json)=>progress.kind===context.kind&&progress.reference===context.reference&&progress.robot_system_id===context.robot_system_id
 if(deployment.progress?.phase==='stopped'&&matches(deployment.progress)&&during(deployment.progress.started_at))return true
 return jobs.some(stop=>stop.action==='stop_subsystems'&&stop.phase==='completed'&&stop.context?.robot_system_id===context.robot_system_id&&during(stop.started_at)&&(!stop.result?.progress||matches(stop.result.progress)))
}
export function matchingPreparation(jobs:Json[],kind:string,reference:string|string[],robotId?:string){
 return jobs.filter(job=>job.action==='prepare_subsystems'&&job.context?.kind===kind&&(Array.isArray(reference)?reference.includes(job.context.reference):job.context.reference===reference)&&
  (!robotId||job.context.robot_system_id===robotId)).sort((a,b)=>(Date.parse(b.started_at)||0)-(Date.parse(a.started_at)||0))[0]||null
}
export function valueAt(variables:Json|undefined,path:unknown):unknown{
 if(typeof path!=='string'||!path)return undefined
 let value:unknown=variables
 for(const segment of path.split('.')){
  if(value===null||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,segment))return undefined
  value=(value as Json)[segment]
 }
 return value
}
export function metricText(variables:Json|undefined,spec:Json,missing:string){
 const value=valueAt(variables,spec.path)
 if(value===undefined||value===null)return missing
 if(spec.values&&Object.prototype.hasOwnProperty.call(spec.values,String(value)))return String(spec.values[String(value)])
 if(typeof value==='number'&&Number.isFinite(value)){
  const scaled=value*(typeof spec.scale==='number'&&Number.isFinite(spec.scale)?spec.scale:1)
  const text=typeof spec.precision==='number'?scaled.toFixed(Math.max(0,Math.min(8,Math.trunc(spec.precision)))):String(Number(scaled.toPrecision(6)))
  return text+(spec.unit?' '+String(spec.unit):'')
 }
 if(typeof value==='boolean'||typeof value==='string')return String(value)
 return missing
}
export function elapsedText(start:unknown,end:unknown,now:number,missing:string){
 const from=typeof start==='string'?Date.parse(start):NaN,to=typeof end==='string'?Date.parse(end):now
 if(!Number.isFinite(from)||!Number.isFinite(to))return missing
 const seconds=Math.max(0,(to-from)/1000)
 if(seconds<60)return seconds.toFixed(seconds<10?1:0)+' s'
 return Math.floor(seconds/60)+' min '+Math.floor(seconds%60)+' s'
}
export function feedbackFields(feedback:unknown):[string,unknown][]{
 if(feedback===null||feedback===undefined)return []
 if(typeof feedback!=='object')return [['message',feedback]]
 const object=feedback as Json,value=object.data&&typeof object.data==='object'?object.data:object
 const entries=Object.entries(value).filter(([,item])=>['string','number','boolean'].includes(typeof item))
 const order=['stage','message','reason','progress']
 return entries.sort(([a],[b])=>(order.includes(a)?order.indexOf(a):9)-(order.includes(b)?order.indexOf(b):9)).slice(0,8)
}
export type EventGroup={start:number;length:number;repeats:number;events:Json[]}
const eventKey=(event:Json)=>JSON.stringify([event.type,event.event,event.source,event.target,event.handled_by,event.status])
export function groupedEvents(events:Json[]):EventGroup[]{
 const groups:EventGroup[]=[],keys=events.map(eventKey)
 for(let index=0;index<events.length;){
  let length=1,repeats=1
  for(let width=1;width<=Math.min(12,Math.floor((events.length-index)/2));width++){
   let count=1
   while(index+(count+1)*width<=events.length&&keys.slice(index,index+width).every((key,offset)=>key===keys[index+count*width+offset]))count++
   if(count>1){length=width;repeats=count;break}
  }
  groups.push({start:index,length,repeats,events:events.slice(index,index+length*repeats)});index+=length*repeats
 }
 return groups
}
