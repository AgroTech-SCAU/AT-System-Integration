import {useEffect,useState} from 'react'
import TaskSetup from './TaskSetup'
import TaskEditor from './TaskEditor'
import StateMachineEditor from './StateMachineEditor'
import type {PageProps} from './shared'
import type {Workspace} from '../types'
import { guideCompleted } from '../guide/courses'


export default function TaskWorkspace(props:PageProps & {robotExampleId?:string|null;configured:boolean;onNavigate:(page:Workspace)=>void}){
  const [tab,setTab]=useState<'template'|'tree'|'hsm'>('hsm')
  useEffect(()=>{const hsm=()=>setTab('hsm'),tree=()=>setTab('tree'),template=()=>setTab('template');window.addEventListener('agro:guide:hsm',hsm);window.addEventListener('agro:guide:tree',tree);window.addEventListener('agro:guide:template',template);return()=>{window.removeEventListener('agro:guide:hsm',hsm);window.removeEventListener('agro:guide:tree',tree);window.removeEventListener('agro:guide:template',template)}},[])
  return <>
    <div className="task-workspace-switch" role="tablist" aria-label="任务编排视图">
      <button data-guide="task-tab-hsm" role="tab" aria-selected={tab==='hsm'} className={tab==='hsm'?'active':''} onClick={()=>{setTab('hsm');window.dispatchEvent(new Event('agro:hsm:refresh'));guideCompleted('task:hsm-selected')}}>层级状态机</button>
      <button data-guide="task-tab-tree" role="tab" aria-selected={tab==='tree'} className={tab==='tree'?'active':''} onClick={()=>{setTab('tree');guideCompleted('task:tree-selected')}}>行为树</button>
      <button data-guide="task-tab-template" role="tab" aria-selected={tab==='template'} className={tab==='template'?'active':''} onClick={()=>{setTab('template');guideCompleted('task:template-selected')}}>任务示例</button>
      <button className="task-run-shortcut" onClick={()=>props.onNavigate('runtime')}>运行调试 →</button>
    </div>
    <div hidden={tab!=='hsm'}><StateMachineEditor {...props}/></div>
    <div data-guide="task-template-panel" hidden={tab!=='template'}><TaskSetup {...props} onOpenEditor={()=>setTab('tree')}/></div>
    <div hidden={tab!=='tree'}><TaskEditor {...props}/></div>
  </>
}
