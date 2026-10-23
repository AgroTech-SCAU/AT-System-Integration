import type {Translator} from '../locale'
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
export const blankMachine=(t:(text:string)=>string=text=>text):MachineSnapshot=>({title:t("我的状态机"),document:{initial:'workflow',states:[{id:'workflow',label:t("工作流程")}],transitions:[],variables:{}},layout:{positions:{}}})
export const snapshotOf=(machine:SavedMachine):MachineSnapshot=>({title:machine.name,document:structuredClone(machine.document),layout:structuredClone(machine.layout||{positions:{}})})
export const fingerprint=(snapshot:MachineSnapshot)=>JSON.stringify(snapshot)

export function statePath(document:MachineDocument,identity:string){
 const path:string[]=[],seen=new Set<string>()
 let state=document.states.find(item=>item.id===identity)
 while(state&&!seen.has(state.id)){
  seen.add(state.id);path.unshift(state.id)
  state=document.states.find(item=>item.id===state?.parent)
 }
 return path
}

export function transitionPlan(document:MachineDocument,edge:Transition,activePath?:string[]){
 const leaf=(identity:string)=>{
  const seen=new Set<string>()
  let state=document.states.find(item=>item.id===identity)
  while(state?.initial&&!seen.has(state.id)){seen.add(state.id);state=document.states.find(item=>item.id===state?.initial)}
  return state?.id||identity
 }
 const source=activePath?.includes(edge.source)?activePath:statePath(document,leaf(edge.source))
 if(edge.source===edge.target)return {exited:[],retained:source,entered:[]}
 const target=statePath(document,leaf(edge.target))
 let common=0
 while(common<Math.min(source.length,target.length)&&source[common]===target[common])common++
 return {exited:source.slice(common).reverse(),retained:source.slice(0,common),entered:target.slice(common)}
}

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

export function diagnoseMachine(snapshot:MachineSnapshot,references:Set<string>,t:Translator=(text,values)=>text.replace(/\{(\w+)\}/g,(_,key)=>String(values?.[key]??''))):Diagnostic[]{
 const {document}=snapshot,issues:Diagnostic[]=[]
 if(!snapshot.title.trim())issues.push({message:t("填写状态机名称")})
 if(document.states.length>48)issues.push({message:t("状态数量不能超过 48 个")})
 if(document.transitions.length>160)issues.push({message:t("转换数量不能超过 160 条")})
 const ids=new Set(document.states.map(s=>s.id))
 for(const state of document.states){
  const children=document.states.filter(s=>s.parent===state.id)
  if(!state.label.trim())issues.push({message:t("为状态填写名称"),stateId:state.id})
  if(children.length&&!children.some(s=>s.id===state.initial))issues.push({message:t("{0} 需要初始子状态", {0: state.label}),stateId:state.id})
  for(const phase of ['entry','do','exit'] as const){if(state[phase]&&!references.has(state[phase]!))issues.push({message:t("{0} 的 {1} 任务已不可用", {0: state.label, 1: phase==='entry'?'Entry':phase==='do'?'Do':'Exit'}),stateId:state.id});for(const mapping of Object.values(state.bindings?.[phase]||{})){for(const variable of Object.values(mapping)){if(!(variable in document.variables))issues.push({message:t("{0} 的 {1} 绑定变量 {2} 已不存在", {0: state.label, 1: phase, 2: variable}),stateId:state.id})}}}
 }
 const signatures=new Set<string>()
 document.transitions.forEach((edge,edgeIndex)=>{
  const signature=edge.source+':'+edge.event
  if(!isIdentifier(edge.event))issues.push({message:t("事件标识需以小写字母开头，仅包含字母、数字和下划线"),edgeIndex})
  if(signatures.has(signature))issues.push({message:t("同一状态的 {0} 事件存在重复转换", {0: edge.event}),edgeIndex})
  signatures.add(signature)
  if(!ids.has(edge.source)||!ids.has(edge.target))issues.push({message:t("转换连接的状态不存在"),edgeIndex})
  if(edge.guard?.operator&&edge.guard.operator!=='always'){
   if(!edge.guard.key||!(edge.guard.key in document.variables))issues.push({message:t("{0} 需要选择有效变量", {0: edge.event||t("转换")}),edgeIndex})
   if(['greater','less'].includes(edge.guard.operator)&&(typeof document.variables[edge.guard.key||'']!=='number'||typeof edge.guard.value!=='number'))issues.push({message:t("{0} 的大小比较需要数值变量和数值比较值", {0: edge.event||t("转换")}),edgeIndex})
  }
 })
 for(const [name,value] of Object.entries(document.variables))if(typeof value==='number'&&!Number.isFinite(value))issues.push({message:t("变量 {0} 需要有效数值", {0: name})})
 return issues
}
