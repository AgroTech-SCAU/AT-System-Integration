import {useState} from 'react'
import {useLocale} from '../../locale'
import {Field} from '../../components/Foundation'
import type {Json} from '../shared'
import Icon from './WorkbenchIcon'

type Props = {
 items:Json[];busy:boolean;loaded:boolean;error:React.ReactNode
 onOpen(item:Json):void;onCreate(name:string):Promise<boolean>;onRename(item:Json,name:string):Promise<boolean>
 onCopy(item:Json,name:string):Promise<boolean>;onDelete(item:Json):Promise<boolean>;onImport(file:File):void
}
export default function BehaviorLibrary({items,busy,loaded,error,onOpen,onCreate,onRename,onCopy,onDelete,onImport}:Props){
 const {t}=useLocale()
 const [query,setQuery]=useState(''),[dialog,setDialog]=useState<{kind:'create'|'rename'|'copy'|'delete';item?:Json}|null>(null),[name,setName]=useState('')
 const phases:Record<string,string>={entry:t('进入'),do:t('持续'),exit:t('退出')}
 const filtered=items.filter(item=>`${item.name} ${(item.uses||[]).map((use:Json)=>`${use.machine_name} ${use.state_name}`).join(' ')}`.toLowerCase().includes(query.toLowerCase()))
 function open(kind:'create'|'rename'|'copy'|'delete',item?:Json){setName(kind==='copy'?`${item?.name} ${t('副本')}`:item?.name||t('未命名行为树'));setDialog({kind,item})}
 async function submit(){if(!dialog)return;const next=name.trim();if(dialog.kind!=='delete'&&!next)return
  const saved=dialog.kind==='create'?await onCreate(next):dialog.kind==='rename'?await onRename(dialog.item!,next):dialog.kind==='copy'?await onCopy(dialog.item!,next):await onDelete(dialog.item!)
  if(saved)setDialog(null)
 }
 const title=dialog?{create:t('新建行为树'),rename:t('重命名行为树'),copy:t('复制行为树'),delete:t('删除行为树')}[dialog.kind]:''
 return <div className="bw-assets">
  <header className="bw-assets-header"><div><h2>{t('行为树')}</h2><p>{t('组合任务，管理可复用的执行逻辑')}</p></div><div className="bw-assets-actions"><label className="bw-asset-import">{t('导入 XML')}<input type="file" accept=".xml" disabled={busy} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)onImport(file)}}/></label><button className="bw-publish" disabled={busy||!loaded} onClick={()=>open('create')}><Icon name="plus"/>{t('新建行为树')}</button></div></header>
  <div className="bw-assets-search"><Icon name="search"/><input aria-label={t('搜索行为树或使用位置')} placeholder={t('搜索行为树或使用位置')} value={query} onChange={event=>setQuery(event.target.value)}/><span>{items.length}</span></div>
  <div className="bw-assets-list">
   {filtered.map(item=><article className="bw-asset-row" key={item.id}>
    <button className="bw-asset-open" onClick={()=>onOpen(item)} disabled={busy}><Icon name="tree"/><span><strong>{item.name}</strong><small>{t('{0} 个节点',{0:Object.values(item.document?.trees||{}).reduce((count:number,tree:any)=>count+Object.keys(tree.nodes).length,0)})}</small></span><Icon name="chevron"/></button>
    <div className="bw-asset-uses">{item.uses?.length?<details><summary>{t('{0} 处使用',{0:item.uses.length})}</summary>{item.uses.map((use:Json,index:number)=><span key={index}>{use.machine_name} / {use.state_name} / {phases[use.phase]}</span>)}</details>:<span>{t('尚未关联状态')}</span>}</div>
    <div className="bw-asset-actions"><button disabled={busy||!item.id.startsWith('draft_')} onClick={()=>open('rename',item)}>{t('重命名')}</button><button disabled={busy} onClick={()=>open('copy',item)}><Icon name="copy"/>{t('复制')}</button><button disabled={busy||!!item.uses?.length} title={item.uses?.length?t('解除状态关联后可删除'):t('删除行为树')} onClick={()=>open('delete',item)}><Icon name="trash"/>{t('删除')}</button></div>
   </article>)}
   {!filtered.length&&<div className="bw-empty"><Icon name={query?'search':'tree'}/><h3>{!loaded?t('正在读取行为树'):query?t('没有匹配的行为树'):t('还没有行为树')}</h3>{!query&&loaded&&<><p>{t('创建行为树后，从任务库添加执行内容')}</p><button className="bw-publish" disabled={busy} onClick={()=>open('create')}><Icon name="plus"/>{t('新建行为树')}</button></>}</div>}
  </div>
  {!dialog&&error}
  {dialog&&<div className="bw-popover-backdrop" onPointerDown={event=>{if(event.target===event.currentTarget&&!busy)setDialog(null)}}><form className="bw-extract" role="dialog" aria-modal="true" aria-label={title} onSubmit={event=>{event.preventDefault();void submit()}} onKeyDown={event=>{if(event.key==='Escape'&&!busy)setDialog(null);if(event.key==='Tab'){const items=event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)');if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items[items.length-1]?.focus()}else if(!event.shiftKey&&document.activeElement===items[items.length-1]){event.preventDefault();items[0]?.focus()}}}}><header><h3>{title}</h3><button type="button" aria-label={t('关闭')} disabled={busy} onClick={()=>setDialog(null)}><Icon name="close"/></button></header>{dialog.kind==='delete'?<p>{t('删除「{0}」后，将从行为树列表中移除，历史运行记录仍然保留',{0:dialog.item?.name})}</p>:<Field label={t('行为树名称')}><input autoFocus value={name} maxLength={80} onChange={event=>setName(event.target.value)}/></Field>}{error}<footer><button type="button" disabled={busy} onClick={()=>setDialog(null)}>{t('取消')}</button><button type="submit" className={dialog.kind==='delete'?'bw-danger':'bw-publish'} disabled={busy||dialog.kind!=='delete'&&!name.trim()}>{dialog.kind==='delete'?t('删除'):t('确定')}</button></footer></form></div>}
 </div>
}
