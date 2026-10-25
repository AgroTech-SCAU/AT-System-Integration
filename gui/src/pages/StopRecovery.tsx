import {useState} from 'react'
import type {ApiClient} from '../api'
import {useLocale} from '../locale'
import {ErrorFields,type Json} from './shared'
export default function StopRecovery({client,run,onRecovered}:{client:ApiClient;run:Json;onRecovered:(run:Json)=>void}){
 const {t}=useLocale(),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null)
 const operations=(run.operations||[]).filter((item:Json)=>item.operation_id?.startsWith('rosop_')&&item.stop_state==='UNCONFIRMED'&&!['ACCEPTED','RUNNING','CANCELING'].includes(item.state))
 async function recover(id:string){setBusy(true);setError(null);try{await client.request(`/ros/operations/${id}/confirm-stop`,'POST',{});onRecovered(run.id?.startsWith('session_')?(await client.request<Json>('/state-machines/status')).session:await client.request<Json>('/tasks/'+run.task_run_id))}catch(cause){setError(cause)}finally{setBusy(false)}}
 if(!operations.length)return null
 return <section className="ros-stop-message"><strong>{t('设备停止尚未确认')}</strong><p>{t('按任务配置核对动作终态与停止反馈，确认后才解除资源占用')}</p>{operations.map((item:Json)=><button key={item.operation_id} disabled={busy} onClick={()=>void recover(item.operation_id)}>{t(busy?'正在核对停止状态':'核对设备停止状态')}</button>)}<ErrorFields value={error}/></section>
}
