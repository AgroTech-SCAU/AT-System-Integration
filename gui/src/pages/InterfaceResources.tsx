import {useEffect, useRef, useState} from 'react'
import type {ApiClient} from '../api'
import {useLocale} from '../locale'
import {Icon} from '../components/Icon'
import {ErrorFields} from './shared'

type Source = {path:string; mode:'source'|'installed'}
type Preview = {
  digest:string
  conflicts:{package:string;sources:string[]}[]
  diagnostics:{code:string;reason:string;ros_type?:string}[]
  affected_tasks:{id:string;name:string;ros_type:string}[]
  types:{ros_type:string;source:string;dependency:boolean}[]
}

export default function InterfaceResources({client,onChanged,onClose}: {
  client:ApiClient;onChanged:()=>Promise<unknown>;onClose:()=>void
}) {
  const {t:translate}=useLocale()
  const [sources,setSources]=useState<Source[]>([{path:'',mode:'source'}])
  const [basePath,setBasePath]=useState(''),[choices,setChoices]=useState<Record<string,string>>({})
  const [preview,setPreview]=useState<Preview|null>(null),[busy,setBusy]=useState(false)
  const [error,setError]=useState<unknown>(null),[notice,setNotice]=useState('')
  const [packageName,setPackageName]=useState(''),[files,setFiles]=useState<File[]>([])
  const alive=useRef(true)
  useEffect(()=>{
    alive.current=true
    void client.request<{configuration:{sources:Source[];base_path:string;choices:Record<string,string>;diagnostics?:Preview['diagnostics']}}>('/ros/interface-types').then(({configuration})=>{
      if(!alive.current)return
      if(configuration.sources.length)setSources(configuration.sources.map(({path,mode})=>({path,mode})))
      setBasePath(configuration.base_path);setChoices(configuration.choices)
      if(configuration.diagnostics?.length)setNotice(configuration.diagnostics.map(issue=>issue.reason).join('；'))
    }).catch(cause=>{if(alive.current)setError(cause)})
    return()=>{alive.current=false}
  },[client])
  const invalidate=()=>{setPreview(previous=>previous?{...previous,digest:''}:null);setNotice('')}
  async function perform(action:()=>Promise<void>){
    if(busy)return
    setBusy(true);setError(null);setNotice('')
    try{await action()}catch(cause){if(alive.current)setError(cause)}finally{if(alive.current)setBusy(false)}
  }
  const request=()=>({sources:sources.map(source=>({...source,path:source.path.trim()})),base_path:basePath.trim(),choices})
  async function inspect(){
    const result=await client.request<Preview>('/ros/interface-sources/preview','POST',request())
    if(alive.current)setPreview(result)
  }
  async function apply(){
    if(!preview?.digest)return
    const result=await client.request<{diagnostics:Preview['diagnostics']}>('/ros/interface-sources','PUT',{...request(),digest:preview.digest})
    await onChanged()
    if(alive.current)setNotice(result.diagnostics.length?translate('可用定义已保存，请处理列出的缺项'):translate('接口资源已保存'))
  }
  async function upload(){
    const definitions=await Promise.all(files.map(async file=>({name:file.name,content:await file.text()})))
    await client.request('/ros/interface-types/import','POST',{package:packageName.trim(),files:definitions})
    await onChanged()
    if(alive.current){setNotice(translate('接口资源已保存'));setFiles([])}
  }
  return <section className="interface-resources" aria-label={translate('接口资源')}>
    <header><div><h2>{translate('接口资源')}</h2><p>{translate('选择当前工程使用的工作区，任务使用其中保存的类型定义')}</p></div><button disabled={busy} onClick={onClose} aria-label={translate('返回任务')}><Icon name="x"/></button></header>
    <p className="ros-field-hint">{translate('路径位于 Studio 服务所在主机，源码工作区无需编译即可读取')}</p>
    <fieldset disabled={busy}>
      {sources.map((source,index)=><div className="interface-source-row" key={index}>
        <input aria-label={translate('工作区路径 {0}',{0:index+1})} value={source.path} placeholder={translate('工作区文件夹的绝对路径')} onChange={event=>{setSources(previous=>previous.map((item,position)=>position===index?{...item,path:event.target.value}:item));invalidate()}}/>
        <select aria-label={translate('读取方式')} value={source.mode} onChange={event=>{setSources(previous=>previous.map((item,position)=>position===index?{...item,mode:event.target.value as Source['mode']}:item));invalidate()}}><option value="source">{translate('源码工作区')}</option><option value="installed">{translate('安装目录')}</option></select>
        <button disabled={sources.length===1} aria-label={translate('移除工作区')} onClick={()=>{setSources(previous=>previous.filter((_,position)=>position!==index));invalidate()}}><Icon name="x"/></button>
      </div>)}
      <button disabled={sources.length>=16} onClick={()=>{setSources(previous=>[...previous,{path:'',mode:'source'}]);invalidate()}}><Icon name="plus"/>{translate('添加工作区')}</button>
      <label className="field"><span>{translate('基础 ROS 安装路径')}</span><input value={basePath} placeholder={translate('可选，用于补齐标准接口依赖')} onChange={event=>{setBasePath(event.target.value);invalidate()}}/></label>
      <div className="buttons"><button disabled={sources.some(source=>!source.path.trim())} onClick={()=>void perform(inspect)}><Icon name="search"/>{translate('预览接口')}</button><button className="primary" disabled={!preview?.digest||!!preview.conflicts.length} onClick={()=>void perform(apply)}>{translate('保存接口资源')}</button></div>
      {preview&&<div className="interface-source-preview">
        <strong>{translate('工作区接口 {0} · 依赖接口 {1}',{0:preview.types.filter(item=>!item.dependency).length,1:preview.types.filter(item=>item.dependency).length})}</strong>
        {preview.conflicts.map(conflict=><label className="field" key={conflict.package}><span>{translate('选择接口包来源')} · {conflict.package}</span><select value={choices[conflict.package]||''} onChange={event=>{setChoices(previous=>({...previous,[conflict.package]:event.target.value}));invalidate()}}><option value="">{translate('请选择来源后重新预览')}</option>{conflict.sources.map(path=><option key={path} value={path}>{path}</option>)}</select></label>)}
        {!!preview.diagnostics.length&&<ul className="interface-source-issues">{preview.diagnostics.map((issue,index)=><li key={index}>{issue.ros_type&&<code>{issue.ros_type} </code>}{translate(issue.reason)}</li>)}</ul>}
        {!!preview.affected_tasks.length&&<div><strong>{translate('受影响的任务')}</strong><p>{translate('已保存任务继续使用原定义，可在任务中读取新定义后检查字段')}</p>{preview.affected_tasks.map(task=><div key={task.id}>{task.name} · <code>{task.ros_type}</code></div>)}</div>}
        <details><summary>{translate('查看工作区接口')}</summary><div className="interface-source-types">{preview.types.filter(item=>!item.dependency).map(item=><div key={item.ros_type}><code>{item.ros_type}</code><small>{item.source}</small></div>)}</div></details>
      </div>}
      <details className="interface-file-import"><summary>{translate('从接口文件导入')}</summary><label className="field"><span>{translate('接口所属包名')}</span><input value={packageName} onChange={event=>setPackageName(event.target.value)}/></label><label className="field"><span>{translate('原生接口文件')}</span><input type="file" accept=".msg,.srv,.action" multiple onChange={event=>setFiles(Array.from(event.target.files||[]))}/></label><button disabled={!packageName.trim()||!files.length} onClick={()=>void perform(upload)}>{translate('导入定义')}</button></details>
    </fieldset>
    {error!=null&&<ErrorFields value={error}/>}
    <div role="status">{busy?translate('正在读取接口'):notice}</div>
  </section>
}
