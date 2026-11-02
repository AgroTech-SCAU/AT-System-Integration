import {useEffect,useState} from 'react'
import type {ApiClient} from '../api'
import type {RosTask} from './RosTaskLibrary'
import {useLocale} from '../locale'
import DisclosureCard from '../components/DisclosureCard'
import StudioSelect from '../components/StudioSelect'
import {ErrorFields,type Json} from './shared'
import {environmentReadiness,runtimeEnvironment,type EnvironmentState} from './environment-state'

type Workspace={id:string;name:string}
type Environment=EnvironmentState
export function resolveTaskProvider(task:RosTask,workspaces:Workspace[],interfaceWorkspaceIds:string[]|undefined,modules:Json[]){
 const available=workspaces.filter(item=>task.workspace_ids?.includes(item.id))
 const selected=modules.filter(item=>task.module_ids?.includes(item.id))
 const endpointKind=['action','service'].includes(task.kind)?task.kind:'topic'
 const providers=task.kind==='compute'?[]:modules.filter(module=>available.some(item=>item.id===module.workspace_id)&&(module.provides||[]).some((endpoint:Json)=>endpoint.name===task.interface&&endpoint.kind===endpointKind&&(endpointKind!=='topic'||(endpoint.role||'publisher')===(task.kind==='subscribe_wait'?'publisher':'subscriber'))&&(!endpoint.type||endpoint.type===task.ros_type)))
 const sourceCandidates=interfaceWorkspaceIds?.length?available.filter(item=>interfaceWorkspaceIds.includes(item.id)):available
 const selectedWorkspaces=[...new Set(selected.map(item=>item.workspace_id))],providerWorkspaces=[...new Set(providers.map(item=>item.workspace_id))]
 const inferredId=sourceCandidates.length===1?sourceCandidates[0].id:selectedWorkspaces.length===1?selectedWorkspaces[0]:providerWorkspaces.length===1?providerWorkspaces[0]:undefined
 const workspace=available.find(item=>item.id===task.execution_workspace_id)||available.find(item=>item.id===inferredId)
 return {available,selected,providers,workspace,sourceCandidates}
}
type Props={client:ApiClient;task:RosTask;workspaces:Workspace[];interfaceWorkspaceIds?:string[];onChange:(value:Partial<RosTask>)=>void;onResolved?:(workspaceId:string|undefined)=>void;onConfigure?:(workspaceId:string,section:'environment'|'modules')=>void;open?:boolean;onOpenChange?:(open:boolean)=>void;disabled?:boolean}
export default function TaskProvider({client,task,workspaces,interfaceWorkspaceIds,onChange,onResolved,onConfigure,open,onOpenChange,disabled=false}:Props){
 const {t}=useLocale(),[modules,setModules]=useState<Json[]>([]),[error,setError]=useState<unknown>(null),[loaded,setLoaded]=useState(false)
 const [environment,setEnvironment]=useState<Environment|null>(null),[environmentError,setEnvironmentError]=useState(false),[choosingWorkspace,setChoosingWorkspace]=useState(false),[choosingModules,setChoosingModules]=useState(false)
 useEffect(()=>{let alive=true;const controller=new AbortController();setLoaded(false);const load=()=>{void client.request<Json>('/deployment/modules','GET',undefined,controller.signal).then(value=>{if(alive){setModules(value.modules);setLoaded(true);setError(null)}}).catch(cause=>{if(alive&&!controller.signal.aborted){setLoaded(true);setError(cause)}})};load();window.addEventListener('agro:modules:changed',load);return()=>{alive=false;controller.abort();window.removeEventListener('agro:modules:changed',load)}},[client,task.workspace_ids?.join(',')])
 const {available,selected,providers,workspace,sourceCandidates}=resolveTaskProvider(task,workspaces,interfaceWorkspaceIds,modules)
 useEffect(()=>{onResolved?.(workspace?.id)},[workspace?.id,onResolved])
 useEffect(()=>{if(!disabled&&loaded&&!error&&!task.execution_workspace_id&&workspace&&sourceCandidates.length!==1)onChange({execution_workspace_id:workspace.id})},[disabled,loaded,error,workspace?.id,task.execution_workspace_id,sourceCandidates.length,onChange])
 useEffect(()=>{setChoosingWorkspace(false);setChoosingModules(false)},[task.id])
 useEffect(()=>{
  setEnvironment(null);setEnvironmentError(false)
  if(!workspace)return
  const controller=new AbortController()
  const load=()=>{void client.request<Environment>(`/ros/interface-workspaces/${workspace.id}/environment`,'GET',undefined,controller.signal).then(value=>{if(!controller.signal.aborted){setEnvironment(value);setEnvironmentError(false)}}).catch(()=>{if(!controller.signal.aborted)setEnvironmentError(true)})}
  load();window.addEventListener('agro:environment:changed',load)
  return()=>{controller.abort();window.removeEventListener('agro:environment:changed',load)}
 },[client,workspace?.id])
 const external=task.startup_policy==='external',missingSelection=(task.module_ids||[]).some(id=>!modules.some(module=>module.id===id&&available.some(workspace=>workspace.id===module.workspace_id)))
 const providerIssue=loaded&&!external&&(task.kind!=='compute'&&!selected.length&&providers.length!==1||missingSelection)
 const moduleSummary=!loaded?t('正在读取启动来源'):external?t('使用外部已启动的接口'):selected.length?selected.map(item=>item.name).join(' · '):providers.length===1?providers[0].name:task.kind==='compute'?t('不启动额外模块'):providers.length>1?t('请选择接口提供模块'):t('尚未配置接口提供模块')
 const environmentState=environmentReadiness(environment,runtimeEnvironment(environment))
 const environmentSummary=!workspace?t('请选择执行子系统'):environmentError?t('无法读取运行环境'):!environment?t('正在读取环境配置'):environmentState.problem?t(environmentState.problem):t(environmentState.loaded?'已配置运行环境':environmentState.checked?'检查通过，运行时自动加载':'已发现环境，运行时检查加载')
 const environmentGap=!!environment&&['missing_setup','missing_python','failed'].includes(environmentState.status)
 const chooseModule=(id:string)=>{const module=modules.find(item=>item.id===id);onChange({module_ids:id?[id]:[],...(module?{execution_workspace_id:module.workspace_id}:{})})}
 return <div data-task-section="provider"><DisclosureCard title={t('执行环境与启动来源')} summary={(workspace?.name||t('请选择执行子系统'))+' · '+moduleSummary} open={open} onOpenChange={onOpenChange} actions={workspace&&onConfigure&&(providerIssue||environmentGap)?<button type="button" disabled={disabled} onClick={()=>onConfigure(workspace.id,environmentGap?'environment':'modules')}>{t(environmentGap?'配置运行环境':'配置接口提供模块')}</button>:undefined} status={!workspace||providerIssue||environmentError||error?<span style={{color:'var(--red)'}}>{t(!workspace?'请选择执行子系统':environmentError?'无法读取运行环境':providerIssue?'接口提供模块待配置':'配置待核对')}</span>:environment&&!environment.loaded?<span>{t(environmentGap?'运行前需配置环境':'运行时检查并加载')}</span>:undefined}>
  <p className="ros-field-hint">{t('接口来源用于生成参数，执行子系统提供运行依赖，启动模块负责提供实际通信')}</p>
  <div className="ros-context-row"><span>{t('执行子系统')}</span><strong>{workspace?.name||t('尚未确定')}</strong>{workspace&&available.length>1&&<button type="button" onClick={()=>setChoosingWorkspace(value=>!value)}>{t(choosingWorkspace?'收起选择':'修改')}</button>}</div>
  {(!workspace||choosingWorkspace)&&<label className="field"><span>{t('选择执行子系统')}</span><StudioSelect value={task.execution_workspace_id||workspace?.id||''} label={t('执行子系统')} options={[{value:'',label:t('按接口与提供模块确定')},...available.map(item=>({value:item.id,label:item.name}))]} onChange={execution_workspace_id=>onChange({execution_workspace_id,module_ids:[]})}/></label>}
  <div className="ros-context-row"><span>{t('运行环境')}</span><strong>{environmentSummary}</strong>{workspace&&onConfigure&&<button type="button" onClick={()=>onConfigure(workspace.id,'environment')}>{t(environmentState.setup?'查看环境':'配置运行环境')}</button>}</div>
  {environmentState.setup&&<code className="ros-context-path">{environmentState.setup}</code>}
  <label className="field"><span>{t('启动来源')}</span><StudioSelect value={task.startup_policy||'managed'} label={t('启动来源')} options={[{value:'managed',label:t('由运行台准备所需模块')},{value:'external',label:t('使用外部已启动的接口')}]} onChange={startup_policy=>onChange({startup_policy:startup_policy as RosTask['startup_policy']})}/></label>
  {!external&&<>
   <div className="ros-context-row"><span>{t('启动模块')}</span><strong>{moduleSummary}</strong><button type="button" onClick={()=>setChoosingModules(value=>!value)}>{t(choosingModules?'收起选择':selected.length?'修改':'手动选择')}</button></div>
   {!selected.length&&providers.length===1&&<p className="ros-field-hint">{t('已按通信名称、类型和话题角色匹配唯一模块')}</p>}
   {!selected.length&&providers.length>1&&<label className="field"><span>{t('选择接口提供模块')}</span><StudioSelect value="" label={t('选择接口提供模块')} options={[{value:'',label:t('多个模块提供此接口，请选择')},...providers.map(item=>({value:item.id,label:item.name,hint:workspaces.find(workspace=>workspace.id===item.workspace_id)?.name}))]} onChange={chooseModule}/></label>}
   {missingSelection&&<p className="ros-invalid">{t('原启动模块已不可用，请重新选择')}</p>}
   {choosingModules&&<div className="ros-module-choices">{modules.filter(item=>available.some(workspace=>workspace.id===item.workspace_id)).map(item=><label className="toggle list-card" key={item.id}><input type="checkbox" checked={task.module_ids?.includes(item.id)||false} onChange={event=>onChange({module_ids:event.target.checked?[...(task.module_ids||[]),item.id]:(task.module_ids||[]).filter(id=>id!==item.id)})}/><span>{item.name}<small>{workspaces.find(workspace=>workspace.id===item.workspace_id)?.name}</small></span></label>)}{!!task.module_ids?.length&&<button type="button" onClick={()=>onChange({module_ids:[]})}>{t('恢复自动匹配')}</button>}</div>}
   {workspace&&onConfigure&&<button type="button" className="ros-context-link" onClick={()=>onConfigure(workspace.id,'modules')}>{t(providerIssue?'配置接口提供模块':'查看子系统启动配置')}</button>}
  </>}
  <p className="ros-field-hint">{t('执行依赖与启动来源不影响离线编辑，开始运行时统一检查')}</p><ErrorFields value={error}/>
 </DisclosureCard></div>
}
