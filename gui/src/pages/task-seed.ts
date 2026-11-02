import {locateStudio,type StudioLocation} from '../studio-links'
import type {OfflineEndpoint} from './OfflineCommunications'
import type {WorkspaceInterface} from './InterfaceWorkspacePicker'
import type {RosTask} from './RosTaskLibrary'

export type CommunicationTaskKind=Exclude<RosTask['kind'],'compute'>
export type TaskSeed={robotId:string;page?:'system'|'editor';name:string;kind:CommunicationTaskKind;interface:string;ros_type:string;workspace_ids?:string[];execution_workspace_id?:string;module_ids?:string[];schema_id?:string}
const key='atil.task.seed'
const communicationKinds:CommunicationTaskKind[]=['action','service','publish_once','publish_periodic','subscribe_wait']

export function offlineTaskIssue(endpoint:OfflineEndpoint){
 if(endpoint.status==='conflict')return endpoint.reason||'通信声明存在冲突，解决后才能创建任务'
 if(endpoint.status!=='resolved'||!endpoint.name.trim())return endpoint.reason||'通信名称尚未解析，请先补充解析参数'
 if(!endpoint.ros_type.trim())return '接口类型尚未确认，无法创建任务'
 return ''
}

export function offlineTaskSeed({robotId,page,workspaceId,endpoint,kind,moduleId,types}:{robotId:string;page:'system'|'editor';workspaceId:string;endpoint:OfflineEndpoint;kind:CommunicationTaskKind;moduleId?:string;types:WorkspaceInterface[]}):TaskSeed|null{
 if(offlineTaskIssue(endpoint)||(endpoint.kind==='topic'?!['publish_once','publish_periodic','subscribe_wait'].includes(kind):kind!==endpoint.kind))return null
 const definitions=types.filter(item=>item.ros_type===endpoint.ros_type)
 const schema=definitions.length===1&&definitions[0].available===true&&definitions[0].workspace_ids.length===1&&definitions[0].workspace_ids[0]===workspaceId?definitions[0].schema_id:undefined
 const providerRole=endpoint.kind==='topic'?(kind==='subscribe_wait'?'publisher':'subscriber'):'server'
 const provider=moduleId&&endpoint.role===providerRole?moduleId:undefined
 return {robotId,page,name:endpoint.name.split('/').filter(Boolean).at(-1)||endpoint.name,kind,interface:endpoint.name,ros_type:endpoint.ros_type,workspace_ids:[workspaceId],execution_workspace_id:workspaceId,...(provider?{module_ids:[provider]}:{}),...(schema?{schema_id:schema}:{})}
}

export function readTaskSeed(robotId:string|undefined,page:'system'|'editor'):{raw:string;task:TaskSeed}|null{
 if(!robotId)return null
 const raw=sessionStorage.getItem(key)
 if(!raw)return null
 try{
  const task=JSON.parse(raw) as TaskSeed
  if(task.robotId!==robotId||(task.page||'system')!==page)return null
  if(!communicationKinds.includes(task.kind)||typeof task.name!=='string'||typeof task.interface!=='string'||typeof task.ros_type!=='string'){clearTaskSeed(raw);return null}
  return {raw,task}
 }catch{clearTaskSeed(raw);return null}
}

export function clearTaskSeed(raw:string){if(sessionStorage.getItem(key)===raw)sessionStorage.removeItem(key)}

export async function openTaskSeed(task:TaskSeed,location:StudioLocation){
 const previous=sessionStorage.getItem(key),raw=JSON.stringify(task)
 sessionStorage.setItem(key,raw)
 const accepted=await locateStudio(location)
 if(!accepted&&sessionStorage.getItem(key)===raw){if(previous===null)sessionStorage.removeItem(key);else sessionStorage.setItem(key,previous)}
 return accepted
}
