import type {Json} from './shared'

export const active=(state?:string)=>['ACCEPTED','RUNNING','CANCELING','ENTERING','TRANSITIONING','STOPPING'].includes(state||'')
const taskNeedsReview=(task:Json)=>task.state==='UNKNOWN'||task.stop_confirmed===false
const flowNeedsReview=(flow:Json)=>flow.status==='UNKNOWN'||flow.stop_confirmed===false||
 (flow.behaviors||[]).some((behavior:Json)=>behavior.status==='UNKNOWN')||
 (flow.operations||[]).some((operation:Json)=>operation.stop_state==='UNCONFIRMED')

// Execution controls follow live summaries, independently of the record on screen.
export function runtimeActivity(session:Json|null,tasks:Json[]){
 const currentTasks=[...tasks].reverse()
 const runningFlow=session&&active(session.status)?session:null
 const runningTask=currentTasks.find(task=>active(task.state))||null
 const unresolvedFlow=session&&flowNeedsReview(session)?session:null
 const unresolvedTask=currentTasks.find(taskNeedsReview)||null
 const flow=runningFlow||(!runningTask?unresolvedFlow:null)
 const task=flow?null:runningTask||unresolvedTask
 return {
  flow,task,
  blocked:!!(runningFlow||runningTask||unresolvedFlow||unresolvedTask),
  canCancel:!!(runningFlow||runningTask),
  status:flow?(active(flow.status)?flow.status:'UNKNOWN'):task?(active(task.state)?task.state:'UNKNOWN'):null,
 }
}
