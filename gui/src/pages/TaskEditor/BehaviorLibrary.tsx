import {motion} from 'motion/react'
import {confirmDialog, nameDialog} from '../../components/StudioDialogs'
import {useState} from 'react'
import {useLocale} from '../../locale'
import type {Json} from '../shared'
import Icon from './WorkbenchIcon'

type Props = {
 items:Json[];busy:boolean;loaded:boolean;error:React.ReactNode
 onOpen(item:Json):void;onCreate(name:string):Promise<boolean>;onRename(item:Json,name:string):Promise<boolean>
 onCopy(item:Json,name:string):Promise<boolean>;onDelete(item:Json):Promise<boolean>;onImport(file:File):void
}
export default function BehaviorLibrary({items,busy,loaded,error,onOpen,onCreate,onRename,onCopy,onDelete,onImport}:Props){
 const {t}=useLocale()
 const [query,setQuery]=useState('')
 const phases:Record<string,string>={entry:t('进入'),do:t('持续'),exit:t('退出')}
 const filtered=items.filter(item=>`${item.name} ${(item.uses||[]).map((use:Json)=>`${use.machine_name} ${use.state_name}`).join(' ')}`.toLowerCase().includes(query.toLowerCase()))
 async function open(kind:'create'|'rename'|'copy'|'delete',item?:Json){
  const title={create:t('新建行为树'),rename:t('重命名行为树'),copy:t('复制行为树'),delete:t('删除行为树')}[kind]
  if(kind==='delete'){if(await confirmDialog(t('删除「{0}」后，将从行为树列表中移除，历史运行记录仍然保留',{0:item?.name}),title,true))await onDelete(item!);return}
  const name=await nameDialog(title,kind==='copy'?`${item?.name} ${t('副本')}`:item?.name||t('未命名行为树'),kind==='create'?t('创建'):kind==='rename'?t('保存'):t('创建副本'))
  if(!name)return
  if(kind==='create')await onCreate(name);else if(kind==='rename')await onRename(item!,name);else await onCopy(item!,name)
 }
 return <div className="bw-assets">
  <header className="bw-assets-header"><div><h2>{t('行为树')}</h2><p>{t('组合任务，管理可复用的执行逻辑')}</p></div><div className="bw-assets-actions"><label className="bw-asset-import">{t('导入 XML')}<input type="file" accept=".xml" disabled={busy} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)onImport(file)}}/></label><button className="bw-publish" disabled={busy||!loaded} onClick={()=>open('create')}><Icon name="plus"/>{t('新建行为树')}</button></div></header>
  <div className="bw-assets-search"><Icon name="search"/><input aria-label={t('搜索行为树或使用位置')} placeholder={t('搜索行为树或使用位置')} value={query} onChange={event=>setQuery(event.target.value)}/><span>{items.length}</span></div>
  <div className="bw-assets-list">
   {filtered.map(item=><motion.article layoutId={"behavior-card-"+item.id} transition={{duration:.28,ease:[.2,0,0,1]}} className="bw-asset-row" key={item.id}>
    <button className="bw-asset-open" onClick={()=>onOpen(item)} disabled={busy}><Icon name="tree"/><span><strong>{item.name}</strong><small>{t('{0} 个节点',{0:Object.values(item.document?.trees||{}).reduce((count:number,tree:any)=>count+Object.keys(tree.nodes).length,0)})}</small></span><Icon name="chevron"/></button>
    <div className="bw-asset-uses">{item.uses?.length?<details><summary>{t('{0} 处使用',{0:item.uses.length})}</summary>{item.uses.map((use:Json,index:number)=><span key={index}>{use.machine_name} / {use.state_name} / {phases[use.phase]}</span>)}</details>:<span>{t('尚未关联状态')}</span>}</div>
    <div className="bw-asset-actions"><button disabled={busy||!item.id.startsWith('draft_')} onClick={()=>open('rename',item)}>{t('重命名')}</button><button disabled={busy} onClick={()=>open('copy',item)}><Icon name="copy"/>{t('复制')}</button><button disabled={busy||!!item.uses?.length} title={item.uses?.length?t('解除状态关联后可删除'):t('删除行为树')} onClick={()=>open('delete',item)}><Icon name="trash"/>{t('删除')}</button></div>
   </motion.article>)}
   {!filtered.length&&<div className="bw-empty"><Icon name={query?'search':'tree'}/><h3>{!loaded?t('正在读取行为树'):query?t('没有匹配的行为树'):t('还没有行为树')}</h3>{!query&&loaded&&<><p>{t('创建行为树后，从任务库添加执行内容')}</p><button className="bw-publish" disabled={busy} onClick={()=>open('create')}><Icon name="plus"/>{t('新建行为树')}</button></>}</div>}
  </div>
  {error}
 </div>
}
