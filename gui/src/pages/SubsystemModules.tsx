import {useEffect,useState} from 'react'
import type {ApiClient} from '../api'
import {useLocale} from '../locale'
import StudioSelect from '../components/StudioSelect'
import DisclosureCard from '../components/DisclosureCard'
import {ErrorFields,type Json} from './shared'
import {confirmDialog} from '../components/StudioDialogs'
import {Icon} from '../components/Icon'

const pretty=(value:unknown)=>JSON.stringify(value??{},null,2)
export default function SubsystemModules({client,workspaceId}:{client:ApiClient;workspaceId:string}){
 const {t}=useLocale(),[modules,setModules]=useState<Json[]>([]),[candidates,setCandidates]=useState<Json[]>([]),[draft,setDraft]=useState<Json|null>(null)
 const [warnings,setWarnings]=useState<string[]>([]),[manifest,setManifest]=useState(''),[health,setHealth]=useState('[]')
 const [parameters,setParameters]=useState('{}'),[advanced,setAdvanced]=useState('{}'),[launchArguments,setLaunchArguments]=useState('{}'),[argv,setArgv]=useState('')
 const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null),[open,setOpen]=useState(false),[newEndpoint,setNewEndpoint]=useState(-1)
 async function read(){setModules((await client.request<Json>('/deployment/modules')).modules)}
 useEffect(()=>{const controller=new AbortController();setDraft(null);setCandidates([]);setWarnings([]);setManifest('');setError(null);setOpen(false);void client.request<Json>('/deployment/modules','GET',undefined,controller.signal).then(value=>{if(!controller.signal.aborted)setModules(value.modules)}).catch(cause=>{if(!controller.signal.aborted)setError(cause)});return()=>controller.abort()},[client,workspaceId])
 function edit(value:Json){
  setHealth(JSON.stringify(value.health_checks||[],null,2));setDraft(structuredClone(value));setParameters(pretty(value.parameters||{}));setLaunchArguments(pretty(value.launch_arguments||{}));setArgv((value.argv||[]).join('\n'));setNewEndpoint(-1);setOpen(true)
  const {id,name,workspace_id,robot_system_id,kind,package:pkg,executable,parameters,dependencies,provides,plugin,launch_arguments,argv,node_name,namespace,startup_timeout_s,stop_timeout_s,health_checks,health_interval_s,...rest}=value
  setAdvanced(pretty(rest))
 }
 async function scan(){setBusy(true);setError(null);try{const next=await client.request<Json>(`/deployment/workspaces/${workspaceId}/scan`);setCandidates(next.modules);setWarnings(next.warnings||[])}catch(cause){setError(cause)}finally{setBusy(false)}}
 async function save(){
  if(!draft)return
  setBusy(true);setError(null)
  try{
   const value={...draft,...JSON.parse(advanced),health_checks:JSON.parse(health),dependencies:draft.dependencies||[],provides:draft.provides||[],parameters:JSON.parse(parameters),workspace_id:workspaceId}
   if(draft.kind==='launch')value.launch_arguments=JSON.parse(launchArguments)
   if(draft.kind==='process')value.argv=argv.split('\n').filter(value=>value.length>0)
   await client.request('/deployment/modules','POST',value);await read();setDraft(null)
   window.dispatchEvent(new Event('agro:modules:changed'))
  }catch(cause){setError(cause)}finally{setBusy(false)}
 }
 async function remove(value:Json){
  if(!await confirmDialog(t('移除启动模块')+' '+value.name,'移除',true))return
  setBusy(true);setError(null)
  try{await client.request('/deployment/modules/'+value.id,'DELETE');await read();if(draft?.id===value.id)setDraft(null);window.dispatchEvent(new Event('agro:modules:changed'))}catch(cause){setError(cause)}finally{setBusy(false)}
 }
 const kinds:Record<string,string>={node:'独立节点',component:'组合式组件',process:'独立程序',launch:'已有 launch'}
 const ownModules=modules.filter(value=>value.workspace_id===workspaceId)
 const availableDependencies=modules.filter(value=>value.id!==draft?.id)
 const draftIncomplete=!draft?.name?.trim()||(draft?.kind==='process'?!argv.trim():!draft?.package?.trim()||!(draft?.kind==='component'?draft.plugin:draft?.executable)?.trim())
 const endpointLabel=(entry:Json)=>entry.kind==='action'?'动作 Action':entry.kind==='service'?'服务 Service':'话题 Topic'
 return <><DisclosureCard title={t('启动配置')} count={ownModules.length} summary={t('运行台按工作流组合所需模块，无需编写整机融合 launch')} status={t('{0} 个启动模块',{0:ownModules.length})} open={open} onOpenChange={setOpen} className="iw-modules-card">
  <p className="ros-field-hint">{t('可使用独立节点、组件、程序或已有 launch，配置时不会启动设备')}</p>
  <div className="buttons iw-card-actions"><button disabled={busy} onClick={()=>void scan()}><Icon name="search"/>{t('扫描可执行入口')}</button><button disabled={busy} onClick={()=>edit({name:'',kind:'node',package:'',executable:'',workspace_id:workspaceId,dependencies:[],provides:[]})}><Icon name="plus"/>{t('添加启动模块')}</button></div>
  {!!warnings.length&&<DisclosureCard title={t('扫描待确认项')} count={warnings.length}>{warnings.map((value,index)=><p key={index}>{value}</p>)}</DisclosureCard>}
  <DisclosureCard title={t('子系统接入声明')} summary={t('明确声明启动入口、依赖、接口与健康条件，导入不会执行代码')}>
   <div className="buttons"><button disabled={busy} onClick={async()=>{try{setManifest(pretty(await client.request(`/deployment/workspaces/${workspaceId}/manifest`)))}catch(cause){setError(cause)}}}>{t('读取当前接入声明')}</button><button disabled={busy||!manifest.trim()} onClick={async()=>{setBusy(true);setError(null);try{await client.request(`/deployment/workspaces/${workspaceId}/manifest`,'POST',JSON.parse(manifest));await read();window.dispatchEvent(new Event('agro:modules:changed'))}catch(cause){setError(cause)}finally{setBusy(false)}}}>{t('导入接入声明')}</button></div>
   <textarea className="ros-code" rows={10} aria-label={t('子系统接入声明')} value={manifest} onChange={event=>setManifest(event.target.value)} placeholder={'{"format":"atil.subsystem","modules":[]}'}/>
  </DisclosureCard>
  <div className="iw-object-cards">{ownModules.map(value=><DisclosureCard key={value.id} title={value.name} summary={<span>{t(kinds[value.kind]||value.kind)} · {value.package?value.package+' / ':''}{value.executable||value.plugin||(value.argv||[])[0]}</span>} status={t('依赖 {0} 个 · 提供接口 {1} 个',{0:value.dependencies?.length||0,1:value.provides?.length||0})}>
   {!!value.dependencies?.length&&<p>{t('先启动的模块')} · {value.dependencies.map((id:string)=>modules.find(item=>item.id===id)?.name||id).join(' · ')}</p>}
   {!!value.provides?.length&&<div className="iw-module-endpoints">{value.provides.map((entry:Json,index:number)=><p key={index}><span>{t(endpointLabel(entry))}</span> <code>{entry.name}</code></p>)}</div>}
   <div className="buttons"><button disabled={busy} onClick={()=>edit(value)}><Icon name="edit"/>{t('编辑启动模块')}</button><button disabled={busy} onClick={()=>void remove(value)}><Icon name="trash"/>{t('移除')}</button></div>
  </DisclosureCard>)}</div>
  {!ownModules.length&&<p className="ros-field-hint">{t('尚未配置启动模块，仍可离线编写任务')}</p>}
  {!!candidates.length&&<label className="field"><span>{t('已发现的入口')}</span><StudioSelect searchable value="" label={t('已发现的入口')} options={[{value:'',label:t('选择入口以配置启动')},...candidates.map((value,index)=>({value:String(index),label:value.package+' / '+(value.executable||value.plugin),hint:t(kinds[value.kind]||value.kind)}))]} onChange={value=>{if(value!==''){const item=candidates[Number(value)];edit({name:item.executable||item.plugin,kind:item.kind,package:item.package,executable:item.executable,plugin:item.plugin,dependencies:[],provides:[]})}}}/></label>}
  {draft&&<section className="iw-module-editor"><header><h4>{t(draft.id?'编辑启动模块':'添加启动模块')}</h4><button aria-label={t('取消')} disabled={busy} onClick={()=>setDraft(null)}><Icon name="x"/></button></header><fieldset disabled={busy}>
   <div className="ros-form-grid">
    <label className="field"><span>{t('模块名称')}</span><input value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
    <label className="field"><span>{t('启动方式')}</span><StudioSelect value={draft.kind} label={t('启动方式')} onChange={kind=>setDraft({...draft,kind})} options={Object.entries(kinds).map(([value,label])=>({value,label:t(label)}))}/></label>
    {draft.kind!=='process'&&<label className="field"><span>{t('包名称')}</span><input value={draft.package||''} onChange={event=>setDraft({...draft,package:event.target.value})}/></label>}
    {['node','launch'].includes(draft.kind)&&<label className="field"><span>{t(draft.kind==='launch'?'launch 文件名':'可执行入口')}</span><input value={draft.executable||''} onChange={event=>setDraft({...draft,executable:event.target.value})}/></label>}
    {draft.kind==='component'&&<label className="field"><span>{t('组件类名')}</span><input value={draft.plugin||''} onChange={event=>setDraft({...draft,plugin:event.target.value})}/></label>}
   </div>
   {draft.kind==='process'&&<label className="field"><span>{t('程序与参数，每行一项')}</span><textarea className="ros-code" rows={4} value={argv} placeholder="/path/to/program" onChange={event=>setArgv(event.target.value)}/></label>}
   <DisclosureCard title={t('先启动的模块')} count={draft.dependencies?.length||0} summary={(draft.dependencies||[]).map((id:string)=>modules.find(value=>value.id===id)?.name||id).join(' · ')||t('没有前置启动依赖')}>
    {availableDependencies.map(value=><label className="toggle iw-module-dependency" key={value.id}><input type="checkbox" checked={draft.dependencies?.includes(value.id)||false} onChange={event=>setDraft({...draft,dependencies:event.target.checked?[...(draft.dependencies||[]),value.id]:(draft.dependencies||[]).filter((id:string)=>id!==value.id)})}/><span>{value.name}{value.workspace_id!==workspaceId&&<small>{t('其他子系统')}</small>}</span></label>)}
    {!availableDependencies.length&&<p className="ros-field-hint">{t('没有其他可选模块')}</p>}
   </DisclosureCard>
   <DisclosureCard title={t('提供的通信接口')} count={draft.provides?.length||0} summary={t('用于匹配任务提供者与检查模块就绪')}>
    <div className="iw-object-cards">{(draft.provides||[]).map((entry:Json,index:number)=>{
     const update=(patch:Json)=>setDraft({...draft,provides:draft.provides.map((value:Json,position:number)=>position===index?{...value,...patch}:value)})
     return <DisclosureCard key={index} title={entry.name||t('未命名通信接口')} summary={t(endpointLabel(entry))+' · '+(entry.type||t('接口类型待确认'))} defaultOpen={index===newEndpoint}>
      <div className="ros-form-grid"><label className="field"><span>{t('接口种类')}</span><StudioSelect value={entry.kind} label={t('接口种类')} options={['action','service','topic'].map(value=>({value,label:value==='action'?'Action':value==='service'?'Service':'Topic'}))} onChange={kind=>update({kind})}/></label><label className="field"><span>{t('通信名称')}</span><input value={entry.name} placeholder="/arm/move" onChange={event=>update({name:event.target.value})}/></label><label className="field"><span>{t('接口类型')}</span><input value={entry.type||''} onChange={event=>update({type:event.target.value})}/></label></div>
      {entry.kind==='topic'&&<label className="field"><span>{t('话题角色')}</span><StudioSelect value={entry.role||'publisher'} label={t('话题角色')} options={[{value:'publisher',label:t('发布者')},{value:'subscriber',label:t('订阅者')}]} onChange={role=>update({role})}/></label>}
      <button onClick={()=>setDraft({...draft,provides:draft.provides.filter((_:Json,position:number)=>position!==index)})}>{t('移除')}</button>
     </DisclosureCard>
    })}</div><button onClick={()=>{setNewEndpoint(draft.provides?.length||0);setDraft({...draft,provides:[...(draft.provides||[]),{kind:'service',name:'',type:''}]})}}><Icon name="plus"/>{t('添加接口')}</button>
   </DisclosureCard>
   {draft.kind==='launch'?<DisclosureCard title={t('launch 启动参数')} summary={t('供实际启动与离线名称解析共同使用')}><label className="field"><span>{t('启动参数对象')}</span><textarea className="ros-code" rows={6} value={launchArguments} onChange={event=>setLaunchArguments(event.target.value)}/></label></DisclosureCard>:draft.kind!=='process'&&<DisclosureCard title={t('节点参数')} summary={t('填写参数对象，复杂文件与转换可在高级设置中配置')}><label className="field"><span>{t('节点参数对象')}</span><textarea className="ros-code" rows={6} value={parameters} onChange={event=>setParameters(event.target.value)}/></label><div className="ros-form-grid"><label className="field"><span>{t('节点名称')}</span><input value={draft.node_name||''} onChange={event=>setDraft({...draft,node_name:event.target.value})}/></label><label className="field"><span>{t('命名空间')}</span><input value={draft.namespace||''} onChange={event=>setDraft({...draft,namespace:event.target.value})}/></label></div></DisclosureCard>}
   <DisclosureCard title={t('启动与停止等待')} summary={t('启动 {0} 秒 · 停止 {1} 秒',{0:draft.startup_timeout_s??60,1:draft.stop_timeout_s??15})}><div className="ros-form-grid"><label className="field"><span>{t('启动等待秒数')}</span><input type="number" min="1" max="300" value={draft.startup_timeout_s??60} onChange={event=>setDraft({...draft,startup_timeout_s:Number(event.target.value)})}/></label><label className="field"><span>{t('停止等待秒数')}</span><input type="number" min="1" max="300" value={draft.stop_timeout_s??15} onChange={event=>setDraft({...draft,stop_timeout_s:Number(event.target.value)})}/></label></div></DisclosureCard>
   <DisclosureCard title={t('就绪与持续健康')} summary={t('检查关键节点、有效消息或生命周期状态')}>
    <p className="ros-field-hint">{t('kind 可为 node、topic、service、action 或 lifecycle，name 使用完整名称，topic 需要 type，可添加 condition 与 max_age_s')}</p>
    <textarea className="ros-code" rows={8} aria-label={t('就绪与持续健康')} value={health} onChange={event=>setHealth(event.target.value)} placeholder={'[{"kind":"node","name":"/controller"}]'}/>
    <label className="field"><span>{t('健康检查间隔秒数')}</span><input type="number" min="1" max="60" value={draft.health_interval_s??5} onChange={event=>setDraft({...draft,health_interval_s:Number(event.target.value)})}/></label>
   </DisclosureCard>
   <DisclosureCard title={t('高级启动设置')} summary={t('参数文件、重映射与其他可选配置')}><p className="ros-field-hint">{t('parameter_files 指定参数文件，arguments 指定节点参数，argv 指定独立程序及参数')}</p><textarea aria-label={t('高级启动设置')} className="ros-code" rows={10} value={advanced} onChange={event=>setAdvanced(event.target.value)}/></DisclosureCard>
   <div className="buttons iw-card-actions"><button onClick={()=>setDraft(null)}>{t('取消')}</button><button className="primary" disabled={draftIncomplete} onClick={()=>void save()}>{t('保存启动配置')}</button></div>
  </fieldset></section>}
 </DisclosureCard><ErrorFields value={error}/></>
}
