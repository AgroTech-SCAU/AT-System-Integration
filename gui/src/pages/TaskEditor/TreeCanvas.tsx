import {motion} from 'motion/react'
import {useStudioCamera, useAnimatedGeometry} from '../../motion'
import {useLocale} from '../../locale'
import {useEffect,useMemo,useRef,useState} from 'react'
import type {Json} from '../shared'
import {positions} from './editor'
import {nodeLabel} from './labels'
import Icon from './WorkbenchIcon'

type Camera={x:number;y:number;zoom:number}
type Drag={kind:'pan';x:number;y:number;camera:Camera}|{kind:'node';id:string;x:number;y:number;px:number;py:number;reparent:boolean}|{kind:'connect';id:string;x:number;y:number}
type Props={tree:Json;layout:Json;selected:string;onSelect(id:string):void;onMove?(id:string,x:number,y:number):void;onInsert?:(parentId:string,registration:string,before?:string)=>void;onReparent?:(node:string,parent:string)=>void;onAddAt?:(parent:string,before?:string)=>void;onOpen?:(id:string)=>void;states?:Record<string,string>;lastStates?:Record<string,string>;bindings?:Json[];portModels?:Json;language?:'zh'|'en';fit?:boolean;viewKey?:string;diagnostics?:Json[];layoutKey?:number}
const WIDTH=190,HEIGHT=68
export default function TreeCanvas({tree,layout,selected,onSelect,onMove,onInsert,onReparent,onAddAt,onOpen,states={},lastStates={},bindings=[],portModels={},language='zh',fit=false,viewKey,diagnostics=[],layoutKey=0}:Props){
 const {t}=useLocale()

 const response=useStudioCamera()
 const viewport=useRef<HTMLDivElement>(null),svg=useRef<SVGSVGElement>(null),drag=useRef<Drag|null>(null)
 const [size,setSize]=useState({width:0,height:0}),[camera,setCamera]=useState<Camera>({x:0,y:0,zoom:1}),[preview,setPreview]=useState<Record<string,[number,number]>>({}),[connection,setConnection]=useState<{id:string;x:number;y:number}|null>(null),[dropTarget,setDropTarget]=useState(''),[panning,setPanning]=useState(false)
 const cameraRef=useRef(camera),savedViews=useRef<Record<string,Camera>>({}),space=useRef(false),initialized=useRef('')
 cameraRef.current=camera
 useEffect(()=>response.move({x:camera.x,y:camera.y,scale:camera.zoom},panning),[camera,response,panning])
 function directCamera(next:Camera){response.move({x:next.x,y:next.y,scale:next.zoom},true);cameraRef.current=next;setCamera(next)}
 const automatic=useMemo(()=>positions(tree,layout.collapsed||[]),[tree,layout.collapsed])
 const targetLocations={...automatic,...layout.positions,...preview} as Record<string,[number,number]>
 const geometry=useAnimatedGeometry(Object.fromEntries(Object.entries(targetLocations).map(([id,p])=>[id,{x:p[0],y:p[1],width:WIDTH,height:HEIGHT}])),!!Object.keys(preview).length,viewKey||tree.tree_id||tree.root_id)
 const locations=Object.fromEntries(Object.entries(geometry).map(([id,p])=>[id,[p.x,p.y] as [number,number]]))
 const visible=useMemo(()=>{const ids=new Set<string>();function visit(id:string){if(ids.has(id)||!tree.nodes[id])return;ids.add(id);if(!(layout.collapsed||[]).includes(id))tree.nodes[id].children.forEach(visit)}visit(tree.root_id);return [...ids]},[tree,layout.collapsed])
 function fitView(){
  if(size.width<=0||size.height<=0)return
  const points=visible.map(id=>locations[id]).filter(Boolean)
  if(!points.length)return
  const minX=Math.min(...points.map(p=>p[0]))-48,minY=Math.min(...points.map(p=>p[1]))-48,maxX=Math.max(...points.map(p=>p[0]+WIDTH))+48,maxY=Math.max(...points.map(p=>p[1]+HEIGHT))+48
  const zoom=Math.max(.18,Math.min(1.1,size.width/(maxX-minX),size.height/(maxY-minY)))
  setCamera({x:(size.width-(maxX-minX)*zoom)/2-minX*zoom,y:(size.height-(maxY-minY)*zoom)/2-minY*zoom,zoom})
 }
 useEffect(()=>{const observer=new ResizeObserver(entries=>{const r=entries[0]?.contentRect;if(r)setSize({width:r.width,height:r.height})});if(viewport.current)observer.observe(viewport.current);return()=>observer.disconnect()},[])
 const identity=viewKey||tree.tree_id||tree.root_id
 useEffect(()=>{
  if(size.width<=0||size.height<=0||initialized.current===identity)return
  if(initialized.current)savedViews.current[initialized.current]=cameraRef.current
  initialized.current=identity
  const saved=savedViews.current[identity]
  if(saved)setCamera(saved);else fitView()
 },[identity,size.width,size.height])
 useEffect(()=>{if(layoutKey)fitView()},[layoutKey])
 useEffect(()=>{if(fit)fitView();else if(layout.zoom&&layout.zoom!==1)setCamera(current=>({...current,zoom:layout.zoom}))},[fit,layout.zoom])
 useEffect(()=>{
  const element=viewport.current;if(!element)return
  function wheel(event:WheelEvent){event.preventDefault();const rect=element!.getBoundingClientRect(),c=cameraRef.current
   if(event.ctrlKey||event.metaKey){const zoom=Math.max(.15,Math.min(2.5,c.zoom*Math.exp(-event.deltaY*.008))),px=event.clientX-rect.left,py=event.clientY-rect.top;setCamera({x:px-(px-c.x)*zoom/c.zoom,y:py-(py-c.y)*zoom/c.zoom,zoom})}
   else{const c=response.current();directCamera({x:c.x-event.deltaX,y:c.y-event.deltaY,zoom:c.scale})}
  }
  element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel)
 },[])
 useEffect(()=>{function release(){space.current=false};window.addEventListener('keyup',release);window.addEventListener('blur',release);return()=>{window.removeEventListener('keyup',release);window.removeEventListener('blur',release)}},[])
 function point(clientX:number,clientY:number){const rect=viewport.current!.getBoundingClientRect(),c=cameraRef.current;return {x:(clientX-rect.left-c.x)/c.zoom,y:(clientY-rect.top-c.y)/c.zoom}}
 function zoomBy(factor:number){const c=cameraRef.current,zoom=Math.max(.15,Math.min(2.5,c.zoom*factor)),px=size.width/2,py=size.height/2;setCamera({x:px-(px-c.x)*zoom/c.zoom,y:py-(py-c.y)*zoom/c.zoom,zoom})}
 function hitNode(x:number,y:number){return document.elementFromPoint(x,y)?.closest('[data-editor-id]')?.getAttribute('data-editor-id')||''}
 function finish(event:React.PointerEvent){
  const active=drag.current;drag.current=null;setPanning(false);setConnection(null);setDropTarget('')
  if(active?.kind==='node'){
   const next=preview[active.id],target=hitNode(event.clientX,event.clientY)
   if(active.reparent&&target&&target!==active.id)onReparent?.(active.id,target)
   else if(next)onMove?.(active.id,next[0],next[1])
  }else if(active?.kind==='connect'){
   const target=hitNode(event.clientX,event.clientY)
   if(target&&target!==active.id)onReparent?.(target,active.id)
   else if(!target)onAddAt?.(active.id)
  }
  setPreview({})
 }
 return <div className={'bw-canvas'+(panning?' is-panning':'')} ref={viewport} tabIndex={0} aria-label={language==='en'?'Behavior tree canvas':t("行为树画布")}
  onKeyDown={event=>{if(event.target!==event.currentTarget&&!((event.target as Element).tagName==='g'))return;if(event.code==='Space'){event.preventDefault();space.current=true}if(event.key.toLowerCase()==='f'&&!event.ctrlKey&&!event.metaKey){event.preventDefault();fitView()}if(event.key==='Escape'){drag.current=null;setPreview({});setConnection(null);setDropTarget('')}}}
  onDragOver={event=>{if(onInsert&&event.dataTransfer.types.includes('application/x-agro-node')){event.preventDefault();event.dataTransfer.dropEffect='copy';setDropTarget((event.target as Element).closest('[data-editor-id]')?.getAttribute('data-editor-id')||'')}}}
  onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDropTarget('')}}
  onDrop={event=>{setDropTarget('');if(!onInsert)return;const registration=event.dataTransfer.getData('application/x-agro-node');if(!registration)return;event.preventDefault();const element=event.target instanceof Element?event.target:null,edge=element?.closest('[data-edge-parent]');onInsert(edge?.getAttribute('data-edge-parent')||element?.closest('[data-editor-id]')?.getAttribute('data-editor-id')||selected||tree.root_id,registration,edge?.getAttribute('data-edge-child')||undefined)}}>
  <svg ref={svg} role="group" aria-label={t("任务结构")} width="100%" height="100%" onPointerDown={event=>{
   const target=event.target as Element
   if(event.button===1||event.button===0&&(!target.closest('[data-editor-id],[data-edge-parent]')||space.current)){
    event.preventDefault();const shown=response.current();directCamera({x:shown.x,y:shown.y,zoom:shown.scale});viewport.current?.focus({preventScroll:true});svg.current?.setPointerCapture(event.pointerId);drag.current={kind:'pan',x:event.clientX,y:event.clientY,camera:cameraRef.current};setPanning(true)
   }
  }} onPointerMove={event=>{const active=drag.current;if(!active)return
   if(active.kind==='pan')directCamera({...active.camera,x:active.camera.x+event.clientX-active.x,y:active.camera.y+event.clientY-active.y})
   else if(active.kind==='node'){setPreview({[active.id]:[active.x+(event.clientX-active.px)/camera.zoom,active.y+(event.clientY-active.py)/camera.zoom]});if(active.reparent)setDropTarget(hitNode(event.clientX,event.clientY))}
   else{setConnection({id:active.id,...point(event.clientX,event.clientY)});setDropTarget(hitNode(event.clientX,event.clientY))}
  }} onPointerUp={finish} onPointerCancel={()=>{drag.current=null;setPreview({});setConnection(null);setPanning(false)}}>
   <motion.g style={{x:response.x,y:response.y,scale:response.scale,originX:0,originY:0,transformBox:"view-box"}}>
    {visible.flatMap(id=>tree.nodes[id].children.filter((child:string)=>visible.includes(child)).map((child:string,index:number)=>{const a=locations[id],b=locations[child],middle=(a[1]+HEIGHT+b[1])/2;return <g key={id+child} data-edge-parent={id} data-edge-child={child} className="bw-edge">
     <path className="bw-edge-wire" d={`M${a[0]+WIDTH/2} ${a[1]+HEIGHT} C${a[0]+WIDTH/2} ${middle} ${b[0]+WIDTH/2} ${middle} ${b[0]+WIDTH/2} ${b[1]}`}/>
     <path className="bw-edge-hit" d={`M${a[0]+WIDTH/2} ${a[1]+HEIGHT} C${a[0]+WIDTH/2} ${middle} ${b[0]+WIDTH/2} ${middle} ${b[0]+WIDTH/2} ${b[1]}`}/>
     <text className="bw-order" x={b[0]+WIDTH/2+10} y={b[1]-10}>{index+1}</text>
     {onAddAt&&<g className="bw-edge-add" role="button" tabIndex={0} aria-label={t("在连接处插入节点")} transform={`translate(${(a[0]+b[0]+WIDTH)/2} ${middle})`} onClick={event=>{event.stopPropagation();onAddAt(id,child)}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();onAddAt(id,child)}}}><circle r="9"/><path d="M-3 0H3M0-3V3"/></g>}
    </g>}))}
    {bindings.flatMap((binding,index)=>(binding.producers||[]).filter((producer:Json)=>producer.tree_id===tree.tree_id&&producer.kind==='node_output'&&visible.includes(producer.editor_id)&&portModels[producer.editor_id]?.[producer.port]?.direction==='OUTPUT').map((producer:Json)=>{const a=locations[producer.editor_id],b=locations[selected];if(!a||!b)return null;return <path key={index+producer.editor_id+producer.port} className="bw-data-wire" d={`M${a[0]+WIDTH} ${a[1]+HEIGHT/2} Q${Math.max(a[0],b[0])+WIDTH+80} ${(a[1]+b[1])/2} ${b[0]+WIDTH} ${b[1]+HEIGHT/2}`}/>}))}
    {visible.map(id=>{const node=tree.nodes[id],p=locations[id],issues=diagnostics.filter(d=>d.editor_id===id),collapsed=(layout.collapsed||[]).includes(id);return <g key={id} transform={`translate(${p[0]} ${p[1]})`} className={`bw-node ${selected===id?'is-selected':''} ${dropTarget===id?'is-drop-target':''} ${issues.length?'has-issue':''} state-${states[id]||'IDLE'}`} role="button" tabIndex={0} aria-label={layout.labels?.[id]||(node.registration_id.startsWith('RosTask_')?t("ROS 能力"):nodeLabel(node.registration_id,language))} data-editor-id={id} data-last-state={lastStates[id]} style={{pointerEvents:drag.current?.kind==='node'&&drag.current.reparent&&drag.current.id===id?'none':undefined}}
     onClick={event=>{event.stopPropagation();onSelect(id)}} onDoubleClick={()=>onOpen?.(id)}
     onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();onOpen?.(id);onSelect(id)}}}
     onPointerDown={event=>{if(event.button!==0||space.current)return;event.stopPropagation();const shown=response.current();directCamera({x:shown.x,y:shown.y,zoom:shown.scale});onSelect(id);viewport.current?.focus({preventScroll:true});if(!onMove)return;svg.current?.setPointerCapture(event.pointerId);drag.current={kind:'node',id,x:p[0],y:p[1],px:event.clientX,py:event.clientY,reparent:event.shiftKey}}}>
     <rect className="bw-node-surface" width={WIDTH} height={HEIGHT} rx="8"/>
     <path className="bw-node-glyph" d={node.children.length||['Sequence','Fallback','Parallel','ReactiveSequence','ReactiveFallback'].includes(node.registration_id)?'M13 17h12M13 23h12M13 29h12':'m14 17 11 6-11 6Z'}/>
     <text className="bw-node-title" x="35" y="26">{(layout.labels?.[id]||(node.registration_id.startsWith('RosTask_')?t("ROS 能力"):nodeLabel(node.registration_id,language))).slice(0,17)}</text>
     <text className="bw-node-detail" x="13" y="49">{(states[id]&&states[id]!=='IDLE'?states[id]:node.attributes?.role||node.attributes?.ID||(node.registration_id.startsWith('RosTask_')?t("ROS 能力"):nodeLabel(node.registration_id,language))).slice(0,25)}{collapsed?t(" · 已折叠"):''}</text>
     {issues.length>0&&<g className="bw-node-issue" transform={`translate(${WIDTH-12} 12)`}><circle r="5"/><title>{issues.map(d=>d.reason).join('\n')}</title></g>}
     {onReparent&&<circle className="bw-node-handle" cx={WIDTH/2} cy={HEIGHT} r="5" onPointerDown={event=>{event.preventDefault();event.stopPropagation();svg.current?.setPointerCapture(event.pointerId);drag.current={kind:'connect',id,...point(event.clientX,event.clientY)};setConnection({id,...point(event.clientX,event.clientY)})}}/>}
    </g>})}
    {connection&&locations[connection.id]&&<path className="bw-connecting" d={`M${locations[connection.id][0]+WIDTH/2} ${locations[connection.id][1]+HEIGHT} L${connection.x} ${connection.y}`}/>}
   </motion.g>
  </svg>
  <div className="bw-canvas-hint">{connection?t("连接到子节点或松开添加"):dropTarget?t("松开连接到此节点"):t("拖动空白处平移 · ⌘ / Ctrl 滚动缩放")}</div>
  <div className="bw-zoom"><button title={t("缩小")} aria-label={t("缩小")} onClick={()=>zoomBy(1/1.2)}><Icon name="minus"/></button><button title={t("恢复原始比例")} onClick={()=>{const c=cameraRef.current,px=size.width/2,py=size.height/2;setCamera({x:px-(px-c.x)/c.zoom,y:py-(py-c.y)/c.zoom,zoom:1})}}>{Math.round(camera.zoom*100)}%</button><button title={t("放大")} aria-label={t("放大")} onClick={()=>zoomBy(1.2)}><Icon name="plus"/></button><span/><button title={t("适配视图 F")} aria-label={t("适配视图")} onClick={fitView}><Icon name="fit"/></button></div>
 </div>
}
