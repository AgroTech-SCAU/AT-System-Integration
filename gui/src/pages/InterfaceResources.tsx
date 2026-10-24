import OfflineCommunications from './OfflineCommunications'
import {TaskIcon, TaskIconPicker} from '../components/TaskIconPicker'
import InterfaceIssues from './InterfaceIssues'
import StudioSelect from '../components/StudioSelect'
import {confirmDialog} from '../components/StudioDialogs'
import {useEffect, useRef, useState} from 'react'
import type {ApiClient} from '../api'
import {useLocale} from '../locale'
import {Icon} from '../components/Icon'
import {ErrorFields} from './shared'
import type {InterfaceWorkspace, WorkspaceResolution} from './InterfaceWorkspacePicker'

type Foundation={path:string;candidates:string[];interface_count:number;status:string}
type DetectedSource={mode:'source'|'installed'|'ambiguous';path:string;alternatives:{mode:'source'|'installed';path:string}[]}

export default function InterfaceResources({client}: {client:ApiClient}) {
  const {t}=useLocale()
  const [workspaces,setWorkspaces]=useState<InterfaceWorkspace[]>([])
  const [selected,setSelected]=useState(''),[query,setQuery]=useState('')
  const [editor,setEditor]=useState<'auto'|'source'|'installed'|'files'|null>(null)
  const [icon,setIcon]=useState('generic')
  const [name,setName]=useState(''),[path,setPath]=useState(''),[packageName,setPackageName]=useState('')
  const [foundation,setFoundation]=useState<Foundation|null>(null),[foundationPath,setFoundationPath]=useState('')
  const [detected,setDetected]=useState<DetectedSource|null>(null)
  const [files,setFiles]=useState<File[]>([]),[rename,setRename]=useState('')
  const [resolution,setResolution]=useState<WorkspaceResolution|null>(null)
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true)
  const [error,setError]=useState<unknown>(null),[notice,setNotice]=useState('')
  const alive=useRef(true)
  const current=workspaces.find(item=>item.id===selected)
  async function load(preferred?:string){
    const result=await client.request<{workspaces:InterfaceWorkspace[];foundation:Foundation}>('/ros/interface-workspaces')
    if(!alive.current)return
    setWorkspaces(result.workspaces);setFoundation(result.foundation);setFoundationPath(result.foundation.path)
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
  function create(mode:typeof editor){setEditor(mode);setName('');setIcon('generic');setPath('');setDetected(null);setFiles([]);setPackageName('');setNotice('');setError(null)}
  async function register(){
    let mode=editor,sourcePath=path.trim()
    if(mode==='auto'){
      const result=await client.request<DetectedSource>('/ros/interface-workspaces/detect','POST',{path:sourcePath})
      setDetected(result)
      if(result.mode==='ambiguous')return
      mode=result.mode;sourcePath=result.path
    }
    const definitions=editor==='files'?await Promise.all(files.map(async file=>({name:file.name,content:await file.text()}))):undefined
    const result=await client.request<InterfaceWorkspace>('/ros/interface-workspaces','POST',{icon,name:name.trim()||(editor==='files'?packageName.trim():path.split('/').filter(Boolean).at(-1)),mode,path:sourcePath,package:packageName.trim(),files:definitions})
    await load(result.id);setEditor(null);setNotice(t('子系统 ROS2 工作区已添加'))
    window.dispatchEvent(new Event('agro:interfaces:changed'));window.dispatchEvent(new Event('agro:ros:refresh'))
  }
  async function update(data:Record<string,unknown>){
    await client.request('/ros/interface-workspaces/'+selected,'PUT',data)
    await load();setNotice(t('工作区已更新，已保存任务继续使用原定义'))
    window.dispatchEvent(new Event('agro:interfaces:changed'));window.dispatchEvent(new Event('agro:ros:refresh'))
  }
  async function remove(){
    if(!current||!await confirmDialog(t('移除子系统 ROS2 工作区 {0}',{0:current.name}),'移除工作区',true))return
    await client.request('/ros/interface-workspaces/'+selected,'DELETE');await load();setNotice(t('子系统 ROS2 工作区已移除'))
    window.dispatchEvent(new Event('agro:interfaces:changed'));window.dispatchEvent(new Event('agro:ros:refresh'))
  }
  return <section className="interface-workspace-manager" aria-label={t('子系统 ROS2 工作区')}>
    <header className="iw-heading"><div><h2>{t('子系统 ROS2 工作区')}</h2><p>{t('导入各子系统的 ROS2 工作区，读取接口定义与依赖，可离线配置')}</p></div><div className="buttons"><button disabled={busy} onClick={()=>create('files')}><Icon name="import"/>{t('导入接口文件')}</button><button className="primary" disabled={busy} onClick={()=>create('auto')}><Icon name="plus"/>{t('添加子系统工作区')}</button></div></header>
    <div className="iw-content"><aside className="iw-catalog"><div className="ros-search"><Icon name="search"/><input aria-label={t('搜索子系统 ROS2 工作区')} placeholder={t('搜索子系统 ROS2 工作区')} value={query} onChange={event=>setQuery(event.target.value)}/></div><div className="iw-workspaces">{workspaces.filter(item=>(item.name+' '+item.path).toLowerCase().includes(query.toLowerCase())).map(item=><button className="iw-workspace-row" aria-current={selected===item.id?'true':undefined} disabled={busy} key={item.id} onClick={()=>{setSelected(item.id);setEditor(null);setError(null);setNotice('')}}><TaskIcon value={item.icon}/><span><strong>{item.name}</strong><small className="iw-workspace-path">{item.path||t('导入的接口定义')}</small><small>{t('{0} 个可用 · {1} 个待补充',{0:item.available_count,1:item.pending_count})}</small></span>{!!item.conflicts_with.length&&<span className="iw-conflict-marker" title={t('与其他工作区存在冲突')}><Icon name="info"/></span>}</button>)}{!workspaces.length&&<p className="iw-list-empty">{t(loading?'正在读取接口':'尚未添加子系统工作区')}</p>}</div><footer>{t('接口定义可离线使用')}</footer></aside>
    <div className="iw-detail">
      {editor?<form className="iw-register" onSubmit={event=>{event.preventDefault();void perform(register)}}><header><h3>{t(editor==='files'?'导入接口文件':'添加子系统工作区')}</h3><button type="button" disabled={busy} aria-label={t('取消')} onClick={()=>setEditor(null)}><Icon name="x"/></button></header><fieldset disabled={busy}>
        <div className="iw-icon-field"><span>{t('子系统图标')}</span><TaskIconPicker value={icon} label="子系统图标" onChange={setIcon}/></div><label className="field"><span>{t('工作区名称')}</span><input autoFocus value={name} placeholder={t('填写子系统或工作区名称')} onChange={event=>setName(event.target.value)}/></label>
        {editor!=='files'?<><label className="field"><span>{t('工作区目录')}</span><div className="iw-path"><input required value={path} placeholder={t('工作区文件夹的绝对路径')} onChange={event=>{setPath(event.target.value);setDetected(null)}}/>{window.agroDesktop?.chooseInterfaceFolder&&<button type="button" onClick={()=>void window.agroDesktop!.chooseInterfaceFolder().then(value=>{if(value){setPath(value);setDetected(null);if(!name)setName(value.split('/').filter(Boolean).at(-1)||'')}}).catch(setError)}>{t('选择文件夹')}</button>}</div></label><p className="ros-field-hint">{t('自动识别源码或安装目录，无需编译或启动 ROS 节点')}</p>
        <details className="iw-source-options"><summary>{t('读取方式')} · {t(editor==='auto'?'自动识别':editor==='source'?'源码工作区':'安装目录')}</summary><StudioSelect label={t('读取方式')} value={editor} options={[{value:'auto',label:t('自动识别')},{value:'source',label:t('源码工作区'),hint:t('读取源码中的接口定义，包含尚未编译的修改')},{value:'installed',label:t('安装目录'),hint:t('读取构建后安装的接口定义')}]} onChange={value=>{setEditor(value as 'auto'|'source'|'installed');setDetected(null)}}/></details>
        {detected?.mode==='ambiguous'&&<div className="iw-source-choice"><strong>{t('源码与安装接口内容不同')}</strong><p>{t('选择本次读取的来源，不会覆盖原目录')}</p>{detected.alternatives.map(option=><button type="button" key={option.mode} onClick={()=>{setEditor(option.mode);setPath(option.path);setDetected(null)}}><span>{t(option.mode==='source'?'使用源码定义':'使用安装定义')}</span><small>{option.path}</small></button>)}</div>}</>:<><label className="field"><span>{t('接口所属包名')}</span><input required value={packageName} placeholder="robot_interfaces" onChange={event=>setPackageName(event.target.value)}/></label><label className="field"><span>{t('原生接口文件')}</span><input type="file" accept=".msg,.srv,.action" multiple onChange={event=>setFiles(Array.from(event.target.files||[]))}/></label><p className="ros-field-hint">{t('支持消息、服务和 Action 定义，依赖可从其他工作区补齐')}</p></>}
        <div className="buttons"><button type="button" onClick={()=>setEditor(null)}>{t('取消')}</button><button className="primary" type="submit" disabled={editor==='files'?!packageName.trim()||!files.length:!path.trim()}>{t(busy?'正在读取接口':'检查并添加')}</button></div>
      </fieldset></form>:current?<><header className="iw-detail-heading"><div><span className="iw-eyebrow">{t(current.mode==='files'?'导入定义':current.mode==='installed'?'安装目录':'源码工作区')}</span><h3>{current.name}</h3><p>{current.path||t('接口文件已保存在当前机器人工程')}</p></div><div className="buttons">{current.mode!=='files'&&<button disabled={busy} onClick={()=>void perform(()=>update({refresh:true}))}><Icon name="refresh"/>{t('重新扫描')}</button>}<button disabled={busy||current.used_by>0} title={current.used_by?t('已有任务使用此工作区'):t('移除工作区')} aria-label={t('移除工作区')} onClick={()=>void perform(remove)}><Icon name="trash"/></button></div></header>
        <div className="iw-metadata"><fieldset disabled={busy} className="iw-icon-field"><span>{t('子系统图标')}</span><TaskIconPicker value={current.icon} label="子系统图标" onChange={icon=>void perform(()=>update({icon}))}/></fieldset><label className="field"><span>{t('工作区名称')}</span><div className="iw-path"><input value={rename} disabled={busy} onChange={event=>setRename(event.target.value)}/><button disabled={busy||!rename.trim()||rename.trim()===current.name} onClick={()=>void perform(()=>update({name:rename.trim()}))}>{t('保存')}</button></div></label><span>{t('{0} 个任务使用',{0:current.used_by})}</span></div>
        {!!current.conflicts_with.length&&<div className="iw-notice"><strong>{t('不能同时选用的工作区')}</strong><p>{t('这些工作区可以保留，任务选择时会自动排除冲突组合')}</p>{current.conflicts_with.map(other=><div key={other.id}><strong>{other.name}</strong><small>{other.types.join(' · ')}</small></div>)}</div>}
        <OfflineCommunications client={client} workspaceId={selected} epoch={workspaces} onUpdate={data=>perform(()=>update(data))} onError={setError} disabled={busy}/><InterfaceIssues issues={resolution?.diagnostics||current.diagnostics} expanded/>
        {!!resolution?.dependencies?.length&&<details className="iw-dependency-sources"><summary>{t('已补齐 {0} 个依赖接口',{0:resolution.dependencies.length})}</summary>{resolution.dependencies.map(item=><div key={item.ros_type}><code>{item.ros_type}</code><small>{item.source}</small></div>)}</details>}
        <div className="iw-interface-list"><h4>{t('接口清单')} <span>{t('共 {0} 个 · 可用 {1} 个 · 待补充 {2} 个',{0:current.interface_count,1:current.available_count,2:current.pending_count})}</span></h4>{resolution?.types.map(item=><div className="iw-interface-row" key={item.ros_type}><span className="ros-type-badge">{t(item.ros_type.includes('/action/')?'动作 Action':item.ros_type.includes('/srv/')?'服务 Service':'消息 Msg')}</span><code>{item.ros_type}</code><span className={item.available?'iw-ready':'iw-pending'}>{t(item.available?'定义可用':'定义待补充')}</span></div>)}{!resolution&&<p className="ros-field-hint">{t('正在读取接口')}</p>}{resolution&&!resolution.types.length&&<p className="ros-field-hint">{t('此目录没有可读取的接口定义')}</p>}</div>
      </>:<div className="iw-empty"><Icon name="boxes" size="xl"/><h3>{t('为机器人准备接口定义')}</h3><p>{t('添加源码工作区或导入接口文件，即可离线创建任务')}</p><button onClick={()=>create('auto')}><Icon name="plus"/>{t('添加子系统工作区')}</button></div>}
      {foundation&&<details className="iw-foundation"><summary><span>{t('基础 ROS 接口')}</span><small>{foundation.status==='ready'?t('已就绪'):t('需要选择来源')}</small></summary><p>{t('基础接口用于补齐消息依赖，单独保存，不计入子系统工作区')}</p><code>{foundation.path||t(foundation.status==='ready'?'导入的基础接口快照':'未选择基础接口目录')}</code><p>{t('保存的定义可离线使用，重新读取后已有任务仍保留原定义')}</p>{foundation.candidates.length>1&&<StudioSelect label={t('基础接口来源')} value={foundationPath} options={[{value:'',label:t('选择一个基础接口来源')},...foundation.candidates.map(value=>({value,label:value}))]} onChange={setFoundationPath}/>}<div className="iw-path"><input aria-label={t('基础 ROS 安装目录')} value={foundationPath} placeholder={t('基础 ROS 安装目录')} onChange={event=>setFoundationPath(event.target.value)}/><button disabled={busy||!foundationPath.trim()} onClick={()=>void perform(async()=>{await client.request('/ros/interface-foundation','PUT',{path:foundationPath.trim()});await load();setNotice(t('基础接口已重新读取'));window.dispatchEvent(new Event('agro:interfaces:changed'));window.dispatchEvent(new Event('agro:ros:refresh'))})}>{t('重新读取')}</button></div></details>}
      <ErrorFields value={error}/>{notice&&<p className="iw-status" role="status">{notice}</p>}
    </div></div>
  </section>
}
