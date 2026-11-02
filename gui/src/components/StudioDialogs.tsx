import {useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore} from 'react'
import {AnimatePresence, motion} from 'motion/react'
import {createPortal} from 'react-dom'
import {ApiError} from '../api'
import {useLocale} from '../locale'
import {springs, fade} from '../motion'
import './studio-dialogs.css'

type Choice={id:string;label:string;primary?:boolean;danger?:boolean}
type DialogRequest={id:number;title:string;description?:string;advice?:string;technical?:string;input?:string;choices:Choice[];error?:boolean;key?:string;resolve:(value:string|null)=>void}
let serial=0,queue:DialogRequest[]=[]
const lastReadErrors=new Map<string,number>()
const listeners=new Set<()=>void>(),seenErrors=new WeakSet<object>()
const notify=()=>listeners.forEach(listener=>listener())
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}}
const snapshot=()=>queue[0]||null
function request(options:Omit<DialogRequest,'id'|'resolve'>){return new Promise<string|null>(resolve=>{queue=[...queue,{...options,id:++serial,resolve}];notify()})}
function finish(id:number,value:string|null){const item=queue.find(item=>item.id===id);queue=queue.filter(item=>item.id!==id);notify();item?.resolve(value)}
export async function confirmDialog(description:string,label='继续',danger=false){return await request({title:label,description,choices:[{id:'cancel',label:'取消'},{id:'accept',label,primary:true,danger}]})==='accept'}
export function nameDialog(title:string,name:string,action='创建副本'){return request({title,input:name,choices:[{id:'cancel',label:'取消'},{id:'input',label:action,primary:true}]})}
export async function unsavedDialog(name:string,save:()=>Promise<boolean>,discard?:()=>void){
  const choice=await request({title:'保存更改后离开',description:name,advice:'当前内容有未保存的更改',choices:[{id:'cancel',label:'继续编辑'},{id:'discard',label:'不保存'},{id:'save',label:'保存并离开',primary:true}]})
  if(choice==='discard'){discard?.();return true}
  if(choice==='save'){try{return await save()}catch(cause){reportError(cause,'保存失败');return false}}
  return false
}
export function reportError(cause:unknown,title='操作未完成'){
  if(!cause)return
  if(typeof cause==='object'){if(seenErrors.has(cause))return;seenErrors.add(cause)}
  const api=cause instanceof ApiError?cause:null
  const issues=api?.details||(cause as {errors?:{path:string;code:string;reason:string}[]})?.errors
  const internal=issues?.some(issue=>['extra_forbidden','http_error'].includes(issue.code))
  const description=api?.kind==='offline'?'无法连接 Studio 服务':api?.kind==='unauthorized'?'后台认证已失效，请重新连接':internal?'应用未能接收本次配置，操作未完成':issues?.length?[...new Set(issues.map(issue=>issue.reason))].join('\n'):cause instanceof Error?cause.message:String(cause)
  const advice=api?.kind==='offline'?'请检查 Studio 服务是否可用，执行结果尚未确认，不会自动重试':internal?'当前编辑内容仍保留，请复制诊断信息以定位应用问题':'当前操作未成功完成，请根据原因调整后再操作'
  const technical=issues?.length?issues.map(issue=>`${issue.path} · ${issue.reason} (${issue.code})`).join('\n'):cause instanceof Error?cause.stack||cause.message:String(cause)
  const key=description+'\n'+technical
  if(queue.some(item=>item.key===key))return
  if(api?.operation==='读取失败'){const now=Date.now();if(now-(lastReadErrors.get(key)||0)<30000)return;lastReadErrors.set(key,now);if(lastReadErrors.size>100)lastReadErrors.delete(lastReadErrors.keys().next().value!)}
  void request({title:api?.operation||title,description,advice,technical,key,error:true,choices:[{id:'close',label:'返回',primary:true}]})
}

