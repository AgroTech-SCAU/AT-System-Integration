import {useEffect, useState,type ReactNode} from 'react'
import {Panel,Field} from '../components/Foundation'
import {guideCompleted} from '../guide/courses'
import {ErrorFields,useOperation,type Json,type PageProps} from './shared'
import type {Workspace} from '../types'

type MachineState={id:string;label:string;parent?:string;initial?:string;entry?:string;do?:string;exit?:string}
type Transition={source:string;target:string;event:string;guard?:{operator:string;key?:string;value?:string|number|boolean}}
type MachineDocument={initial:string;states:MachineState[];transitions:Transition[];variables:Record<string,string|number|boolean>}
type SavedMachine={id:string;name:string;document:MachineDocument;revision:number;needs_tree_rebinding?:boolean}
const blank=():MachineDocument=>({initial:'workflow',states:[{id:'workflow',label:'工作流程',initial:'idle'},{id:'idle',label:'待命',parent:'workflow'},{id:'working',label:'执行任务',parent:'workflow'},{id:'finished',label:'已完成',parent:'workflow'}],transitions:[{source:'idle',target:'working',event:'start'},{source:'working',target:'finished',event:'completed'},{source:'working',target:'idle',event:'failed'}],variables:{}})
const isId=(id:string)=>/^[a-z][a-z0-9_]{0,63}$/.test(id)
const activeStatus=(state?:string)=>['ENTERING','RUNNING','TRANSITIONING','STOPPING'].includes(state||'')

