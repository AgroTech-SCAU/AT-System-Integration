import {useEffect,useState} from 'react'
import type {ApiClient} from '../api'
import {useLocale} from '../locale'
import {ErrorFields} from './shared'

type Binding={task_id:string;name:string;interface:string;ros_type:string;kind:string}

export default function RobotBindings({client}:{client:ApiClient}){
 const {t:translate}=useLocale()
 const [bindings,setBindings]=useState<Binding[]>([]),[busy,setBusy]=useState(''),[error,setError]=useState<unknown>(null),[saved,setSaved]=useState('')
 useEffect(()=>{
  let active=true
  void client.request<{bindings:Binding[]}>('/ros/bindings').then(result=>{if(active)setBindings(result.bindings)}).catch(cause=>{if(active)setError(cause)})
  return()=>{active=false}
 },[client])
 async function save(binding:Binding){
  setBusy(binding.task_id);setError(null);setSaved('')
  try{await client.request('/ros/bindings/'+binding.task_id,'PUT',{interface:binding.interface.trim()});setSaved(binding.task_id)}catch(cause){setError(cause)}finally{setBusy('')}
 }
 return <section className="robot-bindings"><h2>{translate('任务端点绑定')}</h2><p>{translate('将可复用任务连接到这台机器人的实际话题、服务或 Action')}</p>
  {bindings.map(binding=><div className="robot-binding-row" key={binding.task_id}><div><strong>{binding.name}</strong><small>{binding.ros_type||translate('类型尚未选择')}</small></div><input aria-label={translate('{0} 的端点',{0:binding.name})} value={binding.interface} placeholder={translate('填写实际端点名称')} onChange={event=>{setBindings(previous=>previous.map(item=>item.task_id===binding.task_id?{...item,interface:event.target.value}:item));setSaved('')}}/><button disabled={!!busy} onClick={()=>void save(binding)}>{busy===binding.task_id?translate('保存中'):saved===binding.task_id?translate('已保存'):translate('保存绑定')}</button></div>)}
  {!bindings.length&&<p>{translate('在任务库创建能力后，可在此配置实际端点')}</p>}
  <ErrorFields value={error}/>
 </section>
}
