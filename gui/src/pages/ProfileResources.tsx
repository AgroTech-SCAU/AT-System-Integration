import {useEffect,useState} from 'react'
import type {ApiClient} from '../api'
import DisclosureCard from '../components/DisclosureCard'
import {useLocale} from '../locale'
import {ErrorFields,type Json} from './shared'

export default function ProfileResources({client,robotId}:{client:ApiClient;robotId:string}){
 const {t}=useLocale(),[report,setReport]=useState<Json|null>(null),[mapping,setMapping]=useState<Record<string,string>>({}),[error,setError]=useState<unknown>(null),[busy,setBusy]=useState(false)
 useEffect(()=>{const controller=new AbortController();setReport(null);setMapping({});setError(null);void client.request<Json>(`/robot-profiles/${robotId}/dependencies`,'GET',undefined,controller.signal).then(setReport).catch(e=>{if(!controller.signal.aborted)setError(e)});return()=>controller.abort()},[client,robotId])
 async function apply(collect?:string[]){setBusy(true);setError(null);try{setReport(await client.request<Json>(`/robot-profiles/${robotId}/references`,'POST',collect?{collect}:{mapping:Object.fromEntries(Object.entries(mapping).filter(([,v])=>v.trim()))}));setMapping({});window.dispatchEvent(new Event('agro:ros:refresh'))}catch(e){setError(e)}finally{setBusy(false)}}
 const missing=report?.references?.filter((item:Json)=>!item.exists)||[]
 return <DisclosureCard title={t('工程依赖与资源')} count={report?.references?.length||0} summary={t('工程保存配置，外部工作区仍需在本机准备')} status={error?t('读取失败'):!report?t('正在读取'):missing.length?t('缺少 {0} 项依赖',{0:missing.length}):t('路径已就绪')}>
  <p>{report?.storage_path}</p><p>{t('重定位后需要重新加载受影响的执行环境，参数和标定文件可收集到工程内')}</p>
  {(report?.references||[]).map((item:Json)=><DisclosureCard key={item.path} title={item.path} summary={item.used_by.join(' · ')} status={t(item.exists?'路径存在':'路径不存在')}>
   <label className="field"><span>{t('新路径')}</span><input disabled={busy} value={mapping[item.path]||''} onChange={e=>setMapping({...mapping,[item.path]:e.target.value})}/></label>
   {item.packable&&item.file&&<button disabled={busy} onClick={()=>void apply([item.path])}>{t('收集文件到工程')}</button>}
  </DisclosureCard>)}
  <button disabled={busy||!Object.values(mapping).some(v=>v.trim())} onClick={()=>void apply()}>{t('应用路径重定位')}</button><ErrorFields value={error}/>
 </DisclosureCard>
}
