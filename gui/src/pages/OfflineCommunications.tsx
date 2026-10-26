import {useEffect,useState} from 'react'
import type {ApiClient} from '../api'
import {useLocale} from '../locale'
import StudioSelect from '../components/StudioSelect'
import DisclosureCard from '../components/DisclosureCard'

export type OfflineEndpoint={id:string;kind:'topic'|'service'|'action';role:string;ros_type:string;name:string;node:string;source:string;line:number;parameter:string;expression:string;status:'resolved'|'unresolved'|'conflict';reason:string;configuration:string[];workspace_id?:string;workspace_name?:string}
type ModuleProfile={id:string;name:string;kind:string;workspace_id:string;configuration?:unknown;parameters?:Record<string,unknown>;launch_arguments?:Record<string,unknown>}
type Scan={endpoints:OfflineEndpoint[];profiles:{id:string;label:string;kind:string;arguments:{name:string;default:unknown;value:unknown}[]}[];profile:string;arguments:Record<string,string>;missing_parameters?:{name:string;label:string;value:string}[];notices:string[];module_profiles?:ModuleProfile[];selected_module_id?:string}
export default function OfflineCommunications({client,workspaceId,epoch,onUpdate,onError,disabled}:{client:ApiClient;workspaceId:string;epoch:unknown;onUpdate:(data:Record<string,unknown>)=>Promise<void>;onError:(error:unknown)=>void;disabled:boolean}){
 const {t}=useLocale(),[scan,setScan]=useState<Scan|null>(null),[query,setQuery]=useState(''),[args,setArgs]=useState<Record<string,string>>({}),[moduleEpoch,setModuleEpoch]=useState(0)
 useEffect(()=>{const controller=new AbortController();setScan(null);void client.request<Scan>('/ros/interface-workspaces/'+workspaceId+'/communications','GET',undefined,controller.signal).then(result=>{if(!controller.signal.aborted){setScan(result);setArgs(result.arguments)}}).catch(error=>{if(!controller.signal.aborted)onError(error)});return()=>controller.abort()},[client,workspaceId,epoch,moduleEpoch])
 useEffect(()=>{const changed=()=>setModuleEpoch(value=>value+1);window.addEventListener('agro:modules:changed',changed);return()=>window.removeEventListener('agro:modules:changed',changed)},[])
 const profile=scan?.profiles.find(item=>item.id===scan.profile),module=scan?.module_profiles?.find(item=>item.id===scan.selected_module_id)
 const linked=!!scan?.selected_module_id
 const parameters=[...(profile?.arguments||[]).map(item=>({...item,label:item.name})),...(scan?.missing_parameters||[])]
 const visible=scan?.endpoints.slice().sort((a,b)=>(a.status==='resolved'?0:1)-(b.status==='resolved'?0:1)||a.name.localeCompare(b.name)).filter(item=>(item.name+' '+item.ros_type+' '+item.node).toLowerCase().includes(query.toLowerCase()))||[]
 const pending=scan?.endpoints.filter(item=>item.status!=='resolved').length||0
 const source=scan?.selected_module_id?'module:'+scan.selected_module_id:scan?.profile?'profile:'+scan.profile:'source'
 async function changeSource(value:string){
  if(disabled)return
  try{await onUpdate(value.startsWith('module:')?{communication_module_id:value.slice(7)}:{communication_module_id:'',communication_profile:value.startsWith('profile:')?value.slice(8):'',communication_arguments:{}})}catch(error){onError(error)}
 }
 const role=(item:OfflineEndpoint)=>t(item.role==='publisher'?'发布端':item.role==='subscriber'?'订阅端':item.role==='server'?'服务端':'客户端')
 return <DisclosureCard title={t('通信接口')} count={scan?.endpoints.length} status={<span className={pending?'iw-pending':'iw-ready'}>{scan?t('已解析 {0} 条 · 待确认 {1} 条',{0:scan.endpoints.length-pending,1:pending}):t('正在读取接口')}</span>} summary={module?t('按启动模块 {0} 解析',{0:module.name}):linked?t('关联的启动模块已不可用，请重新选择'):t('从节点源码和启动配置读取，无需启动 ROS 节点')} className="iw-communications-card">
  {scan&&<>
   <label className="field"><span>{t('通信名称解析依据')}</span><StudioSelect label={t('通信名称解析依据')} value={source} options={[{value:'source',label:t('源码声明'),hint:t('使用源码默认值，不应用启动覆盖')},...(linked&&!module?[{value:source,label:t('关联的启动模块已不可用，请重新选择')}]:[]),...(scan.module_profiles||[]).map(item=>({value:'module:'+item.id,label:item.name,hint:t('使用启动模块的实际配置')})),...scan.profiles.map(item=>({value:'profile:'+item.id,label:item.label,hint:t(item.kind==='launch'?'启动文件':'参数文件')}))]} onChange={value=>void changeSource(value)}/></label>
   <p className="ros-field-hint">{t(linked?'解析参数跟随此启动模块，请到启动配置中修改':'此处设置用于离线解析通信名称，不会启动节点')}</p>
   {linked&&!module&&<p className="iw-pending" role="status">{t('关联的启动模块已不可用，请重新选择')}</p>}
   {module&&<DisclosureCard title={t('解析使用的模块参数')} summary={t('与启动配置保持一致')}><pre className="ros-code">{JSON.stringify({parameters:module.parameters||{},launch_arguments:module.launch_arguments||{}},null,2)}</pre></DisclosureCard>}
   {!linked&&!!parameters.length&&<DisclosureCard title={t('名称解析参数')} count={parameters.length} summary={t('只影响离线扫描的名称解析')}>
    {parameters.map(arg=><label className="field" key={arg.name}><span>{arg.label}</span><input disabled={disabled} value={args[arg.name]??String(arg.value??'')} placeholder={t('填写此参数后离线解析')} onChange={event=>setArgs(old=>({...old,[arg.name]:event.target.value}))}/></label>)}
    <button disabled={disabled} onClick={()=>void onUpdate({communication_arguments:args}).catch(onError)}>{t('应用并重新解析')}</button>
   </DisclosureCard>}
   <div className="ros-search iw-card-search"><input aria-label={t('搜索通信名称或接口类型')} placeholder={t('搜索通信名称或接口类型')} value={query} onChange={event=>setQuery(event.target.value)}/></div>
   <div className="iw-object-cards">{visible.map(item=><DisclosureCard key={item.id} title={<code>{item.name||item.expression}</code>} summary={<span>{item.kind==='action'?'Action':item.kind==='service'?'Service':'Topic'} · {role(item)} · {item.ros_type||t('接口类型待确认')}</span>} status={<span className={item.status==='resolved'?'iw-ready':'iw-pending'}>{t(item.status==='resolved'?'已解析':item.status==='conflict'?'名称冲突':'待补充')}</span>}>
    <p>{role(item)} · {item.node||t('节点名称待确认')}</p>{item.reason&&<p>{item.reason}</p>}<p><code>{item.source}:{item.line}</code></p>{item.configuration.map((source,index)=><p key={index}>{source}</p>)}
   </DisclosureCard>)}</div>
   {!visible.length&&<p className="ros-field-hint">{t(scan.endpoints.length?'没有匹配的通信接口':'未发现可解析的通信声明，可添加含节点源码的工作区')}</p>}
   {!!scan.notices.length&&<DisclosureCard title={t('扫描提示')} count={scan.notices.length}>{scan.notices.map(note=><p key={note} className="ros-field-hint">{note}</p>)}</DisclosureCard>}
  </>}
 </DisclosureCard>
}
