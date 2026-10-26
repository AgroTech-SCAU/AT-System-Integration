import {useEffect,useState} from 'react'
import type {ApiClient} from '../api'
import type {RosTask} from './RosTaskLibrary'
import {useLocale} from '../locale'
import DisclosureCard from '../components/DisclosureCard'
import StudioSelect from '../components/StudioSelect'
import {ErrorFields,type Json} from './shared'

export default function TaskProvider({client,task,workspaces,interfaceWorkspaceIds,onChange}:{client:ApiClient;task:RosTask;workspaces:{id:string;name:string}[];interfaceWorkspaceIds?:string[];onChange:(value:Partial<RosTask>)=>void}){
 const {t}=useLocale(),[modules,setModules]=useState<Json[]>([]),[error,setError]=useState<unknown>(null)
 useEffect(()=>{let alive=true;const controller=new AbortController();const load=()=>{void client.request<Json>('/deployment/modules','GET',undefined,controller.signal).then(v=>{if(alive){setModules(v.modules);setError(null)}}).catch(cause=>{if(alive&&!controller.signal.aborted)setError(cause)})};load();window.addEventListener('agro:modules:changed',load);return()=>{alive=false;controller.abort();window.removeEventListener('agro:modules:changed',load)}},[client,task.workspace_ids?.join(',')])
 const available=workspaces.filter(v=>task.workspace_ids?.includes(v.id))
 const selected=modules.filter(v=>task.module_ids?.includes(v.id)),candidates=interfaceWorkspaceIds?.length?available.filter(v=>interfaceWorkspaceIds.includes(v.id)):available
 const workspace=available.find(v=>v.id===task.execution_workspace_id)||(candidates.length===1?candidates[0]:undefined)
 const endpointKind=['action','service'].includes(task.kind)?task.kind:'topic',providers=modules.filter(module=>available.some(v=>v.id===module.workspace_id)&&(module.provides||[]).some((endpoint:Json)=>endpoint.name===task.interface&&endpoint.kind===endpointKind&&(!endpoint.type||endpoint.type===task.ros_type)))
 const moduleSummary=selected.length?selected.map(v=>v.name).join(' · '):providers.length===1?providers[0].name:t('未手动选择时，按通信名称匹配唯一的提供模块')
 const providerIssue=task.kind!=='compute'&&(!workspace||task.startup_policy!=='external'&&!selected.length&&providers.length!==1)
 return <DisclosureCard title={t('执行子系统与启动模块')} summary={(workspace?.name||t('请选择执行子系统'))+' · '+(task.startup_policy==='external'?t('使用外部已启动的接口'):moduleSummary)} count={task.startup_policy==='external'?0:selected.length||(providers.length===1?1:0)} status={error||providerIssue?<span style={{color:'var(--red)'}}>{!workspace?t('请选择执行子系统'):providers.length>1&&!selected.length?t('多个模块提供同一接口'):t('配置待核对')}</span>:undefined}><p>{t('接口来源用于编辑参数，执行子系统决定通信依赖与节点环境')}</p><label className="field"><span>{t('执行子系统')}</span><StudioSelect value={task.execution_workspace_id||''} label={t('执行子系统')} onChange={execution_workspace_id=>onChange({execution_workspace_id,module_ids:[]})} options={[{value:'',label:t('按接口来源确定')},...available.map(v=>({value:v.id,label:v.name}))]}/></label><label className="field"><span>{t('启动管理')}</span><StudioSelect value={task.startup_policy||'managed'} label={t('启动管理')} options={[{value:'managed',label:t('由运行台准备所需模块')},{value:'external',label:t('使用外部已启动的接口')}]} onChange={startup_policy=>onChange({startup_policy:startup_policy as RosTask['startup_policy']})}/></label>
 {task.startup_policy!=='external'&&<div>{modules.filter(v=>available.some(w=>w.id===v.workspace_id)).map(v=><label className="toggle list-card" key={v.id}><input type="checkbox" checked={task.module_ids?.includes(v.id)||false} onChange={e=>onChange({module_ids:e.target.checked?[...(task.module_ids||[]),v.id]:(task.module_ids||[]).filter(id=>id!==v.id)})}/>{v.name}</label>)}<small>{t('未手动选择时，按通信名称匹配唯一的提供模块')}</small></div>}<ErrorFields value={error}/></DisclosureCard>
}
