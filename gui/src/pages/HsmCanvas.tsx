import {AnimatePresence, motion} from 'motion/react'
import {AnchoredPopover} from '../components/AnchoredPopover'
import {useStudioCamera, useAnimatedGeometry} from '../motion'
import {useLocale} from '../locale'
import {useCallback,useEffect,useId,useRef,useState,type PointerEvent,type MouseEvent} from 'react'

import {nestedHsmLayout,projectedHsmEdges} from './hsm-layout'

type State={id:string;label:string;parent?:string;initial?:string;entry?:string;do?:string;exit?:string}
type Edge={source:string;target:string;event:string;guard?:{operator:string}}
export type HsmLayout={positions:Record<string,[number,number]>}
type View={x:number;y:number;scale:number}
type Side='input'|'output'
type Connection={id:string;side:Side;x:number;y:number;target?:string}
type Drag={kind:'node';id:string;px:number;py:number;moved:boolean;localX:number;localY:number}|{kind:'pan';x:number;y:number;px:number;py:number}|{kind:'connect';id:string;side:Side;px:number;py:number;moved:boolean}
const W=208,H=112
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value))

export function automaticHsmLayout(states:State[],positions:Record<string,[number,number]>={}):HsmLayout{
 const root=states.find(state=>!state.parent)?.id||''
 const nested=nestedHsmLayout(states,root,positions,new Set())
 return {positions:Object.fromEntries(Object.entries(nested.boxes).map(([id,box])=>[id,[box.localX,box.localY]]))}
}

export function hsmConnectionPath(a:{x:number;y:number;width:number},b:{x:number;y:number;width:number},offset=0){
 const x1=a.x+a.width+6,y1=a.y+56,x2=b.x-7,y2=b.y+56
 if(x2-x1>4){const middle=(x1+x2)/2;return {path:`M${x1} ${y1} C${middle} ${y1} ${middle} ${y2} ${x2} ${y2}`,x:middle,y:(y1+y2)/2-11-offset*20}}
 const top=Math.min(a.y,b.y)-34-offset*28
 return {path:`M${x1} ${y1} H${x1+20} Q${x1+32} ${y1} ${x1+32} ${y1-12} V${top+12} Q${x1+32} ${top} ${x1+20} ${top} H${x2-20} Q${x2-32} ${top} ${x2-32} ${top+12} V${y2-12} Q${x2-32} ${y2} ${x2-20} ${y2} H${x2}`,x:(x1+x2)/2,y:top-3}
}

