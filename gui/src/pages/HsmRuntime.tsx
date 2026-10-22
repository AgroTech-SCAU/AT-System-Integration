import {useEffect,useRef,useState} from 'react'
import {guideCompleted} from '../guide/courses'
import {Panel} from '../components/Foundation'
import {ApiError} from '../api'
import type {Json,PageProps} from './shared'
import type {Workspace} from '../types'
const active=(status?:string)=>['ENTERING','RUNNING','TRANSITIONING','STOPPING'].includes(status||'')
const statusName:Record<string,string>={ENTERING:'进入状态',RUNNING:'运行中',TRANSITIONING:'切换状态',STOPPING:'等待停止确认',STOPPED:'已停止',UNKNOWN:'需要核对设备',FAILED:'执行失败'}
const describe=(value:unknown)=>typeof value==='object'?JSON.stringify(value):String(value)
export default function HsmRuntime({client,onNavigate,observation}:PageProps & {onNavigate:(page:Workspace)=>void}){
 const [machines,setMachines]=useState<Json[]>([]),[rosTasks,setRosTasks]=useState<Json[]>([])
 const [blankRobot,setBlankRobot]=useState(false),[safetyConfirmed,setSafetyConfirmed]=useState(false),[id,setId]=useState('')
 const [session,setSession]=useState<Json|null>(null),[variables,setVariables]=useState<Record<string,string>>({})
 const [message,setMessage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),locked=useRef(false)
 const expected=useRef<'start'|'stop'|null>(null),lastSession=useRef<string|null>(null)
 const showSession=(next:Json|null)=>{
  setSession(next)
  if(next?.id!==lastSession.current){lastSession.current=next?.id||null;setVariables({})}
  if(next&&active(next.status))setId(next.machine_id)
  if(expected.current==='start'&&next?.status==='RUNNING'){setMessage('状态机已运行');guideCompleted('hsm:started');expected.current=null}
  if(expected.current==='stop'&&next?.status==='STOPPED'){setMessage('状态机停止已确认');guideCompleted('hsm:stopped');expected.current=null}
  if(next?.status==='UNKNOWN'){expected.current=null;setMessage('设备停止状态需要核对')}
 }
 const fail=(cause:unknown)=>setError(cause instanceof ApiError?cause.kind==='offline'?'无法连接后台，请核对当前设备状态':cause.details.map(detail=>detail.reason).join(' · ')||'后台连接已失效':cause instanceof Error?cause.message:'操作未完成，请重试')
 useEffect(()=>{
  let alive=true,timer=0
  Promise.all([client.request<Json>('/state-machines'),client.request<Json>('/ros/tasks'),client.request<Json>('/robot-systems')]).then(([machineData,taskData,robotData])=>{if(!alive)return;setMachines(machineData.machines);setId(old=>old||machineData.machines?.[0]?.id||'');setRosTasks(taskData.tasks);const robot=robotData.systems?.find((item:Json)=>item.id===robotData.selected_id);setBlankRobot(Boolean(robot&&!robot.configured))}).catch(cause=>{if(alive)fail(cause)})
  const read=async()=>{try{const response=await client.request<Json>('/state-machines/status');if(alive)showSession(response.session)}catch{if(alive)setMessage('状态暂时无法更新，请核对后台连接')}finally{if(alive)timer=window.setTimeout(read,1000)}}
  void read();return()=>{alive=false;window.clearTimeout(timer)}
 },[client])
 const machine=machines.find(item=>item.id===(session&&active(session.status)?session.machine_id:id))
 const states:Json[]=machine?.document.states||[],edges:Json[]=machine?.document.transitions||[],path=session?.path||[]
 const events=edges.filter(edge=>path.includes(edge.source))
 async function request(work:()=>Promise<void>){if(locked.current)return;locked.current=true;setBusy(true);setError('');try{await work()}catch(cause){fail(cause)}finally{locked.current=false;setBusy(false)}}
 async function run(){
  if(!id)return
  await client.request(`/state-machines/${id}/start`,'POST',{mode:'auto',confirm_safety:blankRobot&&safetyConfirmed})
  expected.current='start';setMessage('启动请求已提交');const response=await client.request<Json>('/state-machines/status');showSession(response.session)
 }
 async function send(event:string){
  const values:Json={}
  for(const [key,raw] of Object.entries(variables)){
   if(!raw.trim())continue
   const value=session?.variables?.[key]
   if(typeof value==='number'){const next=Number(raw);if(!Number.isFinite(next))throw Error(`${key} 需要有效数值`);values[key]=next}
   else if(typeof value==='boolean'){if(!['true','false'].includes(raw.trim()))throw Error(`${key} 只能填写 true 或 false`);values[key]=raw.trim()==='true'}
   else if(typeof value==='object'){try{values[key]=JSON.parse(raw)}catch{throw Error(`${key} 需要有效 JSON`)}}
   else values[key]=raw
  }
  const response=await client.request<Json>('/state-machines/event','POST',{event,variables:values});if(response.session)showSession(response.session)
  setMessage(response.queued?`事件已进入队列，待处理 ${response.queued} 个`:'事件已提交');setVariables({})
 }
 async function stop(){await client.request('/state-machines/stop','POST',{});expected.current='stop';setMessage('停止请求已提交，正在等待设备确认');const response=await client.request<Json>('/state-machines/status');showSession(response.session)}
 return <div data-guide="runtime-hsm"><Panel title="运行状态流程" subtitle="选择流程后启动，在运行中发送事件以切换状态" icon="system"><div className="hsm-runtime-row"><label className="field"><span>选择状态机</span><select value={id} onChange={event=>{setId(event.target.value);setVariables({})}} disabled={active(session?.status)||busy}><option value="">选择状态机</option>{machines.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label><div className="buttons"><button disabled={busy||!id||active(session?.status)||(blankRobot?!safetyConfirmed:observation?.system.state!=='READY')} className="primary" onClick={()=>void request(run)}>运行</button><button disabled={busy||!active(session?.status)||session?.status==='STOPPING'} onClick={()=>void request(stop)}>停止</button><button onClick={()=>onNavigate('editor')}>编辑状态机</button></div></div>
 {blankRobot&&<label className="ros-safety-confirm"><input type="checkbox" checked={safetyConfirmed} onChange={event=>setSafetyConfirmed(event.target.checked)}/><span><strong>机器人运行确认</strong><small>已确认设备急停、动作取消与通信失联保护可用</small></span></label>}
 {!machines.length&&<div className="record-empty"><h3>还没有可运行的状态流程</h3><p>先在编排画布添加状态并保存，再回到这里启动</p><button onClick={()=>onNavigate('editor')}>创建状态流程 →</button></div>}
 {session&&session.machine_id===machine?.id&&<div className="hsm-runtime-status"><strong>{statusName[session.status]||session.status}</strong><span>活动状态 {states.find(state=>state.id===session.active)?.label||session.active||'未进入'}</span>{session.pending_events>0&&<span>事件队列 {session.pending_events}</span>}{session.task_run_id&&<span>行为树正在执行 {session.action||''}</span>}{session.ros_task_id&&<span>{rosTasks.find(task=>task.id===session.ros_task_id)?.name||'ROS 任务'} · {session.action==='entry'?'Entry':session.action==='exit'?'Exit':'Do'}</span>}{session.ros_feedback&&<details><summary>最近反馈</summary><pre className="ros-live-feedback">{JSON.stringify(session.ros_feedback,null,2)}</pre></details>}{session.error&&<p className="error">{session.error}</p>}</div>}
 {session&&active(session.status)&&<><div className="hsm-runtime-events"><h4>状态事件</h4>{events.length?events.map((edge,index)=><button disabled={busy||session.status==='STOPPING'} key={edge.event+edge.source+index} onClick={()=>void request(()=>send(edge.event))}>{states.find(state=>state.id===edge.source)?.label||edge.source} · {edge.event} → {states.find(state=>state.id===edge.target)?.label||edge.target}</button>):<p className="muted">当前状态没有可发送的事件</p>}</div>
 {Object.keys(session.variables||{}).length>0&&<details><summary>发送事件时更新变量</summary><div className="parameter-grid">{Object.entries(session.variables).map(([key,value])=><label className="field" key={key}><span>{key}</span><code title={describe(value)}>{describe(value)?.slice(0,160)}</code><input aria-label={'更新变量 '+key} value={variables[key]||''} placeholder={typeof value==='object'?'JSON，留空保持当前值':'留空保持当前值'} onChange={event=>setVariables(old=>({...old,[key]:event.target.value}))}/></label>)}</div></details>}</>}
 {session&&session.machine_id===machine?.id&&session.events?.length>0&&<details><summary>近期状态转换</summary><div className="hsm-runtime-history">{session.events.slice(-12).reverse().map((event:Json,index:number)=><div key={index}>{states.find(state=>state.id===event.source)?.label||event.source} → {states.find(state=>state.id===event.target)?.label||event.target} <strong>{event.event}</strong></div>)}</div></details>}
 {message&&<p className="callout" role="status">{message}</p>}{error&&<p className="error" role="alert">{error}</p>}</Panel></div>
}
