import {useState} from 'react'
import TaskSetup from './TaskSetup'
import TaskEditor from './TaskEditor'
import type {PageProps} from './shared'


export default function TaskWorkspace(props:PageProps){
  const [tab,setTab]=useState<'template'|'tree'>('template')
  return <>
    <div className="task-workspace-switch" role="tablist" aria-label="任务编排视图">
      <button role="tab" aria-selected={tab==='template'} className={tab==='template'?'active':''} onClick={()=>setTab('template')}>任务模板</button>
      <button role="tab" aria-selected={tab==='tree'} className={tab==='tree'?'active':''} onClick={()=>setTab('tree')}>行为树编辑</button>
    </div>
    <div hidden={tab!=='template'}><TaskSetup {...props} onOpenEditor={()=>setTab('tree')}/></div>
    <div hidden={tab!=='tree'}><TaskEditor {...props}/></div>
  </>
}
