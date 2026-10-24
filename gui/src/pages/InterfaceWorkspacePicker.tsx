import {useState} from 'react'
import {AnimatePresence} from 'motion/react'
import {AnchoredPopover} from '../components/AnchoredPopover'
import {Icon} from '../components/Icon'
import {useLocale} from '../locale'

export type InterfaceIssue={code:string;reason:string;ros_type?:string}
export type InterfaceWorkspace={id:string;name:string;mode:'source'|'installed'|'files';path:string;interface_count:number;diagnostics:InterfaceIssue[];conflicts_with:{id:string;name:string;types:string[]}[];used_by:number}
export type WorkspaceInterface={ros_type:string;schema_id:string;source:string;workspace_ids:string[];dependency?:boolean}
export type WorkspaceResolution={workspace_ids:string[];types:WorkspaceInterface[];conflicts:{ros_type:string;workspace_ids:string[];workspace_names:string[]}[];diagnostics:InterfaceIssue[]}

export default function InterfaceWorkspacePicker({workspaces,value,onChange,onManage,disabled}:{workspaces:InterfaceWorkspace[];value:string[];onChange:(value:string[])=>void;onManage?:()=>void;disabled?:boolean}){
  const {t}=useLocale()
  const [anchor,setAnchor]=useState<HTMLButtonElement|null>(null),[query,setQuery]=useState('')
  const selected=workspaces.filter(item=>value.includes(item.id))
  return <div className="iw-picker"><div className="iw-picker-label"><span>{t('子系统 ROS2 工作区')}</span>{onManage&&<button type="button" onClick={onManage}>{t('管理子系统 ROS2 工作区')}<Icon name="chevron-right"/></button>}</div>
    <button type="button" disabled={disabled} className="ros-select-trigger iw-picker-trigger" aria-label={t('选择子系统 ROS2 工作区')} aria-haspopup="dialog" aria-expanded={!!anchor} onClick={event=>setAnchor(anchor?null:event.currentTarget)}><span>{selected.length?selected.map(item=>item.name).join(' · '):t('选择工作区，可多选')}</span><Icon name="chevron-down"/></button>
    <AnimatePresence>{anchor&&<AnchoredPopover anchor={anchor} role="dialog" label={t('选择子系统 ROS2 工作区')} align="start" className="iw-picker-popover" onClose={()=>setAnchor(null)}><div className="ros-search"><Icon name="search"/><input autoFocus value={query} aria-label={t('搜索子系统 ROS2 工作区')} placeholder={t('搜索子系统 ROS2 工作区')} onChange={event=>setQuery(event.target.value)}/></div><div className="iw-picker-options">{workspaces.filter(item=>item.name.toLowerCase().includes(query.toLowerCase())).map(item=>{
      const checked=value.includes(item.id),conflict=item.conflicts_with.filter(other=>value.includes(other.id)),blocked=!checked&&conflict.length>0
      return <label key={item.id} className={'iw-picker-option'+(blocked?' is-unavailable':'')} title={blocked?conflict.map(other=>other.name+' · '+other.types.join(', ')).join('\n'):item.path}><input type="checkbox" checked={checked} disabled={blocked} onChange={()=>onChange(checked?value.filter(id=>id!==item.id):[...value,item.id])}/><span><strong>{item.name}</strong><small>{blocked?t('与 {0} 冲突',{0:conflict.map(other=>other.name).join(' · ')}):t('{0} 个接口',{0:item.interface_count})}</small>{blocked&&<small className="iw-conflict-types">{conflict.flatMap(other=>other.types).join(' · ')}</small>}</span>{item.diagnostics.length>0&&!blocked&&<span className="iw-pending">{t('待补充')}</span>}</label>
    })}{!workspaces.length&&<p className="iw-list-empty">{t('先在机器人中添加子系统 ROS2 工作区')}</p>}</div><footer><span>{t('已选择 {0} 个工作区',{0:value.length})}</span><button type="button" onClick={()=>setAnchor(null)}>{t('完成')}</button></footer></AnchoredPopover>}</AnimatePresence>
  </div>
}
