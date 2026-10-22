import {motion} from 'motion/react'
import {springs, fade} from '../motion'
import {useLocale} from '../locale'
import {useRef,useState} from 'react'
import TaskEditor from './TaskEditor'
import StateMachineEditor from './StateMachineEditor'
import RosTaskLibrary from './RosTaskLibrary'
import {Icon} from '../components/Icon'
import type {PageProps} from './shared'
import type {Workspace} from '../types'
import './task-workspace.css'

type Surface='hsm'|'tree'|'ros'
type TaskRequest={kind:'ros'|'tree';reference?:string;stateId:string;stateLabel:string;phase:'entry'|'do'|'exit';machineId?:string}
const phases={entry:'进入',do:'持续',exit:'退出'}

export default function TaskWorkspace(props:PageProps & {robotExampleId?:string|null;configured:boolean;onNavigate:(page:Workspace)=>void}){
 const {t}=useLocale()

  const [tab,setTab]=useState<Surface>('hsm')
  const [context,setContext]=useState<TaskRequest|null>(null)
  const [requestKey,setRequestKey]=useState(0)
  const region=useRef<HTMLDivElement>(null)
  function select(next:Surface){
    if(tab===next)return
    if((tab==='tree'||tab==='ros')&&!window.dispatchEvent(new Event('agro:studio:leave-task',{cancelable:true})))return
    setTab(next);setContext(null)
    if(next==='hsm')window.dispatchEvent(new Event('agro:hsm:refresh'))
  }
  function openTask(request:TaskRequest){setContext(request);setRequestKey(key=>key+1);setTab(request.kind)}
  function bind(reference:string){
    if(!context)return
    window.dispatchEvent(new CustomEvent('agro:studio:bind',{detail:{stateId:context.stateId,phase:context.phase,reference,machineId:context.machineId}}))
    setTab('hsm');setContext(null)
    window.dispatchEvent(new Event('agro:hsm:refresh'))
  }
  function back(){
    if(!window.dispatchEvent(new Event('agro:studio:leave-task',{cancelable:true})))return
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
    {context&&<div className="studio-binding-context"><div className="studio-route"><button onClick={back} title={t("返回状态编排")}><Icon name="arrow-left"/>{t("状态编排")}</button><Icon name="chevron-right"/><span title={context.stateLabel}>{context.stateLabel}</span><Icon name="chevron-right"/><strong>{t(phases[context.phase])}</strong></div><span className="studio-binding-hint">{t("为当前状态阶段选择或创建任务")}</span></div>}
    <motion.div initial={false} animate={{opacity:tab==='hsm'?1:0,x:tab==='hsm'?0:-10}} transition={{...springs.spatial,opacity:fade}} className="studio-surface" hidden={tab!=='hsm'}><StateMachineEditor {...props} onOpenRos={()=>select('ros')} onOpenTask={openTask}/></motion.div>
    <motion.div initial={false} animate={{opacity:tab==='ros'?1:0,x:tab==='ros'?0:10}} transition={{...springs.spatial,opacity:fade}} className="studio-surface" hidden={tab!=='ros'}><RosTaskLibrary {...props} onCancelOpen={()=>{setTab('hsm');setContext(null)}} requestedTask={context?.kind==='ros'?context.reference:undefined} requestKey={context?.kind==='ros'?requestKey:undefined} contextLabel={context?.kind==='ros'?contextLabel:undefined} onBound={context?.kind==='ros'?bind:undefined} onBack={context?.kind==='ros'?back:undefined}/></motion.div>
    <motion.div initial={false} animate={{opacity:tab==='tree'?1:0,x:tab==='tree'?0:10}} transition={{...springs.spatial,opacity:fade}} className="studio-surface" hidden={tab!=='tree'}><TaskEditor {...props} requestedDefinition={context?.kind==='tree'?context.reference:undefined} requestKey={context?.kind==='tree'?requestKey:undefined} contextLabel={context?.kind==='tree'?contextLabel:undefined} onBound={context?.kind==='tree'?bind:undefined} onBack={context?.kind==='tree'?back:undefined}/></motion.div>
  </div>
}
