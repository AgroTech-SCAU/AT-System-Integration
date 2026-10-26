import {useState} from 'react'
import type {ApiClient} from '../api'
import {useLocale} from '../locale'
import {ErrorFields,type Json} from './shared'
export default function StopRecovery({client,run,onRecovered}:{client:ApiClient;run:Json;onRecovered:(run:Json)=>void}){
 const [reviewed,setReviewed]=useState(false),[note,setNote]=useState(''),[service,setService]=useState('')
 const {t}=useLocale(),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null)
 const operations=(run.operations||[]).filter((item:Json)=>item.operation_id?.startsWith('rosop_')&&item.stop_state==='UNCONFIRMED'&&!['ACCEPTED','RUNNING','CANCELING'].includes(item.state))
 async function recover(id:string){setBusy(true);setError(null);try{await client.request(`/ros/operations/${id}/confirm-stop`,'POST',{previous_executor_stopped:reviewed,note,service});onRecovered(run.id?.startsWith('session_')?(await client.request<Json>('/state-machines/status')).session:await client.request<Json>('/tasks/'+run.task_run_id))}catch(cause){setError(cause)}finally{setBusy(false)}}
 if(!operations.length)return null
 return <section className="ros-stop-message"><strong>{t('设备停止尚未确认')}</strong><p>{t('按任务配置核对动作终态与停止反馈，确认后才解除资源占用')}</p>{operations.some((item:Json)=>item.previous_session)&&<><label className="toggle"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>{t('已核对旧执行进程停止且不会继续派发命令')}</label><label className="field"><span>{t('核对依据')}</span><textarea value={note} onChange={e=>setNote(e.target.value)}/></label><label className="field"><span>{t('设备停止核对服务')}</span><input value={service} onChange={e=>setService(e.target.value)} placeholder="/device/confirm_stopped"/></label><p>{t('服务必须确认没有活动目标且设备已停止，留空使用任务已配置的核对服务')}</p></>}{operations.map((item:Json)=><button key={item.operation_id} disabled={busy||item.previous_session&&(!reviewed||note.trim().length<4)} onClick={()=>void recover(item.operation_id)}>{t(busy?'正在核对停止状态':'核对设备停止状态')}</button>)}<ErrorFields value={error}/></section>
}
