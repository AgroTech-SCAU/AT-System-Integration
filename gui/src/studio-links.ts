import type {Workspace} from './types'

export type StudioLocation={
 page:Workspace
 workspaceId?:string
 section?:string
 taskId?:string
 machineId?:string
 stateId?:string
 treeId?:string
 subtreeId?:string
 nodeId?:string
 runId?:string
 field?:string
 robotId?:string
 returnTo?:StudioLocation
}

type LocationRequest=StudioLocation&{respond?:(accepted:boolean)=>void}
export function locateStudio(location:StudioLocation):Promise<boolean>{
 return new Promise(resolve=>window.dispatchEvent(new CustomEvent<LocationRequest>('agro:studio:locate',{detail:{...location,respond:resolve}})))
}
export function rememberStudioLocation(robotId:string,location:StudioLocation){
 sessionStorage.setItem('atil.studio.location.'+robotId+'.'+location.page,JSON.stringify(location))
}
export function takeStudioLocation(robotId:string|undefined,page:Workspace):StudioLocation|null{
 if(!robotId)return null
 const key='atil.studio.location.'+robotId+'.'+page
 try{const raw=sessionStorage.getItem(key);if(!raw)return null;sessionStorage.removeItem(key);const value=JSON.parse(raw);return value?.page===page?value:null}catch{sessionStorage.removeItem(key);return null}
}
