import {useState} from 'react'
import TaskSetup from './TaskSetup'
import TaskEditor from './TaskEditor'
import type {PageProps} from './shared'
import { guideCompleted } from '../guide/courses'


export default function TaskWorkspace(props:PageProps){
  const [tab,setTab]=useState<'template'|'tree'>('template')
  return <>
    <div className="task-workspace-switch" role="tablist" aria-label="任务编排视图">
      <button data-guide="task-tab-template" role="tab" aria-selected={tab==='template'} className={tab==='template'?'active':''} onClick={()=>setTab('template')}>任务模板</button>
      <button data-guide="task-tab-tree" role="tab" aria-selected={tab==='tree'} className={tab==='tree'?'active':''} onClick={()=>{setTab('tree');guideCompleted('task:tree-selected')}}>行为树编辑</button>
    </div>
    <div data-guide="task-template-panel" hidden={tab!=='template'}><TaskSetup {...props} onOpenEditor={()=>setTab('tree')}/></div>
    <div hidden={tab!=='tree'}><TaskEditor {...props}/></div>
  </>
}
