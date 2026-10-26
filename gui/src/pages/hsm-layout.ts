export type HierarchyState={id:string;label:string;parent?:string;initial?:string;entry?:string;do?:string;exit?:string}
export type HierarchyEdge={source:string;target:string;event?:string}
export type StateBox={x:number;y:number;width:number;height:number;depth:number;parent?:string;expanded:boolean;localX:number;localY:number}
type Measured={state:HierarchyState;box:StateBox;inside?:Group}
type Group={items:Measured[];width:number;height:number}
const finite=(value:number)=>Number.isFinite(value)?Math.max(0,value):0
const overlaps=(a:StateBox,b:StateBox)=>a.x<b.x+b.width+64&&a.x+a.width+64>b.x&&a.y<b.y+b.height+64&&a.y+a.height+64>b.y

// A deterministic acyclic backbone gives loops a forward reading order without changing transitions
function arrangeGroup(items:Measured[],owner:HierarchyState|undefined,states:HierarchyState[],edges:HierarchyEdge[]){
 if(!items.length)return
 const ids=new Set(items.map(item=>item.state.id)),byId=new Map(states.map(state=>[state.id,state]))
 const represent=(id:string)=>{let state=byId.get(id);for(let depth=0;state&&depth<=states.length;depth++){if(ids.has(state.id))return state.id;if(state.id===owner?.id)break;state=byId.get(state.parent||'')}return undefined}
 const related=edges.map(edge=>({...edge,from:represent(edge.source),to:represent(edge.target)})).filter(edge=>edge.to&&(edge.from||edge.source===owner?.id))
 const failure=new Set(items.filter(item=>related.some(edge=>edge.to===item.state.id&&edge.event==='failed')&&!related.some(edge=>edge.to===item.state.id&&edge.event!=='failed')).map(item=>item.state.id))
 if(owner?.initial)failure.delete(owner.initial)
 const regular=items.filter(item=>!failure.has(item.state.id)),order=new Map(items.map((item,index)=>[item.state.id,index]))
 const successors=new Map(regular.map(item=>[item.state.id,related.filter(edge=>edge.from===item.state.id&&edge.to!==edge.from&&!failure.has(edge.to!)).map(edge=>edge.to!)]))
 const color=new Map<string,number>(),dag=new Map(regular.map(item=>[item.state.id,[] as string[]])),roots=[owner?.initial,...regular.map(item=>item.state.id)].filter((id):id is string=>!!id&&!failure.has(id))
 const visit=(id:string)=>{if(color.has(id))return;color.set(id,1);for(const target of successors.get(id)||[]){if(color.get(target)===1)continue;dag.get(id)?.push(target);visit(target)}color.set(id,2)}
 roots.forEach(visit)
 const indegree=new Map(regular.map(item=>[item.state.id,0])),rank=new Map(regular.map(item=>[item.state.id,0]))
 for(const targets of dag.values())for(const id of new Set(targets))indegree.set(id,(indegree.get(id)||0)+1)
 const queue=regular.filter(item=>!indegree.get(item.state.id)).map(item=>item.state.id)
 for(let index=0;index<queue.length;index++){const id=queue[index];for(const target of new Set(dag.get(id)||[])){rank.set(target,Math.max(rank.get(target)||0,(rank.get(id)||0)+1));indegree.set(target,indegree.get(target)!-1);if(!indegree.get(target))queue.push(target)}}
 const layers=new Map<number,Measured[]>()
 regular.forEach(item=>{const level=rank.get(item.state.id)||0;layers.set(level,[...(layers.get(level)||[]),item])})
 const incoming=(id:string)=>[...dag].filter(([,targets])=>targets.includes(id)).map(([source])=>source)
 const lane=new Map<string,number>()
 for(const [level,group] of [...layers].sort(([a],[b])=>a-b)){
  const barycenter=(id:string)=>{const parents=incoming(id);return parents.length?parents.reduce((sum,parent)=>sum+(lane.get(parent)||0),0)/parents.length:order.get(id)||0}
  group.sort((a,b)=>barycenter(a.state.id)-barycenter(b.state.id)||(order.get(a.state.id)||0)-(order.get(b.state.id)||0))
  group.forEach((item,index)=>lane.set(item.state.id,index));layers.set(level,group)
 }
 if(regular.length>1&&[...dag.values()].every(targets=>!targets.length)){
  const columns=Math.min(3,Math.ceil(Math.sqrt(regular.length))),widths=Array.from({length:columns},(_,column)=>Math.max(208,...regular.filter((_,index)=>index%columns===column).map(item=>item.box.width)))
  let y=64
  for(let start=0;start<regular.length;start+=columns){let x=48,height=0;regular.slice(start,start+columns).forEach((item,column)=>{item.box.x=x;item.box.y=y;x+=widths[column]+132;height=Math.max(height,item.box.height)});y+=height+120}
  let failedY=64;const right=Math.max(...regular.map(item=>item.box.x+item.box.width))
  items.filter(item=>failure.has(item.state.id)).forEach(item=>{item.box.x=right+164;item.box.y=failedY;failedY+=item.box.height+96})
  return
 }
 const depth=Math.max(0,...layers.keys())+1
 // Long chains wrap as graph ranks, while parallel branches stay together in their rank
 const columns=depth<=3?depth:depth<=8?3:4
 let bandY=64,mainRight=36
 for(let start=0;start<depth;start+=columns){
  const bands=Array.from({length:Math.min(columns,depth-start)},(_,index)=>layers.get(start+index)||[])
  const widths=bands.map(group=>Math.max(208,...group.map(item=>item.box.width)))
  const heights=bands.map(group=>group.reduce((sum,item)=>sum+item.box.height,0)+Math.max(0,group.length-1)*80)
  let x=48
  bands.forEach((group,index)=>{let y=bandY;group.forEach(item=>{item.box.x=x;item.box.y=y;y+=item.box.height+80});x+=widths[index]+132;mainRight=Math.max(mainRight,x-132)})
  bandY+=Math.max(112,...heights)+164
 }
 let failureY=64
 items.filter(item=>failure.has(item.state.id)).forEach(item=>{item.box.x=mainRight+164;item.box.y=failureY;failureY+=item.box.height+96})
}

