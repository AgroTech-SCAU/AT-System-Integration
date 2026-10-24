import type {OfflineEndpoint} from './OfflineCommunications'
import type {WorkspaceResolution} from './InterfaceWorkspacePicker'
import {useEffect, useRef, useState} from 'react'
import {AnimatePresence} from 'motion/react'
import type {ApiClient} from '../api'
import {AnchoredPopover} from '../components/AnchoredPopover'
import {Icon} from '../components/Icon'
import {useLocale} from '../locale'

export type RosEndpoint={name:string;types:string[];kind:'topic'|'service'|'action'}
type Graph={topics:RosEndpoint[];services:RosEndpoint[];actions:RosEndpoint[];connected:boolean}
export default function RosCommunicationField({client,robotId,kind,rosType,value,onChange,disabled=false,available,online=false,offline,workspaceIds,autoSelect=false}:{client:ApiClient;robotId?:string;kind:string;rosType:string;value:string;onChange:(value:string)=>void;disabled?:boolean;available?:RosEndpoint[];online?:boolean;offline?:OfflineEndpoint[];workspaceIds?:string[];autoSelect?:boolean}){
  const {t}=useLocale(),alive=useRef(true)
  const [anchor,setAnchor]=useState<HTMLButtonElement|null>(null),[query,setQuery]=useState('')
  const [endpoints,setEndpoints]=useState<RosEndpoint[]>([]),[discovered,setDiscovered]=useState(false),[attempted,setAttempted]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('')
  const [scanned,setScanned]=useState<OfflineEndpoint[]>([])
  const selectionKey=(workspaceIds||[]).join('|')
  useEffect(()=>{if(offline!==undefined){setScanned(offline);return}setScanned([]);if(!workspaceIds?.length)return;const controller=new AbortController();void client.request<WorkspaceResolution>('/ros/interface-workspaces/resolve','POST',{workspace_ids:workspaceIds},controller.signal).then(result=>{if(!controller.signal.aborted)setScanned(result.communications||[])}).catch(()=>{});return()=>controller.abort()},[client,offline,selectionKey])
  const key='atil.graph.'+(robotId||'current')
  const group=kind==='action'?'action':kind==='service'?'service':'topic'
  const label=t(group==='action'?'Action 通信名称':group==='service'?'服务通信名称':'话题通信名称')
  function unpack(graph:Graph):RosEndpoint[]{return [...(graph.actions||[]).map(item=>({...item,kind:'action' as const})),...(graph.services||[]).map(item=>({...item,kind:'service' as const})),...(graph.topics||[]).map(item=>({...item,kind:'topic' as const}))]}
  useEffect(()=>{
    alive.current=true;setDiscovered(false);setAttempted(false);setEndpoints([]);setNotice('')
    try{const cached=JSON.parse(localStorage.getItem(key)||'null');if(cached)setEndpoints(unpack(cached))}catch{}
    const receive=(event:Event)=>{const result=(event as CustomEvent<{key:string;graph:Graph}>).detail;if(result.key===key){setEndpoints(unpack(result.graph));setAttempted(true);setDiscovered(result.graph.connected)}}
    window.addEventListener('agro:ros:discovered',receive)
    return()=>{alive.current=false;window.removeEventListener('agro:ros:discovered',receive)}
  },[client,key])
  const source=discovered?endpoints:available||endpoints
  const matches=source.filter(item=>item.kind===group&&item.types.includes(rosType))
  const candidates=scanned.filter(item=>item.kind===group&&item.ros_type===rosType)
  const ready=candidates.filter(item=>item.status==='resolved')
  const unique=[...new Set(ready.map(item=>item.name))]
  const filled=useRef(''),candidateKey=group+'|'+rosType+'|'+selectionKey+'|'+unique.join('|')
  useEffect(()=>{if(autoSelect&&!disabled&&unique.length===1&&filled.current!==candidateKey){filled.current=candidateKey;if(!value.trim())onChange(unique[0])}},[autoSelect,disabled,value,candidateKey])
  const offlineFound=ready.some(item=>item.name===value.trim())
  const found=!!value.trim()&&matches.some(item=>item.name===value.trim())
  const isOnline=attempted?discovered:online
  async function discover(){
    if(busy)return
    setBusy(true);setAttempted(true);setDiscovered(false);setNotice('')
    try{
      const graph=await client.request<Graph>('/ros/interfaces')
      if(!alive.current)return
      if(graph.connected){setEndpoints(unpack(graph));setDiscovered(true);localStorage.setItem(key,JSON.stringify(graph));window.dispatchEvent(new CustomEvent('agro:ros:discovered',{detail:{key,graph}}));setNotice(t('已刷新发现结果'))}
      else{setDiscovered(false);setNotice(t('当前无法发现在线接口，仍可离线填写通信名称'))}
    }catch{if(alive.current){setDiscovered(false);setNotice(t('当前无法发现在线接口，仍可离线填写通信名称'))}}
    finally{if(alive.current)setBusy(false)}
  }
  const invalid=!!value.trim()&&(!value.trim().startsWith('/')||/\s/.test(value.trim())||value.trim().length>240)
  return <div className="ros-communication-field"><label className="field"><span>{label}</span><div className="ros-communication-input"><input aria-label={label} aria-invalid={invalid} disabled={disabled} value={value} placeholder={t('填写实际通信名称，以 / 开头')} onChange={event=>onChange(event.target.value)}/><button type="button" disabled={disabled||!rosType} aria-label={t('选择离线扫描的通信名称')} aria-haspopup="dialog" aria-expanded={!!anchor} onClick={event=>setAnchor(anchor?null:event.currentTarget)}><Icon name="chevron-down"/></button></div></label>
    <div className="ros-communication-status"><span>{t(!value.trim()?'选择扫描结果或填写通信名称':invalid?'通信名称格式待修正':offlineFound?'已匹配离线声明':'通信名称已配置')}</span><button type="button" disabled={disabled||busy} onClick={()=>void discover()}><Icon name="refresh"/>{t(busy?'正在观测':'在线对照')}</button></div>
    <p className="ros-field-hint">{t('接口类型决定参数格式，通信名称指定实际使用的话题、服务或 Action')}</p>
    {invalid&&<small className="ros-invalid">{t('填写以 / 开头且不含空格的通信名称')}</small>}
    {found&&isOnline&&<p className="ros-field-hint">{t('在线观测已发现此名称')}</p>}
    {notice&&<p className="ros-field-hint" role="status">{notice}</p>}
    <AnimatePresence>{anchor&&<AnchoredPopover anchor={anchor} role="dialog" label={t('选择通信名称')} align="end" className="ros-communication-options" onClose={()=>setAnchor(null)}><div className="ros-search"><Icon name="search"/><input autoFocus aria-label={t('搜索通信名称')} placeholder={t('搜索通信名称')} value={query} onChange={event=>setQuery(event.target.value)}/></div><small>{t('工作区离线扫描')}</small><div className="ros-select-scroll">{candidates.filter(item=>(item.name+' '+item.node).includes(query)).map(item=><button type="button" key={item.workspace_id+':'+item.id} disabled={item.status!=='resolved'} title={item.reason} onClick={()=>{onChange(item.name);setAnchor(null)}}><span><code>{item.name||item.expression}</code><small>{item.workspace_name} · {item.node}<br/>{item.source}:{item.line}{item.status!=='resolved'?' · '+item.reason:''}</small></span>{value===item.name&&<span>✓</span>}</button>)}{!candidates.length&&<p>{t('此类型暂无离线通信声明，请在子系统工作区重新扫描或补充启动参数')}</p>}{!!matches.length&&<><small>{t(isOnline?'在线对照结果':'此前观测记录')}</small>{matches.filter(item=>item.name.includes(query)&&!unique.includes(item.name)).map(item=><button type="button" key={item.name} onClick={()=>{onChange(item.name);setAnchor(null)}}><code>{item.name}</code></button>)}</>}</div></AnchoredPopover>}</AnimatePresence>
  </div>
}
