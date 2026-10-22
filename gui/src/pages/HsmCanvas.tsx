import {useCallback,useEffect,useId,useMemo,useRef,useState,type PointerEvent} from 'react'

type State={id:string;label:string;parent?:string;initial?:string;entry?:string;do?:string;exit?:string}
type Edge={source:string;target:string;event:string;guard?:{operator:string}}
export type HsmLayout={positions:Record<string,[number,number]>}
type View={x:number;y:number;scale:number}
type Drag={kind:'node';id:string;x:number;y:number;px:number;py:number;moved:boolean}|{kind:'pan';x:number;y:number;px:number;py:number}|{kind:'connect';id:string;x:number;y:number}
const W=184,H=82,GAP_X=100,GAP_Y=100
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value))

export function automaticHsmLayout(states:State[]):HsmLayout{
 const positions:Record<string,[number,number]>={}
 const groups=new Map<string,State[]>()
 for(const state of states){const parent=state.parent||'';groups.set(parent,[...(groups.get(parent)||[]),state])}
 for(const siblings of groups.values()){
  const columns=siblings.length<=3?siblings.length:Math.min(6,Math.ceil(Math.sqrt(siblings.length)))
  siblings.forEach((state,index)=>{positions[state.id]=[70+(index%columns)*(W+GAP_X),86+Math.floor(index/columns)*(H+GAP_Y)]})
 }
 return {positions}
}

