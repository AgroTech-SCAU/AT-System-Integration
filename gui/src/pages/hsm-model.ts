import type {HsmLayout} from './HsmCanvas'

export type Scalar = string | number | boolean | null | Scalar[] | {[key:string]:Scalar}
export type MachineState = {id:string;label:string;parent?:string;initial?:string;entry?:string;do?:string;exit?:string;bindings?:Partial<Record<'entry'|'do'|'exit',{inputs?:Record<string,string>;outputs?:Record<string,string>}>>}
export type Transition = {source:string;target:string;event:string;guard?:{operator:string;key?:string;value?:Scalar}}
export type MachineDocument = {initial:string;states:MachineState[];transitions:Transition[];variables:Record<string,Scalar>}
export type MachineSnapshot = {title:string;document:MachineDocument;layout:HsmLayout}
export type SavedMachine = {id:string;name:string;document:MachineDocument;layout?:HsmLayout;revision?:number;needs_tree_rebinding?:boolean}
export type Diagnostic = {message:string;stateId?:string;edgeIndex?:number}
export const isIdentifier=(value:string)=>/^[a-z][a-z0-9_]{0,63}$/.test(value)
export const activeStatus=(value?:string)=>['ENTERING','RUNNING','TRANSITIONING','STOPPING'].includes(value||'')
export const blankMachine=():MachineSnapshot=>({title:'我的状态机',document:{initial:'workflow',states:[{id:'workflow',label:'工作流程',initial:'idle'},{id:'idle',label:'待命',parent:'workflow'},{id:'working',label:'执行任务',parent:'workflow'},{id:'finished',label:'已完成',parent:'workflow'}],transitions:[{source:'idle',target:'working',event:'start'},{source:'working',target:'finished',event:'completed'},{source:'working',target:'idle',event:'failed'}],variables:{}},layout:{positions:{}}})
export const snapshotOf=(machine:SavedMachine):MachineSnapshot=>({title:machine.name,document:structuredClone(machine.document),layout:structuredClone(machine.layout||{positions:{}})})
export const fingerprint=(snapshot:MachineSnapshot)=>JSON.stringify(snapshot)

export function descendants(document:MachineDocument,id:string){
 const result=new Set([id])
 let added=true
 while(added){added=false;for(const state of document.states){if(state.parent&&result.has(state.parent)&&!result.has(state.id)){result.add(state.id);added=true}}}
 return result
}

export function canReparent(document:MachineDocument,child:string,parent:string){
 return child!==document.initial&&document.states.some(s=>s.id===parent)&&!descendants(document,child).has(parent)
}

export function normalizeInitials(document:MachineDocument):MachineDocument{
 return {...document,states:document.states.map(state=>{
  const children=document.states.filter(child=>child.parent===state.id)
  return {...state,initial:children.some(child=>child.id===state.initial)?state.initial:children[0]?.id}
 })}
}

export function diagnoseMachine(snapshot:MachineSnapshot,references:Set<string>):Diagnostic[]{
 const {document}=snapshot,issues:Diagnostic[]=[]
 if(!snapshot.title.trim())issues.push({message:'填写状态机名称'})
 if(document.states.length>48)issues.push({message:'状态数量不能超过 48 个'})
 if(document.transitions.length>160)issues.push({message:'转换数量不能超过 160 条'})
 const ids=new Set(document.states.map(s=>s.id))
 for(const state of document.states){
  const children=document.states.filter(s=>s.parent===state.id)
  if(!state.label.trim())issues.push({message:'为状态填写名称',stateId:state.id})
  if(children.length&&!children.some(s=>s.id===state.initial))issues.push({message:`${state.label} 需要初始子状态`,stateId:state.id})
  for(const phase of ['entry','do','exit'] as const){if(state[phase]&&!references.has(state[phase]!))issues.push({message:`${state.label} 的 ${phase==='entry'?'Entry':phase==='do'?'Do':'Exit'} 任务已不可用`,stateId:state.id});for(const mapping of Object.values(state.bindings?.[phase]||{})){for(const variable of Object.values(mapping)){if(!(variable in document.variables))issues.push({message:`${state.label} 的 ${phase} 绑定变量 ${variable} 已不存在`,stateId:state.id})}}}
 }
 const signatures=new Set<string>()
 document.transitions.forEach((edge,edgeIndex)=>{
  const signature=edge.source+':'+edge.event
  if(!isIdentifier(edge.event))issues.push({message:'事件标识需以小写字母开头，仅包含字母、数字和下划线',edgeIndex})
  if(signatures.has(signature))issues.push({message:`同一状态的 ${edge.event} 事件存在重复转换`,edgeIndex})
  signatures.add(signature)
  if(!ids.has(edge.source)||!ids.has(edge.target))issues.push({message:'转换连接的状态不存在',edgeIndex})
  if(edge.guard?.operator&&edge.guard.operator!=='always'){
   if(!edge.guard.key||!(edge.guard.key in document.variables))issues.push({message:`${edge.event||'转换'} 需要选择有效变量`,edgeIndex})
   if(['greater','less'].includes(edge.guard.operator)&&(typeof document.variables[edge.guard.key||'']!=='number'||typeof edge.guard.value!=='number'))issues.push({message:`${edge.event||'转换'} 的大小比较需要数值变量和数值比较值`,edgeIndex})
  }
 })
 for(const [name,value] of Object.entries(document.variables))if(typeof value==='number'&&!Number.isFinite(value))issues.push({message:`变量 ${name} 需要有效数值`})
 return issues
}