type NavigationDetail={checks:(()=>Promise<boolean>)[]}
let navigating=false
export function deferNavigation(event:Event,check:()=>Promise<boolean>){
  const detail=(event as CustomEvent<NavigationDetail>).detail
  if(detail?.checks)detail.checks.push(check)
  else event.preventDefault()
}
export async function requestNavigation(type='agro:navigate'){
  if(navigating)return false
  navigating=true
  try{
    const detail:NavigationDetail={checks:[]}
    if(!window.dispatchEvent(new CustomEvent(type,{cancelable:true,detail})))return false
    for(const check of detail.checks)if(!await check())return false
    return true
  }finally{navigating=false}
}

function DialogCard({item}:{item:DialogRequest}){
  const {t}=useLocale(),dialog=useRef<HTMLDialogElement>(null),previous=useRef<HTMLElement|null>(null)
  const [value,setValue]=useState(item.input||''),[copied,setCopied]=useState('')
  useLayoutEffect(()=>{
    previous.current=document.activeElement as HTMLElement|null
    const node=dialog.current!;node.showModal()
    node.querySelector<HTMLElement>('input,button[data-default]')?.focus()
    node.querySelector<HTMLInputElement>('input')?.select()
    return()=>{node.close();if(previous.current?.isConnected)previous.current.focus({preventScroll:true})}
  },[])
  const close=(choice:Choice)=>{if(choice.id==='cancel')finish(item.id,null);else if(choice.id==='input'){if(value.trim())finish(item.id,value.trim())}else finish(item.id,choice.id)}
  return <motion.dialog ref={dialog} className={'studio-dialog'+(item.error?' is-error':'')} initial={{opacity:0,y:10,scale:.97}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:5,scale:.985,transition:fade}} transition={springs.panel} role={item.error?'alertdialog':'dialog'} aria-labelledby={'studio-dialog-title-'+item.id} aria-describedby={'studio-dialog-description-'+item.id} onCancel={event=>{event.preventDefault();finish(item.id,null)}} onKeyDown={event=>event.stopPropagation()}>
    <form onSubmit={event=>{event.preventDefault();const action=item.choices.find(choice=>choice.primary);if(action)close(action)}}>
      <span className="studio-dialog-kicker">ATIL Robot Studio</span><h2 id={'studio-dialog-title-'+item.id}>{t(item.title)}</h2>
      <p id={'studio-dialog-description-'+item.id}>{item.description?.split('\n').map((line,index)=><span key={index}>{t(line)}<br/></span>)}</p>
      {item.input!==undefined&&<label className="field"><span>{t(item.title==='创建副本'?'副本名称':'名称')}</span><input value={value} maxLength={80} required onChange={event=>setValue(event.target.value)}/></label>}
      {item.advice&&<p className="studio-dialog-advice">{t(item.advice)}</p>}
      {item.technical&&<details className="studio-dialog-technical"><summary>{t('技术详情')}</summary><pre>{item.technical}</pre></details>}
      <div className="studio-dialog-actions">{item.technical&&<button type="button" className="studio-dialog-copy" onClick={()=>void navigator.clipboard.writeText([t(item.title),t(item.description||''),item.technical].join('\n\n')).then(()=>setCopied('已复制')).catch(()=>setCopied('复制不可用，可展开详情手动复制'))}>{t(copied||'复制诊断')}</button>}{item.choices.map((choice,index)=><button key={choice.id} type="button" data-default={index===0?'true':undefined} className={choice.danger?'danger':choice.primary?'primary':''} disabled={choice.id==='input'&&!value.trim()} onClick={()=>close(choice)}>{t(choice.label)}</button>)}</div>
      {copied&&<span className="sr-only" role="status">{t(copied)}</span>}
    </form>
  </motion.dialog>
}
export function DialogHost(){const item=useSyncExternalStore(subscribe,snapshot,snapshot);return createPortal(<AnimatePresence mode="wait">{item&&<DialogCard key={item.id} item={item}/>}</AnimatePresence>,document.body)}
export function ErrorNotice({value,title}:{value:unknown;title?:string}){useEffect(()=>{if(value)reportError(value,title)},[value,title]);return null}