export default function HsmCanvas({states,transitions,layout,selected,onSelect,onMove,onReset,scope,selectedTransition,onSelectTransition,onConnect,onCreate,onRename,onEnter,onOpenPhase,onReparent,onCreateIn,onDelete,onDeleteTransition,onMakeInitial,readOnly=false,activePath=[],taskLabels={}}:{
 states:State[];transitions:Edge[];layout:HsmLayout;selected:string;scope?:string;selectedTransition?:number|null;activePath?:string[];taskLabels?:Record<string,string>
 onSelect:(id:string)=>void;onMove:(id:string,x:number,y:number)=>void;onReset:()=>void
 readOnly?:boolean
 onReparent?:(id:string,parent:string)=>void
 onCreateIn?:(parent:string,x?:number,y?:number)=>void;onDelete?:(id:string)=>void;onDeleteTransition?:(index:number)=>void;onMakeInitial?:(id:string)=>void
 onSelectTransition?:(index:number)=>void;onConnect?:(source:string,target:string)=>void;onCreate?:(x:number,y:number)=>void;onRename?:(id:string,label:string)=>void;onEnter?:(id:string)=>void;onOpenPhase?:(id:string,phase:'entry'|'do'|'exit')=>void
}){
 const {t}=useLocale()

 const camera=useStudioCamera()
 const svg=useRef<SVGSVGElement>(null),surface=useRef<HTMLDivElement>(null),frame=useRef<number|null>(null),drag=useRef<Drag|null>(null)
 const views=useRef<Record<string,View>>({}),space=useRef(false),marker=useId().replaceAll(':',''),renameCanceled=useRef(false)
 const [view,setView]=useState<View>({x:0,y:0,scale:1}),viewRef=useRef(view)
 const [size,setSize]=useState({width:700,height:400}),[preview,setPreview]=useState<{id:string;x:number;y:number}|null>(null)
 const [connection,setConnection]=useState<Connection|null>(null),[dragging,setDragging]=useState(false)
 const [renaming,setRenaming]=useState<string|null>(null),[name,setName]=useState(''),[externalOpen,setExternalOpen]=useState(false)
 const scopeId=scope||states.find(s=>!s.parent)?.id||''
 const [collapsed,setCollapsed]=useState<Set<string>>(()=>new Set(states.filter(state=>state.parent&&states.some(parent=>parent.id===state.parent&&parent.parent)).map(state=>state.id))),[dropTarget,setDropTarget]=useState('')
 const menuAnchor=useRef<HTMLSpanElement>(null)
 const [menu,setMenu]=useState<{x:number;y:number;point:{x:number;y:number};state?:string;edge?:number;parent?:string}|null>(null)
 const nested=nestedHsmLayout(states,scopeId,layout.positions,collapsed,preview)
 const geometry=useAnimatedGeometry(nested.boxes,!!preview,scopeId)
 const visible=nested.shown,boxes=Object.fromEntries(Object.entries(nested.boxes).map(([id,box])=>[id,{...box,...geometry[id]}])),visibleIds=new Set(visible.map(state=>state.id))
 const positions=Object.fromEntries(Object.entries(boxes).map(([id,box])=>[id,[box.x,box.y] as [number,number]]))
 const positionRef=useRef(positions);positionRef.current=positions
 const boxRef=useRef(boxes);boxRef.current=boxes
 const shownEdges=projectedHsmEdges(states,transitions,visibleIds)
 const externalEdges=transitions.map((edge,index)=>({edge,index})).filter(({edge})=>(visibleIds.has(edge.source)||visibleIds.has(edge.target)||edge.source===scopeId)&&!(visibleIds.has(edge.source)&&visibleIds.has(edge.target)))
 const updateView=useCallback((next:View,direct=false)=>{viewRef.current=next;camera.move(next,direct);setView(next)},[camera])
 const localPoint=(clientX:number,clientY:number)=>{const bounds=surface.current!.getBoundingClientRect();return {x:(clientX-bounds.left-viewRef.current.x)/viewRef.current.scale,y:(clientY-bounds.top-viewRef.current.y)/viewRef.current.scale}}
 const fit=useCallback(()=>{
  const bounds=surface.current?.getBoundingClientRect();if(!bounds?.width||!bounds.height)return
  const points=visible.map(s=>positionRef.current[s.id]).filter(Boolean)
  if(!points.length){updateView({x:0,y:0,scale:1});return}
  const left=Math.min(0,...points.map(p=>p[0]))-32,top=Math.min(0,...points.map(p=>p[1]))-32,right=Math.max(...visible.map(s=>{const b=boxRef.current[s.id];return b?b.x+b.width:0}))+44,bottom=Math.max(...visible.map(s=>{const b=boxRef.current[s.id];return b?b.y+b.height:0}))+70
  const scale=clamp(Math.min((bounds.width-44)/(right-left),(bounds.height-80)/(bottom-top)),.25,1)
  updateView({x:(bounds.width-(right-left)*scale)/2-left*scale,y:(bounds.height-(bottom-top)*scale)/2-top*scale,scale})
 },[visible,updateView])
 const fitRef=useRef(fit);fitRef.current=fit
 const zoomAt=(factor:number,clientX?:number,clientY?:number,direct=false)=>{
  const bounds=surface.current?.getBoundingClientRect();if(!bounds||!visible.length)return
  const x=clientX===undefined?bounds.width/2:clientX-bounds.left,y=clientY===undefined?bounds.height/2:clientY-bounds.top,current=camera.current(),scale=clamp(current.scale*factor,.25,2)
  updateView({x:x-(x-current.x)/current.scale*scale,y:y-(y-current.y)/current.scale*scale,scale},direct)
 }
 useEffect(()=>{if(!surface.current)return;let first=true;const observer=new ResizeObserver(([entry])=>{setSize({width:entry.contentRect.width,height:entry.contentRect.height});if(first&&entry.contentRect.width&&entry.contentRect.height){first=false;if(!views.current[scopeId])fitRef.current()}});observer.observe(surface.current);return()=>observer.disconnect()},[scopeId])
 useEffect(()=>{setRenaming(null);setExternalOpen(false);setConnection(null);setMenu(null);const saved=views.current[scopeId];if(saved)updateView(saved);else requestAnimationFrame(()=>fitRef.current());return()=>{views.current[scopeId]=viewRef.current}},[scopeId,updateView])
 useEffect(()=>{const element=surface.current;if(!element)return;const wheel=(event:WheelEvent)=>{if((event.target as Element).closest('button,input,[role=menu]'))return;event.preventDefault();if(!visible.length)return;const unit=event.deltaMode===1?16:event.deltaMode===2?element.clientHeight:1;zoomAt(Math.exp(-clamp(event.deltaY*unit,-150,150)*.0025),event.clientX,event.clientY,true)};element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel)},[updateView,visible.length])
 useEffect(()=>()=>{if(frame.current!==null)cancelAnimationFrame(frame.current)},[])
 const beginRename=(state:State)=>{if(!onRename)return;renameCanceled.current=false;setName(state.label);setRenaming(state.id)}
 const finishRename=()=>{if(renaming&&!renameCanceled.current&&name.trim())onRename?.(renaming,name.trim());setRenaming(null)}
 const capture=(event:PointerEvent)=>{updateView(camera.current(),true);svg.current?.setPointerCapture(event.pointerId);surface.current?.focus({preventScroll:true})}
 const hitNode=(x:number,y:number)=>[...visible].reverse().find(state=>{const box=boxRef.current[state.id];return x>=box.x-14&&x<=box.x+box.width+14&&y>=box.y-8&&y<=box.y+112})
 const completeConnection=(link:Connection,target:string)=>{if(link.side==='output')onConnect?.(link.id,target);else onConnect?.(target,link.id);setConnection(null)}
 const nodeDown=(event:PointerEvent<SVGGElement>,state:State)=>{
  if(event.button!==0&&event.button!==1)return
  event.stopPropagation();setMenu(null);capture(event)
  if(connection&&event.button===0&&!space.current){completeConnection(connection,state.id);return}
  if(space.current||event.button===1){const v=viewRef.current;drag.current={kind:'pan',x:v.x,y:v.y,px:event.clientX,py:event.clientY};setDragging(true);return}
  onSelect(state.id);if(readOnly)return;const p=localPoint(event.clientX,event.clientY),box=boxRef.current[state.id],parent=boxRef.current[box.parent||''];if(p.y>box.y+43)return
  drag.current={kind:'node',id:state.id,px:p.x,py:p.y,moved:false,localX:box.x-(parent?parent.x+24:0),localY:box.y-(parent?parent.y+132:0)}
 }
 const portDown=(event:PointerEvent<SVGCircleElement>,id:string,side:Side)=>{
  event.stopPropagation();event.preventDefault();if(!onConnect||event.button!==0)return
  setMenu(null);capture(event)
  if(connection&&connection.side!==side){completeConnection(connection,id);drag.current=null;return}
  const p=localPoint(event.clientX,event.clientY)
  drag.current={kind:'connect',id,side,px:p.x,py:p.y,moved:false};setConnection({id,side,...p});onSelect(id)
 }
 const blankDown=(event:PointerEvent<SVGSVGElement>)=>{
  if(event.button!==0&&event.button!==1||!visible.length)return
  setMenu(null);setConnection(null);capture(event);const v=viewRef.current;drag.current={kind:'pan',x:v.x,y:v.y,px:event.clientX,py:event.clientY};setDragging(true)
 }
 const move=(event:PointerEvent<SVGSVGElement>)=>{
  const current=drag.current
  if(current?.kind==='pan'){updateView({...viewRef.current,x:current.x+event.clientX-current.px,y:current.y+event.clientY-current.py},true);return}
  const p=localPoint(event.clientX,event.clientY)
  if(current?.kind==='connect'||!current&&connection){const link=current?.kind==='connect'?current:connection!;if(current?.kind==='connect'&&Math.hypot(p.x-current.px,p.y-current.py)>3)current.moved=true;const target=hitNode(p.x,p.y)?.id;setConnection({id:link.id,side:link.side,...p,target});return}
  if(!current||current.kind!=='node')return
  if(Math.abs(p.x-current.px)+Math.abs(p.y-current.py)<3&&!current.moved)return
  current.moved=true
  const next={id:current.id,x:clamp(Math.round(current.localX+p.x-current.px),0,12000),y:clamp(Math.round(current.localY+p.y-current.py),0,12000)}
  const isAncestor=(id:string)=>{let cursor=states.find(s=>s.id===id);for(let i=0;cursor&&i<states.length;i++){if(cursor.id===current.id)return true;cursor=states.find(s=>s.id===cursor?.parent)}return false}
  const target=event.shiftKey?[...visible].reverse().find(state=>{const box=boxRef.current[state.id];return box.expanded&&!isAncestor(state.id)&&p.x>box.x&&p.x<box.x+box.width&&p.y>box.y+132&&p.y<box.y+box.height}):undefined
  setDropTarget(target?.id||'')
  if(frame.current!==null)cancelAnimationFrame(frame.current)
  frame.current=requestAnimationFrame(()=>{frame.current=null;setPreview(next)})
 }
 const finish=(event:PointerEvent<SVGSVGElement>,cancel=false)=>{
  const current=drag.current
  if(frame.current!==null){cancelAnimationFrame(frame.current);frame.current=null}
  if(current&&!cancel){
   const p=localPoint(event.clientX,event.clientY)
   if(current.kind==='node'&&current.moved){if(dropTarget&&onReparent)onReparent(current.id,dropTarget);else onMove(current.id,clamp(Math.round(current.localX+p.x-current.px),0,12000),clamp(Math.round(current.localY+p.y-current.py),0,12000))}
   if(current.kind==='connect'&&current.moved){const target=hitNode(p.x,p.y);if(target)completeConnection({...current,...p},target.id);else setConnection(null)}
  }
  if(svg.current?.hasPointerCapture(event.pointerId))svg.current.releasePointerCapture(event.pointerId)
  drag.current=null;setPreview(null);if(cancel)setConnection(null);setDragging(false);setDropTarget('')
 }
 const containingState=(point:{x:number;y:number})=>[...visible].reverse().find(state=>{const box=boxes[state.id];return box.expanded&&point.x>box.x+12&&point.x<box.x+box.width-12&&point.y>box.y+156&&point.y<box.y+box.height-12})
 const createAt=(point:{x:number;y:number},parentId?:string)=>{const parent=parentId?boxes[parentId]:undefined;if(parent&&onCreateIn)onCreateIn(parentId!,clamp(point.x-parent.x-24-W/2,0,12000),clamp(point.y-parent.y-132-H/2,40,12000));else onCreate?.(clamp(point.x-W/2,0,12000),clamp(point.y-H/2,64,12000))}
 const showMenu=(event:MouseEvent,state?:string,edge?:number)=>{event.preventDefault();event.stopPropagation();updateView(camera.current(),true);setConnection(null);const bounds=surface.current!.getBoundingClientRect();setMenu({x:event.clientX-bounds.left,y:event.clientY-bounds.top,point:localPoint(event.clientX,event.clientY),state,edge,parent:!state&&edge===undefined?containingState(localPoint(event.clientX,event.clientY))?.id:undefined});if(state)onSelect(state);if(edge!==undefined)onSelectTransition?.(edge)}
 const toggleChildren=(id:string)=>setCollapsed(old=>{const next=new Set(old);next.has(id)?next.delete(id):next.add(id);return next})

 const owner=states.find(s=>s.id===scopeId),initial=owner?.initial&&positions[owner.initial]
 const scopeWidth=Math.max(320,...Object.values(boxes).map(box=>box.x+box.width+24)),scopeHeight=Math.max(200,...Object.values(boxes).map(box=>box.y+box.height+24))
 const menuState=states.find(state=>state.id===menu?.state)
 const menuAction=(action:()=>void)=>{setMenu(null);action()}
 return <div className="hsm-canvas-shell wb-canvas">
  <div ref={surface} className={'wb-canvas-surface'+(dragging?' is-panning':'')+(connection?' is-connecting':'')} tabIndex={0} aria-label={t("状态编排画布")} onKeyDown={event=>{
   if(event.target instanceof HTMLInputElement)return
   if(event.code==='Space'){space.current=true;event.preventDefault()}
   if(event.key==='0'){event.preventDefault();fit()}
   if(event.key==='+'||event.key==='='){event.preventDefault();zoomAt(1.15)}
   if(event.key==='-'){event.preventDefault();zoomAt(1/1.15)}
   if(event.key==='F2'){event.preventDefault();const state=states.find(s=>s.id===selected);if(state)beginRename(state)}
   if(event.key==='Escape'){drag.current=null;setConnection(null);setPreview(null);setDragging(false);setExternalOpen(false);setMenu(null)}
  }} onKeyUp={event=>{if(event.code==='Space')space.current=false}} onBlur={()=>{space.current=false}}>
   <svg ref={svg} className="wb-graph" width={size.width} height={size.height} role="group" aria-label={t("{0}的子状态", {0: owner?.label||t("状态机")})} onPointerDown={blankDown} onPointerMove={move} onPointerUp={event=>finish(event)} onPointerCancel={event=>finish(event,true)} onContextMenu={event=>showMenu(event)} onDoubleClick={event=>{event.preventDefault()}}>
    <defs><marker id={marker+'-arrow'} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M1 1 L7 4 L1 7"/></marker></defs>
    <motion.g style={{x:camera.x,y:camera.y,scale:camera.scale,originX:0,originY:0,transformBox:"view-box"}}>
     {visible.length>0&&<g className="wb-scope-frame"><rect className="wb-scope-body" x="0" y="0" width={scopeWidth} height={scopeHeight} rx="12"/><text className="wb-scope-title" x="18" y="28">{owner?.label||t("状态机")}</text><text className="wb-scope-kind" x={scopeWidth-16} y="28" textAnchor="end">{owner?.parent?t("复合状态"):t("根状态")} · {t("{0} 个子状态",{0:states.filter(state=>state.parent===scopeId).length})}</text><path d={`M0 42 H${scopeWidth}`}/></g>}
     {visible.filter(state=>boxes[state.id].expanded).map(state=>{const b=boxes[state.id];return <rect x={b.x} y={b.y} width={b.width} height={b.height} key={'background'+state.id} className={'wb-container-bg'+(activePath.includes(state.id)?' is-live':'')} rx="9"/>})}
     {visible.filter(state=>boxes[state.id].expanded&&state.initial&&boxes[state.initial]).map(state=>{const b=boxes[state.initial!];return <g className="wb-initial" key={'initial'+state.id}><circle cx={b.x-17} cy={b.y+56} r="3"/><path d={`M${b.x-13} ${b.y+56} H${b.x-4}`} markerEnd={`url(#${marker}-arrow)`}/></g>})}
     {initial&&<g className="wb-initial" aria-label={t("初始状态")}><circle cx={initial[0]-32} cy={initial[1]+H/2} r="4"/><path d={`M${initial[0]-27} ${initial[1]+H/2} H${initial[0]-5}`} markerEnd={`url(#${marker}-arrow)`}/></g>}
     {shownEdges.map(({edge,index})=>{
      const same=transitions.slice(0,index).filter(item=>item.source===edge.source&&item.target===edge.target).length
      const route=hsmConnectionPath(boxes[edge.source],boxes[edge.target],same),path=route.path,tx=route.x,ty=route.y
      const label=edge.event||t("未命名事件"),labelWidth=Math.min(170,Math.max(52,label.length*6.7+18)),guarded=edge.guard?.operator&&edge.guard.operator!=='always'
      return <g key={index} className={'wb-edge'+(selectedTransition===index?' is-selected':'')} role="button" tabIndex={0} aria-label={t("转换 {0} 从 {1} 到 {2}", {0: label, 1: states.find(s=>s.id===edge.source)?.label, 2: states.find(s=>s.id===edge.target)?.label})} onPointerDown={event=>event.stopPropagation()} onContextMenu={event=>showMenu(event,undefined,index)} onClick={event=>{event.stopPropagation();onSelectTransition?.(index)}} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelectTransition?.(index)}}}>
       <path className="wb-edge-hit" d={path}/><path className="wb-edge-line" d={path} markerEnd={`url(#${marker}-arrow)`}/><rect className="wb-edge-label-bg" x={tx-labelWidth/2} y={ty-11} width={labelWidth} height="21" rx="5"/><text x={tx} y={ty+3} textAnchor="middle">{guarded?'◇ ':''}{label.slice(0,23)}</text>
      </g>
     })}
     {connection&&(()=>{const anchor=boxes[connection.id],target=connection.target&&boxes[connection.target];if(!anchor)return null;const point={x:connection.x+(connection.side==='input'?-6:7),y:connection.y-56,width:0};const route=connection.side==='output'?hsmConnectionPath(anchor,target||point):hsmConnectionPath(target||point,anchor);return <path className="wb-connection-preview" d={route.path} markerEnd={`url(#${marker}-arrow)`}/>})()}

     {visible.map(state=>{
      const p=positions[state.id],box=boxes[state.id],width=box.width,height=box.height,children=states.filter(s=>s.parent===state.id),live=activePath.includes(state.id),task=state.do?taskLabels[state.do]||t("关联行为"):children.length?t("{0} 个子状态", {0: children.length}):t("添加状态行为")
      return <g key={state.id} className={'wb-node'+(selected===state.id&&selectedTransition==null?' is-selected':'')+(preview?.id===state.id?' is-dragging':'')+(live?' is-live':'')+(connection?.target===state.id||dropTarget===state.id?' is-target':'')+(box.expanded?' is-composite':'')} transform={`translate(${p[0]} ${p[1]})`} role="button" tabIndex={0} aria-label={t("状态 {0}", {0: state.label})} onPointerDown={event=>nodeDown(event,state)} onContextMenu={event=>showMenu(event,state.id)} onDoubleClick={event=>{event.stopPropagation();onEnter?.(state.id)}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();onSelect(state.id);if(children.length)onEnter?.(state.id)}if(event.key==='F2'){event.preventDefault();beginRename(state)}}}>
       <rect className="wb-node-body" width={width} height={height} rx="9"/>{box.expanded&&<rect className="wb-container-handle" width={width} height="112" rx="9"/>}
       <rect className="wb-node-separator" x="12" y="43" width={width-24} height=".6"/>
       <g className="wb-node-glyph" transform="translate(13 13)">{children.length?<><rect width="13" height="13" rx="3"/><path d="M3 5 H10 M3 8 H7"/></>:<rect width="13" height="13" rx="4"/>}</g>
       {renaming===state.id?<foreignObject x="34" y="7" width={width-80} height="32"><input className="wb-node-name-input" autoFocus aria-label={t("状态名称")} maxLength={80} value={name} onChange={event=>setName(event.target.value)} onFocus={event=>event.target.select()} onPointerDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()} onBlur={finishRename} onKeyDown={event=>{event.stopPropagation();if(event.key==='Enter'){event.preventDefault();finishRename();surface.current?.focus()}if(event.key==='Escape'){renameCanceled.current=true;setRenaming(null);surface.current?.focus()}}}/></foreignObject>:<text className="wb-node-title" x="35" y="24">{state.label.slice(0,12)}</text>}
       {children.length>0&&<g className="wb-node-enter" role="button" aria-label={`${box.expanded?t("折叠"):t("展开")} ${state.label}`} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();toggleChildren(state.id)}} transform={`translate(${width-23} 15)`}><rect x="-6" y="-6" width="22" height="22"/><path d="M2 0 L6 4 L2 8"/></g>}
       {(['entry','do','exit'] as const).map((phase,index)=><g className="wb-node-behavior" key={phase} role="button" tabIndex={0} aria-label={t("{0} {1} 的 {2} 行为", {0: readOnly?t("查看"):t("编辑"), 1: state.label, 2: phase})} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onSelect(state.id);onOpenPhase?.(state.id,phase)}} onDoubleClick={event=>event.stopPropagation()} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();onOpenPhase?.(state.id,phase)}}}><rect x="8" y={46+index*20} width={width-16} height="20" rx="4"/><text className="wb-node-phase" x="13" y={60+index*20}>{phase==='entry'?t("进入"):phase==='do'?t("持续"):t("退出")}</text><text className="wb-node-task" x="45" y={60+index*20}>{state[phase]?(taskLabels[state[phase]!]||t("关联行为")).slice(0,22):readOnly?t("未设置"):t("＋ 添加任务")}</text></g>)}
       {box.expanded&&<><path className="wb-container-divider" d={`M12 120 H${width-12}`}/><text className="wb-container-caption" x="18" y="143">{t("子状态 · ")}{children.length}</text>{!readOnly&&onCreateIn&&<g className="wb-container-add" role="button" tabIndex={0} aria-label={t("在 {0} 中添加子状态",{0:state.label})} onPointerDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onCreateIn(state.id)}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();onCreateIn(state.id)}}}><rect x={width-80} y="127" width="64" height="22" rx="4"/><text x={width-48} y="142" textAnchor="middle">{t("＋ 子状态")}</text></g>}</>}
       {live&&<circle className="wb-node-live" cx={width-13} cy="24" r="3"/>}
       {!readOnly&&<><circle className="wb-port wb-port-input" cx="0" cy="56" r="6" role="button" tabIndex={0} aria-label={t("连接到 {0}",{0:state.label})} onPointerDown={event=>portDown(event,state.id,'input')} onDoubleClick={event=>{event.preventDefault();event.stopPropagation()}} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();if(connection?.side==='output')completeConnection(connection,state.id);else setConnection({id:state.id,side:'input',x:p[0]-40,y:p[1]+56})}}}/>
       <circle className="wb-port wb-port-output" cx={width} cy="56" r="6" role="button" tabIndex={0} aria-label={t("从 {0} 创建转换", {0: state.label})} onPointerDown={event=>portDown(event,state.id,'output')} onDoubleClick={event=>{event.preventDefault();event.stopPropagation()}} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();if(connection?.side==='input')completeConnection(connection,state.id);else setConnection({id:state.id,side:'output',x:p[0]+width+40,y:p[1]+56})}}}/></>}
      </g>
     })}
    </motion.g>
   </svg>
   {!visible.length&&<div className="wb-canvas-empty"><span className="wb-empty-glyph">＋</span><strong>{t("在这里组织状态")}</strong><span>{t("添加第一个状态，配置进入、期间与离开行为")}</span>{!readOnly&&<button onClick={()=>onCreate?.(80,90)}>{t("添加第一个状态")}</button>}</div>}
   {visible.length>0&&<div className="wb-canvas-tools"><button onClick={()=>zoomAt(1/1.15)} aria-label={t("缩小画布")} title={t("缩小 −")}>−</button><button className="wb-zoom-value" onClick={()=>{const bounds=surface.current?.getBoundingClientRect();if(bounds)zoomAt(1/view.scale)}} title={t("恢复实际大小")}>{Math.round(view.scale*100)}%</button><button onClick={()=>zoomAt(1.15)} aria-label={t("放大画布")} title={t("放大 +")}>＋</button><span/><button onClick={fit} title={t("适合画布 0")}>{t("适合")}</button>{!readOnly&&<button onClick={()=>{onReset();requestAnimationFrame(()=>fitRef.current())}}>{t("整理")}</button>}</div>}
   <div className="wb-canvas-hint">{readOnly?t("单击状态查看详情 · 拖动画布平移"):connection?t("选择另一状态的连接点 · Esc 取消"):visible.length?t("左键拖动 · 滚轮缩放 · 右键菜单"):''}</div>
   <span ref={menuAnchor} className="wb-context-anchor" style={{left:menu?.x||0,top:menu?.y||0}} aria-hidden="true"/>
   <AnimatePresence>{menu&&menuAnchor.current&&<AnchoredPopover anchor={menuAnchor.current} positionKey={`${menu.x}:${menu.y}`} onClose={()=>setMenu(null)} label={t("画布菜单")} role="menu" className="wb-context-menu" align="start">
    {menuState?<><small>{menuState.label}</small>{!readOnly&&<><button role="menuitem" onClick={()=>menuAction(()=>onCreateIn?.(menuState.id))}>{t("添加子状态")}</button><button role="menuitem" onClick={()=>menuAction(()=>beginRename(menuState))}>{t("重命名状态")}</button>{menuState.parent&&<button role="menuitem" disabled={states.find(state=>state.id===menuState.parent)?.initial===menuState.id} onClick={()=>menuAction(()=>onMakeInitial?.(menuState.id))}>{t("设为初始子状态")}</button>}</>}{states.some(state=>state.parent===menuState.id)&&<><button role="menuitem" onClick={()=>menuAction(()=>toggleChildren(menuState.id))}>{collapsed.has(menuState.id)?t("展开子状态"):t("折叠子状态")}</button><button role="menuitem" onClick={()=>menuAction(()=>onEnter?.(menuState.id))}>{t("进入子状态")}</button></>}{!readOnly&&onDelete&&menuState.parent&&<button role="menuitem" className="is-danger" onClick={()=>menuAction(()=>onDelete(menuState.id))}>{t("删除状态")}</button>}</>:menu.edge!==undefined?<><button role="menuitem" onClick={()=>menuAction(()=>onSelectTransition?.(menu.edge!))}>{t("编辑转换")}</button>{!readOnly&&onDeleteTransition&&<button role="menuitem" className="is-danger" onClick={()=>menuAction(()=>onDeleteTransition(menu.edge!))}>{t("删除转换")}</button>}</>:<>{!readOnly&&<button role="menuitem" onClick={()=>menuAction(()=>createAt(menu.point,menu.parent))}>{menu.parent?t("添加子状态"):t("添加状态")}</button>}<button role="menuitem" onClick={()=>menuAction(fit)}>{t("适合画布")}</button>{!readOnly&&<button role="menuitem" onClick={()=>menuAction(()=>{onReset();requestAnimationFrame(()=>fitRef.current())})}>{t("整理状态")}</button>}</>}
   </AnchoredPopover>}</AnimatePresence>
   {externalEdges.length>0&&<div className="wb-external-edges"><button aria-expanded={externalOpen} onClick={()=>setExternalOpen(!externalOpen)}>↗ {t("{0} 条跨层转换",{0:externalEdges.length})}</button>{externalOpen&&<div className="wb-external-menu">{externalEdges.map(({edge,index})=><button key={index} onClick={()=>{onSelectTransition?.(index);setExternalOpen(false)}}><span>{edge.event}</span><small>{states.find(s=>s.id===edge.source)?.label} → {states.find(s=>s.id===edge.target)?.label}</small></button>)}</div>}</div>}
  </div>
 </div>
}
