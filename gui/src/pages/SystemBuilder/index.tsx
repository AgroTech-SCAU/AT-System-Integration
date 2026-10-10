import {useEffect, useState} from 'react'
import {Panel, Field} from '../../components/Foundation'
import {Icon} from '../../components/Icon'
import {guideCompleted} from '../../guide/courses'
import {systemCategories} from '../../components/systemCategories'
import type {RobotSystem} from '../RobotLibrary'
import type {Workspace} from '../../types'
import {ErrorFields, Parameters, durableIntent, useOperation, waitJob, type Json, type PageProps} from '../shared'

type PackageItem = {id:string; imported?:boolean; description:Json}
const idPattern = /^[a-z][a-z0-9_]*$/
const friendly = (value:string) => value.split('.').slice(-2).join(' · ').replaceAll('_',' ')
const stateText = (module?:Json) => !module ? '未运行' : module.process && module.interface ? '已连接' : module.process ? '接口未就绪' : '未运行'
const safeId = (id:string) => id.replace(/[^a-z0-9_]/g,'_').replace(/^[^a-z]+/,'') || 'backend'

export default function SystemBuilder({client, observation, language, changed, robotSystem, onNavigate}:PageProps & {robotSystem:RobotSystem;onNavigate?:(page:Workspace)=>void}){
  const op=useOperation(language)
  const [catalog,setCatalog]=useState<PackageItem[]>([])
  const [drafts,setDrafts]=useState<Json[]>([])
  const [draft,setDraft]=useState<Json|null>(null)
  const [content,setContent]=useState<Json|null>(null)
  const [dirty,setDirty]=useState(false)
  const [composer,setComposer]=useState(false)
  const [category,setCategory]=useState('视觉系统')
  const [packageId,setPackageId]=useState('')
  const [instance,setInstance]=useState('')
  const [description,setDescription]=useState('')
  const [editingBackend,setEditingBackend]=useState<string|null>(null)
  const [expanded,setExpanded]=useState(false)
  const [raw,setRaw]=useState('')
  const [validation,setValidation]=useState<Json|null>(null)
  const [message,setMessage]=useState('')
  const [phase,setPhase]=useState('')
  const [runtimeRaw,setRuntimeRaw]=useState('')
  const backends:Json[]=Array.isArray(content?.backends)?content.backends:[]
  const roles:Json=content?.roles||{}
  const chosen=catalog.find(c=>c.id===packageId)
  const groupOptions=systemCategories
  const categorize=(backend:Json)=>{const nick=String(backend.instance_id).toLowerCase();const direct=nick==='vision'?'视觉系统':nick==='navigation'?'导航系统':nick==='arm'?'机械臂系统':nick==='control'?'电控系统':null;if(direct)return direct;const pack=catalog.find(p=>p.id===backend.package_id);const caps=(pack?.description.capabilities||[]).map((c:Json)=>String(c.capability_id));const matches=groupOptions.slice(0,4).filter(g=>caps.some((id:string)=>g.prefix.some(prefix=>id.startsWith(prefix))));return matches.length===1?matches[0].name:'自定义系统'}
  const selected=backends.find(b=>b.instance_id===editingBackend)
  const selectedPackage=catalog.find(c=>c.id===selected?.package_id)
  const readyForApply=observation?.system.state==='STOPPED'||!observation?.system.state

  async function refresh(){
    const [a,b]=await Promise.all([client.request<Json>('/catalog'),client.request<Json>('/config/drafts')])
    setCatalog(a.packages)
    const found=b.drafts.filter((item:Json)=>item.content?.system_id===robotSystem.content.system_id)
    setDrafts(found)
    return found
  }
  useEffect(()=>{
    let alive=true
    Promise.all([client.request<Json>('/catalog'),client.request<Json>('/config/drafts')]).then(([a,b])=>{
      if(!alive)return
      setCatalog(a.packages)
      const found=b.drafts.filter((item:Json)=>item.content?.system_id===robotSystem.content.system_id)
      setDrafts(found)
      const previous=found.at(-1)
      setDraft(previous||null)
      setContent(structuredClone(previous?.content||robotSystem.content))
      setDirty(false)
    }).catch(op.setError)
    return ()=>{alive=false}
  },[client,robotSystem.id])
  function update(next:Json){setContent(next);setDirty(true);setValidation(null);setMessage('')}
  async function ensureDraft(){
    if(draft)return draft
    const status=await client.request<Json>('/config/status')
    const next=await client.request<Json>('/config/drafts','POST',{base_snapshot_id:status.snapshot_id,content:robotSystem.content})
    setDraft(next);setContent(structuredClone(next.content));setDirty(false)
    await refresh()
    return next
  }
  async function openComposer(nextCategory?:string){
    if(nextCategory)setCategory(nextCategory)
    await ensureDraft();setComposer(true);setEditingBackend(null);setMessage('');if(nextCategory)guideCompleted('system:category-opened')
    setPackageId('');setInstance('');setDescription('')
  }
  async function importPackage(file:File){
    if(file.size>2097152)throw Error('接入描述文件过大')
    const result=await client.request<Json>('/catalog','POST',{filename:file.name,content:await file.text()})
    await refresh();setPackageId(result.id);setInstance(safeId(result.id)+'_1')
    setMessage('接入描述已导入，需部署对应适配器后才能执行设备动作')
  }
  useEffect(()=>{const handler=()=>{if(!composer)void openComposer().catch(op.setError)};window.addEventListener('agro:guide:system-open',handler);return()=>window.removeEventListener('agro:guide:system-open',handler)},[composer,draft,client])
  function addBackend(){
    if(!content||!draft||!chosen)return
    const name=instance.trim()
    if(!idPattern.test(name)) {op.setError({errors:[{path:'实例名称',code:'invalid_name',reason:'请使用小写英文字母、数字和下划线，并以字母开头'}]});return}
    if(backends.some(b=>b.instance_id===name)){op.setError({errors:[{path:'实例名称',code:'duplicate_name',reason:'实例名称已存在，请另起名称'}]});return}
    const extraRoles:Json={}
    for(const cap of chosen.description.capabilities||[]){
      const role=`${name}_${safeId(cap.capability_id)}`
      if(!roles[role])extraRoles[role]={backend_instance:name,capability_id:cap.capability_id,input:cap.input||{},output:cap.output||{},parameters:{}}
    }
    const nextBackends=[...backends,{instance_id:name,package_id:chosen.id,config:{}}]
    const paths=new Set<string>(content.packages||[])
    paths.add(`packages/${chosen.id}.yaml`)
    update({...content,backends:nextBackends,packages:Array.from(paths),roles:{...roles,...extraRoles},required_roles:Array.from(new Set([...(content.required_roles||[]),...Object.keys(extraRoles)]))})
    setComposer(false);setEditingBackend(name)
    setMessage(`已添加「${name}」，能力映射已自动生成，检查参数后保存到机器人`)
    guideCompleted('system:backend-added')
  }
  function removeBackend(name:string){
    if(!content||!window.confirm(`从当前机器人移除「${name}」及其能力映射`))return
    const remaining=backends.filter(b=>b.instance_id!==name)
    const nextRoles=Object.fromEntries(Object.entries(roles).filter(([,v])=>(v as Json).backend_instance!==name))
    const used=new Set(remaining.map(b=>b.package_id))
    const paths=(content.packages||[]).filter((p:string)=>!p.startsWith('packages/')||used.has(p.split('/').pop()?.replace(/\.ya?ml$/,'')))
    update({...content,backends:remaining,packages:paths,roles:nextRoles,required_roles:(content.required_roles||[]).filter((r:string)=>r in nextRoles)})
    setEditingBackend(null)
  }
  function setBackendConfig(name:string,config:Json){update({...content,backends:backends.map(b=>b.instance_id===name?{...b,config}:b)})}
  function setBackendRuntime(name:string,runtime:Json){update({...content,backends:backends.map(b=>b.instance_id===name?{...b,runtime}:b)})}
  async function saveAndApply(progress:(value:string)=>void,signal:AbortSignal){
    if(!content)return
    const current=await ensureDraft()
    progress('检查机器人配置')
    const saved=await client.request<Json>(`/config/drafts/${current.id}`,'PUT',{revision:current.revision,content},signal)
    setDraft(saved);setDirty(false);setValidation(saved.validation)
    await refresh()
    if(!saved.validation?.valid){throw {errors:saved.validation?.errors||[{path:'系统配置',code:'invalid',reason:'请先修正配置问题'}]}}
    if(!readyForApply)throw {errors:[{path:'设备状态',code:'not_stopped',reason:'当前机器人仍在运行，请到运行工作区安全停止后再保存生效'}]}
    progress('确认配置变更')
    const diff=await client.request<Json>(`/config/drafts/${saved.id}/diff`,'GET',undefined,signal)
    if(!diff.validation.valid)throw {errors:diff.validation.errors}
    const payload={draft_id:saved.id,revision:diff.revision,base_snapshot_id:diff.base_snapshot_id}
    const job=await client.request<Json>('/config/apply','POST',{...payload,request_id:durableIntent('apply',payload)},signal)
    progress('应用到当前机器人')
    await waitJob(client,job.management_job_id,progress,signal)
    await client.request(`/robot-systems/${robotSystem.id}/configuration`,'PUT',{revision:robotSystem.revision,content},signal)
    await changed()
    setMessage('配置已应用')
    setPhase('success')
    guideCompleted('system:applied')
  }
  function issueHelp(error:unknown){
    const entries=(error as Json)?.errors || (error as Json)?.details || []
    return entries.map((e:Json)=>e.reason).filter(Boolean).join('；')
  }
  return <div className="studio-system">
    <div className="studio-hero"><div><span className="eyebrow">系统搭建</span><h2>{robotSystem.name}</h2><p>管理设备、软件后端及任务能力</p></div><div className="studio-hero-actions"><span className="studio-count">{backends.length} 个后端 · {Object.keys(roles).length} 项能力</span><button className="primary" data-guide="system-add-button" disabled={op.busy||!content} onClick={()=>void op.run('准备添加系统',async()=>openComposer())}>＋ 添加系统</button></div></div>
    <div className="robot-category-grid" data-guide="system-categories">{groupOptions.map(g=>{const groupBackends=backends.filter(b=>categorize(b)===g.name);return <button key={g.name} className={'robot-category '+(composer&&category===g.name?'chosen':'')} onClick={()=>void op.run('选择系统类型',async()=>openComposer(g.name))}><span className="robot-category-icon" aria-hidden="true"><Icon name={g.icon} size="xl" /></span><strong>{g.name}</strong><small>{g.caption}</small><span className="robot-category-number">{groupBackends.length?`${groupBackends.length} 个后端 · 添加`:'添加后端'}</span></button>})}</div>
    {!robotSystem.configured&&<div className="studio-notice"><strong>未配置后端</strong><span>支持直接编辑逻辑任务</span><button onClick={()=>onNavigate?.('editor')}>任务编排 →</button></div>}
    <div className="studio-steps"><span className="done">1　创建机器人</span><span className={backends.length?'done':''}>2　添加系统</span><span className={robotSystem.configured&&!dirty?'done':''}>3　保存配置</span><button onClick={()=>onNavigate?.('editor')}>4　设计任务 →</button></div>
    {backends.length===0&&!composer?<div className="studio-empty"><span className="studio-empty-icon"><Icon name="boxes" size="xl" /></span><h3>暂无功能后端</h3><p>选择系统类别，添加可用的接入包</p><button className="primary" onClick={()=>void op.run('准备添加系统',async()=>openComposer())}>添加第一个系统 →</button></div>:null}
    {composer&&<section className="studio-composer" data-guide="system-start-config"><header><div><span className="eyebrow">接入向导</span><h3>添加{category}</h3><p>选择类别与接入包，确认能力后添加</p></div><button disabled={op.busy} onClick={()=>setComposer(false)}>关闭</button></header><div className="studio-composer-grid"><div><div className="studio-category-select"><Field label="① 系统类别"><select value={category} onChange={e=>{setCategory(e.target.value);setPackageId('');setInstance('')}}>{groupOptions.map(g=><option key={g.name}>{g.name}</option>)}</select></Field></div><h4>② 接入包</h4><p className="muted">选择已有接入包，或导入新的接入描述</p><div data-guide="system-package-select"><Field label="已有接入描述"><select value={packageId} onChange={e=>{setPackageId(e.target.value);setInstance(safeId(e.target.value)+'_1');if(e.target.value)guideCompleted('system:package-selected')}}><option value="">选择已登记的接入描述</option>{catalog.filter(p=>category==='自定义系统'||(p.description.capabilities||[]).some((c:Json)=>groupOptions.find(g=>g.name===category)?.prefix.some(prefix=>String(c.capability_id).startsWith(prefix)))).map(p=><option key={p.id} value={p.id}>{p.id}</option>)}</select></Field></div><label className="file-button studio-import">＋ 导入新的接入描述<input type="file" accept=".yaml,.yml,.json" onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void op.run('导入接入描述',async()=>importPackage(file))}} /></label><Field label="③ 后端标识"><input value={instance} onChange={e=>setInstance(e.target.value)} placeholder="例如 arm_left 或 camera_front" /></Field><button data-guide="system-backend-confirm" className="primary" disabled={op.busy||!chosen||!instance.trim()} onClick={addBackend}>添加后端 →</button></div><div className="studio-capability-preview"><h4>可用能力</h4>{chosen?<><p>{chosen.description.capabilities?.length||0} 项能力 · 自动生成任务绑定</p>{chosen.description.capabilities?.map((cap:Json)=><div className="studio-capability" key={cap.capability_id}><strong>{friendly(cap.capability_id)}</strong><small>{cap.description||cap.capability_id}</small></div>)}<p className="studio-warning">设备控制需要已部署并授权的适配器</p></>:<p>选择接入包以查看能力</p>}</div></div></section>}
    <div className="studio-module-list" data-guide="system-backend-list">{backends.map(backend=>{const entry=catalog.find(p=>p.id===backend.package_id);const mapping=Object.entries(roles).filter(([,r])=>(r as Json).backend_instance===backend.instance_id);const active=observation?.system.modules?.[backend.instance_id];return <section className={'studio-module '+(editingBackend===backend.instance_id?'focused':'')} key={backend.instance_id}><div className="studio-module-main"><div className="studio-module-icon"><Icon name={groupOptions.find(g=>g.name===categorize(backend))?.icon||'boxes'} size="xl" /></div><div className="studio-module-heading"><strong>{categorize(backend)} · {backend.instance_id}</strong><small>{entry?.description?.source||backend.package_id}</small><span>{mapping.length} 项任务能力</span></div><span className={'studio-module-state '+(active?.process&&active?.interface?'connected':'')}>{stateText(active)}</span><button data-guide="system-backend-config" onClick={()=>{const opening=editingBackend!==backend.instance_id;setEditingBackend(opening?backend.instance_id:null);setRuntimeRaw('');if(opening)guideCompleted('system:detail-opened')}}>{editingBackend===backend.instance_id?'收起':'配置与能力'} →</button></div>{editingBackend===backend.instance_id&&<div className="studio-module-detail"><h4>能力列表</h4><div className="studio-capability-grid">{mapping.map(([name,r]:[string,any])=><div className="studio-capability" key={name}><strong>{friendly(r.capability_id)}</strong><small>{entry?.description.capabilities?.find((c:Json)=>c.capability_id===r.capability_id)?.description||name}</small><details><summary>选择执行该能力的后端</summary><select value={r.backend_instance} onChange={e=>{if(!content)return;update({...content,roles:{...roles,[name]:{...r,backend_instance:e.target.value}}})}}>{backends.filter(b=>catalog.some(p=>p.id===b.package_id&&p.description.capabilities?.some((c:Json)=>c.capability_id===r.capability_id&&JSON.stringify(c.input)===JSON.stringify(r.input)&&JSON.stringify(c.output)===JSON.stringify(r.output)))).map(b=><option key={b.instance_id} value={b.instance_id}>{b.instance_id}</option>)}</select></details></div>)}</div><h4>系统参数</h4>{Object.keys(entry?.description.config||{}).length?<Parameters specs={entry?.description.config||{}} value={backend.config||{}} onChange={v=>setBackendConfig(backend.instance_id,v)}/>:<p className="muted">无额外参数</p>}<details className="studio-advanced"><summary>开发者选项 · 运行配置与接口描述</summary><p>接入包运行参数，修改后需重新应用配置</p><textarea rows={6} value={runtimeRaw||JSON.stringify(backend.runtime||entry?.description.runtime||{},null,2)} onChange={e=>setRuntimeRaw(e.target.value)} /><button onClick={()=>{try{setBackendRuntime(backend.instance_id,JSON.parse(runtimeRaw||JSON.stringify(backend.runtime||entry?.description.runtime||{})));setRuntimeRaw('')}catch{op.setError({errors:[{path:'运行配置',code:'invalid_json',reason:'请填写合法的 JSON 对象'}]})}}}>保存运行设置</button></details><button className="danger-quiet" onClick={()=>removeBackend(backend.instance_id)}>移除后端</button></div>}</section>})}</div>
    <section className="studio-save" data-guide="system-save-config"><div><h3>{dirty?'配置待应用':robotSystem.configured?'配置已应用':'配置未应用'}</h3><p>{backends.length===0?'添加后端后可应用配置，逻辑任务无需后端':'校验通过后，在停止状态下应用配置'}</p>{!readyForApply&&<p className="studio-warning">运行中不可应用配置</p>}{validation&&!validation.valid&&<ErrorFields value={validation}/>}</div><div className="buttons"><button className="primary" disabled={!content||op.busy||!readyForApply||(!dirty&&robotSystem.configured)||backends.length===0} onClick={()=>void op.run('保存机器人配置',saveAndApply)}>{backends.length===0?'请先添加后端':dirty?'保存并应用':robotSystem.configured?'已应用':'保存并应用'}</button><button onClick={()=>onNavigate?.('editor')}>进入任务编排 →</button></div></section>
    <details className="studio-advanced" open={expanded} onToggle={e=>setExpanded(e.currentTarget.open)}><summary>开发者选项 · 接入包与原始配置</summary><div className="studio-advanced-body"><h4>接入描述目录</h4>{catalog.map(p=><div className="studio-capability" key={p.id}><strong>{p.id}</strong><small>{p.description.capabilities?.length||0} 项能力</small><details><summary>查看接口结构</summary><pre>{JSON.stringify(p.description,null,2)}</pre></details></div>)}<h4>配置草稿</h4><select value={draft?.id||''} onChange={e=>{const item=drafts.find(v=>v.id===e.target.value);if(item){setDraft(item);setContent(structuredClone(item.content));setDirty(false);setEditingBackend(null)}}}><option value="">尚未建立草稿</option>{drafts.map((d:Json)=><option key={d.id} value={d.id}>{d.content.system_id} · {d.id.slice(-8)}</option>)}</select><button onClick={()=>void op.run('重新建立草稿',async()=>{if(dirty&&!window.confirm('当前尚未保存的修改会被放弃，确认重新开始'))return;const status=await client.request<Json>('/config/status');const next=await client.request<Json>('/config/drafts','POST',{base_snapshot_id:status.snapshot_id,content:robotSystem.content});setDraft(next);setContent(structuredClone(next.content));setDirty(false);await refresh()})}>从当前机器人重新建立配置</button><h4>原始配置</h4><textarea rows={9} value={raw||JSON.stringify(content||{},null,2)} onChange={e=>setRaw(e.target.value)}/><button onClick={()=>{try{const next=JSON.parse(raw);if(!next||Array.isArray(next)||typeof next!=='object')throw Error();update(next);setRaw('')}catch{op.setError({errors:[{path:'原始配置',code:'invalid_json',reason:'配置必须是有效的 JSON 对象'}]})}}} disabled={!raw}>应用原始编辑</button></div></details>
    {message&&<p className={phase==='success'?'callout':'muted'} role="status">{message}</p>}
    <ErrorFields value={op.error}/>{op.dialog()}
  </div>
}