export function nestedHsmLayout(states:HierarchyState[],scope:string,positions:Record<string,[number,number]>,collapsed:Set<string>,preview?:{id:string;x:number;y:number}|null,edges:HierarchyEdge[]=[]){
 const boxes:Record<string,StateBox>={},shown:HierarchyState[]=[],children=(id:string)=>states.filter(state=>state.parent===id)
 function measure(parent:string,depth:number,seen:Set<string>):Group{
  if(seen.has(parent)||depth>40)return {items:[],width:0,height:0}
  const next=new Set(seen).add(parent)
  const items:Measured[]=children(parent).map(state=>{
   const expanded=children(state.id).length>0&&!collapsed.has(state.id),inside=expanded?measure(state.id,depth+1,next):undefined
   return {state,inside,box:{x:48,y:64,width:expanded?Math.max(320,(inside?.width||0)+48):208,height:expanded?Math.max(245,(inside?.height||0)+156):112,depth,parent,expanded,localX:0,localY:0}}
  })
  arrangeGroup(items,states.find(state=>state.id===parent),states,edges)
  const occupied=items.filter(item=>positions[item.state.id]||preview?.id===item.state.id).map(item=>{const local=preview?.id===item.state.id?[preview.x,preview.y]:positions[item.state.id];item.box.x=finite(local[0]);item.box.y=finite(local[1]);return item.box})
  for(const item of items){
   if(!positions[item.state.id]&&preview?.id!==item.state.id){for(let tries=0;tries<=occupied.length;tries++){const collision=occupied.find(other=>overlaps(item.box,other));if(!collision)break;item.box.y=collision.y+collision.height+80}occupied.push(item.box)}
   item.box.localX=item.box.x;item.box.localY=item.box.y
  }
  return {items,width:Math.max(0,...items.map(item=>item.box.x+item.box.width)),height:Math.max(0,...items.map(item=>item.box.y+item.box.height))}
 }
 function place(group:Group,offsetX:number,offsetY:number){for(const {state,box,inside} of group.items){boxes[state.id]={...box,x:box.x+offsetX,y:box.y+offsetY};shown.push(state);if(inside)place(inside,box.x+offsetX+24,box.y+offsetY+132)}}
 place(measure(scope,0,new Set()),0,0)
 return {boxes,shown}
}

export function arrangeHsmPositions(states:HierarchyState[],edges:HierarchyEdge[],positions:Record<string,[number,number]>,scope:string,recursive=false,collapsed:Set<string>=new Set()){
 const next={...positions},seen=new Set<string>()
 const organize=(parent:string)=>{
  if(seen.has(parent))return
  seen.add(parent)
  const children=states.filter(state=>state.parent===parent)
  if(recursive)children.forEach(child=>organize(child.id))
  const preserved=Object.fromEntries(Object.entries(next).filter(([id])=>!children.some(child=>child.id===id)))
  const measured=nestedHsmLayout(states,parent,preserved,collapsed,undefined,edges)
  for(const child of children){const box=measured.boxes[child.id];if(box)next[child.id]=[box.localX,box.localY]}
 }
 organize(scope)
 return next
}

export function projectedHsmEdges<T extends {source:string;target:string}>(states:HierarchyState[],edges:T[],visible:Set<string>){
 const represent=(identity:string)=>{let current=states.find(state=>state.id===identity);for(let depth=0;current&&depth<states.length;depth++){if(visible.has(current.id))return current.id;current=states.find(state=>state.id===current?.parent)}return undefined}
 return edges.flatMap((edge,index)=>{const source=represent(edge.source),target=represent(edge.target);return source&&target&&(source!==target||edge.source===edge.target)?[{index,edge:{...edge,source,target}}]:[]})
}
