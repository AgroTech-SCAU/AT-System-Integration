import {useEffect,useRef,useState} from 'react'
import TaskEditor from './TaskEditor'
import StateMachineEditor from './StateMachineEditor'
import RosTaskLibrary from './RosTaskLibrary'
import {Icon} from '../components/Icon'
import type {PageProps} from './shared'
import type {Workspace} from '../types'
import {guideCompleted} from '../guide/courses'

type Surface='hsm'|'tree'|'ros'
type TaskRequest={kind:'ros'|'tree';reference?:string;stateId:string;stateLabel:string;phase:'entry'|'do'|'exit';machineId?:string}
const phases={entry:'进入',do:'持续',exit:'退出'}

export default function TaskWorkspace(props:PageProps & {robotExampleId?:string|null;configured:boolean;onNavigate:(page:Workspace)=>void}){
  const [tab,setTab]=useState<Surface>('hsm')
  const [context,setContext]=useState<TaskRequest|null>(null)
  const [requestKey,setRequestKey]=useState(0)
  const region=useRef<HTMLDivElement>(null)
  function select(next:Surface){
    if(tab===next)return
    if((tab==='tree'||tab==='ros')&&!window.dispatchEvent(new Event('agro:studio:leave-task',{cancelable:true})))return
    setTab(next);setContext(null)
    if(next==='hsm')window.dispatchEvent(new Event('agro:hsm:refresh'))
    if(next==='tree'||next==='hsm')guideCompleted(`task:${next}-selected`)
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
  useEffect(()=>{
    const hsm=()=>select('hsm'),tree=()=>select('tree')
    window.addEventListener('agro:guide:hsm',hsm);window.addEventListener('agro:guide:tree',tree)
    return()=>{window.removeEventListener('agro:guide:hsm',hsm);window.removeEventListener('agro:guide:tree',tree)}
  },[tab])
  const contextLabel=context?`${context.stateLabel} / ${phases[context.phase]}`:undefined
  return <div className="studio-workspace" ref={region}>
    <div className="studio-location">
      {context?<div className="studio-route"><button onClick={back} title="返回状态编排"><Icon name="arrow-left"/>状态编排</button><Icon name="chevron-right"/><span>{context.stateLabel}</span><Icon name="chevron-right"/><strong>{phases[context.phase]}</strong></div>:<nav className="studio-sections" aria-label="编排工作区">
        <button data-guide="task-tab-hsm" aria-current={tab==='hsm'?'page':undefined} onClick={()=>select('hsm')}><Icon name="git-branch"/>状态编排</button>
        <button data-guide="task-tab-tree" aria-current={tab==='tree'?'page':undefined} onClick={()=>select('tree')}><Icon name="network"/>行为树</button>
        <button onClick={()=>props.onNavigate('system')}><Icon name="network"/>任务库</button>
      </nav>}
      <div className="studio-location-end"><button className="studio-run-link" onClick={()=>props.onNavigate('runtime')} title="打开运行台"><Icon name="play"/>运行台</button></div>
    </div>
    <div className="studio-surface" hidden={tab!=='hsm'}><StateMachineEditor {...props} onOpenRos={()=>select('ros')} onOpenTask={openTask}/></div>
    <div className="studio-surface" hidden={tab!=='ros'}><RosTaskLibrary {...props} onCancelOpen={()=>{setTab('hsm');setContext(null)}} requestedTask={context?.kind==='ros'?context.reference:undefined} requestKey={context?.kind==='ros'?requestKey:undefined} contextLabel={context?.kind==='ros'?contextLabel:undefined} onBound={context?.kind==='ros'?bind:undefined} onBack={context?.kind==='ros'?back:undefined}/></div>
    <div className="studio-surface" hidden={tab!=='tree'}><TaskEditor {...props} requestedDefinition={context?.kind==='tree'?context.reference:undefined} requestKey={context?.kind==='tree'?requestKey:undefined} contextLabel={context?.kind==='tree'?contextLabel:undefined} onBound={context?.kind==='tree'?bind:undefined} onBack={context?.kind==='tree'?back:undefined}/></div>
  </div>
}
