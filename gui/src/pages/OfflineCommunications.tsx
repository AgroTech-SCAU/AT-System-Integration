import {useEffect,useState} from 'react'
import type {ApiClient} from '../api'
import {useLocale} from '../locale'
import StudioSelect from '../components/StudioSelect'

export type OfflineEndpoint={id:string;kind:'topic'|'service'|'action';role:string;ros_type:string;name:string;node:string;source:string;line:number;parameter:string;expression:string;status:'resolved'|'unresolved'|'conflict';reason:string;configuration:string[];workspace_id?:string;workspace_name?:string}
type Scan={endpoints:OfflineEndpoint[];profiles:{id:string;label:string;kind:string;arguments:{name:string;default:unknown;value:unknown}[]}[];profile:string;arguments:Record<string,string>;missing_parameters?:{name:string;label:string;value:string}[];notices:string[]}
export default function OfflineCommunications({client,workspaceId,epoch,onUpdate,onError,disabled}:{client:ApiClient;workspaceId:string;epoch:unknown;onUpdate:(data:Record<string,unknown>)=>Promise<void>;onError:(error:unknown)=>void;disabled:boolean}){
 const {t}=useLocale(),[scan,setScan]=useState<Scan|null>(null),[query,setQuery]=useState(''),[args,setArgs]=useState<Record<string,string>>({})
 useEffect(()=>{const controller=new AbortController();setScan(null);void client.request<Scan>('/ros/interface-workspaces/'+workspaceId+'/communications','GET',undefined,controller.signal).then(result=>{if(!controller.signal.aborted){setScan(result);setArgs(result.arguments)}}).catch(error=>{if(!controller.signal.aborted)onError(error)});return()=>controller.abort()},[client,workspaceId,epoch])
 const profile=scan?.profiles.find(item=>item.id===scan.profile)
 const parameters=[...(profile?.arguments||[]).map(item=>({...item,label:item.name})),...(scan?.missing_parameters||[])]
 const visible=scan?.endpoints.slice().sort((a,b)=>(a.status==='resolved'?0:1)-(b.status==='resolved'?0:1)||a.name.localeCompare(b.name)).filter(item=>(item.name+' '+item.ros_type+' '+item.node).toLowerCase().includes(query.toLowerCase()))||[]
 return <section className="iw-offline"><h4>{t('离线通信接口')} <small>{scan?t('{0} 条声明',{0:scan.endpoints.length}):t('正在读取接口')}</small></h4><p className="ros-field-hint">{t('从节点源码和启动配置读取，无需启动 ROS 节点')}</p>{scan&&<>
 <StudioSelect label={t('启动配置')} value={scan.profile} options={[{value:'',label:t('源码声明'),hint:t('使用源码默认值，不应用启动覆盖')},...scan.profiles.map(item=>({value:item.id,label:item.label,hint:t(item.kind==='launch'?'启动文件':'参数文件')}))]} onChange={value=>{if(!disabled)void onUpdate({communication_profile:value,communication_arguments:{}}).catch(onError)}}/>
 {!!parameters.length&&<details className="iw-source-options" open><summary>{t('启动参数')}</summary>{parameters.map(arg=><label className="field" key={arg.name}><span>{arg.label}</span><input disabled={disabled} value={args[arg.name]??String(arg.value??'')} placeholder={t('填写此参数后离线解析')} onChange={event=>setArgs(old=>({...old,[arg.name]:event.target.value}))}/></label>)}<button disabled={disabled} onClick={()=>void onUpdate({communication_arguments:args}).catch(onError)}>{t('应用并重新解析')}</button></details>}
 <input className="iw-offline-search" aria-label={t('搜索通信名称或接口类型')} placeholder={t('搜索通信名称或接口类型')} value={query} onChange={event=>setQuery(event.target.value)}/>
 <div className="iw-offline-list">{visible.map(item=><details key={item.id} className="iw-offline-row"><summary><span className="ros-type-badge">{item.kind==='action'?'Action':item.kind==='service'?'Service':'Topic'}</span><span><code>{item.name||item.expression}</code><small>{item.ros_type||t('接口类型待确认')}</small></span><span className={item.status==='resolved'?'iw-ready':'iw-pending'}>{t(item.status==='resolved'?'已解析':item.status==='conflict'?'名称冲突':'待补充')}</span></summary><div><p>{t(item.role==='publisher'?'发布端':item.role==='subscriber'?'订阅端':item.role==='server'?'服务端':'客户端')} · {item.node||t('节点名称待确认')}</p><p>{item.reason}</p><code>{item.source}:{item.line}</code>{item.configuration.map(source=><p key={source}>{source}</p>)}</div></details>)}</div>
 {!visible.length&&<p className="ros-field-hint">{t(scan.endpoints.length?'没有匹配的通信接口':'未发现可解析的通信声明，可添加含节点源码的工作区')}</p>}{scan.notices.map(note=><p key={note} className="ros-field-hint">{note}</p>)}
 </>}</section>
}
