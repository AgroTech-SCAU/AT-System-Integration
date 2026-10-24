import RosCommunicationField from './RosCommunicationField'
import {useEffect,useState} from 'react'
import type {ApiClient} from '../api'
import {useLocale} from '../locale'
import {ErrorFields} from './shared'
import {deferNavigation,unsavedDialog} from '../components/StudioDialogs'

type Binding={workspace_ids?:string[];task_id:string;name:string;interface:string;ros_type:string;kind:string}
type Endpoint={name:string;types:string[];kind:'topic'|'service'|'action'}
export default function RobotBindings({client,robotId,available=[],online=false}:{client:ApiClient;robotId?:string;available?:Endpoint[];online?:boolean}){
 const {t}=useLocale()
 const [bindings,setBindings]=useState<Binding[]>([]),[saved,setSaved]=useState<Record<string,string>>({})
 const [busy,setBusy]=useState(''),[error,setError]=useState<unknown>(null)
 useEffect(()=>{let active=true;void client.request<{bindings:Binding[]}>('/ros/bindings').then(result=>{if(active){setBindings(result.bindings);setSaved(Object.fromEntries(result.bindings.map(item=>[item.task_id,item.interface])))}}).catch(cause=>{if(active)setError(cause)});return()=>{active=false}},[client])
 async function save(binding:Binding){
  setBusy(binding.task_id);setError(null)
  try{await client.request('/ros/bindings/'+binding.task_id,'PUT',{interface:binding.interface.trim()});setSaved(previous=>({...previous,[binding.task_id]:binding.interface.trim()}));setBindings(previous=>previous.map(item=>item.task_id===binding.task_id?{...item,interface:binding.interface.trim()}:item));window.dispatchEvent(new Event('agro:ros:refresh'));return true}catch(cause){setError(cause);return false}finally{setBusy('')}
 }
 useEffect(()=>{
  const leave=(event:Event)=>{const changes=bindings.filter(item=>item.interface!==saved[item.task_id]);if(changes.length)deferNavigation(event,()=>unsavedDialog(t('任务通信配置'),async()=>{for(const item of changes)if(!await save(item))return false;return true},()=>setBindings(previous=>previous.map(item=>({...item,interface:saved[item.task_id]||''})))))}
  window.addEventListener('agro:navigate',leave);window.addEventListener('agro:robot:leave-bindings',leave)
  return()=>{window.removeEventListener('agro:navigate',leave);window.removeEventListener('agro:robot:leave-bindings',leave)}
 },[bindings,saved])
 return <section className="robot-bindings"><h2>{t('任务通信配置')}</h2><p>{t('为每个任务指定实际使用的话题、服务或 Action 名称，可离线填写')}</p>
  {bindings.map(binding=><div className="robot-binding-row" key={binding.task_id}><div><strong>{binding.name}</strong><span className="binding-kind">{t('接口类型')}</span><small>{binding.ros_type||t('类型尚未选择')}</small></div><RosCommunicationField workspaceIds={binding.workspace_ids} client={client} robotId={robotId} kind={binding.kind} rosType={binding.ros_type} value={binding.interface} available={available} online={online} disabled={!!busy} onChange={interfaceName=>setBindings(previous=>previous.map(item=>item.task_id===binding.task_id?{...item,interface:interfaceName}:item))}/><button disabled={!!busy||binding.interface===saved[binding.task_id]} onClick={()=>void save(binding)}>{t(busy===binding.task_id?'保存中':binding.interface!==saved[binding.task_id]?'保存':binding.interface.trim()?'已保存':'待配置')}</button></div>)}
  {!bindings.length&&<p>{t('先在任务库创建任务，再配置它实际使用的通信名称')}</p>}
  <ErrorFields value={error}/>
 </section>
}
