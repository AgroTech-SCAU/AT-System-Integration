export type HierarchyState={id:string;label:string;parent?:string;initial?:string;entry?:string;do?:string;exit?:string}
export type StateBox={x:number;y:number;width:number;height:number;depth:number;parent?:string;expanded:boolean;localX:number;localY:number}
export function nestedHsmLayout(states:HierarchyState[],scope:string,positions:Record<string,[number,number]>,collapsed:Set<string>,preview?:{id:string;x:number;y:number}|null){
 const boxes:Record<string,StateBox>={},shown:HierarchyState[]=[]
 const children=(id:string)=>states.filter(state=>state.parent===id)
 function measure(parent:string,depth:number,seen:Set<string>):{items:{state:HierarchyState;box:StateBox;inside?:ReturnType<typeof measure>}[];width:number;height:number}{
  if(seen.has(parent)||depth>40)return {items:[],width:0,height:0}
  const next=new Set(seen).add(parent),items:{state:HierarchyState;box:StateBox;inside?:ReturnType<typeof measure>}[]=[]
  children(parent).forEach((state,index)=>{
   const expanded=children(state.id).length>0&&!collapsed.has(state.id)
   const inside=expanded?measure(state.id,depth+1,next):undefined
   const width=expanded?Math.max(320,(inside?.width||0)+48):208,height=expanded?Math.max(245,(inside?.height||0)+156):112
   const local=preview?.id===state.id?[preview.x,preview.y]:positions[state.id]||[36+index*280,64]
   let x=Math.max(24,local[0]),y=Math.max(40,local[1])
   // Expanded containers reserve their full area, including when loading an older flat layout
   for(let tries=0;tries<items.length+1;tries++){
    const collision=items.find(item=>x<item.box.x+item.box.width+56&&x+width+56>item.box.x&&y<item.box.y+item.box.height+64&&y+height+64>item.box.y)
    if(!collision)break
    x=collision.box.x+collision.box.width+72
   }
   items.push({state,box:{x,y,width,height,depth,parent,expanded,localX:local[0],localY:local[1]},inside})
  })
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
