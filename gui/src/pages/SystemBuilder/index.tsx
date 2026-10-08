import { useEffect, useState } from 'react'
import { Panel, Field } from '../../components/Foundation'
import { ErrorFields, Parameters, durableIntent, useOperation, waitJob, type Json, type PageProps } from '../shared'

export default function SystemBuilder({client,observation,language,changed}:PageProps){
  const [catalog,setCatalog]=useState<Json[]>([]),[drafts,setDrafts]=useState<Json[]>([]),[draft,setDraft]=useState<Json|null>(null),[content,setContent]=useState<Json|null>(null),[diff,setDiff]=useState<Json|null>(null)
  const [runtimeText,setRuntimeText]=useState<Record<string,string>>({})
  const [instance,setInstance]=useState('backend'),[packageId,setPackageId]=useState(''),[roleName,setRoleName]=useState('')
  const op=useOperation(language)
  async function load(){const [a,b]=await Promise.all([client.request<Json>('/catalog'),client.request<Json>('/config/drafts')]);setCatalog(a.packages);setDrafts(b.drafts)}
  useEffect(()=>{let active=true;load().catch(e=>{if(active)op.setError(e)});return()=>{active=false}},[client])
  const select=(next:Json)=>{setDraft(next);setContent(structuredClone(next.content));setRuntimeText({});setDiff(null)}
  const update=(next:Json)=>{setContent(next);setRuntimeText(previous=>{const next={...previous};delete next.raw;return next});setDiff(null)}
  async function create(){const next=await client.request<Json>('/config/drafts','POST',{base_snapshot_id:observation?.system.snapshot_id});select(next);await load()}
  const backends:Json[]=Array.isArray(content?.backends)?content.backends.filter((b:unknown)=>b&&typeof b==='object'&&!Array.isArray(b)):[]
  const roles:Json=content?.roles&&typeof content.roles==='object'&&!Array.isArray(content.roles)?Object.fromEntries(Object.entries(content.roles).filter(([,b])=>b&&typeof b==='object'&&!Array.isArray(b))):{}
  const requiredRoles:string[]=Array.isArray(content?.required_roles)?content.required_roles:[]
  const invalidEditor=Object.values(runtimeText).some(text=>{try{const value=JSON.parse(text);return !value||typeof value!=='object'||Array.isArray(value)}catch{return true}})
  const packages=(backends:Json[])=>Array.from(new Set(backends.map(b=>`packages/${b.package_id}.yaml`)))
  return <>
    <div className="workspace-grid">
      <Panel title="接入包目录" subtitle="导入只保存描述，应用和启用是独立操作" icon="plug">
        <label className="file-button">导入 package.yaml<input type="file" accept=".yaml,.yml,.json" aria-label="导入接入包" disabled={op.busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void op.run('静态校验接入包',async()=>{if(file.size>2097152)throw new Error('文件过大');await client.request('/catalog','POST',{filename:file.name,content:await file.text()});await load()})}}/></label>
        {catalog.map(entry=><div className="package-row" key={entry.id}><div><strong>{entry.id}</strong><p className="muted">{entry.description.source} · 描述已保存</p><details><summary>能力与契约</summary>{entry.description.capabilities.map((cap:Json)=><div key={cap.capability_id}><strong>{cap.capability_id}</strong><p>{cap.description}</p><pre>{JSON.stringify({input:cap.input,output:cap.output},null,2)}</pre></div>)}</details></div><button disabled={op.busy} onClick={()=>void op.run('删除目录项',async()=>{await client.request(`/catalog/${entry.id}`,'DELETE');await load()})}>删除描述</button></div>)}
      </Panel>
      <Panel title="系统配置草稿" subtitle="草稿不会改变当前生效配置" icon="system">
        <div className="buttons"><button disabled={op.busy||!observation} onClick={()=>void op.run('创建草稿',create)}>从当前系统创建草稿</button><button disabled={op.busy} onClick={()=>void op.run('重新加载草稿',async()=>{await load();if(draft)select(await client.request<Json>(`/config/drafts/${draft.id}`))})}>重新加载</button></div>
        <Field label="选择草稿"><select value={draft?.id||''} onChange={e=>{const next=drafts.find(d=>d.id===e.target.value);if(next)select(next)}}><option value="">未选择</option>{drafts.map(d=><option key={d.id} value={d.id}>{d.content.system_id} · revision {d.revision}</option>)}</select></Field>
        <p className="muted">生效快照 {observation?.system.snapshot_id}</p>
      </Panel>
    </div>
    {draft&&content&&<>
      <ErrorFields value={draft.validation?.valid?null:draft.validation}/><details><summary>完整草稿 JSON（修复结构错误）</summary><textarea rows={12} value={runtimeText.raw??JSON.stringify(content,null,2)} onChange={e=>setRuntimeText({...runtimeText,raw:e.target.value})} onBlur={e=>{try{const next=JSON.parse(e.target.value);if(next&&typeof next==='object'&&!Array.isArray(next))update(next)}catch{op.setError({errors:[{path:'$',code:'invalid_json',reason:'草稿不是合法 JSON'}]})}}}/></details><Panel title="系统搭建" subtitle={`草稿 ${draft.id} · revision ${draft.revision} · 停止态应用`}>
        <div className="parameter-grid"><Field label="系统标识"><input aria-label="系统标识" value={typeof content.system_id==='string'?content.system_id:''} onChange={e=>update({...content,system_id:e.target.value})}/></Field><Field label="运行主机"><select disabled value="localhost"><option>localhost</option><option disabled>远程主机（后续阶段）</option></select></Field></div>
        {backends.map((backend:Json,index:number)=>{const entry=catalog.find(p=>p.id===backend.package_id);return <div className="backend-editor" key={draft.id+backend.instance_id+index}>
          <h3>{backend.instance_id} · {backend.package_id}</h3>
          <Parameters specs={entry?.description.config||{}} value={backend.config||{}} onChange={config=>update({...content,backends:backends.map((b:Json,i:number)=>i===index?{...b,config}:b)})}/>
          <p className="muted">进程管理者 {backend.runtime?.manager||entry?.description.runtime.manager} · 目标 {backend.runtime?.target||entry?.description.runtime.target}</p>
          <details><summary>运行描述（应用后才生效）</summary><Field label="运行描述 JSON"><textarea rows={5} value={runtimeText[String(index)]??JSON.stringify(backend.runtime||entry?.description.runtime,null,2)} onChange={e=>setRuntimeText({...runtimeText,[index]:e.target.value})} onBlur={e=>{try{const runtime=JSON.parse(e.target.value);update({...content,backends:backends.map((b:Json,i:number)=>i===index?{...b,runtime}:b)})}catch{op.setError({errors:[{path:`$.backends[${index}].runtime`,code:'invalid_json',reason:'运行描述不是合法 JSON'}]})}}}/></Field></details>
          <button disabled={op.busy} onClick={()=>{const nextBackends=backends.filter((_:Json,i:number)=>i!==index);setRuntimeText({});update({...content,backends:nextBackends,packages:packages(nextBackends)})}}>删除后端实例</button>
        </div>})}
        <div className="parameter-grid"><Field label="新实例标识"><input value={instance} onChange={e=>setInstance(e.target.value)}/></Field><Field label="接入包"><select value={packageId} onChange={e=>setPackageId(e.target.value)}><option value="">选择目录描述</option>{catalog.map(p=><option key={p.id}>{p.id}</option>)}</select></Field></div>
        <button disabled={!packageId||op.busy} onClick={()=>{const nextBackends=[...backends,{instance_id:instance,package_id:packageId,config:{}}];update({...content,backends:nextBackends,packages:packages(nextBackends)})}}>添加后端实例</button>
        <h3>角色绑定</h3>
        {Object.entries(roles).map(([role,binding]:[string,any])=><div className="role-editor" key={role}><Field label={role}><select value={`${binding.backend_instance}|${binding.capability_id}`} onChange={e=>{const [backend_instance,capability_id]=e.target.value.split('|');const backend=backends.find((b:Json)=>b.instance_id===backend_instance);const cap=catalog.find(p=>p.id===backend?.package_id)?.description.capabilities.find((c:Json)=>c.capability_id===capability_id);update({...content,roles:{...content.roles,[role]:{backend_instance,capability_id,input:cap.input,output:cap.output,parameters:{}}}})}}>
          <option value={`${binding.backend_instance}|${binding.capability_id}`}>{binding.backend_instance} · {binding.capability_id}</option>{backends.flatMap((b:Json)=>{const entry=catalog.find(p=>p.id===b.package_id);return(entry?.description.capabilities||[]).filter((c:Json)=>c.capability_id!==binding.capability_id||b.instance_id!==binding.backend_instance).map((c:Json)=><option key={b.instance_id+c.capability_id} value={`${b.instance_id}|${c.capability_id}`} disabled={JSON.stringify(c.input)!==JSON.stringify(binding.input)||JSON.stringify(c.output)!==JSON.stringify(binding.output)}>{b.instance_id} · {c.capability_id}</option>)})}
        </select></Field><Parameters specs={catalog.find(p=>p.id===backends.find((b:Json)=>b.instance_id===binding.backend_instance)?.package_id)?.description.capabilities.find((c:Json)=>c.capability_id===binding.capability_id)?.parameters||{}} value={binding.parameters||{}} onChange={parameters=>update({...content,roles:{...content.roles,[role]:{...binding,parameters}}})}/>
        <button onClick={()=>{const roles={...content.roles};delete roles[role];update({...content,roles,required_roles:requiredRoles.filter((r:string)=>r!==role)})}}>移除角色</button></div>)}
        <Field label="新增角色名称"><input value={roleName} onChange={e=>setRoleName(e.target.value)}/></Field><Field label="从能力创建角色"><select value="" onChange={e=>{if(!roleName||!e.target.value)return;const [backend_instance,capability_id]=e.target.value.split('|');const b=backends.find((b:Json)=>b.instance_id===backend_instance);const cap=catalog.find(p=>p.id===b?.package_id)?.description.capabilities.find((c:Json)=>c.capability_id===capability_id);update({...content,required_roles:Array.from(new Set([...requiredRoles,roleName])),roles:{...content.roles,[roleName]:{backend_instance,capability_id,input:cap.input,output:cap.output,parameters:{}}}})}}><option value="">选择能力，自动带入端口契约</option>{backends.flatMap((b:Json)=>(catalog.find(p=>p.id===b.package_id)?.description.capabilities||[]).map((c:Json)=><option key={b.instance_id+c.capability_id} value={`${b.instance_id}|${c.capability_id}`}>{b.instance_id} · {c.capability_id}</option>))}</select></Field>
        <div className="buttons"><button className="primary" disabled={op.busy||invalidEditor} onClick={()=>void op.run('保存并校验草稿',async()=>{const next=await client.request<Json>(`/config/drafts/${draft.id}`,'PUT',{revision:draft.revision,content});select(next);await load();if(!next.validation.valid)op.setError(next.validation)})}>保存并校验</button><button disabled={op.busy} onClick={()=>void op.run('生成字段差异',async()=>setDiff(await client.request<Json>(`/config/drafts/${draft.id}/diff`)))}>查看已保存草稿差异</button></div>
      </Panel>
      {diff&&<Panel title="应用配置" subtitle="仅在停止态切换，保留原任务与目标台账"><ErrorFields value={diff.validation.valid?null:diff.validation}/><pre>{JSON.stringify(diff.changes,null,2)}</pre><p>基准快照 {diff.base_snapshot_id}</p><button className="primary" disabled={op.busy||!diff.validation.valid||observation?.system.state!=='STOPPED'} onClick={()=>void op.run('应用配置',async (phase,signal)=>{const payload={draft_id:draft.id,revision:diff.revision,base_snapshot_id:diff.base_snapshot_id};const job=await client.request<Json>('/config/apply','POST',{...payload,request_id:durableIntent('apply',payload)});await waitJob(client,job.management_job_id,phase,signal);await changed()})}>停止态应用已保存草稿</button></Panel>}
    </>}
    <ErrorFields value={op.error}/>{op.dialog()}
  </>
}
