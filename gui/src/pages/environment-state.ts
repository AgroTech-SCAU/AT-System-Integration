export type EnvironmentStatus='reading'|'loaded'|'checked'|'automatic'|'modified'|'missing_setup'|'missing_python'|'failed'
export type EnvironmentState={
 setup:string
 setup_candidates?:string[]
 candidates:string[]
 loaded:boolean
 active:null|{workspace_id:string;name:string;python:string;setup:string}
 report:null|{ready:boolean;setup:string;python:string;reason:string;missing:string;interface_count?:number;prefixes?:string[]}
}

// Match the environment the backend will actually select, rather than unsaved editor values
export function runtimeEnvironment(state:EnvironmentState|null){
 return {setup:state?.active?.setup||state?.setup||'',python:state?.active?.python||state?.report?.python||state?.candidates[0]||''}
}

export function environmentReadiness(state:EnvironmentState|null,draft:{setup:string;python:string},error=''){
 const runtime=runtimeEnvironment(state)
 const selectionPending=!!state&&(draft.setup!==runtime.setup||draft.python!==runtime.python)
 const report=state?.report?.setup===runtime.setup&&state.report.python===runtime.python?state.report:null
 let status:EnvironmentStatus='reading',problem=error
 if(error)status='failed'
 else if(state){
  if(state.active&&!state.loaded){status='failed';problem='已保存的执行环境已变化，请重新检查并加载'}
  else if(!state.active&&!runtime.setup){status='missing_setup';problem='没有找到已构建的安装环境，请选择 setup 文件'}
  else if(!state.active&&(!runtime.python||!state.candidates.includes(runtime.python))){status='missing_python';problem='没有找到可用的 Python，请选择可执行文件'}
  else if(!state.active&&report&&!report.ready){status='failed';problem=report.reason}
  else if(selectionPending)status='modified'
  else if(state.active)status='loaded'
  else status=report?.ready?'checked':'automatic'
 }
 return {...runtime,status,problem,selectionPending,loaded:status==='loaded',checked:status==='checked',automatic:status==='automatic'||status==='checked',reading:status==='reading'}
}
