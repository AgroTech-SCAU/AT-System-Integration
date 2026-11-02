import {useState} from 'react'
import {useLocale} from '../locale'
import type {FieldSchema} from './SchemaMessageForm'

export type FieldNote={label?:string;description?:string;unit?:string;options?:{label:string;value:unknown}[]}
export default function FieldNoteEditor({schema,path,onSave}:{schema:FieldSchema;path:string[];onSave:(path:string[],note:FieldNote)=>Promise<boolean>}){
 const {t}=useLocale(),[open,setOpen]=useState(false),[busy,setBusy]=useState(false)
 const [note,setNote]=useState<FieldNote>({})
 function show(){setNote({label:schema.label||'',description:schema.description||'',unit:schema.unit||'',options:schema.options||[]});setOpen(true)}
 const [invalid,setInvalid]=useState(false)
 return <div className="schema-note-editor">{!open?<button type="button" className="ros-expose-port" onClick={show}>{t(schema.constant_candidates?.length&&!schema.options?.length?'说明与命令选项':'字段说明')}</button>:<div className="schema-note-card">
 <strong>{path.join('.')}</strong><label className="field"><span>{t('显示名称')}</span><input maxLength={80} value={note.label||''} onChange={event=>setNote({...note,label:event.target.value})}/></label><label className="field"><span>{t('字段说明')}</span><textarea maxLength={2000} value={note.description||''} onChange={event=>setNote({...note,description:event.target.value})}/></label>
 {['integer','number'].includes(schema.kind)&&<label className="field"><span>{t('单位')}</span><input maxLength={40} value={note.unit||''} placeholder={t('按作者说明填写，未知时留空')} onChange={event=>setNote({...note,unit:event.target.value})}/></label>}
 {!!schema.constant_candidates?.length&&<><p className="ros-field-hint">{t('接口中的同类型常量，需要确认哪些属于此字段')}</p>{schema.constant_candidates.map(item=><label className="schema-constant-option" key={item.name}><input type="checkbox" checked={!!note.options?.some(option=>option.value===item.value)} onChange={event=>setNote({...note,options:event.target.checked?[...(note.options||[]),{label:item.name,value:item.value}]:(note.options||[]).filter(option=>option.value!==item.value)})}/><span>{item.name} · {String(item.value)}<small>{item.description}</small></span></label>)}</>}
 {note.options?.map((option,index)=><div className="schema-note-option" key={index}><input aria-label={t('选项说明')} maxLength={120} value={option.label} onChange={event=>setNote({...note,options:note.options!.map((row,i)=>i===index?{...row,label:event.target.value}:row)})}/><input aria-label={t('选项值')} value={String(option.value)} onChange={event=>{const value=schema.kind==='string'?event.target.value:Number(event.target.value);setNote({...note,options:note.options!.map((row,i)=>i===index?{...row,value}:row)})}}/><button type="button" aria-label={t('移除选项')} onClick={()=>setNote({...note,options:note.options!.filter((_,i)=>i!==index)})}>×</button></div>)}
 {['integer','number','string'].includes(schema.kind)&&<button type="button" onClick={()=>setNote({...note,options:[...(note.options||[]),{label:'',value:schema.kind==='string'?'':0}]})}>{t('添加可选值')}</button>}
 <p className="ros-field-hint">{t('保存到此接口所属工作区，新配置的任务可复用这些说明')}</p>{invalid&&<p className="ros-invalid">{t('请填写选项说明，并确保数值有效且不重复')}</p>}<div className="buttons"><button type="button" disabled={busy} onClick={()=>setOpen(false)}>{t('取消')}</button><button type="button" disabled={busy} onClick={async()=>{if(note.options?.some((option,index)=>!option.label.trim()||typeof option.value==='number'&&!Number.isFinite(option.value)||note.options!.some((other,i)=>i!==index&&other.value===option.value))){setInvalid(true);return}setInvalid(false);setBusy(true);try{if(await onSave(path,note))setOpen(false)}finally{setBusy(false)}}}>{t(busy?'保存中':'保存字段说明')}</button></div>
 </div>}</div>
}
