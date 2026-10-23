import {useEffect, useState} from 'react'
import {useLocale} from '../locale'
import {Icon} from '../components/Icon'

export type FieldSchema={type:string;kind:'boolean'|'integer'|'number'|'string'|'object'|'array';default:unknown;fields?:Record<string,FieldSchema>;item?:FieldSchema;length?:number;max_length?:number;min?:number;max?:number}
export type MessageSchema={fields:Record<string,unknown>;field_types:Record<string,string>;field_schemas?:Record<string,FieldSchema>;output_fields?:Record<string,unknown>;output_field_schemas?:Record<string,FieldSchema>;feedback_fields?:Record<string,unknown>;feedback_field_schemas?:Record<string,FieldSchema>;source?:string;schema_id?:string}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)
export function fallbackFields(values:Record<string,unknown>,types:Record<string,string>={}):Record<string,FieldSchema>{
  return Object.fromEntries(Object.entries(values).map(([name,value])=>[name,{type:types[name]||'',default:value,kind:Array.isArray(value)?'array':record(value)?'object':typeof value==='boolean'?'boolean':typeof value==='number'?'number':'string',...(record(value)?{fields:fallbackFields(value)}:{}),...(Array.isArray(value)?{item:fallbackFields({item:value[0]??''}).item}:{})}]))
}
export function reconcileFields(fields:Record<string,FieldSchema>,value:Record<string,unknown>,prefix=''):{value:Record<string,unknown>;changed:string[]}{
  const changed=Object.keys(value).filter(key=>!(key in fields)).map(key=>prefix+key)
  function merge(schema:FieldSchema,previous:unknown,path:string):unknown{
    if(schema.kind==='object'){
      const nested=reconcileFields(schema.fields||{},record(previous)?previous:{},path+'.');changed.push(...nested.changed);return nested.value
    }
    if(schema.kind==='array'){
      if(!Array.isArray(previous)){if(previous!==undefined)changed.push(path);return structuredClone(schema.default??[])}
      if(schema.length!==undefined&&previous.length!==schema.length||schema.max_length!==undefined&&previous.length>schema.max_length){changed.push(path);return structuredClone(schema.default??[])}
      return schema.item?previous.map((item,index)=>merge(schema.item!,item,path+'['+index+']')):previous
    }
    const valid=schema.kind==='boolean'?typeof previous==='boolean':schema.kind==='string'?typeof previous==='string'&&(schema.max_length===undefined||previous.length<=schema.max_length):typeof previous==='number'&&Number.isFinite(previous)&&(schema.kind!=='integer'||Number.isInteger(previous))&&(schema.min===undefined||previous>=schema.min)&&(schema.max===undefined||previous<=schema.max)
    if(valid)return previous
    if(previous!==undefined)changed.push(path)
    return structuredClone(schema.default)
  }
  return {value:Object.fromEntries(Object.entries(fields).map(([name,schema])=>[name,merge(schema,value[name],prefix+name)])),changed}
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
function NumberValue({schema,value,label,onChange}:{schema:FieldSchema;value:unknown;label:string;onChange:(value:unknown)=>void}){
  const [text,setText]=useState(String(value??schema.default??0))
  useEffect(()=>setText(String(value??schema.default??0)),[value])
  const number=Number(text),valid=text.trim()!==''&&Number.isFinite(number)&&(schema.kind!=='integer'||Number.isSafeInteger(number))&&(schema.min===undefined||number>=schema.min)&&(schema.max===undefined||number<=schema.max)
  return <input type="number" aria-label={label} aria-invalid={!valid} value={text} step={schema.kind==='integer'?1:'any'} min={schema.min} max={schema.max} onChange={event=>{const next=event.target.value;setText(next);if(next.trim()&&Number.isFinite(Number(next)))onChange(Number(next))}}/>
}
function SchemaField({name,schema,value,path,onChange,onExpose}:{name:string;schema:FieldSchema;value:unknown;path:string[];onChange:(value:unknown)=>void;onExpose?:(path:string[],value:unknown)=>void}){
  const {t}=useLocale(),[limit,setLimit]=useState(30)
  const label=path.join('.'),actual=value===undefined?structuredClone(schema.default):value
  const expose=onExpose&&<button type="button" className="ros-expose-port" onClick={()=>onExpose(path,actual)}>{t('设为任务输入')}</button>
  if(schema.kind==='object')return <details className="schema-group" open><summary><span>{name}</span><small>{schema.type}</small></summary><div className="schema-group-fields">{Object.entries(schema.fields||{}).map(([key,child])=><SchemaField key={key} name={key} schema={child} value={record(actual)?actual[key]:undefined} path={[...path,key]} onChange={next=>onChange({...(record(actual)?actual:{}),[key]:next})} onExpose={onExpose}/>)}</div></details>
  if(schema.kind==='array'){
    const entries=Array.isArray(actual)?actual:[],item=schema.item||fallbackFields({item:''}).item,fixed=schema.length!==undefined
    return <details className="schema-group schema-array" open><summary><span>{name}</span><small>{schema.type} · {entries.length}{schema.max_length!==undefined?' / '+schema.max_length:''}</small></summary><div className="schema-array-items">{entries.slice(0,limit).map((entry,index)=><div className="schema-array-item" key={index}><SchemaField name={String(index)} schema={item} value={entry} path={[...path,String(index)]} onChange={next=>onChange(entries.map((old,i)=>i===index?next:old))}/>{!fixed&&<button type="button" aria-label={t('移除数组项 {0}',{0:index+1})} onClick={()=>onChange(entries.filter((_,i)=>i!==index))}><Icon name="x"/></button>}</div>)}{entries.length>limit&&<button type="button" onClick={()=>setLimit(limit+30)}>{t('显示更多字段')}</button>}<div className="schema-array-actions">{!fixed&&<button type="button" disabled={schema.max_length!==undefined&&entries.length>=schema.max_length} onClick={()=>onChange([...entries,structuredClone(item.default)])}><Icon name="plus"/>{t('添加数组项')}</button>}{expose}</div></div></details>
  }
  return <div className="schema-field"><label><span>{name}<small>{schema.type}</small></span>{schema.kind==='boolean'?<button type="button" role="switch" aria-label={label} aria-checked={actual===true} className="schema-boolean" onClick={()=>onChange(!actual)}><span/>{actual===true?'true':'false'}</button>:schema.kind==='integer'||schema.kind==='number'?<NumberValue schema={schema} value={actual} label={label} onChange={onChange}/>:<input aria-label={label} value={typeof actual==='string'?actual:''} maxLength={schema.max_length} onChange={event=>onChange(event.target.value)}/>}</label>{expose}</div>
}
export default function SchemaMessageForm({fields,value,onChange,onExpose}:{fields:Record<string,FieldSchema>;value:Record<string,unknown>;onChange:(value:Record<string,unknown>)=>void;onExpose?:(path:string[],value:unknown)=>void}){
  const {t}=useLocale()
  return <div className="schema-message-form">{Object.entries(fields).map(([name,schema])=><SchemaField key={name} name={name} schema={schema} value={value[name]} path={[name]} onChange={next=>onChange({...value,[name]:next})} onExpose={onExpose}/>)}{!Object.keys(fields).length&&<p className="ros-field-hint">{t('此接口无需填写参数')}</p>}</div>
}
