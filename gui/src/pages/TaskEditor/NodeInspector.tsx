import {useLocale} from '../../locale'
import {useEffect,useState} from 'react'
import {Field} from '../../components/Foundation'
import type {Json} from '../shared'
import {canAdopt,parentOf,canReferenceTree,type EditorValue} from './editor'
import {nodeLabel} from './labels'
import Icon from './WorkbenchIcon'

type Source={key:string;label:string;reason?:string}
type Props={value:EditorValue;treeId:string;selected:string;models:Json;readonly:boolean;diagnostics:Json[];language:'zh'|'en';change:(work:(value:EditorValue)=>void,mergeKey?:string)=>void;onReparent:(id:string,parent:string)=>void;onOrder:(delta:number)=>void;onDuplicate:()=>void;onDelete:()=>void;onOpen:(id:string)=>void;onExtract:()=>void;bindings:(spec:Json)=>Source[]}
export default function NodeInspector({value,treeId,selected,models,readonly,diagnostics,language,change,onReparent,onOrder,onDuplicate,onDelete,onOpen,onExtract,bindings}:Props){
 const {t}=useLocale()

 const tree=value.document.trees[treeId],node=tree?.nodes[selected],model=models.nodes[node?.registration_id]
 const specs:Json=node?.registration_id==='SubTree'?Object.fromEntries(Object.entries(value.document.trees[node.attributes.ID]?.ports||{}).map(([key,spec]:[string,any])=>[key,{...spec.type,direction:spec.direction,required:true}])):model?.ports||{}
 function setPort(name:string,next:Json|undefined){change(v=>{const ports=v.document.trees[treeId].nodes[selected].ports;if(next)ports[name]=next;else delete ports[name]},`${selected}.port.${name}`)}
 const parent=node&&parentOf(tree,selected),index=parent?.children.indexOf(selected),issues=diagnostics.filter(issue=>issue.editor_id===selected)
 if(!node)return <div className="bw-inspector-empty"><Icon name="settings"/><p>{t("选择一个节点查看属性")}</p></div>
 return <>
  <div className="bw-inspector-heading"><span className="bw-eyebrow">{model?.ros_task_id?t("机器人任务"):model?.capability_id?t("机器人能力"):t("流程节点")}</span><h3>{value.layout.labels[selected]||(model?.ros_task_id?model.label:t(model?.label||nodeLabel(node.registration_id,language)))}</h3><p>{t(model?.description||nodeLabel(node.registration_id,language))}</p></div>
  {issues.length>0&&<div className={'bw-inline-issues'+(issues.every(issue=>issue.severity==='warning')?' is-pending':'')} role="status">{issues.map((issue,index)=><p key={index}>{issue.port&&<strong>{issue.port} · </strong>}{t(issue.reason)}</p>)}</div>}
  <div className="bw-inspector-section"><Field label={t("名称")}><input disabled={readonly} value={value.layout.labels[selected]||''} placeholder={(model?.ros_task_id?model.label:t(model?.label||nodeLabel(node.registration_id,language)))} onChange={event=>change(v=>{v.layout.labels[selected]=event.target.value},`${selected}.label`)}/></Field>
   {model?.capability_id&&!model?.ros_task_id&&<Field label={t("执行绑定")}><select disabled={readonly} value={node.attributes.role||(node.attributes.backend_instance?'backend:'+node.attributes.backend_instance:'')} onChange={event=>change(v=>{const attrs=v.document.trees[treeId].nodes[selected].attributes;delete attrs.role;delete attrs.backend_instance;if(event.target.value.startsWith('backend:'))attrs.backend_instance=event.target.value.slice(8);else attrs.role=event.target.value})}><option value="">{t("选择兼容绑定")}</option>{(model.roles||[]).map((role:string)=><option key={role}>{role}</option>)}{(model.backends||[]).map((backend:string)=><option key={backend} value={'backend:'+backend}>{backend}</option>)}</select></Field>}
   {node.registration_id==='SubTree'&&<><Field label={t("调用子树")}><select disabled={readonly} value={node.attributes.ID||''} onChange={event=>change(v=>{v.document.trees[treeId].nodes[selected].attributes.ID=event.target.value;v.document.trees[treeId].nodes[selected].ports={}})}><option value="">{t("选择子树")}</option>{Object.keys(value.document.trees).filter(key=>canReferenceTree(value.document,treeId,key)).map(key=><option key={key}>{key}</option>)}</select></Field><button className="bw-wide-action" disabled={!value.document.trees[node.attributes.ID]} onClick={()=>onOpen(selected)}>{t("打开子树 ")}<Icon name="arrow"/></button></>}
   {!!model?.resources?.length&&<div className="bw-property"><span>{t("占用资源")}</span><span>{model.resources.map((resource:any)=>typeof resource==='string'?resource:resource.name+(resource.access==='shared'?t(" 共享"):t(" 独占"))).join(' · ')}</span></div>}
  </div>
  {Object.entries(specs).filter(([name])=>!['role','backend_instance','node_id'].includes(name)).map(([name,spec]:[string,any])=><PortField key={`${selected}.${name}`} name={name} spec={spec} port={node.ports[name]} sources={bindings(spec)} disabled={readonly} setPort={next=>setPort(name,next)}/>)}
  <div className="bw-inspector-section"><h4>{t("执行位置")}</h4><Field label={t("父节点")}><select disabled={readonly||selected===tree.root_id} value={parent?.editor_id||''} onChange={event=>onReparent(selected,event.target.value)}><option value="">{t("根节点")}</option>{(Object.values(tree.nodes) as Json[]).filter(candidate=>candidate.editor_id===parent?.editor_id||canAdopt(tree,selected,candidate.editor_id,models.nodes)).map(candidate=><option key={candidate.editor_id} value={candidate.editor_id}>{value.layout.labels[candidate.editor_id]||models.nodes[candidate.registration_id]?.label||nodeLabel(candidate.registration_id,language)}</option>)}</select></Field>
   <div className="bw-node-actions"><button title={t("提前执行 Alt ↑")} disabled={readonly||!parent||index===0} onClick={()=>onOrder(-1)}>{t("上移")}</button><button title={t("延后执行 Alt ↓")} disabled={readonly||!parent||index===parent?.children.length-1} onClick={()=>onOrder(1)}>{t("下移")}</button><button disabled={readonly||!node.children.length} onClick={()=>change(v=>{v.layout.collapsed=v.layout.collapsed.includes(selected)?v.layout.collapsed.filter((id:string)=>id!==selected):[...v.layout.collapsed,selected]})}>{value.layout.collapsed.includes(selected)?t("展开"):t("折叠")}</button></div>
   <button className="bw-wide-action" disabled={readonly} onClick={onExtract}>{t("提取为子树 ")}<Icon name="layers"/></button>
   <div className="bw-node-actions"><button disabled={readonly||selected===tree.root_id} onClick={()=>onDuplicate()}><Icon name="copy"/>{t("复制片段")}</button><button disabled={readonly||selected===tree.root_id} className="bw-danger" onClick={()=>onDelete()}><Icon name="trash"/>{t("删除")}</button></div>
  </div>
  <details className="bw-inspector-section bw-technical"><summary>{t("节点信息")}</summary><dl><dt>{t("注册标识")}</dt><dd>{node.registration_id}</dd><dt>{t("节点标识")}</dt><dd>{node.editor_id}</dd><dt>{t("子节点")}</dt><dd>{node.children.length} / {model?.maximum_children<0?t("不限"):model?.maximum_children??'—'}</dd></dl></details>
 </>
}
function PortField({name,spec,port,sources,disabled,setPort}:{name:string;spec:Json;port?:Json;sources:Source[];disabled:boolean;setPort:(value:Json|undefined)=>void}){
 const {t}=useLocale()

 const output=spec.direction==='OUTPUT',type=typeof spec.type==='object'?spec.type.type:spec.type
 const contract=typeof spec.type==='object'?spec.type:spec
 const [text,setText]=useState(''),[error,setError]=useState('')
 const complex=!['string','number','integer','boolean'].includes(type)
 useEffect(()=>{setText(typeof port?.value==='object'?JSON.stringify(port?.value??null,null,2):String(port?.value??''));setError('')},[port?.value])
 function binding(kind:string){
  if(!kind){setPort(undefined);return}
  if(kind==='variable'){setPort({kind:'blackboard_reference',key:sources.find(source=>!source.reason)?.key||name.replace('out_',''),value:null,type:{}});return}
  setPort({kind:'typed_literal',key:null,value:type==='boolean'?false:type==='string'?'':type==='number'||type==='integer'?0:null,type:{type,...(contract.unit?{unit:contract.unit}:{}),...(contract.frame_id?{frame_id:contract.frame_id}:{}),...(contract.clock_domain?{clock_domain:contract.clock_domain}:{})}})
 }
 function applyComplex(){try{setPort({...port,value:JSON.parse(text)});setError('')}catch{setError(t("请输入有效的 JSON 数据"))}}
 return <section className="bw-port"><header><strong>{name.replace(/^out_/,'')}</strong><span>{output?t("输出"):t("输入")}{spec.required?t(" · 必填"):''}</span></header><p className="bw-port-type">{[type,contract.unit,contract.frame_id,contract.clock_domain].filter(Boolean).join(' · ')}{contract.max_age_s?t(" · {0} s 内", {0: contract.max_age_s}):''}</p>
  {!output&&<Field label={t("来源")}><select disabled={disabled} value={port?.kind==='blackboard_reference'?'variable':port?.kind==='typed_literal'?'literal':''} onChange={event=>binding(event.target.value)}><option value="">{spec.default!==undefined?t("缺省 · {0}", {0: String(spec.default)}):t("未绑定")}</option><option value="literal">{t("固定值")}</option><option value="variable">{t("参数或节点输出")}</option></select></Field>}
  {output||port?.kind==='blackboard_reference'?<>
   {!output&&sources.length>0&&<select className="bw-source-select" aria-label={t("{0} 数据来源", {0: name})} disabled={disabled} value={sources.some(source=>source.key===port?.key)?port?.key:''} onChange={event=>{if(event.target.value)setPort({...port,kind:'blackboard_reference',key:event.target.value,value:null,type:{}})}}><option value="">{t("选择兼容的数据")}</option>{sources.map(source=><option key={source.key} value={source.key} disabled={!!source.reason}>{source.label}{source.reason?' · '+t(source.reason):''}</option>)}</select>}
   {output?<Field label={t("保存为变量")}><input disabled={disabled} value={port?.key||''} placeholder={name.replace('out_','')} onChange={event=>setPort({kind:'blackboard_reference',key:event.target.value,value:null,type:{}})}/></Field>:<details className="bw-port-manual" open={!sources.length}><summary>{sources.length?t("自定义变量"):t("变量名称")}</summary><input aria-label={t("{0} 变量", {0: name})} disabled={disabled} value={port?.key||''} placeholder={t("输入变量标识")} onChange={event=>setPort({...port,key:event.target.value})}/></details>}
  </>:port?.kind==='typed_literal'&&<>
   {type==='boolean'?<Field label={t("值")}><select disabled={disabled} value={String(port.value)} onChange={event=>setPort({...port,value:event.target.value==='true'})}><option value="true">true</option><option value="false">false</option></select></Field>:complex?<Field label={t("数据")}><textarea disabled={disabled} value={text} spellCheck={false} onChange={event=>setText(event.target.value)} onBlur={applyComplex}/></Field>:spec.choices?<Field label={t("值")}><select disabled={disabled} value={JSON.stringify(port.value)} onChange={event=>setPort({...port,value:JSON.parse(event.target.value)})}>{spec.choices.map((choice:unknown,index:number)=><option key={index} value={JSON.stringify(choice)}>{String(choice)}</option>)}</select></Field>:<Field label={contract.unit?t("值 · {0}", {0: contract.unit}):t("值")}><input disabled={disabled} type={['number','integer'].includes(type)?'number':'text'} step={type==='integer'?1:'any'} min={spec.minimum} max={spec.maximum} value={port.value??''} onChange={event=>setPort({...port,value:['number','integer'].includes(type)?event.target.value===''?null:Number(event.target.value):event.target.value})}/></Field>}
   {error&&<p className="bw-field-error" role="alert">{error}</p>}
   {contract.unit&&<details className="bw-port-manual"><summary>{t("单位")}</summary><input disabled={disabled} aria-label={t("{0} 单位", {0: name})} value={port.type?.unit||''} onChange={event=>setPort({...port,type:{...port.type,unit:event.target.value}})}/></details>}
  </>}
 </section>
}
