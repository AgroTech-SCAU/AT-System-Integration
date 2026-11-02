import {requestNavigation} from '../components/StudioDialogs'
import {motion} from 'motion/react'
import {springs, fade} from '../motion'
import {useLocale} from '../locale'
import {useEffect,useRef,useState} from 'react'
import TaskEditor from './TaskEditor'
import StateMachineEditor from './StateMachineEditor'
import RosTaskLibrary from './RosTaskLibrary'
import {Icon} from '../components/Icon'
import type {PageProps} from './shared'
import type {Workspace} from '../types'
import './task-workspace.css'
import {takeStudioLocation,type StudioLocation} from '../studio-links'

type Surface='hsm'|'tree'|'ros'
type TaskRequest={kind:'ros'|'tree';reference?:string;stateId:string;stateLabel:string;phase:'entry'|'do'|'exit';machineId?:string}
const phases={entry:'进入',do:'持续',exit:'退出'}

type Props=PageProps & {robotId?:string;robotExampleId?:string|null;configured:boolean;onNavigate:(page:Workspace)=>void}
export default function TaskWorkspace(props:Props){return <TaskWorkspaceContent key={props.robotId||'none'} {...props}/>}
function TaskWorkspaceContent(props:Props){
 const {t}=useLocale()
  const storageKey='atil.composer.'+(props.robotId||'none')
  const [restored]=useState<{tab?:Surface;context?:TaskRequest|null;requestKey?:number}>(()=>{try{return JSON.parse(sessionStorage.getItem(storageKey)||'{}')}catch{return {}}})
  const [tab,setTab]=useState<Surface>(['hsm','tree','ros'].includes(restored.tab||'')?restored.tab!:'hsm')
  const [context,setContext]=useState<TaskRequest|null>(restored.context||null)
  const [requestKey,setRequestKey]=useState(restored.requestKey||0)
  const [browseKey,setBrowseKey]=useState(0)
  const [studioLocation,setStudioLocation]=useState<StudioLocation|null>(null)
  const region=useRef<HTMLDivElement>(null)
  useEffect(()=>{sessionStorage.setItem(storageKey,JSON.stringify({tab,context,requestKey}))},[storageKey,tab,context,requestKey])
  useEffect(()=>{
    const accept=(location:StudioLocation|null)=>{
      if(!location||location.page!=='editor'||location.robotId&&location.robotId!==props.robotId)return
      setStudioLocation(location)
      if(location.taskId||['provider','communication','message','ports'].includes(location.section||'')){setContext(previous=>previous?.kind==='ros'&&previous.stateId&&(!previous.reference||!location.taskId||previous.reference.replace(/^ros:/,'')===location.taskId)?{...previous,reference:location.taskId||previous.reference}:{kind:'ros',reference:location.taskId,stateId:'',stateLabel:'',phase:'do'});setRequestKey(key=>key+1);setTab('ros')}
      else if(location.treeId){setContext(null);setTab('tree')}
      else if(location.machineId){setContext(null);setTab('hsm')}
    }
    accept(takeStudioLocation(props.robotId,'editor'))
    const locate=(event:Event)=>{const location=(event as CustomEvent<StudioLocation>).detail;if(location.page==='editor'){takeStudioLocation(props.robotId,'editor');accept(location)}}
    window.addEventListener('agro:studio:located',locate)
    return()=>window.removeEventListener('agro:studio:located',locate)
  },[props.robotId])
  async function select(next:Surface){
    if(tab===next){if(next==='tree'){setContext(null);setBrowseKey(key=>key+1)}return}
    if((tab==='tree'||tab==='ros')&&!await requestNavigation('agro:studio:leave-task'))return
    setTab(next);setContext(null)
    if(next==='tree')setBrowseKey(key=>key+1)
    if(next==='hsm')window.dispatchEvent(new Event('agro:hsm:refresh'))
  }
  function openTask(request:TaskRequest){setContext(request);setRequestKey(key=>key+1);setTab(request.kind)}
  function bind(reference:string){
    if(!context)return
    window.dispatchEvent(new CustomEvent('agro:studio:bind',{detail:{stateId:context.stateId,phase:context.phase,reference,machineId:context.machineId}}))
    setTab('hsm');setContext(null)
    window.dispatchEvent(new Event('agro:hsm:refresh'))
  }
  async function back(){
    if(!await requestNavigation('agro:studio:leave-task'))return
    setTab('hsm');setContext(null)
  }
  const contextLabel=context?`${context.stateLabel} / ${t(phases[context.phase])}`:undefined
  return <div className="studio-workspace" ref={region}>
    <div className="studio-location">
      <nav className="studio-sections" aria-label={t("编排工作区")}>
        <button aria-current={tab==='hsm'?'page':undefined} onClick={()=>select('hsm')}>{tab==='hsm'&&<motion.span className="workspace-selection" layoutId="composer-tab" transition={springs.quick}/>}<Icon name="git-branch"/>{t("状态编排")}</button>
        <button aria-current={tab==='tree'?'page':undefined} onClick={()=>select('tree')}>{tab==='tree'&&<motion.span className="workspace-selection" layoutId="composer-tab" transition={springs.quick}/>}<Icon name="network"/>{t("行为树")}</button>
        <button aria-current={tab==='ros'?'page':undefined} onClick={()=>select('ros')}>{tab==='ros'&&<motion.span className="workspace-selection" layoutId="composer-tab" transition={springs.quick}/>}<Icon name="boxes"/>{t("任务库")}</button>
      </nav>
      <div className="studio-location-end"><button className="studio-run-link" onClick={()=>props.onNavigate('runtime')} title={t("打开运行台")}><Icon name="play"/>{t("运行台")}</button></div>
    </div>
    {context?.stateId&&<div className="studio-binding-context"><div className="studio-route"><button onClick={back} title={t("返回状态编排")}><Icon name="arrow-left"/>{t("状态编排")}</button><Icon name="chevron-right"/><span title={context.stateLabel}>{context.stateLabel}</span><Icon name="chevron-right"/><strong>{t(phases[context.phase])}</strong></div><span className="studio-binding-hint">{t("为当前状态阶段选择或创建任务")}</span></div>}
    <motion.div initial={false} animate={{opacity:tab==='hsm'?1:0,x:tab==='hsm'?0:-10}} transition={{...springs.spatial,opacity:fade}} className="studio-surface" hidden={tab!=='hsm'}><StateMachineEditor {...props} studioLocation={studioLocation?.machineId?studioLocation:undefined} onOpenRos={()=>select('ros')} onOpenTask={openTask}/></motion.div>
    <motion.div initial={false} animate={{opacity:tab==='ros'?1:0,x:tab==='ros'?0:10}} transition={{...springs.spatial,opacity:fade}} className="studio-surface" hidden={tab!=='ros'}><RosTaskLibrary {...props} requestedSection={studioLocation?.section} requestedField={studioLocation?.field} onCancelOpen={()=>{setTab('hsm');setContext(null)}} requestedTask={context?.kind==='ros'?context.reference:undefined} requestKey={context?.kind==='ros'?requestKey:undefined} contextLabel={context?.kind==='ros'&&context.stateId?contextLabel:undefined} onBound={context?.kind==='ros'&&context.stateId?bind:undefined} onBack={context?.kind==='ros'&&context.stateId?back:undefined}/></motion.div>
    <motion.div initial={false} animate={{opacity:tab==='tree'?1:0,x:tab==='tree'?0:10}} transition={{...springs.spatial,opacity:fade}} className="studio-surface" hidden={tab!=='tree'}><TaskEditor {...props} studioLocation={studioLocation?.treeId?studioLocation:undefined} browseKey={browseKey} requestedDefinition={context?.kind==='tree'?context.reference:undefined} requestKey={context?.kind==='tree'?requestKey:undefined} owner={context?.kind==='tree'?{machine_id:context.machineId,state_id:context.stateId,phase:context.phase}:undefined} contextLabel={context?.kind==='tree'?contextLabel:undefined} onRememberReference={reference=>setContext(previous=>previous?.kind==='tree'?{...previous,reference}:previous)} onBound={context?.kind==='tree'?bind:undefined} onBack={context?.kind==='tree'?back:undefined}/></motion.div>
  </div>
}
