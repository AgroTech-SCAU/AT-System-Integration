import {useLocale} from '../locale'
import DisclosureCard from '../components/DisclosureCard'
import type {InterfaceIssue} from './InterfaceWorkspacePicker'

export default function InterfaceIssues({issues,expanded:_expanded=false}:{issues:InterfaceIssue[];expanded?:boolean}){
 const {t}=useLocale()
 const groups=new Map<string,{issue:InterfaceIssue;affected:Set<string>}>()
 for(const issue of issues){
  const key=issue.code+':'+(issue.dependency||issue.reason)
  const group=groups.get(key)||{issue,affected:new Set<string>()}
  if(issue.ros_type)group.affected.add(issue.ros_type)
  groups.set(key,group)
 }
 if(!groups.size)return null
 return <DisclosureCard title={t('待补充的接口定义')} count={groups.size} status={<span className="iw-pending">{t('有 {0} 项接口定义需要补充',{0:groups.size})}</span>} className="iw-issues">
  {[...groups].map(([key,{issue,affected}])=><DisclosureCard key={key} title={issue.dependency?<code>{issue.dependency}</code>:t(issue.reason)} summary={issue.dependency?t(issue.code==='ambiguous_dependency'?'依赖存在不同定义':'未找到依赖定义'):undefined} count={affected.size||undefined}>
   {issue.dependency&&<p>{t(issue.code==='ambiguous_dependency'?'在任务中选择提供此接口的工作区，以明确使用的来源':'检查基础 ROS 接口来源，或添加包含此依赖的子系统工作区')}</p>}
   {affected.size>0&&<div className="iw-affected-types">{[...affected].map(name=><code key={name}>{name}</code>)}</div>}
  </DisclosureCard>)}
 </DisclosureCard>
}
