import DisclosureCard from '../components/DisclosureCard'
import './subsystem-workspaces.css'
import SubsystemModules from './SubsystemModules'
import ExecutionEnvironment from './ExecutionEnvironment'
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
  const [metadataOpen,setMetadataOpen]=useState(false),[interfaceQuery,setInterfaceQuery]=useState('')
  const [tasks,setTasks]=useState<{id:string;name:string;workspace_ids?:string[];execution_workspace_id?:string;interface?:string;ros_type?:string}[]>([])
  const [uses,setUses]=useState<Record<string,{kind:string;name:string;detail:string}[]>>({})
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
  useEffect(()=>{setMetadataOpen(false);setInterfaceQuery('')},[selected])
  useEffect(()=>{
    const controller=new AbortController()
    void Promise.all([client.request<{tasks:typeof tasks}>('/ros/tasks','GET',undefined,controller.signal),client.request<{uses:typeof uses}>('/ros/task-uses','GET',undefined,controller.signal)]).then(([items,refs])=>{if(!controller.signal.aborted){setTasks(items.tasks);setUses(refs.uses)}}).catch(cause=>{if(!controller.signal.aborted)setError(cause)})
    return()=>controller.abort()
  },[client,workspaces])
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
  const diagnostics=resolution?.diagnostics||current?.diagnostics||[]
  const issueCount=diagnostics.length+(current?.conflicts_with.length||0)
  const usedTasks=tasks.filter(task=>task.workspace_ids?.includes(selected)||task.execution_workspace_id===selected)
  const visibleTypes=resolution?.types.filter(item=>item.ros_type.toLowerCase().includes(interfaceQuery.toLowerCase()))||[]
  return <section className="interface-workspace-manager" aria-label={t('子系统 ROS2 工作区')}>
    <header className="iw-heading"><div><h2>{t('子系统 ROS2 工作区')}</h2><p>{t('导入各子系统的 ROS2 工作区，读取接口定义与依赖，可离线配置')}</p></div><div className="buttons"><button disabled={busy} onClick={()=>create('files')}><Icon name="import"/>{t('导入接口文件')}</button><button className="primary" disabled={busy} onClick={()=>create('auto')}><Icon name="plus"/>{t('添加子系统工作区')}</button></div></header>
    <div className="iw-content"><aside className="iw-catalog"><div className="ros-search"><Icon name="search"/><input aria-label={t('搜索子系统 ROS2 工作区')} placeholder={t('搜索子系统 ROS2 工作区')} value={query} onChange={event=>setQuery(event.target.value)}/></div><div className="iw-workspaces">{workspaces.filter(item=>(item.name+' '+item.path).toLowerCase().includes(query.toLowerCase())).map(item=><button className="iw-workspace-row iw-workspace-card" aria-current={selected===item.id?'true':undefined} disabled={busy} key={item.id} onClick={()=>{setSelected(item.id);setEditor(null);setError(null);setNotice('')}}><TaskIcon value={item.icon}/><span><strong>{item.name}</strong><small className="iw-workspace-path">{item.path||t('导入的接口定义')}</small><small>{t('{0} 个可用 · {1} 个待补充',{0:item.available_count,1:item.pending_count})}</small></span>{!!item.conflicts_with.length&&<span className="iw-conflict-marker" title={t('与其他工作区存在冲突')}><Icon name="info"/></span>}</button>)}{!workspaces.length&&<p className="iw-list-empty">{t(loading?'正在读取接口':'尚未添加子系统工作区')}</p>}</div><footer>{t('接口定义可离线使用')}</footer></aside>
    <div className="iw-detail iw-card-detail">
      {editor?<form className="iw-register" onSubmit={event=>{event.preventDefault();void perform(register)}}><header><h3>{t(editor==='files'?'导入接口文件':'添加子系统工作区')}</h3><button type="button" disabled={busy} aria-label={t('取消')} onClick={()=>setEditor(null)}><Icon name="x"/></button></header><fieldset disabled={busy}>
        <div className="iw-icon-field"><span>{t('子系统图标')}</span><TaskIconPicker value={icon} label="子系统图标" onChange={setIcon}/></div><label className="field"><span>{t('工作区名称')}</span><input autoFocus value={name} placeholder={t('填写子系统或工作区名称')} onChange={event=>setName(event.target.value)}/></label>
        {editor!=='files'?<><label className="field"><span>{t('工作区目录')}</span><div className="iw-path"><input required value={path} placeholder={t('工作区文件夹的绝对路径')} onChange={event=>{setPath(event.target.value);setDetected(null)}}/>{window.agroDesktop?.chooseInterfaceFolder&&<button type="button" onClick={()=>void window.agroDesktop!.chooseInterfaceFolder().then(value=>{if(value){setPath(value);setDetected(null);if(!name)setName(value.split('/').filter(Boolean).at(-1)||'')}}).catch(setError)}>{t('选择文件夹')}</button>}</div></label><p className="ros-field-hint">{t('自动识别源码或安装目录，无需编译或启动 ROS 节点')}</p>
        <DisclosureCard title={t('读取方式')} summary={t(editor==='auto'?'自动识别':editor==='source'?'源码工作区':'安装目录')}><StudioSelect label={t('读取方式')} value={editor} options={[{value:'auto',label:t('自动识别')},{value:'source',label:t('源码工作区'),hint:t('读取源码中的接口定义，包含尚未编译的修改')},{value:'installed',label:t('安装目录'),hint:t('读取构建后安装的接口定义')}]} onChange={value=>{setEditor(value as 'auto'|'source'|'installed');setDetected(null)}}/></DisclosureCard>
        {detected?.mode==='ambiguous'&&<div className="iw-source-choice"><strong>{t('源码与安装接口内容不同')}</strong><p>{t('选择本次读取的来源，不会覆盖原目录')}</p>{detected.alternatives.map(option=><button type="button" key={option.mode} onClick={()=>{setEditor(option.mode);setPath(option.path);setDetected(null)}}><span>{t(option.mode==='source'?'使用源码定义':'使用安装定义')}</span><small>{option.path}</small></button>)}</div>}</>:<><label className="field"><span>{t('接口所属包名')}</span><input required value={packageName} placeholder="robot_interfaces" onChange={event=>setPackageName(event.target.value)}/></label><label className="field"><span>{t('原生接口文件')}</span><input type="file" accept=".msg,.srv,.action" multiple onChange={event=>setFiles(Array.from(event.target.files||[]))}/></label><p className="ros-field-hint">{t('支持消息、服务和 Action 定义，依赖可从其他工作区补齐')}</p></>}
        <div className="buttons"><button type="button" onClick={()=>setEditor(null)}>{t('取消')}</button><button className="primary" type="submit" disabled={editor==='files'?!packageName.trim()||!files.length:!path.trim()}>{t(busy?'正在读取接口':'检查并添加')}</button></div>
      </fieldset></form>:current?<div key={selected} className="iw-workspace-sections">
      <section className="iw-overview-card"><header className="iw-detail-heading"><div className="iw-overview-title"><TaskIcon value={current.icon}/><div><span className="iw-eyebrow">{t(current.mode==='files'?'导入定义':current.mode==='installed'?'安装目录':'源码工作区')}</span><h3>{current.name}</h3></div></div><div className="buttons"><button disabled={busy} aria-expanded={metadataOpen} onClick={()=>setMetadataOpen(value=>!value)}><Icon name="edit"/>{t('编辑基本信息')}</button>{current.mode!=='files'&&<button disabled={busy} onClick={()=>void perform(()=>update({refresh:true}))}><Icon name="refresh"/>{t('重新扫描')}</button>}<button disabled={busy||current.used_by>0} title={current.used_by?t('已有任务使用此工作区'):t('移除工作区')} aria-label={t('移除工作区')} onClick={()=>void perform(remove)}><Icon name="trash"/></button></div></header><p className="iw-overview-path"><code>{current.path||t('接口文件已保存在当前机器人工程')}</code></p><div className="iw-overview-status"><span>{t('定义可用 {0} 个',{0:current.available_count})}</span><span className={current.pending_count?'iw-pending':undefined}>{t('待补充 {0} 个',{0:current.pending_count})}</span><span>{t('{0} 个任务使用',{0:current.used_by})}</span>{issueCount>0&&<span className="iw-pending" role="status">{t('有 {0} 项需要处理',{0:issueCount})}</span>}</div>
        {metadataOpen&&<div className="iw-metadata-editor"><div className="iw-metadata"><fieldset disabled={busy} className="iw-icon-field"><span>{t('子系统图标')}</span><TaskIconPicker value={current.icon} label="子系统图标" onChange={icon=>void perform(()=>update({icon}))}/></fieldset><label className="field"><span>{t('工作区名称')}</span><div className="iw-path"><input value={rename} disabled={busy} onChange={event=>setRename(event.target.value)}/><button disabled={busy||!rename.trim()||rename.trim()===current.name} onClick={()=>void perform(()=>update({name:rename.trim()}))}>{t('保存')}</button></div></label></div><p className="ros-field-hint">{t('目录与读取方式用于离线扫描，运行环境单独配置')}</p><button disabled={busy} onClick={()=>setMetadataOpen(false)}>{t('完成')}</button></div>}
      </section>
      <DisclosureCard title={t('接口定义')} count={current.interface_count} status={<span className={current.pending_count?'iw-pending':'iw-ready'}>{t('可用 {0} 个 · 待补充 {1} 个',{0:current.available_count,1:current.pending_count})}</span>} summary={t('用于任务参数与输入输出编写，可离线读取')}>
        <div className="ros-search iw-card-search"><Icon name="search"/><input aria-label={t('搜索接口定义')} placeholder={t('搜索接口定义')} value={interfaceQuery} onChange={event=>setInterfaceQuery(event.target.value)}/></div>
        <div className="iw-object-cards">{visibleTypes.map(item=><DisclosureCard key={item.ros_type} title={<code>{item.ros_type}</code>} summary={t(item.ros_type.includes('/action/')?'动作 Action':item.ros_type.includes('/srv/')?'服务 Service':'消息 Msg')} status={<span className={item.available?'iw-ready':'iw-pending'}>{t(item.available?'定义可用':'定义待补充')}</span>}><p>{t('接口来源')} · <code>{item.source}</code></p>{item.issues&&<InterfaceIssues issues={item.issues}/>}<p className="ros-field-hint">{t(item.available?'选择此接口创建任务后，参数字段会自动显示':'补齐依赖后即可在任务中使用此接口')}</p></DisclosureCard>)}</div>
        {!resolution&&<p className="ros-field-hint">{t('正在读取接口')}</p>}{resolution&&!visibleTypes.length&&<p className="ros-field-hint">{t(interfaceQuery?'没有匹配的接口定义':'此目录没有可读取的接口定义')}</p>}
        {!!resolution?.dependencies?.length&&<DisclosureCard title={t('已补齐的依赖接口')} count={resolution.dependencies.length}>{resolution.dependencies.map(item=><DisclosureCard key={item.ros_type} title={<code>{item.ros_type}</code>} summary={item.source}><p><code>{item.source}</code></p></DisclosureCard>)}</DisclosureCard>}
        {foundation&&<DisclosureCard title={t('基础 ROS 接口')} status={t(foundation.status==='ready'?'已就绪':'需要选择来源')} summary={t('供当前机器人共用，用于补齐标准接口依赖')}><p>{t('基础接口用于补齐消息依赖，单独保存，不计入子系统工作区')}</p><p><code>{foundation.path||t(foundation.status==='ready'?'导入的基础接口快照':'未选择基础接口目录')}</code></p><p className="ros-field-hint">{t('保存的定义可离线使用，重新读取后已有任务仍保留原定义')}</p>{foundation.candidates.length>1&&<StudioSelect label={t('基础接口来源')} value={foundationPath} options={[{value:'',label:t('选择一个基础接口来源')},...foundation.candidates.map(value=>({value,label:value}))]} onChange={setFoundationPath}/>}<div className="iw-path"><input aria-label={t('基础 ROS 安装目录')} value={foundationPath} placeholder={t('基础 ROS 安装目录')} onChange={event=>setFoundationPath(event.target.value)}/><button disabled={busy||!foundationPath.trim()} onClick={()=>void perform(async()=>{await client.request('/ros/interface-foundation','PUT',{path:foundationPath.trim()});await load();setNotice(t('基础接口已重新读取'));window.dispatchEvent(new Event('agro:interfaces:changed'));window.dispatchEvent(new Event('agro:ros:refresh'))})}>{t('重新读取')}</button></div></DisclosureCard>}
      </DisclosureCard>
      <OfflineCommunications client={client} workspaceId={selected} epoch={workspaces} onUpdate={data=>perform(()=>update(data))} onError={setError} disabled={busy}/>
      <ExecutionEnvironment client={client} workspaceId={selected} epoch={workspaces}/>
      <SubsystemModules client={client} workspaceId={selected}/>
      <DisclosureCard title={t('使用与诊断')} count={usedTasks.length} status={<span className={issueCount?'iw-pending':'iw-ready'}>{issueCount?t('有 {0} 项需要处理',{0:issueCount}):t('没有接口定义问题')}</span>} summary={t('{0} 个任务使用',{0:current.used_by})}>
        <DisclosureCard title={t('使用此工作区的任务')} count={usedTasks.length}>{usedTasks.map(task=><DisclosureCard key={task.id} title={task.name} summary={<code>{task.interface||task.ros_type||t('尚未配置通信名称')}</code>} status={t('{0} 处编排引用',{0:uses[task.id]?.length||0})}>{(uses[task.id]||[]).map((item,index)=><p key={index}>{t(item.kind==='tree'?'行为树':'状态编排')} · {item.name} · {item.detail}</p>)}{!uses[task.id]?.length&&<p className="ros-field-hint">{t('尚未用于流程编排')}</p>}</DisclosureCard>)}{!usedTasks.length&&<p className="ros-field-hint">{t('尚无任务使用此工作区')}</p>}</DisclosureCard>
        <InterfaceIssues issues={diagnostics}/>
        {!!current.conflicts_with.length&&<DisclosureCard title={t('不能同时选用的工作区')} count={current.conflicts_with.length} status={<span className="iw-pending">{t('存在定义冲突')}</span>}><p className="ros-field-hint">{t('这些工作区可以保留，任务选择时会自动排除冲突组合')}</p>{current.conflicts_with.map(other=><DisclosureCard key={other.id} title={other.name} count={other.types.length} summary={t('存在不同定义的接口')}>{other.types.map(type=><p key={type}><code>{type}</code></p>)}</DisclosureCard>)}</DisclosureCard>}
        {!issueCount&&<p className="ros-field-hint">{t('离线定义与依赖可用，实际运行状态请在运行台查看')}</p>}
      </DisclosureCard>
    </div>:<div className="iw-empty"><Icon name="boxes" size="xl"/><h3>{t('为机器人准备接口定义')}</h3><p>{t('添加源码工作区或导入接口文件，即可离线创建任务')}</p><button onClick={()=>create('auto')}><Icon name="plus"/>{t('添加子系统工作区')}</button></div>}
    <ErrorFields value={error}/>{notice&&<p className="iw-status" role="status">{notice}</p>}
    </div></div>
  </section>
}