export default function HsmCanvas({states,transitions,layout,selected,onSelect,onMove,onReset,scope,selectedTransition,onSelectTransition,onConnect,onCreate,onRename,onEnter,onOpenPhase,activePath=[],taskLabels={}}:{
 states:State[];transitions:Edge[];layout:HsmLayout;selected:string;scope?:string;selectedTransition?:number|null;activePath?:string[];taskLabels?:Record<string,string>
 onSelect:(id:string)=>void;onMove:(id:string,x:number,y:number)=>void;onReset:()=>void
 onSelectTransition?:(index:number)=>void;onConnect?:(source:string,target:string)=>void;onCreate?:(x:number,y:number)=>void;onRename?:(id:string,label:string)=>void;onEnter?:(id:string)=>void;onOpenPhase?:(id:string,phase:'entry'|'do'|'exit')=>void
}){
 const svg=useRef<SVGSVGElement>(null),surface=useRef<HTMLDivElement>(null),frame=useRef<number|null>(null),drag=useRef<Drag|null>(null)
 const views=useRef<Record<string,View>>({}),space=useRef(false),marker=useId().replaceAll(':',''),renameCanceled=useRef(false)
 const [view,setView]=useState<View>({x:0,y:0,scale:1}),viewRef=useRef(view)
 const [size,setSize]=useState({width:700,height:400}),[preview,setPreview]=useState<{id:string;x:number;y:number}|null>(null)
 const [connection,setConnection]=useState<{id:string;x:number;y:number;target?:string}|null>(null),[dragging,setDragging]=useState(false)
 const [renaming,setRenaming]=useState<string|null>(null),[name,setName]=useState(''),[externalOpen,setExternalOpen]=useState(false)
 const scopeId=scope||states.find(s=>!s.parent)?.id||''
 const visible=useMemo(()=>states.filter(s=>s.parent===scopeId),[states,scopeId])
 const visibleIds=useMemo(()=>new Set(visible.map(s=>s.id)),[visible])
 const automatic=useMemo(()=>automaticHsmLayout(states).positions,[states])
 const positions={...automatic,...layout.positions,...(preview?{[preview.id]:[preview.x,preview.y] as [number,number]}:{})}
 const positionRef=useRef(positions);positionRef.current=positions
 const shownEdges=transitions.map((edge,index)=>({edge,index})).filter(({edge})=>visibleIds.has(edge.source)&&visibleIds.has(edge.target))
 const externalEdges=transitions.map((edge,index)=>({edge,index})).filter(({edge})=>(visibleIds.has(edge.source)||visibleIds.has(edge.target)||edge.source===scopeId)&&!(visibleIds.has(edge.source)&&visibleIds.has(edge.target)))
 const updateView=useCallback((next:View)=>{viewRef.current=next;setView(next)},[])
 const localPoint=(clientX:number,clientY:number)=>{const bounds=surface.current!.getBoundingClientRect();return {x:(clientX-bounds.left-viewRef.current.x)/viewRef.current.scale,y:(clientY-bounds.top-viewRef.current.y)/viewRef.current.scale}}
 const fit=useCallback(()=>{
  const bounds=surface.current?.getBoundingClientRect();if(!bounds?.width||!bounds.height)return
  const points=visible.map(s=>positionRef.current[s.id]).filter(Boolean)
  if(!points.length){updateView({x:0,y:0,scale:1});return}
  const left=Math.min(...points.map(p=>p[0]))-44,top=Math.min(...points.map(p=>p[1]))-70,right=Math.max(...points.map(p=>p[0]+W))+44,bottom=Math.max(...points.map(p=>p[1]+H))+70
  const scale=clamp(Math.min((bounds.width-44)/(right-left),(bounds.height-80)/(bottom-top)),.25,1)
  updateView({x:(bounds.width-(right-left)*scale)/2-left*scale,y:(bounds.height-(bottom-top)*scale)/2-top*scale,scale})
 },[visible,updateView])
 const fitRef=useRef(fit);fitRef.current=fit
 const zoomAt=(factor:number,clientX?:number,clientY?:number)=>{
  const bounds=surface.current?.getBoundingClientRect();if(!bounds)return
  const x=clientX===undefined?bounds.width/2:clientX-bounds.left,y=clientY===undefined?bounds.height/2:clientY-bounds.top,current=viewRef.current,scale=clamp(current.scale*factor,.25,2)
  updateView({x:x-(x-current.x)/current.scale*scale,y:y-(y-current.y)/current.scale*scale,scale})
 }
 useEffect(()=>{if(!surface.current)return;let first=true;const observer=new ResizeObserver(([entry])=>{setSize({width:entry.contentRect.width,height:entry.contentRect.height});if(first&&entry.contentRect.width&&entry.contentRect.height){first=false;if(!views.current[scopeId])fitRef.current()}});observer.observe(surface.current);return()=>observer.disconnect()},[scopeId])
 useEffect(()=>{setRenaming(null);setExternalOpen(false);const saved=views.current[scopeId];if(saved)updateView(saved);else requestAnimationFrame(()=>fitRef.current());return()=>{views.current[scopeId]=viewRef.current}},[scopeId,updateView])
 useEffect(()=>{const element=surface.current;if(!element)return;const wheel=(event:WheelEvent)=>{event.preventDefault();if(event.ctrlKey||event.metaKey){zoomAt(Math.exp(-event.deltaY*.006),event.clientX,event.clientY)}else{const v=viewRef.current;updateView({...v,x:v.x-event.deltaX,y:v.y-event.deltaY})}};element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel)},[updateView])
 useEffect(()=>()=>{if(frame.current!==null)cancelAnimationFrame(frame.current)},[])
 const beginRename=(state:State)=>{if(!onRename)return;renameCanceled.current=false;setName(state.label);setRenaming(state.id)}
 const finishRename=()=>{if(renaming&&!renameCanceled.current&&name.trim())onRename?.(renaming,name.trim());setRenaming(null)}
 const capture=(event:PointerEvent)=>{svg.current?.setPointerCapture(event.pointerId);surface.current?.focus({preventScroll:true})}
 const nodeDown=(event:PointerEvent<SVGGElement>,state:State)=>{
  if(event.button!==0&&event.button!==1)return
  event.stopPropagation();capture(event)
  if(space.current||event.button===1){const v=viewRef.current;drag.current={kind:'pan',x:v.x,y:v.y,px:event.clientX,py:event.clientY};setDragging(true);return}
  onSelect(state.id);const p=localPoint(event.clientX,event.clientY),pos=positions[state.id]
  drag.current={kind:'node',id:state.id,x:pos[0],y:pos[1],px:p.x,py:p.y,moved:false}
 }
 const portDown=(event:PointerEvent<SVGCircleElement>,id:string)=>{
  if(!onConnect||event.button!==0)return
  event.stopPropagation();capture(event);const p=localPoint(event.clientX,event.clientY)
  drag.current={kind:'connect',id,x:p.x,y:p.y};setConnection({id,...p});onSelect(id)
 }
 const blankDown=(event:PointerEvent<SVGSVGElement>)=>{
  if(event.button!==0&&event.button!==1)return
  capture(event);const v=viewRef.current;drag.current={kind:'pan',x:v.x,y:v.y,px:event.clientX,py:event.clientY};setDragging(true)
 }
 const move=(event:PointerEvent<SVGSVGElement>)=>{
  const current=drag.current;if(!current)return
  if(current.kind==='pan'){updateView({...viewRef.current,x:current.x+event.clientX-current.px,y:current.y+event.clientY-current.py});return}
  const p=localPoint(event.clientX,event.clientY)
  if(current.kind==='connect'){const target=visible.find(s=>{const a=positionRef.current[s.id];return p.x>=a[0]-12&&p.x<=a[0]+W+12&&p.y>=a[1]-8&&p.y<=a[1]+H+8})?.id;setConnection({id:current.id,...p,target});return}
  if(Math.abs(p.x-current.px)+Math.abs(p.y-current.py)<3&&!current.moved)return
  current.moved=true
  const next={id:current.id,x:clamp(Math.round(current.x+p.x-current.px),0,12000),y:clamp(Math.round(current.y+p.y-current.py),0,12000)}
  if(frame.current!==null)cancelAnimationFrame(frame.current)
  frame.current=requestAnimationFrame(()=>{frame.current=null;setPreview(next)})
 }
 const finish=(event:PointerEvent<SVGSVGElement>,cancel=false)=>{
  const current=drag.current
  if(frame.current!==null){cancelAnimationFrame(frame.current);frame.current=null}
  if(current&&!cancel){
   const p=localPoint(event.clientX,event.clientY)
   if(current.kind==='node'&&current.moved)onMove(current.id,clamp(Math.round(current.x+p.x-current.px),0,12000),clamp(Math.round(current.y+p.y-current.py),0,12000))
   if(current.kind==='connect'){const target=visible.find(s=>{const a=positionRef.current[s.id];return p.x>=a[0]-12&&p.x<=a[0]+W+12&&p.y>=a[1]-8&&p.y<=a[1]+H+8});if(target)onConnect?.(current.id,target.id)}
  }
  if(svg.current?.hasPointerCapture(event.pointerId))svg.current.releasePointerCapture(event.pointerId)
  drag.current=null;setPreview(null);setConnection(null);setDragging(false)
 }
 const owner=states.find(s=>s.id===scopeId),initial=owner?.initial&&positions[owner.initial]
 return <div className="hsm-canvas-shell wb-canvas" data-guide="hsm-visual-canvas">
  <div ref={surface} className={'wb-canvas-surface'+(dragging?' is-panning':'')+(connection?' is-connecting':'')} tabIndex={0} aria-label="状态编排画布" onKeyDown={event=>{
   if(event.target instanceof HTMLInputElement)return
   if(event.code==='Space'){space.current=true;event.preventDefault()}
   if(event.key==='0'){event.preventDefault();fit()}
   if(event.key==='+'||event.key==='='){event.preventDefault();zoomAt(1.15)}
   if(event.key==='-'){event.preventDefault();zoomAt(1/1.15)}
   if(event.key==='F2'){event.preventDefault();const state=states.find(s=>s.id===selected);if(state)beginRename(state)}
   if(event.key==='Escape'){drag.current=null;setConnection(null);setPreview(null);setDragging(false);setExternalOpen(false)}
  }} onKeyUp={event=>{if(event.code==='Space')space.current=false}} onBlur={()=>{space.current=false}}>
   <svg ref={svg} className="wb-graph" width={size.width} height={size.height} role="group" aria-label={`${owner?.label||'状态机'}的子状态`} onPointerDown={blankDown} onPointerMove={move} onPointerUp={event=>finish(event)} onPointerCancel={event=>finish(event,true)} onDoubleClick={event=>{if(event.target===svg.current){const p=localPoint(event.clientX,event.clientY);onCreate?.(clamp(p.x-W/2,0,12000),clamp(p.y-H/2,0,12000))}}}>
    <defs><marker id={marker+'-arrow'} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M1 1 L7 4 L1 7"/></marker></defs>
    <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
     {initial&&<g className="wb-initial" aria-label="初始状态"><circle cx={initial[0]-32} cy={initial[1]+H/2} r="4"/><path d={`M${initial[0]-27} ${initial[1]+H/2} H${initial[0]-5}`} markerEnd={`url(#${marker}-arrow)`}/></g>}
     {shownEdges.map(({edge,index})=>{
      const a=positions[edge.source],b=positions[edge.target],x1=a[0]+W,y1=a[1]+H/2,x2=b[0],y2=b[1]+H/2,forward=x2-x1>32
      const same=transitions.slice(0,index).filter(t=>t.source===edge.source&&t.target===edge.target).length
      let path='',tx=0,ty=0
      if(edge.source===edge.target){path=`M${x1} ${y1} H${x1+32} V${a[1]-34-same*28} H${a[0]+W/2} V${a[1]-4}`;tx=a[0]+W/2+38;ty=a[1]-34-same*28}
      else if(forward){const mid=(x1+x2)/2;path=`M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2-4} ${y2}`;tx=mid;ty=(y1+y2)/2-11-same*20}
      else{const top=Math.min(a[1],b[1])-44-same*26;path=`M${x1} ${y1} H${x1+24} Q${x1+36} ${y1} ${x1+36} ${y1-12} V${top+12} Q${x1+36} ${top} ${x1+24} ${top} H${x2-24} Q${x2-36} ${top} ${x2-36} ${top+12} V${y2-12} Q${x2-36} ${y2} ${x2-24} ${y2} H${x2-4}`;tx=(x1+x2)/2;ty=top-2}
      const label=edge.event||'未命名事件',labelWidth=Math.min(170,Math.max(52,label.length*6.7+18)),guarded=edge.guard?.operator&&edge.guard.operator!=='always'
      return <g key={index} className={'wb-edge'+(selectedTransition===index?' is-selected':'')} role="button" tabIndex={0} aria-label={`转换 ${label} 从 ${states.find(s=>s.id===edge.source)?.label} 到 ${states.find(s=>s.id===edge.target)?.label}`} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onSelectTransition?.(index)}} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelectTransition?.(index)}}}>
       <path className="wb-edge-hit" d={path}/><path className="wb-edge-line" d={path} markerEnd={`url(#${marker}-arrow)`}/><rect className="wb-edge-label-bg" x={tx-labelWidth/2} y={ty-11} width={labelWidth} height="21" rx="5"/><text x={tx} y={ty+3} textAnchor="middle">{guarded?'◇ ':''}{label.slice(0,23)}</text>
      </g>
     })}
     {connection&&<path className="wb-connection-preview" d={`M${positions[connection.id][0]+W} ${positions[connection.id][1]+H/2} C${positions[connection.id][0]+W+60} ${positions[connection.id][1]+H/2} ${connection.x-60} ${connection.y} ${connection.x} ${connection.y}`} markerEnd={`url(#${marker}-arrow)`}/>}
     {visible.map(state=>{
      const p=positions[state.id],children=states.filter(s=>s.parent===state.id),live=activePath.includes(state.id),task=state.do?taskLabels[state.do]||'关联行为':children.length?`${children.length} 个子状态`:'添加状态行为'
      return <g key={state.id} className={'wb-node'+(selected===state.id&&selectedTransition==null?' is-selected':'')+(preview?.id===state.id?' is-dragging':'')+(live?' is-live':'')+(connection?.target===state.id?' is-target':'')} transform={`translate(${p[0]} ${p[1]})`} role="button" tabIndex={0} aria-label={`状态 ${state.label}`} onPointerDown={event=>nodeDown(event,state)} onDoubleClick={event=>{event.stopPropagation();if(children.length)onEnter?.(state.id);else beginRename(state)}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();onSelect(state.id);if(children.length)onEnter?.(state.id)}if(event.key==='F2'){event.preventDefault();beginRename(state)}}}>
       <rect className="wb-node-body" width={W} height={H} rx="9"/>
       <rect className="wb-node-separator" x="12" y="43" width={W-24} height=".6"/>
       <g className="wb-node-glyph" transform="translate(13 13)">{children.length?<><rect width="13" height="13" rx="3"/><path d="M3 5 H10 M3 8 H7"/></>:<rect width="13" height="13" rx="4"/>}</g>
       {renaming===state.id?<foreignObject x="34" y="7" width={W-44} height="32"><input className="wb-node-name-input" autoFocus aria-label="状态名称" maxLength={80} value={name} onChange={event=>setName(event.target.value)} onFocus={event=>event.target.select()} onPointerDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()} onBlur={finishRename} onKeyDown={event=>{event.stopPropagation();if(event.key==='Enter'){event.preventDefault();finishRename();surface.current?.focus()}if(event.key==='Escape'){renameCanceled.current=true;setRenaming(null);surface.current?.focus()}}}/></foreignObject>:<text className="wb-node-title" x="35" y="24">{state.label.slice(0,12)}</text>}
       {children.length>0&&<g className="wb-node-enter" role="button" aria-label={`进入 ${state.label}`} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onEnter?.(state.id)}} transform={`translate(${W-23} 15)`}><rect x="-6" y="-6" width="22" height="22"/><path d="M2 0 L6 4 L2 8"/></g>}
       <g className="wb-node-behavior" role="button" tabIndex={0} aria-label={`编辑 ${state.label} 的 Do 行为`} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();onSelect(state.id);onOpenPhase?.(state.id,'do')}} onDoubleClick={event=>event.stopPropagation()} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();onOpenPhase?.(state.id,'do')}}}>
        <rect x="8" y="47" width={W-16} height="28" rx="4"/><text className="wb-node-phase" x="13" y="65">Do</text><text className="wb-node-task" x="37" y="65">{task.slice(0,17)}</text>
       </g>
       {live&&<circle className="wb-node-live" cx={W-13} cy={H-14} r="3"/>}
       <circle className="wb-port wb-port-input" cx="0" cy={H/2} r="5"/>
       <circle className="wb-port wb-port-output" cx={W} cy={H/2} r="6" role="button" aria-label={`从 ${state.label} 拖动创建转换`} onPointerDown={event=>portDown(event,state.id)}/>
      </g>
     })}
    </g>
   </svg>
   {!visible.length&&<div className="wb-canvas-empty"><span className="wb-empty-glyph">＋</span><strong>在这里组织状态</strong><span>双击画布添加状态</span><button onClick={()=>onCreate?.(80,90)}>添加第一个状态</button></div>}
   <div className="wb-canvas-tools"><button onClick={()=>zoomAt(1/1.15)} aria-label="缩小画布" title="缩小 −">−</button><button className="wb-zoom-value" onClick={()=>{const bounds=surface.current?.getBoundingClientRect();if(bounds)zoomAt(1/view.scale)}} title="恢复实际大小">{Math.round(view.scale*100)}%</button><button onClick={()=>zoomAt(1.15)} aria-label="放大画布" title="放大 +">＋</button><span/><button onClick={fit} title="适合画布 0">适合</button><button onClick={()=>{onReset();requestAnimationFrame(()=>fitRef.current())}}>整理</button></div>
   <div className="wb-canvas-hint">{connection?'拖到目标状态以创建转换':visible.length?'拖动右侧端点创建转换 · 双击空白添加状态':''}</div>
   {externalEdges.length>0&&<div className="wb-external-edges"><button aria-expanded={externalOpen} onClick={()=>setExternalOpen(!externalOpen)}>↗ {externalEdges.length} 条跨层转换</button>{externalOpen&&<div className="wb-external-menu">{externalEdges.map(({edge,index})=><button key={index} onClick={()=>{onSelectTransition?.(index);setExternalOpen(false)}}><span>{edge.event}</span><small>{states.find(s=>s.id===edge.source)?.label} → {states.find(s=>s.id===edge.target)?.label}</small></button>)}</div>}</div>}
  </div>
 </div>
}