export default function StateMachineEditor({client,language,onNavigate}:PageProps & {onNavigate:(page:Workspace)=>void}){
 const op=useOperation(language)
 const [machines,setMachines]=useState<SavedMachine[]>([])
 const [definitions,setDefinitions]=useState<Json[]>([])
 const [current,setCurrent]=useState<SavedMachine|null>(null)
 const [title,setTitle]=useState('我的状态机')
 const [document,setDocument]=useState<MachineDocument>(blank)
 const [selected,setSelected]=useState('idle')
 const [dirty,setDirty]=useState(false)
 const [newState,setNewState]=useState('')
 const [newEvent,setNewEvent]=useState('')
 const [newVariable,setNewVariable]=useState('')
 const [session,setSession]=useState<Json|null>(null)
 const [notice,setNotice]=useState('')
 async function reload(){
  const [m,d,s]=await Promise.all([client.request<Json>('/state-machines'),client.request<Json>('/trees/definitions'),client.request<Json>('/state-machines/status')])
  setMachines(m.machines);setDefinitions(d.definitions);setSession(s.session)
  return m.machines as SavedMachine[]
 }
 useEffect(()=>{let alive=true;Promise.all([client.request<Json>('/state-machines'),client.request<Json>('/trees/definitions'),client.request<Json>('/state-machines/status')]).then(([m,d,s])=>{
  if(!alive)return;setMachines(m.machines);setDefinitions(d.definitions);setSession(s.session)
  if(m.machines.length){const latest=m.machines.at(-1);setCurrent(latest);setTitle(latest.name);setDocument(structuredClone(latest.document));setSelected(latest.document.states.find((state:MachineState)=>state.parent)?.id||latest.document.initial)}
 }).catch(op.setError);return()=>{alive=false}},[client])
 useEffect(()=>{const refresh=()=>{void reload().catch(op.setError)};window.addEventListener('agro:hsm:refresh',refresh);return()=>window.removeEventListener('agro:hsm:refresh',refresh)},[client])
 useEffect(()=>{const timer=window.setInterval(()=>{client.request<Json>('/state-machines/status').then(r=>setSession(r.session)).catch(()=>{})},900);return()=>clearInterval(timer)},[client])
 const state=document.states.find(s=>s.id===selected)
 const root=document.states.find(s=>!s.parent)
 const children=(parent:string)=>document.states.filter(s=>s.parent===parent)
 const currentRunning=activeStatus(session?.status)&&session?.machine_id===current?.id
 function modify(next:MachineDocument){setDocument(next);setDirty(true);setNotice('')}
 function changeState(id:string,updates:Partial<MachineState>){modify({...document,states:document.states.map(s=>s.id===id?{...s,...updates}:s)})}
 function loadMachine(machine:SavedMachine){if(dirty&&!window.confirm('当前未保存的状态机修改将被放弃，确认切换'))return;setCurrent(machine);setTitle(machine.name);setDocument(structuredClone(machine.document));setSelected(machine.document.states.find(s=>s.parent)?.id||machine.document.initial);setDirty(false);setNotice('')}
 function create(){if(dirty&&!window.confirm('当前修改尚未保存，确认创建新状态机'))return;setCurrent(null);setTitle('我的状态机');setDocument(blank());setSelected('idle');setDirty(true);setNotice('')}
 function addState(){const id=newState.trim();if(!isId(id)||document.states.some(s=>s.id===id)){setNotice('状态标识需要唯一，使用小写英文、数字和下划线，并以字母开头');return}const parent=selected||document.initial;const next={...document,states:[...document.states,{id,label:id,parent}],transitions:[...document.transitions]};const owner=next.states.find(s=>s.id===parent);if(owner&&!owner.initial)owner.initial=id;modify(next);setSelected(id);setNewState('')}
 function removeState(){if(!state||state.id===document.initial)return;const doomed=new Set([state.id]);let found=true;while(found){found=false;document.states.forEach(s=>{if(s.parent&&doomed.has(s.parent)&&!doomed.has(s.id)){doomed.add(s.id);found=true}})}
  const remaining=document.states.filter(s=>!doomed.has(s.id)).map(s=>({ ...s,initial:s.initial&&doomed.has(s.initial)?document.states.find(c=>c.parent===s.id&&!doomed.has(c.id))?.id: s.initial }))
  modify({...document,states:remaining,transitions:document.transitions.filter(t=>!doomed.has(t.source)&&!doomed.has(t.target))});setSelected(state.parent||document.initial)
 }
 function addTransition(){if(!state)return;const event=newEvent.trim();if(!isId(event)){setNotice('事件标识只能使用小写英文、数字和下划线');return}if(document.transitions.some(t=>t.source===state.id&&t.event===event)){setNotice('当前状态已存在同名事件');return}
  modify({...document,transitions:[...document.transitions,{source:state.id,target:document.initial,event,guard:{operator:'always'}}]});setNewEvent('');guideCompleted('hsm:transition-added')
 }
 async function save(){const payload={id:current?.id||null,name:title,document};const saved=await client.request<SavedMachine>('/state-machines','POST',payload);const items=await reload();setCurrent(saved);setMachines(items);setDirty(false);setNotice('状态机已保存');guideCompleted('hsm:saved')}
 async function execute(action:'start'|'stop',name?:string){if(action==='start'&&(!current||dirty)){setNotice('先保存当前状态机，再启动');return}await client.request(action==='start'?`/state-machines/${current!.id}/start`:'/state-machines/stop','POST',{});await reload();setNotice(action==='start'?'启动请求已提交':'停止请求已提交 · 等待停止确认')}
 async function fire(name:string){await client.request('/state-machines/event','POST',{event:name,variables:{}});await reload();setNotice('事件已提交 · 可在运行调试查看转换结果')}
 const lineage=(id:string,level=0):ReactNode=>{const s=document.states.find(t=>t.id===id);if(!s||level>48)return null;return <div key={id} className="hsm-hierarchy-row"><button className={'hsm-state '+(selected===id?'selected ':'')+(session?.active===id?'live':'')} style={{marginLeft:level*18}} onClick={()=>setSelected(id)}><strong>{s.label||s.id}</strong><small>{s.id}{s.do?' · BT':''}{session?.active===id?' · 正在执行':''}</small></button>{children(id).map(c=>lineage(c.id,level+1))}</div>}
 const descendants=state?document.states.filter(s=>s.id!==state.id):[]
 const transitions=document.transitions.filter(t=>t.source===selected)
 return <div className="hsm-editor" data-guide="task-hsm-workspace">
  <div className="studio-hero"><div><span className="eyebrow">HIERARCHICAL STATE MACHINE</span><h2>层级状态机</h2><p>编辑业务状态、转换事件及行为树关联</p></div><div className="buttons"><button onClick={()=>onNavigate('runtime')}>运行观察 →</button><button className="primary" onClick={create}>＋ 新建状态机</button></div></div>
  <div className="hsm-toolbar"><Field label="已保存的状态机"><select value={current?.id||''} onChange={e=>{const item=machines.find(m=>m.id===e.target.value);if(item)loadMachine(item)}}><option value="">新建草稿</option>{machines.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></Field><Field label="状态机名称"><input value={title} maxLength={80} onChange={e=>{setTitle(e.target.value);setDirty(true)}} /></Field><div className="buttons"><button data-guide="task-hsm-save" className="primary" disabled={op.busy||!dirty&&!current} onClick={()=>void op.run('保存状态机',async()=>save())}>{dirty?'保存状态机':'保存当前定义'}</button>{current&&<button disabled={op.busy||currentRunning} onClick={()=>void op.run('删除状态机',async()=>{if(!window.confirm('确认删除当前状态机定义'))return;await client.request(`/state-machines/${current.id}`,'DELETE');await reload();create()})}>删除定义</button>}</div></div>
  <div className="hsm-grid"><Panel title="状态层级" subtitle="点击状态编辑属性和动作" icon="templates"><div data-guide="hsm-state-tree" className="hsm-hierarchy">{root&&lineage(root.id)}</div><div data-guide="hsm-add-state" className="hsm-add"><Field label="新状态标识"><input placeholder="例如 approach" value={newState} onChange={e=>setNewState(e.target.value)}/></Field><button disabled={!newState} onClick={addState}>在选中状态下新增子状态</button></div><p className="muted">每个复合状态需要指定初始子状态</p></Panel>
  <Panel title="状态设置" subtitle="Entry 进入一次 · Do 状态内运行 · Exit 离开前执行" icon="settings">{state?<><Field label="显示名称"><input value={state.label} onChange={e=>changeState(selected,{label:e.target.value})}/></Field><Field label="父状态"><select disabled={selected===document.initial} value={state.parent||''} onChange={e=>{const parent=e.target.value;const childSet=new Set([selected]);let changed=true;while(changed){changed=false;document.states.forEach(s=>{if(s.parent&&childSet.has(s.parent)&&!childSet.has(s.id)){childSet.add(s.id);changed=true}})}if(childSet.has(parent))return;const next=structuredClone(document);const editing=next.states.find(s=>s.id===selected)!;const oldParent=editing.parent;editing.parent=parent||undefined;for(const p of next.states){if(p.id===oldParent&&p.initial===selected)p.initial=next.states.find(c=>c.parent===p.id&&c.id!==selected)?.id;if(p.id===parent&&!p.initial)p.initial=selected}modify(next)}}><option value="">根状态</option>{descendants.filter(s=>{let p=s.parent;while(p){if(p===selected)return false;p=document.states.find(x=>x.id===p)?.parent}return true}).map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
   {children(selected).length>0&&<Field label="初始子状态"><select value={state.initial||''} onChange={e=>changeState(selected,{initial:e.target.value})}>{children(selected).map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>}
   <div data-guide="hsm-lifecycle">{(['entry','do','exit'] as const).map(phase=><Field key={phase} label={phase==='entry'?'Entry · 进入动作':phase==='do'?'Do · 持续行为':'Exit · 退出动作'}><select value={state[phase]||''} onChange={e=>{changeState(selected,{[phase]:e.target.value||undefined});if(phase==='do'&&e.target.value)guideCompleted('hsm:tree-bound')}}><option value="">不执行关联行为树</option>{definitions.map(d=><option value={d.id} key={d.id}>{d.layout?.labels?.[d.document.trees?.[d.document.main_tree_id]?.root_id]||d.document.main_tree_id} · {d.id.slice(-7)}</option>)}</select></Field>)}</div>
   {!definitions.length&&<p className="studio-warning">暂无已发布行为树 · 保存或发布 BT 后可选择关联</p>}
   <button disabled={state.id===document.initial} onClick={removeState}>删除选中状态及其子状态</button>
  </>:<p>请从左侧选择一个状态</p>}</Panel>
  <div data-guide="hsm-transitions"><Panel title="状态转换" subtitle="事件、目标状态与转换条件" icon="runtime">{transitions.map((t,i)=>{const index=document.transitions.indexOf(t);return <div className="hsm-transition" key={selected+'-'+i}><div className="hsm-transition-heading"><strong>{t.event}</strong><button onClick={()=>modify({...document,transitions:document.transitions.filter((_,n)=>n!==index)})}>移除</button></div><Field label="目标状态"><select value={t.target} onChange={e=>modify({...document,transitions:document.transitions.map((v,n)=>n===index?{...v,target:e.target.value}:v)})}>{document.states.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></Field><Field label="Guard · 条件"><select value={t.guard?.operator||'always'} onChange={e=>modify({...document,transitions:document.transitions.map((v,n)=>n===index?{...v,guard:{...v.guard,operator:e.target.value}}:v)})}><option value="always">总是允许</option><option value="equals">变量等于</option><option value="not_equals">变量不等于</option><option value="greater">变量大于</option><option value="less">变量小于</option></select></Field>{t.guard?.operator&&t.guard.operator!=='always'&&<div className="hsm-guard"><Field label="变量"><select value={t.guard?.key||''} onChange={e=>modify({...document,transitions:document.transitions.map((v,n)=>n===index?{...v,guard:{...v.guard!,key:e.target.value}}:v)})}><option value="">选择变量</option>{Object.keys(document.variables).map(k=><option key={k} value={k}>{k}</option>)}</select></Field><Field label="比较值"><input value={String(t.guard?.value??'')} onChange={e=>{const raw=e.target.value;const key=t.guard?.key||'';const val=typeof document.variables[key]==='number'?Number(raw):typeof document.variables[key]==='boolean'?raw==='true':raw;modify({...document,transitions:document.transitions.map((v,n)=>n===index?{...v,guard:{...v.guard!,value:val}}:v)})}}/></Field></div>}</div>})}
  <div className="hsm-add"><Field label="新事件名称"><input value={newEvent} placeholder="例如 target_detected" onChange={e=>setNewEvent(e.target.value)}/></Field><button disabled={!newEvent||!state} onClick={addTransition}>添加事件转换</button></div></Panel></div></div>
  <Panel title="状态变量与运行" subtitle="状态变量供 Guard 判断，任务执行结果可触发 completed 或 failed" icon="system"><div className="hsm-variable-list">{Object.entries(document.variables).map(([key,value])=><div key={key} className="hsm-variable"><strong>{key}</strong><input aria-label={key} value={String(value)} onChange={e=>{const next=structuredClone(document);next.variables[key]=typeof value==='number'?Number(e.target.value):typeof value==='boolean'?e.target.value==='true':e.target.value;modify(next)}}/><button onClick={()=>{const next=structuredClone(document);delete next.variables[key];modify(next)}}>删除</button></div>)}</div><div className="hsm-add"><Field label="新变量标识"><input placeholder="例如 target_found" value={newVariable} onChange={e=>setNewVariable(e.target.value)}/></Field><button onClick={()=>{if(!isId(newVariable)||newVariable in document.variables){setNotice('变量标识无效或重复');return}modify({...document,variables:{...document.variables,[newVariable]:false}});setNewVariable('')}}>添加变量</button></div>
  <div className="hsm-runner"><div><strong>状态机运行</strong><p>{session?.status||'尚未启动'} · {session?.active||'无活动状态'}</p>{session?.error&&<p className="error">{session.error}</p>}</div><div className="buttons"><button className="primary" disabled={op.busy||!current||dirty||activeStatus(session?.status)} onClick={()=>void op.run('启动业务状态机',async()=>execute('start'))}>启动状态机</button><button disabled={op.busy||!activeStatus(session?.status)} onClick={()=>void op.run('安全停止状态机',async()=>execute('stop'))}>停止状态机</button>{currentRunning&&document.transitions.filter(t=>session?.path?.includes(t.source)).map(t=><button key={t.source+t.event} disabled={op.busy} onClick={()=>void op.run('发送事件',async()=>fire(t.event))}>发送 {t.event}</button>)}</div></div>
  </Panel>
  {current&&current.needs_tree_rebinding&&<p className="studio-warning">导入状态机的行为树引用需要重新关联</p>}
  {notice&&<p className="callout" role="status">{notice}</p>}<ErrorFields value={op.error}/>{op.dialog()}
 </div>
}
