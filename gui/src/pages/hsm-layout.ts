export type HierarchyState={id:string;label:string;parent?:string;initial?:string;entry?:string;do?:string;exit?:string}
export type StateBox={x:number;y:number;width:number;height:number;depth:number;parent?:string;expanded:boolean;localX:number;localY:number}
export function nestedHsmLayout(states:HierarchyState[],scope:string,positions:Record<string,[number,number]>,collapsed:Set<string>,preview?:{id:string;x:number;y:number}|null){
 const boxes:Record<string,StateBox>={},shown:HierarchyState[]=[]
 const children=(id:string)=>states.filter(state=>state.parent===id)
 const coordinate=(value:number)=>Number.isFinite(value)?Math.max(0,value):0
 function measure(parent:string,depth:number,seen:Set<string>):{items:{state:HierarchyState;box:StateBox;inside?:ReturnType<typeof measure>}[];width:number;height:number}{
  if(seen.has(parent)||depth>40)return {items:[],width:0,height:0}
  const next=new Set(seen).add(parent)
  const measured=children(parent).map(state=>{
   const expanded=children(state.id).length>0&&!collapsed.has(state.id)
   const inside=expanded?measure(state.id,depth+1,next):undefined
   const width=expanded?Math.max(320,(inside?.width||0)+48):208,height=expanded?Math.max(245,(inside?.height||0)+156):112
   const local=preview?.id===state.id?[preview.x,preview.y]:positions[state.id]
   return {state,inside,fixed:Boolean(local),box:{x:local?coordinate(local[0]):36,y:local?coordinate(local[1]):depth===0?64:40,width,height,depth,parent,expanded,localX:0,localY:0}}
  })
  const occupied=measured.filter(item=>item.fixed).map(item=>item.box)
  let cursor=36
  for(const item of measured){
   const box=item.box
   if(!item.fixed){
    box.x=cursor
    // Only new, unpositioned states yield space to their siblings
    for(let tries=0;tries<=occupied.length;tries++){
     const collision=occupied.find(other=>box.x<other.x+other.width+72&&box.x+box.width+72>other.x&&box.y<other.y+other.height+64&&box.y+box.height+64>other.y)
     if(!collision)break
     box.x=collision.x+collision.width+72
    }
    occupied.push(box)
    cursor=box.x+box.width+72
   }
   box.localX=box.x;box.localY=box.y
  }
  const items=measured.map(({state,box,inside})=>({state,box,inside}))
  return {items,width:Math.max(0,...items.map(item=>item.box.x+item.box.width)),height:Math.max(0,...items.map(item=>item.box.y+item.box.height))}
 }
 function place(group:ReturnType<typeof measure>,offsetX:number,offsetY:number){for(const {state,box,inside} of group.items){boxes[state.id]={...box,x:box.x+offsetX,y:box.y+offsetY};shown.push(state);if(inside)place(inside,box.x+offsetX+24,box.y+offsetY+132)}}
 place(measure(scope,0,new Set()),0,0)
 return {boxes,shown}
}
export function projectedHsmEdges<T extends {source:string;target:string}>(states:HierarchyState[],edges:T[],visible:Set<string>){
 const represent=(identity:string)=>{let current=states.find(state=>state.id===identity);for(let depth=0;current&&depth<states.length;depth++){if(visible.has(current.id))return current.id;current=states.find(state=>state.id===current?.parent)}return undefined}
 return edges.flatMap((edge,index)=>{const source=represent(edge.source),target=represent(edge.target);return source&&target&&(source!==target||edge.source===edge.target)?[{index,edge:{...edge,source,target}}]:[]})
}
