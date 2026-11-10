import type {ApiClient} from '../api'
import {waitJob,type Json} from './shared'
export type WorkflowPreparation={kind:string;reference:string;confirm_safety:boolean;inputs?:Record<string,unknown>}
type PreparationOptions={signal?:AbortSignal;onSubmitting?:(pending:Promise<unknown>)=>void}
// Existing projects with managed drivers start their environment as part of Run
export async function prepareRobot(client:ApiClient,workflow?:WorkflowPreparation,onJob?:(job:Json)=>void,options:PreparationOptions={}){
 const {signal}=options
 async function submit(path:string,body:unknown){
  signal?.throwIfAborted()
  // Keep the acceptance request observable before a caller submits Stop
  const pending=client.request<Json>(path,'POST',body)
  options.onSubmitting?.(pending)
  const result=await pending
  signal?.throwIfAborted()
  return result
 }
 signal?.throwIfAborted()
 if(workflow){
  const job=await submit('/deployment/prepare',{...workflow,request_id:'prepare_'+crypto.randomUUID().replaceAll('-','')})
  await waitJob(client,job.management_job_id,()=>{},signal,600000,onJob)
 }
 signal?.throwIfAborted()
 const [directory,status]=await Promise.all([client.request<Json>('/robot-systems','GET',undefined,signal),client.request<Json>('/system/status','GET',undefined,signal)])
 signal?.throwIfAborted()
 const robot=directory.systems.find((item:Json)=>item.id===directory.selected_id)
 if(!robot?.configured||status.state!=='STOPPED')return
 const job=await submit('/system/start',{request_id:'prepare_'+crypto.randomUUID().replaceAll('-','')})
 await waitJob(client,job.management_job_id,()=>{},signal,30000,onJob)
}
