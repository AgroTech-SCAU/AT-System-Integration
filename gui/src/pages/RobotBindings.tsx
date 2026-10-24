import {useEffect,useState} from 'react'
import type {ApiClient} from '../api'
import {useLocale} from '../locale'
import {ErrorFields} from './shared'
import {deferNavigation,unsavedDialog} from '../components/StudioDialogs'

type Binding={task_id:string;name:string;interface:string;ros_type:string;kind:string}
type Endpoint={name:string;types:string[];kind:'topic'|'service'|'action'}
export default function RobotBindings({client,available=[]}:{client:ApiClient;available?:Endpoint[]}){
 const {t}=useLocale()
 const [bindings,setBindings]=useState<Binding[]>([]),[saved,setSaved]=useState<Record<string,string>>({})
 const [busy,setBusy]=useState(''),[error,setError]=useState<unknown>(null)
 useEffect(()=>{let active=true;void client.request<{bindings:Binding[]}>('/ros/bindings').then(result=>{if(active){setBindings(result.bindings);setSaved(Object.fromEntries(result.bindings.map(item=>[item.task_id,item.interface])))}}).catch(cause=>{if(active)setError(cause)});return()=>{active=false}},[client])
 async function save(binding:Binding){
  setBusy(binding.task_id);setError(null)
  try{await client.request('/ros/bindings/'+binding.task_id,'PUT',{interface:binding.interface.trim()});setSaved(previous=>({...previous,[binding.task_id]:binding.interface.trim()}));setBindings(previous=>previous.map(item=>item.task_id===binding.task_id?{...item,interface:binding.interface.trim()}:item));return true}catch(cause){setError(cause);return false}finally{setBusy('')}
 }
 useEffect(()=>{
  const leave=(event:Event)=>{const changes=bindings.filter(item=>item.interface!==saved[item.task_id]);if(changes.length)deferNavigation(event,()=>unsavedDialog(t('任务通信配置'),async()=>{for(const item of changes)if(!await save(item))return false;return true},()=>setBindings(previous=>previous.map(item=>({...item,interface:saved[item.task_id]||''})))))}
  window.addEventListener('agro:navigate',leave);window.addEventListener('agro:robot:leave-bindings',leave)
  return()=>{window.removeEventListener('agro:navigate',leave);window.removeEventListener('agro:robot:leave-bindings',leave)}
 },[bindings,saved])
 return <section className="robot-bindings"><h2>{t('任务通信配置')}</h2><p>{t('为每个任务指定实际使用的话题、服务或 Action 名称，可离线填写')}</p>
  {bindings.map(binding=>{const value=binding.interface.trim(),invalid=!!value&&(!value.startsWith('/')||value.includes(' ')||value.length>240);const kind=binding.kind==='action'?'action':binding.kind==='service'?'service':'topic',label=kind==='action'?'Action 名称':kind==='service'?'服务名称':'话题名称';return <div className="robot-binding-row" key={binding.task_id}><div><strong>{binding.name}</strong><span className="binding-kind">{t(kind==='action'?'执行 Action 目标':kind==='service'?'调用 Service 服务':binding.kind==='publish_once'?'发布一次话题消息':binding.kind==='publish_periodic'?'持续发布话题消息':'等待话题消息')}</span><small>{binding.ros_type||t('类型尚未选择')}</small></div><label className="field"><span>{t(label)}</span><input disabled={!!busy} aria-invalid={invalid} aria-describedby={invalid?'binding-error-'+binding.task_id:undefined} aria-label={binding.name+' · '+t(label)} value={binding.interface} placeholder={kind==='action'?'/arm/move':kind==='service'?'/device/enable':'/sensor/data'} list={'binding-'+binding.task_id} onChange={event=>setBindings(previous=>previous.map(item=>item.task_id===binding.task_id?{...item,interface:event.target.value}:item))}/><datalist id={'binding-'+binding.task_id}>{available.filter(item=>item.kind===kind&&item.types.includes(binding.ros_type)).map(item=><option key={item.name} value={item.name}/>)}</datalist>{invalid&&<small className="ros-invalid" id={'binding-error-'+binding.task_id}>{t('填写以 / 开头的 ROS 2 接口名称')}</small>}</label><button disabled={!!busy||binding.interface===saved[binding.task_id]} onClick={()=>void save(binding)}>{t(busy===binding.task_id?'保存中':binding.interface===saved[binding.task_id]?'已保存':'保存')}</button></div>})}
  {!bindings.length&&<p>{t('先在任务库创建任务，再配置它实际使用的通信名称')}</p>}
  <ErrorFields value={error}/>
 </section>
}
