import {useLocale} from '../locale'
import type {InterfaceIssue} from './InterfaceWorkspacePicker'

export default function InterfaceIssues({issues,expanded=false}:{issues:InterfaceIssue[];expanded?:boolean}){
  const {t}=useLocale()
  const groups=new Map<string,{issue:InterfaceIssue;affected:Set<string>}>()
  for(const issue of issues){
    const key=issue.code+':'+(issue.dependency||issue.reason)
    const group=groups.get(key)||{issue,affected:new Set<string>()}
    if(issue.ros_type)group.affected.add(issue.ros_type)
    groups.set(key,group)
  }
  if(!groups.size)return null
  return <details className="ros-interface-issues iw-issues" open={expanded||undefined}>
    <summary>{t('有 {0} 项接口定义需要补充',{0:groups.size})}</summary>
    {[...groups].map(([key,{issue,affected}])=><div className="iw-issue" key={key}>
      {issue.dependency?<><strong>{t(issue.code==='ambiguous_dependency'?'依赖存在不同定义':'未找到依赖定义')}</strong><code>{issue.dependency}</code><p>{t(issue.code==='ambiguous_dependency'?'在任务中选择提供此接口的工作区，以明确使用的来源':'检查基础 ROS 接口来源，或添加包含此依赖的子系统工作区')}</p></>:<p>{t(issue.reason)}</p>}
      {affected.size>0&&<details><summary>{t('影响 {0} 个接口',{0:affected.size})}</summary>{[...affected].map(name=><code key={name}>{name}</code>)}</details>}
    </div>)}
  </details>
}
