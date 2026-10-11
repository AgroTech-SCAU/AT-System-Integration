import {useRef,useState,type PointerEvent} from 'react'

type State = {id:string;label:string;parent?:string;initial?:string;entry?:string;do?:string;exit?:string}
type Edge = {source:string;target:string;event:string}
export type HsmLayout = {positions:Record<string,[number,number]>}

const NODE_W=172, NODE_H=72, X_STEP=215, Y_STEP=126

export function automaticHsmLayout(states:State[]):HsmLayout {
  const positions:Record<string,[number,number]>={}
  const byParent = (parent:string)=>states.filter(state=>state.parent===parent)
  let leaf=0
  const visit=(id:string,depth:number):number=>{
    const children=byParent(id)
    const x=children.length?children.map(s=>visit(s.id,depth+1)).reduce((a,b)=>a+b,0)/children.length:(leaf++*X_STEP+28)
    positions[id]=[Math.round(x),28+depth*Y_STEP]
    return x
  }
  states.filter(s=>!s.parent).forEach(s=>visit(s.id,0))
  return {positions}
}

export default function HsmCanvas({states,transitions,layout,selected,onSelect,onMove,onReset}:{
  states:State[];transitions:Edge[];layout:HsmLayout;selected:string
  onSelect:(id:string)=>void;onMove:(id:string,x:number,y:number)=>void;onReset:()=>void
}){
  const svg=useRef<SVGSVGElement>(null)
  const moving=useRef<{id:string;x:number;y:number;px:number;py:number;moved:boolean}|null>(null)
  const preview=useRef<[number,number]|null>(null)
  const [movingId,setMovingId]=useState<string|null>(null)
  const [point,setPoint]=useState<[number,number]|null>(null)
  const automatic=automaticHsmLayout(states).positions
  const positions={...automatic,...layout.positions}
  if(movingId&&point)positions[movingId]=point
  const extents=Object.values(positions)
  const width=Math.max(660,...extents.map(v=>v[0]+NODE_W+45))
  const height=Math.max(260,...extents.map(v=>v[1]+NODE_H+55))
  const byId=Object.fromEntries(states.map(s=>[s.id,s]))
  const scale=(e:PointerEvent<SVGElement>)=>{
    const bounds=svg.current?.getBoundingClientRect()
    return bounds?[(e.clientX-bounds.left)*(width/bounds.width),(e.clientY-bounds.top)*(height/bounds.height)]:[e.clientX,e.clientY]
  }
  const begin=(e:PointerEvent<SVGGElement>,id:string)=>{
    if(e.button!==0)return
    e.currentTarget.setPointerCapture(e.pointerId)
    const [px,py]=scale(e)
    moving.current={id,x:positions[id][0],y:positions[id][1],px,py,moved:false}
    preview.current=null
  }
  const move=(e:PointerEvent<SVGGElement>)=>{
    const current=moving.current
    if(!current)return
    const [x,y]=scale(e)
    if(Math.abs(x-current.px)+Math.abs(y-current.py)>4)current.moved=true
    if(current.moved){
      const next:[number,number]=[Math.max(4,Math.round(current.x+x-current.px)),Math.max(4,Math.round(current.y+y-current.py))]
      preview.current=next
      setMovingId(current.id);setPoint(next)
    }
  }
  const finish=(e:PointerEvent<SVGGElement>)=>{
    const current=moving.current
    if(!current)return
    if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)
    if(current.moved&&preview.current)onMove(current.id,...preview.current)
    else onSelect(current.id)
    moving.current=null;preview.current=null;setMovingId(null);setPoint(null)
  }
  return <div className="hsm-canvas-shell" data-guide="hsm-visual-canvas">
    <div className="hsm-canvas-toolbar"><span>拖动卡片调整位置 · 在状态层级中拖放可调整父子关系</span><button onClick={onReset}>自动排版</button></div>
    <div className="hsm-canvas-scroll" tabIndex={0} aria-label="状态层级图画布">
      <svg ref={svg} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="状态及事件转换图">
        <defs><marker id="hsm-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0 0 L7 3 L0 6" fill="none" stroke="currentColor" strokeWidth="1.3"/></marker></defs>
        {states.filter(s=>s.parent&&positions[s.parent]).map(s=>{
          const a=positions[s.parent!],b=positions[s.id]
          return <path key={'parent-'+s.id} className="hsm-canvas-hierarchy" d={`M${a[0]+NODE_W/2},${a[1]+NODE_H} V${a[1]+NODE_H+18} H${b[0]+NODE_W/2} V${b[1]}`} />
        })}
        {transitions.filter(t=>positions[t.source]&&positions[t.target]).map((edge,i)=>{
          const a=positions[edge.source],b=positions[edge.target]
          const x1=a[0]+NODE_W,y1=a[1]+NODE_H/2,x2=b[0],y2=b[1]+NODE_H/2
          const bend=Math.max(32,Math.abs(x2-x1)/3)
          return <g key={'event-'+i} className="hsm-canvas-event"><path d={`M${x1},${y1} C${x1+bend},${y1-40} ${x2-bend},${y2-40} ${x2},${y2}`} markerEnd="url(#hsm-arrow)" /><text x={(x1+x2)/2} y={Math.min(y1,y2)-38} textAnchor="middle">{edge.event.slice(0,22)}</text></g>
        })}
        {states.map(state=>{
          const p=positions[state.id]
          return <g key={state.id} className={'hsm-canvas-node'+(selected===state.id?' selected':'')+(movingId===state.id?' dragging':'')} transform={`translate(${p[0]} ${p[1]})`} role="button" tabIndex={0} aria-label={`状态 ${state.label}`} onClick={()=>onSelect(state.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(state.id)}}} onPointerDown={e=>begin(e,state.id)} onPointerMove={move} onPointerUp={finish} onPointerCancel={()=>{moving.current=null;setMovingId(null);setPoint(null)}}>
            <rect width={NODE_W} height={NODE_H} rx="10"/>
            <text x="13" y="22" className="hsm-canvas-title">{state.label.slice(0,13)}</text>
            <text x="13" y="40" className="hsm-canvas-meta">{state.id.slice(0,24)}</text>
            <text x="13" y="59" className="hsm-canvas-meta">{state.initial?'复合状态':state.do?'Do · 行为树':state.entry||state.exit?'生命周期动作':'普通状态'}</text>
          </g>
        })}
      </svg>
    </div>
  </div>
}
