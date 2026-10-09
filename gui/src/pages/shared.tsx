import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiClient, ApiError } from '../api'
import { Field, PendingDialog } from '../components/Foundation'
import { messages } from '../i18n'
import type { Language, Observation } from '../types'

export type Json = Record<string, any>
export interface PageProps { client: ApiClient; observation: Observation | null; language: Language; changed(): Promise<void> }
export function ErrorFields({ value }: {value: unknown}) {
  if (!value) return null
  const errors = value instanceof ApiError ? value.details : (value as Json).errors
  return <div className="error" role="alert">{errors?.length ? errors.map((e: Json, i: number) => <p key={i}><code>{e.path}</code> · {e.reason} ({e.code})</p>) : <p>{value instanceof ApiError && value.kind === 'unauthorized' ? '后台认证已失效，请重新连接' : '请求未完成，请核对后台状态后重试'}</p>}</div>
}
export function Parameters({ specs, value, onChange }: {specs: Json; value: Json; onChange(value: Json): void}) {
  return <div className="parameter-grid">{Object.entries(specs).map(([name, spec]: [string, any]) => {
    const update = (next: unknown) => { const copy = { ...value }; if (next === undefined) delete copy[name]; else copy[name] = next; onChange(copy) }
    return <Field key={name} label={`${name}${spec.unit ? ` (${spec.unit})` : ''}${spec.required ? ' *' : ''}`}>
      {spec.choices ? <select value={value[name] === undefined ? '' : JSON.stringify(value[name])} onChange={e => update(e.target.value === '' ? undefined : JSON.parse(e.target.value))}><option value="">使用缺省值</option>{spec.choices.map((x: unknown,i:number) => <option key={i} value={JSON.stringify(x)}>{String(x)}</option>)}</select>
        : spec.type === 'boolean' ? <select value={value[name] === undefined ? '' : String(value[name])} onChange={e => update(e.target.value === '' ? undefined : e.target.value === 'true')}><option value="">使用缺省值</option><option value="true">true</option><option value="false">false</option></select>
        : <input type={spec.type === 'string' ? 'text' : 'number'} step={spec.type === 'integer' ? 1 : 'any'} min={spec.minimum} max={spec.maximum} value={value[name] ?? ''} placeholder={spec.default === undefined ? '未设置' : String(spec.default)} onChange={e => update(e.target.value === '' ? undefined : spec.type === 'string' ? e.target.value : Number(e.target.value))} />}
      <small className="muted">{spec.minimum !== undefined ? `最小 ${spec.minimum} ` : ''}{spec.maximum !== undefined ? `最大 ${spec.maximum} ` : ''} · {spec.apply_policy}</small>
    </Field>
  })}</div>
}
export function useOperation(language: Language) {
  const [busy,setBusy]=useState(false),[open,setOpen]=useState(false),[phase,setPhase]=useState(''),[error,setError]=useState<unknown>(null)
  const locked=useRef(false), alive=useRef(true), observer=useRef<AbortController|null>(null)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;observer.current?.abort()}},[])
  async function run(title:string,work:(phase:(v:string)=>void,signal:AbortSignal)=>Promise<void>) {
    if(locked.current) return
    observer.current=new AbortController();locked.current=true;setBusy(true);setOpen(true);setPhase(title);setError(null)
    try { await work(v=>{if(alive.current)setPhase(v)},observer.current.signal) }
    catch(cause){if(alive.current&&!observer.current?.signal.aborted)setError(cause)}
    finally{locked.current=false;if(alive.current){setBusy(false);setOpen(false)}}
  }
  const dialog=(actions?:ReactNode)=><PendingDialog open={open} text={{...messages(language),pendingDescription:phase}} onClose={()=>{observer.current?.abort();setOpen(false)}} actions={actions}/>
  return {busy,error,run,dialog,setError}
}
export async function waitJob(client:ApiClient,key:string,phase:(v:string)=>void,signal?:AbortSignal) {
  const deadline=Date.now()+30000
  while(Date.now()<deadline) {
    signal?.throwIfAborted()
    const job=await client.request<Json>(`/management/jobs/${encodeURIComponent(key)}`,'GET',undefined,signal)
    phase(`${job.action} · ${job.phase}`)
    if(job.phase==='completed') return job.result
    if(['failed','rolled_back','blocked'].includes(job.phase)) throw new ApiError('response',job.error?.errors || [{path:'$.management',code:job.phase,reason:job.error?.reason||'操作未完成'}])
    await new Promise(r=>setTimeout(r,400))
  }
  throw new ApiError('response',[{path:'$.management',code:'observation_timeout',reason:'等待已结束，操作结果尚未确认，请按原请求核对'}])
}
export function requestId(){return 'request_'+crypto.randomUUID().replaceAll('-','')}
export function durableIntent(key:string,payload:unknown){
  const data=JSON.stringify(payload)
  try { const old=JSON.parse(localStorage.getItem('agro.intent.'+key)||'null'); if(old?.data===data)return old.id } catch{}
  const id=requestId();localStorage.setItem('agro.intent.'+key,JSON.stringify({id,data}));return id
}

export function finishIntent(key:string){localStorage.removeItem('agro.intent.'+key)}
