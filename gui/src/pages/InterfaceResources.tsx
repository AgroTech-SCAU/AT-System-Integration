import {useEffect, useRef, useState} from 'react'
import type {ApiClient} from '../api'
import {useLocale} from '../locale'
import {Icon} from '../components/Icon'
import {ErrorFields} from './shared'
import type {InterfaceWorkspace, WorkspaceResolution} from './InterfaceWorkspacePicker'

export default function InterfaceResources({client}: {client:ApiClient}) {
  const {t}=useLocale()
  const [workspaces,setWorkspaces]=useState<InterfaceWorkspace[]>([])
  const [selected,setSelected]=useState(''),[query,setQuery]=useState('')
  const [editor,setEditor]=useState<'source'|'installed'|'files'|null>(null)
  const [name,setName]=useState(''),[path,setPath]=useState(''),[packageName,setPackageName]=useState('')
  const [files,setFiles]=useState<File[]>([]),[rename,setRename]=useState('')
  const [resolution,setResolution]=useState<WorkspaceResolution|null>(null)
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true)
  const [error,setError]=useState<unknown>(null),[notice,setNotice]=useState('')
  const alive=useRef(true)
  const current=workspaces.find(item=>item.id===selected)
  async function load(preferred?:string){
    const result=await client.request<{workspaces:InterfaceWorkspace[]}>('/ros/interface-workspaces')
    if(!alive.current)return
    setWorkspaces(result.workspaces)
    setSelected(old=>preferred|| (result.workspaces.some(item=>item.id===old)?old:result.workspaces[0]?.id||''))
  }
  useEffect(()=>{alive.current=true;void load().catch(setError).finally(()=>setLoading(false));return()=>{alive.current=false}},[client])
  useEffect(()=>{
    setResolution(null);setRename(current?.name||'')
    if(!selected)return
    const controller=new AbortController()
    void client.request<WorkspaceResolution>('/ros/interface-workspaces/resolve','POST',{workspace_ids:[selected]},controller.signal).then(value=>{if(!controller.signal.aborted)setResolution(value)}).catch(cause=>{if(!controller.signal.aborted)setError(cause)})
    return()=>controller.abort()
  },[selected,workspaces,client])
  async function perform(action:()=>Promise<void>){
    if(busy)return
    setBusy(true);setError(null);setNotice('')
    try{await action()}catch(cause){if(alive.current)setError(cause)}finally{if(alive.current)setBusy(false)}
  }
  function create(mode:typeof editor){setEditor(mode);setName('');setPath('');setFiles([]);setPackageName('');setNotice('');setError(null)}
  async function register(){
    const definitions=editor==='files'?await Promise.all(files.map(async file=>({name:file.name,content:await file.text()}))):undefined
    const result=await client.request<InterfaceWorkspace>('/ros/interface-workspaces','POST',{name:name.trim()||(editor==='files'?packageName.trim():path.split('/').filter(Boolean).at(-1)),mode:editor,path:path.trim(),package:packageName.trim(),files:definitions})
    await load(result.id);setEditor(null);setNotice(t('接口工作区已添加'))
    window.dispatchEvent(new Event('agro:interfaces:changed'))
  }
  async function update(data:Record<string,unknown>){
    await client.request('/ros/interface-workspaces/'+selected,'PUT',data)
    await load();setNotice(t('工作区已更新，已保存任务继续使用原定义'))
    window.dispatchEvent(new Event('agro:interfaces:changed'))
  }
  async function remove(){
    if(!current||!window.confirm(t('移除接口工作区 {0}',{0:current.name})))return
    await client.request('/ros/interface-workspaces/'+selected,'DELETE');await load();setNotice(t('接口工作区已移除'))
    window.dispatchEvent(new Event('agro:interfaces:changed'))
  }
  return <section className="interface-workspace-manager" aria-label={t('接口工作区')}>
    <header className="iw-heading"><div><h2>{t('接口工作区')}</h2><p>{t('集中管理接口定义，在任务中选择需要的工作区')}</p></div><div className="buttons"><button disabled={busy} onClick={()=>create('files')}><Icon name="import"/>{t('导入接口文件')}</button><button className="primary" disabled={busy} onClick={()=>create('source')}><Icon name="plus"/>{t('添加工作区')}</button></div></header>
    <div className="iw-content"><aside className="iw-catalog"><div className="ros-search"><Icon name="search"/><input aria-label={t('搜索接口工作区')} placeholder={t('搜索接口工作区')} value={query} onChange={event=>setQuery(event.target.value)}/></div><div className="iw-workspaces">{workspaces.filter(item=>(item.name+' '+item.path).toLowerCase().includes(query.toLowerCase())).map(item=><button className="iw-workspace-row" aria-current={selected===item.id?'true':undefined} disabled={busy} key={item.id} onClick={()=>{setSelected(item.id);setEditor(null);setError(null);setNotice('')}}><Icon name="boxes"/><span><strong>{item.name}</strong><small>{t('{0} 个接口',{0:item.interface_count})}{item.diagnostics.length?` · ${t('待补充')}`:''}</small></span>{!!item.conflicts_with.length&&<span className="iw-conflict-marker" title={t('与其他工作区存在冲突')}><Icon name="info"/></span>}</button>)}{!workspaces.length&&<p className="iw-list-empty">{t(loading?'正在读取接口':'尚未添加工作区')}</p>}</div><footer>{t('接口定义可离线使用')}</footer></aside>
    <div className="iw-detail">
      {editor?<form className="iw-register" onSubmit={event=>{event.preventDefault();void perform(register)}}><header><h3>{t(editor==='files'?'导入接口文件':'添加工作区')}</h3><button type="button" disabled={busy} aria-label={t('取消')} onClick={()=>setEditor(null)}><Icon name="x"/></button></header><fieldset disabled={busy}>
        <label className="field"><span>{t('工作区名称')}</span><input autoFocus value={name} placeholder={t('为这组接口命名')} onChange={event=>setName(event.target.value)}/></label>
        {editor!=='files'?<><div className="iw-source-mode" role="group" aria-label={t('读取方式')}><button type="button" aria-pressed={editor==='source'} onClick={()=>setEditor('source')}>{t('源码工作区')}</button><button type="button" aria-pressed={editor==='installed'} onClick={()=>setEditor('installed')}>{t('安装目录')}</button></div><label className="field"><span>{t('工作区目录')}</span><div className="iw-path"><input required value={path} placeholder={t('工作区文件夹的绝对路径')} onChange={event=>setPath(event.target.value)}/>{window.agroDesktop?.chooseInterfaceFolder&&<button type="button" onClick={()=>void window.agroDesktop!.chooseInterfaceFolder().then(value=>{if(value){setPath(value);if(!name)setName(value.split('/').filter(Boolean).at(-1)||'')}}).catch(setError)}>{t('选择文件夹')}</button>}</div></label><p className="ros-field-hint">{t('读取 Studio 主机上的接口文件，无需启动 ROS 节点')}</p></>:<><label className="field"><span>{t('接口所属包名')}</span><input required value={packageName} placeholder="robot_interfaces" onChange={event=>setPackageName(event.target.value)}/></label><label className="field"><span>{t('原生接口文件')}</span><input type="file" accept=".msg,.srv,.action" multiple onChange={event=>setFiles(Array.from(event.target.files||[]))}/></label><p className="ros-field-hint">{t('支持消息、服务和 Action 定义，依赖可从其他工作区补齐')}</p></>}
        <div className="buttons"><button type="button" onClick={()=>setEditor(null)}>{t('取消')}</button><button className="primary" type="submit" disabled={editor==='files'?!packageName.trim()||!files.length:!path.trim()}>{t(busy?'正在读取接口':'检查并添加')}</button></div>
      </fieldset></form>:current?<><header className="iw-detail-heading"><div><span className="iw-eyebrow">{t(current.mode==='files'?'导入定义':current.mode==='installed'?'安装目录':'源码工作区')}</span><h3>{current.name}</h3><p>{current.path||t('接口文件已保存在当前机器人工程')}</p></div><div className="buttons">{current.mode!=='files'&&<button disabled={busy} onClick={()=>void perform(()=>update({refresh:true}))}><Icon name="refresh"/>{t('重新扫描')}</button>}<button disabled={busy||current.used_by>0} title={current.used_by?t('已有任务使用此工作区'):t('移除工作区')} aria-label={t('移除工作区')} onClick={()=>void perform(remove)}><Icon name="trash"/></button></div></header>
        <div className="iw-metadata"><label className="field"><span>{t('工作区名称')}</span><div className="iw-path"><input value={rename} disabled={busy} onChange={event=>setRename(event.target.value)}/><button disabled={busy||!rename.trim()||rename.trim()===current.name} onClick={()=>void perform(()=>update({name:rename.trim()}))}>{t('保存')}</button></div></label><span>{t('{0} 个任务使用',{0:current.used_by})}</span></div>
        {!!current.conflicts_with.length&&<div className="iw-notice"><strong>{t('不能同时选用的工作区')}</strong><p>{t('这些工作区可以保留，任务选择时会自动排除冲突组合')}</p>{current.conflicts_with.map(other=><div key={other.id}><strong>{other.name}</strong><small>{other.types.join(' · ')}</small></div>)}</div>}
        {!!(resolution?.diagnostics.length||current.diagnostics.length)&&<div className="iw-diagnostics"><strong>{t('待补充的接口定义')}</strong>{(resolution?.diagnostics||current.diagnostics).map((issue,index)=><p key={index}>{issue.ros_type&&<code>{issue.ros_type} · </code>}{t(issue.reason)}</p>)}</div>}
        <div className="iw-interface-list"><h4>{t('接口清单')} <span>{resolution?.types.length??current.interface_count}</span></h4>{resolution?.types.map(item=><div className="iw-interface-row" key={item.ros_type}><span className="ros-kind-symbol">{item.ros_type.includes('/action/')?'A':item.ros_type.includes('/srv/')?'S':'T'}</span><code>{item.ros_type}</code></div>)}{!resolution&&<p className="ros-field-hint">{t('正在读取接口')}</p>}{resolution&&!resolution.types.length&&<p className="ros-field-hint">{t('补齐定义后，接口会显示在这里')}</p>}</div>
      </>:<div className="iw-empty"><Icon name="boxes" size="xl"/><h3>{t('为机器人准备接口定义')}</h3><p>{t('添加源码工作区或导入接口文件，即可离线创建任务')}</p><button onClick={()=>create('source')}><Icon name="plus"/>{t('添加工作区')}</button></div>}
      <ErrorFields value={error}/>{notice&&<p className="iw-status" role="status">{notice}</p>}
    </div></div>
  </section>
}
