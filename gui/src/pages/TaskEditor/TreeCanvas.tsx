import {motion} from 'motion/react'
import {useStudioCamera, useAnimatedGeometry} from '../../motion'
import {useLocale} from '../../locale'
import {useEffect,useMemo,useRef,useState} from 'react'
import type {Json} from '../shared'
import {positions,canAdopt,descendants,parentOf} from './editor'
import {nodeLabel} from './labels'
import Icon from './WorkbenchIcon'

type Camera={x:number;y:number;zoom:number}
type Slot={parent:string;before?:string;x:number;y:number;order:number}
type Drag={kind:'pan';x:number;y:number;camera:Camera}|{kind:'node';id:string;x:number;y:number;px:number;py:number}|{kind:'connect';id:string;x:number;y:number}
type Props={tree:Json;layout:Json;models?:Json;selected:string;onSelect(id:string):void;onMove?(id:string,x:number,y:number):void;onInsert?:(parentId:string,registration:string,before?:string)=>void;onReparent?:(node:string,parent:string,before?:string)=>void;onAddAt?:(parent:string,before?:string)=>void;onOpen?:(id:string)=>void;onDelete?:(id:string)=>void;onDuplicate?:(id:string)=>void;states?:Record<string,string>;lastStates?:Record<string,string>;bindings?:Json[];portModels?:Json;language?:'zh'|'en';fit?:boolean;viewKey?:string;diagnostics?:Json[];layoutKey?:number}
const WIDTH=190,HEIGHT=68
export default function TreeCanvas({tree,layout,models={},selected,onSelect,onMove,onInsert,onReparent,onAddAt,onOpen,onDelete,onDuplicate,states={},lastStates={},bindings=[],portModels={},language='zh',fit=false,viewKey,diagnostics=[],layoutKey=0}:Props){
 const {t}=useLocale(),response=useStudioCamera()
 const viewport=useRef<HTMLDivElement>(null),svg=useRef<SVGSVGElement>(null),menuElement=useRef<HTMLDivElement>(null),drag=useRef<Drag|null>(null)
 const [size,setSize]=useState({width:0,height:0}),[camera,setCamera]=useState<Camera>({x:0,y:0,zoom:1}),[preview,setPreview]=useState<Record<string,[number,number]>>({}),[connection,setConnection]=useState<{id:string;x:number;y:number}|null>(null),[dropSlot,setDropSlot]=useState<Slot|null>(null),[panning,setPanning]=useState(false),[moving,setMoving]=useState(''),[paletteDrag,setPaletteDrag]=useState(false),[menu,setMenu]=useState<{x:number;y:number;id?:string}|null>(null)
 const cameraRef=useRef(camera),savedViews=useRef<Record<string,Camera>>({}),space=useRef(false),initialized=useRef(''),previewRef=useRef(preview),slotRef=useRef(dropSlot)
 cameraRef.current=camera;previewRef.current=preview;slotRef.current=dropSlot
 useEffect(()=>response.move({x:camera.x,y:camera.y,scale:camera.zoom},panning),[camera,response,panning])
 function directCamera(next:Camera){response.move({x:next.x,y:next.y,scale:next.zoom},true);cameraRef.current=next;setCamera(next)}
 const automatic=useMemo(()=>positions(tree,layout.collapsed||[]),[tree,layout.collapsed])
 const baseLocations={...automatic,...layout.positions} as Record<string,[number,number]>
 const targetLocations={...baseLocations,...preview}
 const geometry=useAnimatedGeometry(Object.fromEntries(Object.entries(targetLocations).map(([id,p])=>[id,{x:p[0],y:p[1],width:WIDTH,height:HEIGHT}])),!!moving,viewKey||tree.tree_id||tree.root_id)
 const locations=Object.fromEntries(Object.entries(geometry).map(([id,p])=>[id,[p.x,p.y] as [number,number]]))
 const visible=useMemo(()=>{const ids=new Set<string>();function visit(id:string){if(ids.has(id)||!tree.nodes[id])return;ids.add(id);if(!(layout.collapsed||[]).includes(id))tree.nodes[id].children.forEach(visit)}visit(tree.root_id);return [...ids]},[tree,layout.collapsed])
 function canContain(id:string){const node=tree.nodes[id];return node&&models[node.registration_id]?.maximum_children!==0&&(models[node.registration_id]||node.children.length>0)}
 function available(id:string){const node=tree.nodes[id],max=models[node?.registration_id]?.maximum_children;return canContain(id)&&(max===undefined||max<0||node.children.length<max)}
 function label(id:string){const node=tree.nodes[id];return layout.labels?.[id]||models[node?.registration_id]?.label||nodeLabel(node?.registration_id||'',language)}
 const slots:Slot[]=visible.flatMap(parent=>{
  if(!canContain(parent)||moving&&!canAdopt(tree,moving,parent,models)||!moving&&!available(parent))return []
  const children=(tree.nodes[parent].children as string[]).filter(id=>visible.includes(id)&&id!==moving),p=baseLocations[parent]
  if(!p)return []
  const before=children.map((id,index)=>{const point=baseLocations[id];return {parent,before:id,x:point[0]+WIDTH/2-65,y:point[1]-20,order:index+1}})
  const last=children.length?baseLocations[children[children.length-1]]:null
  return [...before,{parent,x:last?last[0]+WIDTH+55:p[0]+WIDTH/2,y:last?last[1]-20:p[1]+HEIGHT+35,order:children.length+1}]
 })
 function fitView(){if(size.width<=0||size.height<=0)return;const points=visible.map(id=>baseLocations[id]).filter(Boolean);if(!points.length)return
  const minX=Math.min(...points.map(p=>p[0]))-64,minY=Math.min(...points.map(p=>p[1]))-64,maxX=Math.max(...points.map(p=>p[0]+WIDTH))+64,maxY=Math.max(...points.map(p=>p[1]+HEIGHT))+100
  const zoom=Math.max(.18,Math.min(1,size.width/(maxX-minX),size.height/(maxY-minY)))
  setCamera({x:(size.width-(maxX-minX)*zoom)/2-minX*zoom,y:(size.height-(maxY-minY)*zoom)/2-minY*zoom,zoom})
 }
 useEffect(()=>{const observer=new ResizeObserver(entries=>{const r=entries[0]?.contentRect;if(r)setSize({width:r.width,height:r.height})});if(viewport.current)observer.observe(viewport.current);return()=>observer.disconnect()},[])
 const identity=viewKey||tree.tree_id||tree.root_id
 useEffect(()=>{if(size.width<=0||size.height<=0||initialized.current===identity)return;if(initialized.current)savedViews.current[initialized.current]=cameraRef.current;initialized.current=identity;setMenu(null);const saved=savedViews.current[identity];if(saved)setCamera(saved);else fitView()},[identity,size.width,size.height])
 useEffect(()=>{if(layoutKey)fitView()},[layoutKey])
 useEffect(()=>{if(fit)fitView();else if(layout.zoom&&layout.zoom!==1)setCamera(current=>({...current,zoom:layout.zoom}))},[fit,layout.zoom])
 useEffect(()=>{const element=viewport.current;if(!element)return
  function wheel(event:WheelEvent){if((event.target as Element).closest('button,[role=menu]'))return;event.preventDefault();if(!visible.length)return;const rect=element!.getBoundingClientRect(),c=cameraRef.current,unit=event.deltaMode===1?16:event.deltaMode===2?element!.clientHeight:1,zoom=Math.max(.15,Math.min(2.5,c.zoom*Math.exp(-Math.max(-150,Math.min(150,event.deltaY*unit))*.0025))),px=event.clientX-rect.left,py=event.clientY-rect.top;setCamera({x:px-(px-c.x)*zoom/c.zoom,y:py-(py-c.y)*zoom/c.zoom,zoom})}
  element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel)
 },[visible.length])
 useEffect(()=>{function release(){space.current=false}window.addEventListener('keyup',release);window.addEventListener('blur',release);return()=>{window.removeEventListener('keyup',release);window.removeEventListener('blur',release)}},[])
 useEffect(()=>{if(!menu)return;function outside(event:PointerEvent){if(event.button===0&&!menuElement.current?.contains(event.target as Node))setMenu(null)}document.addEventListener('pointerdown',outside);menuElement.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();return()=>document.removeEventListener('pointerdown',outside)},[menu])
 function point(clientX:number,clientY:number){const rect=viewport.current!.getBoundingClientRect(),c=cameraRef.current;return {x:(clientX-rect.left-c.x)/c.zoom,y:(clientY-rect.top-c.y)/c.zoom}}
 function zoomBy(factor:number){const c=cameraRef.current,zoom=Math.max(.15,Math.min(2.5,c.zoom*factor)),px=size.width/2,py=size.height/2;setCamera({x:px-(px-c.x)*zoom/c.zoom,y:py-(py-c.y)*zoom/c.zoom,zoom})}
 function hitNode(x:number,y:number){return document.elementFromPoint(x,y)?.closest('[data-editor-id]')?.getAttribute('data-editor-id')||''}
 function hitSlot(x:number,y:number){const p=point(x,y);return slots.find(slot=>Math.abs(slot.x-p.x)<55&&Math.abs(slot.y-p.y)<20)||null}
 function clearDrag(){drag.current=null;previewRef.current={};slotRef.current=null;setPanning(false);setConnection(null);setDropSlot(null);setPreview({});setMoving('');setPaletteDrag(false)}
 function finish(event:React.PointerEvent){const active=drag.current,slot=slotRef.current,next=active?.kind==='node'?previewRef.current[active.id]:null
  if(active?.kind==='node'&&next){if(slot)onReparent?.(active.id,slot.parent,slot.before);else onMove?.(active.id,next[0],next[1])}
  else if(active?.kind==='connect'){const target=hitNode(event.clientX,event.clientY);if(target&&target!==active.id&&canAdopt(tree,target,active.id,models))onReparent?.(target,active.id);else if(!target||target===active.id)onAddAt?.(active.id)}
  clearDrag();if(svg.current?.hasPointerCapture(event.pointerId))svg.current.releasePointerCapture(event.pointerId)
 }
 function showMenu(event:React.MouseEvent){event.preventDefault();event.stopPropagation();clearDrag();const id=(event.target as Element).closest('[data-editor-id]')?.getAttribute('data-editor-id')||undefined;if(id)onSelect(id);const rect=viewport.current!.getBoundingClientRect();setMenu({id,x:Math.max(8,Math.min(event.clientX-rect.left,size.width-210)),y:Math.max(8,Math.min(event.clientY-rect.top,size.height-240))})}
 return <div className={'bw-canvas'+(panning?' is-panning':'')} ref={viewport} tabIndex={0} aria-label={t('行为树画布')} onContextMenu={showMenu}
  onKeyDown={event=>{if(event.key==='Escape'){setMenu(null);clearDrag()}if(event.target!==event.currentTarget&&!((event.target as Element).tagName==='g'))return;if(event.code==='Space'){event.preventDefault();space.current=true}if(event.key.toLowerCase()==='f'&&!event.ctrlKey&&!event.metaKey){event.preventDefault();fitView()}}}
  onDragOver={event=>{if(onInsert&&event.dataTransfer.types.includes('application/x-agro-node')){event.preventDefault();const slot=hitSlot(event.clientX,event.clientY),target=hitNode(event.clientX,event.clientY),validTarget=target&&available(target);event.dataTransfer.dropEffect=slot||validTarget?'copy':'none';setPaletteDrag(true);setDropSlot(slot||(validTarget?slots.find(item=>item.parent===target&&!item.before)||null:null))}}}
  onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node)){setDropSlot(null);setPaletteDrag(false)}}}
  onDrop={event=>{if(!onInsert)return;const registration=event.dataTransfer.getData('application/x-agro-node');if(!registration)return;event.preventDefault();const slot=hitSlot(event.clientX,event.clientY),target=hitNode(event.clientX,event.clientY);setPaletteDrag(false);setDropSlot(null);if(slot)onInsert(slot.parent,registration,slot.before);else if(target&&available(target))onInsert(target,registration)}}>
  <svg ref={svg} role="group" aria-label={t('行为树结构')} width="100%" height="100%" onPointerDown={event=>{const target=event.target as Element;if(event.button===1||event.button===0&&(!target.closest('[data-editor-id],[data-slot-parent]')||space.current)){event.preventDefault();setMenu(null);const shown=response.current();directCamera({x:shown.x,y:shown.y,zoom:shown.scale});viewport.current?.focus({preventScroll:true});svg.current?.setPointerCapture(event.pointerId);drag.current={kind:'pan',x:event.clientX,y:event.clientY,camera:cameraRef.current};setPanning(true)}}}
   onPointerMove={event=>{const active=drag.current;if(!active)return
    if(active.kind==='pan')directCamera({...active.camera,x:active.camera.x+event.clientX-active.x,y:active.camera.y+event.clientY-active.y})
    else if(active.kind==='node'){const dx=(event.clientX-active.px)/cameraRef.current.zoom,dy=(event.clientY-active.py)/cameraRef.current.zoom;if(Math.abs(dx)+Math.abs(dy)<3)return;const next:Record<string,[number,number]>={};for(const id of descendants(tree,active.id)){const p=baseLocations[id];if(p)next[id]=[p[0]+dx,p[1]+dy]}setPreview(next);previewRef.current=next;const slot=hitSlot(event.clientX,event.clientY);setDropSlot(slot);slotRef.current=slot}
    else setConnection({id:active.id,...point(event.clientX,event.clientY)})
   }} onPointerUp={finish} onPointerCancel={clearDrag}>
   <motion.g style={{x:response.x,y:response.y,scale:response.scale,originX:0,originY:0,transformBox:'view-box'}}>
    {visible.flatMap(id=>tree.nodes[id].children.filter((child:string)=>visible.includes(child)).map((child:string,index:number)=>{const a=locations[id],b=locations[child];if(!a||!b)return null;const middle=(a[1]+HEIGHT+b[1])/2;return <g key={id+child} className="bw-edge"><path className="bw-edge-wire" d={`M${a[0]+WIDTH/2} ${a[1]+HEIGHT} C${a[0]+WIDTH/2} ${middle} ${b[0]+WIDTH/2} ${middle} ${b[0]+WIDTH/2} ${b[1]}`}/><text className="bw-order" x={b[0]+WIDTH/2+10} y={b[1]-9}>{index+1}</text></g>}))}
    {bindings.flatMap((binding,index)=>(binding.producers||[]).filter((producer:Json)=>producer.tree_id===tree.tree_id&&producer.kind==='node_output'&&visible.includes(producer.editor_id)&&portModels[producer.editor_id]?.[producer.port]?.direction==='OUTPUT').map((producer:Json)=>{const a=locations[producer.editor_id],b=locations[selected];if(!a||!b)return null;return <path key={index+producer.editor_id+producer.port} className="bw-data-wire" d={`M${a[0]+WIDTH} ${a[1]+HEIGHT/2} Q${Math.max(a[0],b[0])+WIDTH+80} ${(a[1]+b[1])/2} ${b[0]+WIDTH} ${b[1]+HEIGHT/2}`}/>}))}
    {visible.map(id=>{const node=tree.nodes[id],p=locations[id];if(!p)return null;const issues=diagnostics.filter(d=>d.editor_id===id),hasError=issues.some(issue=>issue.severity==='error'),collapsed=(layout.collapsed||[]).includes(id),parent=parentOf(tree,id),order=parent?parent.children.indexOf(id)+1:0;return <g key={id} transform={`translate(${p[0]} ${p[1]})`} className={`bw-node ${selected===id?'is-selected':''} ${moving&&descendants(tree,moving).has(id)?'is-moving':''} state-${states[id]||'IDLE'}`} role="button" tabIndex={0} aria-label={label(id)} data-editor-id={id} data-last-state={lastStates[id]}
     onClick={event=>{event.stopPropagation();onSelect(id)}} onDoubleClick={()=>onOpen?.(id)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();onOpen?.(id);onSelect(id)}}}
     onPointerDown={event=>{if(event.button!==0||space.current)return;event.stopPropagation();setMenu(null);const shown=response.current();directCamera({x:shown.x,y:shown.y,zoom:shown.scale});onSelect(id);viewport.current?.focus({preventScroll:true});if(!onMove)return;svg.current?.setPointerCapture(event.pointerId);drag.current={kind:'node',id,x:p[0],y:p[1],px:event.clientX,py:event.clientY};setMoving(id)}}>
     <rect className="bw-node-surface" width={WIDTH} height={HEIGHT} rx="9"/><path className="bw-node-glyph" d={canContain(id)?'M13 17h12M13 23h12M13 29h12':'m14 17 11 6-11 6Z'}/>
     <text className="bw-node-title" x="35" y="26">{label(id).slice(0,18)}</text><text className="bw-node-detail" x="13" y="49">{states[id]&&states[id]!=='IDLE'?states[id]:node.registration_id==='SubTree'?node.attributes.ID:order?t('执行位置 {0}',{0:order}):t('执行起点')}{collapsed?t(' · 已折叠'):''}</text>
     {issues.length>0&&<g className={'bw-node-issue'+(hasError?'':' is-pending')} transform={`translate(${WIDTH-12} 12)`}><circle r="4"/><title>{issues.map(d=>t(d.reason)).join('\n')}</title></g>}
     {onReparent&&available(id)&&<circle className="bw-node-handle" cx={WIDTH/2} cy={HEIGHT} r="6" role="button" tabIndex={0} aria-label={t('添加子节点')} onKeyDown={event=>{if(event.key==='Enter'){event.stopPropagation();onAddAt?.(id)}}} onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.stopPropagation();svg.current?.setPointerCapture(event.pointerId);drag.current={kind:'connect',id,...point(event.clientX,event.clientY)};setConnection({id,...point(event.clientX,event.clientY)})}}/>}
    </g>})}
    {onAddAt&&slots.filter(slot=>moving||paletteDrag||slot.parent===selected).map(slot=>{const active=dropSlot?.parent===slot.parent&&dropSlot?.before===slot.before;return <g key={slot.parent+':'+(slot.before||'end')} data-slot-parent={slot.parent} className={'bw-insertion-slot'+(active?' is-active':'')} role="button" tabIndex={0} aria-label={t('插入到第 {0} 项',{0:slot.order})} transform={`translate(${slot.x} ${slot.y})`} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onAddAt(slot.parent,slot.before)}} onKeyDown={event=>{if(event.key==='Enter')onAddAt(slot.parent,slot.before)}}><rect x="-48" y="-11" width="96" height="22" rx="6"/><text textAnchor="middle" y="4">{active?t('放到这里'):t('＋ 第 {0} 项',{0:slot.order})}</text></g>})}
    {connection&&locations[connection.id]&&<path className="bw-connecting" d={`M${locations[connection.id][0]+WIDTH/2} ${locations[connection.id][1]+HEIGHT} L${connection.x} ${connection.y}`}/>}
   </motion.g>
  </svg>
  {menu&&<div className="bw-context-menu" ref={menuElement} role="menu" style={{left:menu.x,top:menu.y}} onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{if(event.key==='Escape'){setMenu(null);viewport.current?.focus()}if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();const items=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')),index=items.indexOf(document.activeElement as HTMLButtonElement);items[(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus()}}}>
   {onAddAt&&<button role="menuitem" disabled={!available(menu.id||tree.root_id)} onClick={()=>{onAddAt(menu.id||tree.root_id);setMenu(null)}}><Icon name="plus"/>{t('添加子节点')}</button>}
   {menu.id&&<button role="menuitem" onClick={()=>{onOpen?.(menu.id!);setMenu(null)}}><Icon name="settings"/>{t('节点属性')}</button>}
   {menu.id&&onDuplicate&&<button role="menuitem" disabled={menu.id===tree.root_id} onClick={()=>{onDuplicate(menu.id!);setMenu(null)}}><Icon name="copy"/>{t('复制片段')}</button>}
   {menu.id&&onDelete&&<button role="menuitem" className="bw-danger" disabled={menu.id===tree.root_id} onClick={()=>{onDelete(menu.id!);setMenu(null)}}><Icon name="trash"/>{t('删除节点')}</button>}
   <button role="menuitem" onClick={()=>{fitView();setMenu(null)}}><Icon name="fit"/>{t('适配视图')}</button>
  </div>}
  <div className="bw-canvas-hint">{dropSlot?t('松开后调整到「{0}」的第 {1} 项',{0:label(dropSlot.parent),1:dropSlot.order}):connection?t('连接到子节点或松开添加'):t('左键拖动 · 滚轮缩放 · 右键菜单')}</div>
  <div className="bw-zoom"><button aria-label={t('缩小')} onClick={()=>zoomBy(1/1.2)}><Icon name="minus"/></button><button title={t('恢复原始比例')} onClick={()=>{const c=cameraRef.current,px=size.width/2,py=size.height/2;setCamera({x:px-(px-c.x)/c.zoom,y:py-(py-c.y)/c.zoom,zoom:1})}}>{Math.round(camera.zoom*100)}%</button><button aria-label={t('放大')} onClick={()=>zoomBy(1.2)}><Icon name="plus"/></button><span/><button title={t('适配视图 F')} aria-label={t('适配视图')} onClick={fitView}><Icon name="fit"/></button></div>
 </div>
}
