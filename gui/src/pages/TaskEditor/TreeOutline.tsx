import {useState, type DragEvent} from 'react'
import type {Json} from '../shared'
import {nodeLabel} from './labels'

export default function TreeOutline({tree,labels,selected,onSelect,onAdd,onReparent,disabled}: {
  tree:Json;labels:Record<string,string>;selected:string;onSelect:(id:string)=>void
  onAdd:(parent:string,registration:string)=>void;onReparent:(node:string,parent:string)=>void;disabled:boolean
}){
  const [hover,setHover]=useState('')
  const visited=new Set<string>()
  const entries:{id:string;depth:number;order:number}[]=[]
  function visit(id:string,depth:number,order:number){
    if(visited.has(id)||!tree.nodes[id])return
    visited.add(id);entries.push({id,depth,order})
    tree.nodes[id].children.forEach((child:string,index:number)=>visit(child,depth+1,index+1))
  }
  visit(tree.root_id,0,0)
  const anyChildren=(id:string)=>tree.nodes[id]?.children.length>0
  const canParent=(id:string)=>id!==undefined&&id!==''&&id in tree.nodes
  function drop(event:DragEvent<HTMLButtonElement>,parent:string){
    event.preventDefault();event.stopPropagation();setHover('')
    if(disabled)return
    const registration=event.dataTransfer.getData('application/x-agro-node')
    const moving=event.dataTransfer.getData('application/x-agro-tree-node')
    if(registration)onAdd(parent,registration)
    else if(moving&&moving!==tree.root_id&&moving!==parent)onReparent(moving,parent)
  }
  return <div className="studio-outline" role="tree" aria-label="任务结构">
    <p className="muted">点击节点编辑 · 把节点拖到另一个节点上以改变父子关系</p>
    {entries.map(({id,depth,order})=>{const node=tree.nodes[id];return <button
      key={id} type="button" role="treeitem" aria-selected={selected===id}
      className={'studio-outline-item'+(selected===id?' current':'')+(hover===id?' drop-target':'')}
      style={{paddingLeft:12+depth*16}}
      onClick={()=>onSelect(id)}
      draggable={!disabled&&id!==tree.root_id}
      onDragStart={e=>{e.dataTransfer.setData('application/x-agro-tree-node',id);e.dataTransfer.effectAllowed='move'}}
      onDragOver={e=>{if(!disabled&&canParent(id)){e.preventDefault();e.dataTransfer.dropEffect='move';setHover(id)}}}
      onDragLeave={()=>setHover('')}
      onDrop={e=>drop(e,id)}
    ><span className="studio-outline-guide">{depth===0?'◆':anyChildren(id)?'▾':'·'}</span><span className="studio-outline-label">{labels[id]||nodeLabel(node.registration_id)}</span><small>{order||'ROOT'}</small></button>})}
  </div>
}
