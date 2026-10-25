import {useEffect,useState} from 'react'
import type {ApiClient} from '../api'
import type {RosTask} from './RosTaskLibrary'
import {useLocale} from '../locale'
import StudioSelect from '../components/StudioSelect'
import {ErrorFields,type Json} from './shared'

export default function TaskProvider({client,task,workspaces,onChange}:{client:ApiClient;task:RosTask;workspaces:{id:string;name:string}[];onChange:(value:Partial<RosTask>)=>void}){
 const {t}=useLocale(),[modules,setModules]=useState<Json[]>([]),[error,setError]=useState<unknown>(null)
 useEffect(()=>{void client.request<Json>('/deployment/modules').then(v=>setModules(v.modules)).catch(setError)},[client,task.workspace_ids?.join(',')])
 const available=workspaces.filter(v=>task.workspace_ids?.includes(v.id))
 return <section className="ros-stop-message"><h3>{t('执行子系统与启动模块')}</h3><p>{t('接口来源用于编辑参数，执行子系统决定通信依赖与节点环境')}</p><label className="field"><span>{t('执行子系统')}</span><StudioSelect value={task.execution_workspace_id||''} label={t('执行子系统')} onChange={execution_workspace_id=>onChange({execution_workspace_id,module_ids:[]})} options={[{value:'',label:t('按接口来源确定')},...available.map(v=>({value:v.id,label:v.name}))]}/></label><label className="field"><span>{t('启动管理')}</span><StudioSelect value={task.startup_policy||'managed'} label={t('启动管理')} options={[{value:'managed',label:t('由运行台准备所需模块')},{value:'external',label:t('使用外部已启动的接口')}]} onChange={startup_policy=>onChange({startup_policy:startup_policy as RosTask['startup_policy']})}/></label>
 {task.startup_policy!=='external'&&<div>{modules.filter(v=>available.some(w=>w.id===v.workspace_id)).map(v=><label className="toggle" key={v.id}><input type="checkbox" checked={task.module_ids?.includes(v.id)||false} onChange={e=>onChange({module_ids:e.target.checked?[...(task.module_ids||[]),v.id]:(task.module_ids||[]).filter(id=>id!==v.id)})}/>{v.name}</label>)}<small>{t('未手动选择时，按通信名称匹配唯一的提供模块')}</small></div>}<ErrorFields value={error}/></section>
}
