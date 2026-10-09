import {useState} from 'react'
import TaskSetup from './TaskSetup'
import TaskEditor from './TaskEditor'
import type {PageProps} from './shared'
import type {Workspace} from '../types'
import { guideCompleted } from '../guide/courses'


export default function TaskWorkspace(props:PageProps & {robotExampleId?:string|null;configured:boolean;onNavigate:(page:Workspace)=>void}){
  const [tab,setTab]=useState<'template'|'tree'>('tree')
  return <>
    <div className="task-workspace-switch" role="tablist" aria-label="任务编排视图">
      <button data-guide="task-tab-tree" role="tab" aria-selected={tab==='tree'} className={tab==='tree'?'active':''} onClick={()=>{setTab('tree');guideCompleted('task:tree-selected')}}>任务编辑</button>
      <button data-guide="task-tab-template" role="tab" aria-selected={tab==='template'} className={tab==='template'?'active':''} onClick={()=>{setTab('template');guideCompleted('task:template-selected')}}>可选示例库</button>
      <button className="task-run-shortcut" onClick={()=>props.onNavigate('runtime')}>运行调试 →</button>
    </div>
    <div data-guide="task-template-panel" hidden={tab!=='template'}><TaskSetup {...props} onOpenEditor={()=>setTab('tree')}/></div>
    <div hidden={tab!=='tree'}><TaskEditor {...props}/></div>
  </>
}
