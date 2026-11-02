import type {HierarchyState,StateBox} from './hsm-layout'
export type RoutePoint={x:number;y:number}
export type RouteBounds={left:number;top:number;right:number;bottom:number}
export type RoutedEdge={index:number;path:string;points:RoutePoint[];x:number;y:number;labelWidth:number;bounds:RouteBounds;inherited?:boolean}
type Edge={source:string;target:string;event?:string;guard?:{operator?:string;key?:string;value?:unknown}}
type Rectangle={x:number;y:number;width:number;height:number}
const intersects=(a:RoutePoint,b:RoutePoint,box:Rectangle)=>a.x===b.x?a.x>box.x+.1&&a.x<box.x+box.width-.1&&Math.max(a.y,b.y)>box.y+.1&&Math.min(a.y,b.y)<box.y+box.height-.1:a.y>box.y+.1&&a.y<box.y+box.height-.1&&Math.max(a.x,b.x)>box.x+.1&&Math.min(a.x,b.x)<box.x+box.width-.1
const boxOverlap=(a:Rectangle,b:Rectangle)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y
const distance=(a:RoutePoint,b:RoutePoint)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y)
const simplify=(points:RoutePoint[])=>points.filter((point,index)=>!index||point.x!==points[index-1].x||point.y!==points[index-1].y).filter((point,index,all)=>!index||index===all.length-1||!(all[index-1].x===point.x&&point.x===all[index+1].x&&point.y>=Math.min(all[index-1].y,all[index+1].y)&&point.y<=Math.max(all[index-1].y,all[index+1].y)||all[index-1].y===point.y&&point.y===all[index+1].y&&point.x>=Math.min(all[index-1].x,all[index+1].x)&&point.x<=Math.max(all[index-1].x,all[index+1].x)))
export function roundedRoute(points:RoutePoint[]){
 if(!points.length)return ''
 let path=`M${points[0].x} ${points[0].y}`
 for(let index=1;index<points.length-1;index++){const before=points[index-1],point=points[index],after=points[index+1],radius=Math.min(10,distance(before,point)/2,distance(point,after)/2),entry={x:point.x+Math.sign(before.x-point.x)*radius,y:point.y+Math.sign(before.y-point.y)*radius},exit={x:point.x+Math.sign(after.x-point.x)*radius,y:point.y+Math.sign(after.y-point.y)*radius};path+=` L${entry.x} ${entry.y} Q${point.x} ${point.y} ${exit.x} ${exit.y}`}
 const end=points[points.length-1];return path+` L${end.x} ${end.y}`
}
export function guardSummary(edge:Edge){
 const guard=edge.guard
 if(!guard?.operator||['always','otherwise'].includes(guard.operator))return ''
 const operator=({equals:'=',not_equals:'≠',greater:'>',less:'<'} as Record<string,string>)[guard.operator]||guard.operator
 const value=typeof guard.value==='string'?JSON.stringify(guard.value):JSON.stringify(guard.value)??'?'
 return `${guard.key||'?'} ${operator} ${value}`
}

