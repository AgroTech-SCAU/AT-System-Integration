import {useEffect,useState} from 'react'
import {guideCompleted} from '../guide/courses'
import {Panel} from '../components/Foundation'
import {ErrorFields,useOperation,type Json,type PageProps} from './shared'
import type {Workspace} from '../types'
const active=(status?:string)=>['ENTERING','RUNNING','TRANSITIONING','STOPPING'].includes(status||'')
export default function HsmRuntime({client,language,onNavigate,observation}:PageProps & {onNavigate:(page:Workspace)=>void}){
 const op=useOperation(language)
 const [machines,setMachines]=useState<Json[]>([])
 const [id,setId]=useState('')
 const [session,setSession]=useState<Json|null>(null)
 const [variables,setVariables]=useState<Record<string,string>>({})
 const [message,setMessage]=useState('')
 useEffect(()=>{let alive=true;client.request<Json>('/state-machines').then(data=>{if(alive){setMachines(data.machines);setId(old=>old||data.machines?.[0]?.id||'')}}).catch(op.setError)
  const read=()=>client.request<Json>('/state-machines/status').then(r=>{if(alive)setSession(r.session)}).catch(()=>{if(alive)setMessage('状态机接口不可用')})
  void read();const timer=window.setInterval(read,800);return()=>{alive=false;window.clearInterval(timer)}
 },[client])
 const machine=machines.find(m=>m.id===(session&&active(session.status)?session.machine_id:id))
 const states:Json[]=machine?.document.states||[]
 const edges:Json[]=machine?.document.transitions||[]
 const path=session?.path||[]
 const events=edges.filter(t=>path.includes(t.source))
 async function confirmStatus(expected:'RUNNING'|'STOPPED'){
  const deadline=Date.now()+30000
  while(Date.now()<deadline){
   const current=await client.request<Json>('/state-machines/status')
   setSession(current.session)
   if(current.session?.status===expected)return
   if(current.session?.status==='UNKNOWN')throw Error('状态机运行状态未知，请检查任务与设备停止确认')
   await new Promise(resolve=>setTimeout(resolve,300))
  }
  throw Error('等待状态机确认超时，请核对当前运行状态')
 }
 async function run(){if(!id)return;await client.request(`/state-machines/${id}/start`,'POST',{});setMessage('正在确认状态机已启动');await confirmStatus('RUNNING');setMessage('状态机已运行');guideCompleted('hsm:started')}
 async function send(event:string){const vars:Json={};for(const [key,raw] of Object.entries(variables)){if(!raw.trim())continue;const source=session?.variables?.[key];vars[key]=typeof source==='number'?Number(raw):typeof source==='boolean'?raw==='true':raw}await client.request('/state-machines/event','POST',{event,variables:vars});const status=await client.request<Json>('/state-machines/status');setSession(status.session);setMessage('事件已提交')}
 async function stop(){await client.request('/state-machines/stop','POST',{});setMessage('正在确认状态机已停止');await confirmStatus('STOPPED');setMessage('状态机停止已确认');guideCompleted('hsm:stopped')}
 return <div data-guide="runtime-hsm"><Panel title="业务层级状态机" subtitle="状态、事件与关联任务" icon="system"><div className="hsm-runtime-row"><label className="field"><span>选择状态机</span><select value={id} onChange={e=>setId(e.target.value)} disabled={active(session?.status)}><option value="">尚未创建状态机</option>{machines.map(m=><option value={m.id} key={m.id}>{m.name}</option>)}</select></label><div className="buttons"><button disabled={op.busy||!id||active(session?.status)||observation?.system.state!=='READY'} className="primary" onClick={()=>void op.run('启动状态机',async()=>run())}>启动状态机</button><button disabled={op.busy||!active(session?.status)} onClick={()=>void op.run('安全停止状态机',async()=>stop())}>停止状态机</button><button onClick={()=>onNavigate('editor')}>编辑状态机 →</button></div></div>
 {!machines.length&&<p className="muted">暂无状态机 · 可在任务编排中创建</p>}
 {session&&<div className="hsm-runtime-status"><strong>当前 {session.status==='RUNNING'?'运行中':session.status==='UNKNOWN'?'需要人工核对':session.status==='STOPPED'?'已停止':session.status}</strong><span>活动状态：{states.find(s=>s.id===session.active)?.label||session.active||'未进入'}</span>{session.task_run_id&&<span>正在执行关联行为树</span>}{session.error&&<p className="error">{session.error}</p>}</div>}
 {session&&active(session.status)&&<><div className="hsm-runtime-events"><h4>当前可触发的事件</h4>{events.length?events.map((e,i)=><button disabled={op.busy||session.status!=='RUNNING'} key={e.event+e.source+i} onClick={()=>void op.run('处理状态事件',async()=>send(e.event))}>{states.find(s=>s.id===e.source)?.label||e.source} · {e.event} → {states.find(s=>s.id===e.target)?.label||e.target}</button>):<p className="muted">当前状态无可触发的手动事件</p>}</div>
 {Object.keys(session.variables||{}).length>0&&<details><summary>事件变量（发送时生效）</summary><div className="parameter-grid">{Object.entries(session.variables).map(([key,value])=><label className="field" key={key}><span>{key}（当前 {String(value)}）</span><input value={variables[key]||''} placeholder="留空表示不修改" onChange={e=>setVariables(old=>({...old,[key]:e.target.value}))}/></label>)}</div></details>}</>}
 {session&&session.events?.length>0&&<details><summary>近期状态转换</summary><div className="hsm-runtime-history">{session.events.slice(-12).reverse().map((e:Json,i:number)=><div key={i}>{e.source} → {e.target} <strong>{e.event}</strong></div>)}</div></details>}
 {message&&<p className="callout">{message}</p>}<ErrorFields value={op.error}/>{op.dialog()}</Panel></div>
}
