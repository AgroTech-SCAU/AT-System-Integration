import type {ApiClient} from '../api'
import {waitJob,type Json} from './shared'
// Existing projects with managed drivers start their environment as part of Run
export async function prepareRobot(client:ApiClient,workflow?:{kind:string;reference:string;confirm_safety:boolean}){
 if(workflow){
  const job=await client.request<Json>('/deployment/prepare','POST',{...workflow,request_id:'prepare_'+crypto.randomUUID().replaceAll('-','')})
  await waitJob(client,job.management_job_id,()=>{},undefined,600000)
 }
 const [directory,status]=await Promise.all([client.request<Json>('/robot-systems'),client.request<Json>('/system/status')])
 const robot=directory.systems.find((item:Json)=>item.id===directory.selected_id)
 if(!robot?.configured||status.state!=='STOPPED')return
 const job=await client.request<Json>('/system/start','POST',{request_id:'prepare_'+crypto.randomUUID().replaceAll('-','')})
 await waitJob(client,job.management_job_id,()=>{})
}