export function routeHsmEdges(states:HierarchyState[],shown:{index:number;edge:Edge;inherited?:boolean}[],boxes:Record<string,StateBox>,labels:Map<number,string>,scope:string):RoutedEdge[]{
 const routes:RoutedEdge[]=[],usedLabels:Rectangle[]=[],usedSegments=new Map<string,[number,number][]>(),byId=new Map(states.map(state=>[state.id,state]))
 const ancestor=(possible:string,id:string)=>{let state=byId.get(id);for(let count=0;state&&count<states.length;count++){if(state.parent===possible)return true;state=byId.get(state.parent||'')}return false}
 const all=Object.entries(boxes)
 const bounds={left:Math.min(0,...all.map(([,box])=>box.x)),top:Math.min(0,...all.map(([,box])=>box.y)),right:Math.max(320,...all.map(([,box])=>box.x+box.width)),bottom:Math.max(200,...all.map(([,box])=>box.y+box.height))}
 const ordered=[...shown].sort((a,b)=>Number(!!a.inherited)-Number(!!b.inherited)||a.index-b.index)
 for(const {edge,index,inherited} of ordered){
  const a=boxes[edge.source]||(edge.source===scope?{x:0,y:-26,width:Math.max(160,(byId.get(scope)?.label.length||0)*14+40),height:0}:undefined),b=boxes[edge.target]
  if(!a||!b)continue
  const same=routes.filter(route=>{const other=shown.find(item=>item.index===route.index)?.edge;return other?.source===edge.source||other?.target===edge.target}).length
  const lane=same%9,loop=edge.source===edge.target,back=loop||b.y<a.y-10||b.y===a.y&&b.x<=a.x
  const start={x:a.x+a.width+7,y:a.y+56},end={x:b.x-9,y:b.y+56}
  const source={x:start.x+26+lane*16,y:start.y},target={x:end.x-26-lane*16,y:end.y}
  const obstacles=all.map(([id,box])=>{const transparent=ancestor(id,edge.source)||ancestor(id,edge.target);return {id,x:box.x-12,y:box.y-12,width:box.width+24,height:(transparent?112:box.height)+24}})
  const label=labels.get(index)||'',labelWidth=Math.min(282,Math.max(64,[...label].reduce((sum,char)=>sum+(/[\u3000-\u9fff]/.test(char)?11:6.4),0)+20))
  const ys=[(start.y+end.y)/2,a.y-44-lane*26,b.y-44-lane*26,a.y+('height' in a?a.height:112)+44+lane*26,b.y+b.height+44+lane*26,bounds.top-48-index*20,bounds.bottom+48+index*20]
  const xs=[(source.x+target.x)/2,bounds.left-48-index*22,bounds.right+48+index*22,...all.flatMap(([,box])=>[box.x-34-lane*16,box.x+box.width+34+lane*16])]
  const candidates:RoutePoint[][]=[]
  if(!back&&source.x<=target.x&&start.y===end.y)candidates.push([start,source,target,end])
  for(const y of ys)candidates.push([start,source,{x:source.x,y},{x:target.x,y},target,end])
  for(const x of xs)candidates.push([start,source,{x,y:source.y},{x,y:target.y},target,end])
  // Outer corridors remain available when a branch or a container blocks both simple bends
  const outerXs=[bounds.left-64-index*22,bounds.right+64+index*22]
  const outerYs=[bounds.top-54-index*22,bounds.bottom+54+index*22,a.y-40,b.y-40,a.y+('height' in a?a.height:112)+40,b.y+b.height+40]
  for(const x of outerXs)for(const y1 of outerYs.slice(0,4))for(const y2 of outerYs.slice(0,4))candidates.push([start,source,{x:source.x,y:y1},{x,y:y1},{x,y:y2},{x:target.x,y:y2},target,end])
  let best:{points:RoutePoint[];score:number;label:Rectangle}|undefined
  for(const raw of candidates){
   const points=simplify(raw)
   if(points.length<2||points[1].y!==start.y||points[1].x<=start.x||points[points.length-2].y!==end.y||points[points.length-2].x>=end.x)continue
   if(points.some((point,i)=>i>0&&i<points.length-1&&(point.x-points[i-1].x)*(points[i+1].x-point.x)+(point.y-points[i-1].y)*(points[i+1].y-point.y)<0))continue
   const segments=points.slice(1).map((point,i)=>[points[i],point] as const)
   const collisions=segments.reduce((sum,[p,q],part)=>sum+obstacles.filter(box=>!(part===0&&box.id===edge.source)&&!(part===segments.length-1&&box.id===edge.target)&&intersects(p,q,box)).length,0)
   const length=segments.reduce((sum,[p,q])=>sum+distance(p,q),0)
   if(best&&(collisions*100000+length+points.length*20)>best.score)continue
   const horizontal=segments.filter(([p,q])=>p.y===q.y&&distance(p,q)>35).sort((left,right)=>distance(...right)-distance(...left))
   const options=horizontal.flatMap(([p,q])=>[.5,.3,.7].flatMap(fraction=>[-25,12,-52,40,-84,72].map(offset=>({x:p.x+(q.x-p.x)*fraction-labelWidth/2,y:p.y+offset,width:labelWidth,height:22,distance:Math.abs(offset+11)}))))
   if(!options.length)options.push({x:(source.x+target.x)/2-labelWidth/2,y:(source.y+target.y)/2-25,width:labelWidth,height:22,distance:0})
   const labelCost=(box:Rectangle)=>obstacles.filter(other=>boxOverlap(box,other)).length*20000+usedLabels.filter(other=>boxOverlap(box,other)).length*1400
   let labelBox=options[0],labelScore=Infinity
   for(const option of options){const score=labelCost(option)+option.distance*.5;if(score<labelScore){labelBox=option;labelScore=score}}
   let overlap=0
   for(const [p,q] of segments){const vertical=p.x===q.x,key=vertical?'x:'+p.x:'y:'+p.y,low=vertical?Math.min(p.y,q.y):Math.min(p.x,q.x),high=vertical?Math.max(p.y,q.y):Math.max(p.x,q.x);for(const [otherLow,otherHigh] of usedSegments.get(key)||[]){const amount=Math.min(high,otherHigh)-Math.max(low,otherLow);if(amount>15)overlap+=amount}}
   const score=collisions*100000+labelScore+length+points.length*20+overlap*3
   if(!best||score<best.score)best={points,score,label:labelBox}
  }
  if(!best)continue
  usedLabels.push(best.label)
  best.points.slice(1).forEach((point,i)=>{const before=best!.points[i],vertical=point.x===before.x,key=vertical?'x:'+point.x:'y:'+point.y,range:[number,number]=vertical?[Math.min(point.y,before.y),Math.max(point.y,before.y)]:[Math.min(point.x,before.x),Math.max(point.x,before.x)];usedSegments.set(key,[...(usedSegments.get(key)||[]),range])})
  routes.push({index,path:roundedRoute(best.points),points:best.points,x:best.label.x+labelWidth/2,y:best.label.y+11,labelWidth,inherited,bounds:{left:Math.min(best.label.x,...best.points.map(point=>point.x))-10,top:Math.min(best.label.y,...best.points.map(point=>point.y))-10,right:Math.max(best.label.x+labelWidth,...best.points.map(point=>point.x))+10,bottom:Math.max(best.label.y+best.label.height,...best.points.map(point=>point.y))+10}})
 }
 return routes.sort((a,b)=>a.index-b.index)
}
