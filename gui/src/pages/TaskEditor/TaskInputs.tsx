import type {DataContract} from '../../data-contracts'
import DataContractEditor from '../DataContractEditor'
import {useLocale} from '../../locale'
import {useState} from 'react'
import {Field} from '../../components/Foundation'
import {Parameters,JsonParameterInput,type Json} from '../shared'

const TYPES=[{value:'json',label:'结构化数据'},{value:'string',label:'字符串'},{value:'number',label:'小数'},{value:'integer',label:'整数'},{value:'boolean',label:'布尔值'}]
const validName=/^[a-z][a-z0-9_]*$/

type Props={specs:Json;values:Json;disabled:boolean;onChange:(specs:Json,values:Json)=>void}

export default function TaskInputs({specs,values,disabled,onChange}:Props){
 const {t}=useLocale()

 const [name,setName]=useState(''),[error,setError]=useState('')
 const entries=Object.entries(specs) as [string,Json][]
 function add(){
  const key=name.trim()
  if(!validName.test(key)){setError(t("参数标识使用小写字母、数字和下划线，且以字母开头"));return}
  if(Object.hasOwn(specs,key)){setError(t("参数标识已存在"));return}
  onChange({...specs,[key]:{type:'string',required:false,apply_policy:'idle'}},values)
  setName('');setError('')
 }
 function modify(key:string,patch:Json){
  const next={...specs[key],...patch}
  for(const field of ['default','unit','minimum','maximum','choices'])if(next[field]===undefined)delete next[field]
  onChange({...specs,[key]:next},values)
 }
 function changeType(key:string,next:string){
  const {default:_default,minimum:_min,maximum:_max,choices:_choices,frame_path:_framePath,stamp_path:_stampPath,...previous}=specs[key]
  const spec={...previous,type:next}
  if(next==='number'||next==='integer')spec.unit=previous.unit||'1'
  else delete spec.unit
  const updated={...values};delete updated[key]
  onChange({...specs,[key]:spec},updated)
 }
 function remove(key:string){
  const next={...specs},data={...values};delete next[key];delete data[key];onChange(next,data)
 }
 function setDefault(key:string,raw:string){
  if(raw===''){modify(key,{default:undefined});return}
  const type=specs[key].type
  if(type==='number'||type==='integer'){
   const n=Number(raw)
   if(!Number.isFinite(n)||(type==='integer'&&!Number.isInteger(n)))return
   modify(key,{default:n})
  }else modify(key,{default:raw})
 }
 return <section><h3>{t("任务参数")}</h3>
  <div className="task-input-add"><Field label={t("新参数标识")}><input disabled={disabled} value={name} placeholder={t("如 target_speed")} onChange={e=>{setName(e.target.value);setError('')}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();add()}}}/></Field><button type="button" className="primary" disabled={disabled} onClick={add}>{t("添加参数")}</button></div>
  {error&&<p className="error" role="alert">{error}</p>}
  {!entries.length&&<p className="muted">{t("未声明任务参数")}</p>}
  <div className="task-input-list">{entries.map(([key,spec])=><div className="task-input-card" key={key}>
    <div className="task-input-title"><strong>{key}</strong><button disabled={disabled} onClick={()=>remove(key)}>{t("删除")}</button></div>
    <div className="task-input-fields">
      <Field label={t("数据类型")}><select disabled={disabled} value={spec.type} onChange={e=>changeType(key,e.target.value)}>{TYPES.map(item=><option key={item.value} value={item.value}>{t(item.label)}</option>)}</select></Field>
      <Field label={t("参数要求")}><select disabled={disabled} value={spec.required?'yes':'no'} onChange={e=>modify(key,{required:e.target.value==='yes'})}><option value="no">{t("可选")}</option><option value="yes">{t("必填")}</option></select></Field>
      {(spec.type==='number'||spec.type==='integer')&&<Field label={t("单位")}><input disabled={disabled} value={spec.unit||'1'} placeholder={t("如 m 或 1")} onChange={e=>modify(key,{unit:e.target.value})}/></Field>}
      <Field label={t("生效策略")}><select disabled={disabled} value={spec.apply_policy||'idle'} onChange={e=>modify(key,{apply_policy:e.target.value})}><option value="immediate">{t("立即")}</option><option value="idle">{t("空闲时")}</option><option value="restart">{t("重启后")}</option></select></Field>
      <Field label={t("默认值")}><>{spec.type==='boolean'?<select disabled={disabled} value={spec.default===undefined?'':String(spec.default)} onChange={e=>modify(key,{default:e.target.value===''?undefined:e.target.value==='true'})}><option value="">{t("不设置")}</option><option value="true">true</option><option value="false">false</option></select>:spec.type==='json'?<JsonParameterInput disabled={disabled} value={spec.default} onChange={value=>modify(key,{default:value})} placeholder={t('不设置默认值')}/>:<input disabled={disabled} type={spec.type==='string'?'text':'number'} step={spec.type==='integer'?1:'any'} value={spec.default??''} placeholder={t("不设置默认值")} onChange={e=>setDefault(key,e.target.value)}/>}</></Field>
      {(spec.type==='number'||spec.type==='integer')&&<><Field label={t("最小值")}><input disabled={disabled} type="number" value={spec.minimum??''} onChange={e=>modify(key,{minimum:e.target.value===''?undefined:Number(e.target.value)})}/></Field><Field label={t("最大值")}><input disabled={disabled} type="number" value={spec.maximum??''} onChange={e=>modify(key,{maximum:e.target.value===''?undefined:Number(e.target.value)})}/></Field></>}
    </div><DataContractEditor disabled={disabled} value={spec as DataContract} onChange={next=>onChange({...specs,[key]:next},values)}/>
  </div>)}</div>
  {!!entries.length&&<><h3>{t("运行时参数")}</h3><Parameters specs={specs} value={values} onChange={next=>onChange(specs,next)}/></>}
 </section>
}
