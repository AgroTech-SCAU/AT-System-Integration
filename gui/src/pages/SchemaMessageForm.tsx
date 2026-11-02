import FieldNoteEditor, {type FieldNote} from './FieldNoteEditor'
import StudioSelect from '../components/StudioSelect'
import {useEffect, useRef, useState} from 'react'
import {useLocale} from '../locale'
import {Icon} from '../components/Icon'

export type FieldSchema={label?:string;description?:string;source_description?:string;unit?:string;explicit_default?:boolean;options?:{label:string;value:unknown}[];constant_candidates?:{name:string;value:unknown;description:string}[];type:string;kind:'boolean'|'integer'|'number'|'string'|'object'|'array';default:unknown;fields?:Record<string,FieldSchema>;item?:FieldSchema;length?:number;max_length?:number;min?:number;max?:number}
export type MessageSchema={field_notes?:Record<string,FieldNote>;fields:Record<string,unknown>;field_types:Record<string,string>;field_schemas?:Record<string,FieldSchema>;output_fields?:Record<string,unknown>;output_field_schemas?:Record<string,FieldSchema>;feedback_fields?:Record<string,unknown>;feedback_field_schemas?:Record<string,FieldSchema>;source?:string;schema_id?:string}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)
export function fallbackFields(values:Record<string,unknown>,types:Record<string,string>={}):Record<string,FieldSchema>{
  return Object.fromEntries(Object.entries(values).map(([name,value])=>[name,{type:types[name]||'',default:value,kind:Array.isArray(value)?'array':record(value)?'object':typeof value==='boolean'?'boolean':typeof value==='number'?'number':'string',...(record(value)?{fields:fallbackFields(value)}:{}),...(Array.isArray(value)?{item:fallbackFields({item:value[0]??''}).item}:{})}]))
}
export function reconcileFields(fields:Record<string,FieldSchema>,value:Record<string,unknown>,prefix=''):{value:Record<string,unknown>;changed:string[]}{
  const changed=Object.keys(value).filter(key=>!(key in fields)).map(key=>prefix+key)
  function merge(schema:FieldSchema,previous:unknown,path:string):unknown{
    if(schema.kind==='object'){
      if(previous!==undefined&&!record(previous)){changed.push(path);return previous}
      const nested=reconcileFields(schema.fields||{},record(previous)?previous:{},path+'.');changed.push(...nested.changed);return nested.value
    }
    if(schema.kind==='array'){
      if(!Array.isArray(previous)){if(previous!==undefined){changed.push(path);return previous}return structuredClone(schema.default??[])}
      if(schema.length!==undefined&&previous.length!==schema.length||schema.max_length!==undefined&&previous.length>schema.max_length)changed.push(path)
      return schema.item?previous.map((item,index)=>merge(schema.item!,item,path+'.'+index)):previous
    }
    const valid=schema.kind==='boolean'?typeof previous==='boolean':schema.kind==='string'?typeof previous==='string'&&(schema.max_length===undefined||previous.length<=schema.max_length):typeof previous==='number'&&Number.isFinite(previous)&&(schema.kind!=='integer'||Number.isInteger(previous))&&(schema.min===undefined||previous>=schema.min)&&(schema.max===undefined||previous<=schema.max)
    if(valid)return previous
    if(previous!==undefined){changed.push(path);return previous}
    return structuredClone(schema.default)
  }
  return {value:{...value,...Object.fromEntries(Object.entries(fields).map(([name,schema])=>[name,merge(schema,value[name],prefix+name)]))},changed}
}
export function schemaFieldAt(fields:Record<string,FieldSchema>,path:string):FieldSchema|undefined{
  let node:FieldSchema={kind:'object',type:'',default:{},fields}
  if(path==='$')return node
  for(const key of path.split('.')){
    const next:FieldSchema|undefined=node.kind==='object'?node.fields?.[key]:node.kind==='array'&&/^\d+$/.test(key)?node.item:undefined
    if(!next)return
    node=next
  }
  return node
}
export function invalidMessageFields(fields:Record<string,FieldSchema>,value:Record<string,unknown>,prefix=''):string[]{
  const errors:string[]=[]
  function check(schema:FieldSchema|undefined,item:unknown,path:string){
    if(!schema){errors.push(path);return}
    if(schema.kind==='object'){
      if(!record(item))errors.push(path)
      else for(const [key,child] of Object.entries(item))check(schema.fields?.[key],child,path?path+'.'+key:key)
    }else if(schema.kind==='array'){
      if(!Array.isArray(item)){errors.push(path);return}
      if(schema.length!==undefined&&item.length!==schema.length||schema.max_length!==undefined&&item.length>schema.max_length)errors.push(path)
      if(schema.item)item.forEach((child,index)=>check(schema.item,child,path+'.'+index))
    }else if(schema.kind==='boolean'){if(typeof item!=='boolean')errors.push(path)}
    else if(schema.kind==='string'){if(typeof item!=='string'||schema.max_length!==undefined&&item.length>schema.max_length)errors.push(path)}
    else if(typeof item!=='number'||!Number.isFinite(item)||schema.kind==='integer'&&!Number.isSafeInteger(item)||schema.min!==undefined&&item<schema.min||schema.max!==undefined&&item>schema.max)errors.push(path)
  }
  check({kind:'object',type:'',default:{},fields},value,prefix)
  return errors
}
function addDecimal(value:number,delta:number){
  const parts=(number:number)=>{const [digits,exponent='0']=String(number).split('e');const decimals=digits.split('.')[1]?.length||0;return {digits:BigInt(digits.replace('.','')),exponent:Number(exponent)-decimals}}
  const a=parts(value),b=parts(delta),exponent=Math.min(a.exponent,b.exponent)
  return Number(String(a.digits*10n**BigInt(a.exponent-exponent)+b.digits*10n**BigInt(b.exponent-exponent))+'e'+exponent)
}
export function MessageFieldIssues({fields,value,onChange}:{fields:Record<string,FieldSchema>;value:Record<string,unknown>;onChange:(value:Record<string,unknown>)=>void}){
  const {t}=useLocale(),issues=invalidMessageFields(fields,value)
  const at=(path:string)=>path.split('.').reduce<unknown>((item,key)=>item&&typeof item==='object'?(item as Record<string,unknown>)[key]:undefined,value)
  function repair(path:string){
    const next=structuredClone(value),parts=path.split('.'),key=parts.pop()!,schema=schemaFieldAt(fields,path)
    const parent=parts.reduce<Record<string,unknown>>((item,key)=>item[key] as Record<string,unknown>,next)
    if(schema)parent[key]=structuredClone(schema.default);else delete parent[key]
    onChange(next)
  }
  return issues.length>0?<div className="ros-field-review" role="group" aria-label={t('待处理的原参数')}><strong>{t('原参数已保留，以下字段与当前接口不兼容')}</strong>{issues.map(path=><div key={path}><code>{path}</code><pre>{JSON.stringify(at(path),null,2)}</pre><button type="button" onClick={()=>repair(path)}>{t(schemaFieldAt(fields,path)?'使用此字段默认值':'移除不再支持的字段')}</button></div>)}</div>:null
}
function NumberValue({schema,value,label,onChange}:{schema:FieldSchema;value:unknown;label:string;onChange:(value:unknown)=>void}){
  const {t}=useLocale(),emitted=useRef(value)
  const [text,setText]=useState(String(value??schema.default??0))
  useEffect(()=>{if(!Object.is(value,emitted.current)){emitted.current=value;setText(String(value??schema.default??0))}},[value])
  const number=Number(text),valid=text.trim()!==''&&Number.isFinite(number)&&(schema.kind!=='integer'||Number.isSafeInteger(number))&&(schema.min===undefined||number>=schema.min)&&(schema.max===undefined||number<=schema.max)
  function change(next:string){setText(next);const parsed=Number(next);if(next.trim()&&Number.isFinite(parsed)){emitted.current=parsed;onChange(parsed)}else onChange(value)}
  function increment(direction:number,fine=false){
    let next=addDecimal(Number.isFinite(number)&&text.trim()?number:0,direction*(schema.kind==='integer'?1:fine?0.01:0.1))
    next=Math.max(schema.min??-Infinity,Math.min(schema.max??Infinity,next))
    if(Number.isFinite(next)&&(schema.kind!=='integer'||Number.isSafeInteger(next)))change(String(next))
  }
  return <div className="schema-number"><input type="text" inputMode={schema.kind==='integer'?'numeric':'decimal'} role="spinbutton" aria-label={label} aria-valuenow={valid?number:undefined} aria-valuemin={schema.min} aria-valuemax={schema.max} aria-invalid={!valid} value={text} onChange={event=>change(event.target.value)} onKeyDown={event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();increment(event.key==='ArrowUp'?1:-1,event.altKey)}}}/><span className="schema-number-steps"><button type="button" aria-label={t('增加 {0}',{0:label})} title={t(schema.kind==='integer'?'每次调整 1':'每次调整 0.1，按住 Alt 调整 0.01')} disabled={schema.max!==undefined&&number>=schema.max} onClick={event=>increment(1,event.altKey)}>▴</button><button type="button" aria-label={t('减少 {0}',{0:label})} title={t(schema.kind==='integer'?'每次调整 1':'每次调整 0.1，按住 Alt 调整 0.01')} disabled={schema.min!==undefined&&number<=schema.min} onClick={event=>increment(-1,event.altKey)}>▾</button></span></div>
}
function SchemaField({name,schema,value,path,onChange,onExpose,onAnnotate}:{name:string;schema:FieldSchema;value:unknown;path:string[];onChange:(value:unknown)=>void;onExpose?:(path:string[],value:unknown)=>void;onAnnotate?:(path:string[],note:FieldNote)=>Promise<boolean>}){
  const {t}=useLocale(),[limit,setLimit]=useState(30)
  const label=path.join('.'),actual=value===undefined?structuredClone(schema.default):value
  const expose=onExpose&&<button type="button" className="ros-expose-port" onClick={()=>onExpose(path,actual)}>{t('设为任务输入')}</button>
  if(schema.kind==='object')return <details className="schema-group" open><summary><span>{schema.label||name}</span><small>{schema.type}</small></summary><div className="schema-group-fields">{Object.entries(schema.fields||{}).map(([key,child])=><SchemaField key={key} name={key} schema={child} value={record(actual)?actual[key]:undefined} path={[...path,key]} onChange={next=>onChange({...(record(actual)?actual:{}),[key]:next})} onExpose={onExpose} onAnnotate={onAnnotate}/>)}</div></details>
  if(schema.kind==='array'){
    const entries=Array.isArray(actual)?actual:[],item=schema.item||fallbackFields({item:''}).item,fixed=schema.length!==undefined
    return <details className="schema-group schema-array" open><summary><span>{schema.label||name}</span><small>{schema.type} · {entries.length}{schema.max_length!==undefined?' / '+schema.max_length:''}</small></summary><div className="schema-array-items">{entries.slice(0,limit).map((entry,index)=><div className="schema-array-item" key={index}><SchemaField name={String(index)} schema={item} value={entry} path={[...path,String(index)]} onChange={next=>onChange(entries.map((old,i)=>i===index?next:old))}/>{!fixed&&<button type="button" aria-label={t('移除数组项 {0}',{0:index+1})} onClick={()=>onChange(entries.filter((_,i)=>i!==index))}><Icon name="x"/></button>}</div>)}{entries.length>limit&&<button type="button" onClick={()=>setLimit(limit+30)}>{t('显示更多字段')}</button>}<div className="schema-array-actions">{!fixed&&<button type="button" disabled={schema.max_length!==undefined&&entries.length>=schema.max_length} onClick={()=>onChange([...entries,structuredClone(item.default)])}><Icon name="plus"/>{t('添加数组项')}</button>}{expose}</div></div></details>
  }
  return <div className="schema-field"><label><span>{schema.label||name}<small>{schema.type}{schema.unit?' · '+schema.unit:''}</small></span>{schema.options?.length?<StudioSelect label={label} value={JSON.stringify(actual)} options={schema.options.map(option=>({value:JSON.stringify(option.value),label:option.label+' · '+String(option.value)}))} onChange={next=>onChange(JSON.parse(next))}/>:schema.kind==='boolean'?<button type="button" role="switch" aria-label={label} aria-checked={actual===true} className="schema-boolean" onClick={()=>onChange(!actual)}><span/>{actual===true?'true':'false'}</button>:schema.kind==='integer'||schema.kind==='number'?<NumberValue schema={schema} value={actual} label={label} onChange={onChange}/>:<input aria-label={label} value={typeof actual==='string'?actual:''} maxLength={schema.max_length} onChange={event=>onChange(event.target.value)}/>}</label>{schema.label&&<code className="ros-field-hint">{name}</code>}{schema.description&&<p className="ros-field-hint schema-description" title={schema.description}>{schema.description}</p>}{schema.options?.length&&!schema.explicit_default&&<p className="ros-field-hint">{t('接口未声明默认选项，请确认当前选择')}</p>}{expose}{onAnnotate&&<FieldNoteEditor schema={schema} path={path} onSave={onAnnotate}/>}</div>
}
export default function SchemaMessageForm({fields,value,onChange,onExpose,onAnnotate}:{fields:Record<string,FieldSchema>;value:Record<string,unknown>;onChange:(value:Record<string,unknown>)=>void;onExpose?:(path:string[],value:unknown)=>void;onAnnotate?:(path:string[],note:FieldNote)=>Promise<boolean>}){
  const {t}=useLocale()
  return <div className="schema-message-form">{Object.entries(fields).map(([name,schema])=><SchemaField key={name} name={name} schema={schema} value={value[name]} path={[name]} onChange={next=>onChange({...value,[name]:next})} onExpose={onExpose} onAnnotate={onAnnotate}/>)}{!Object.keys(fields).length&&<p className="ros-field-hint">{t('此接口无需填写参数')}</p>}</div>
}
