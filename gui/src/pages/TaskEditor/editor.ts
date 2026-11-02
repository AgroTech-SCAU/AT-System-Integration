import type {Json} from '../shared'
export interface EditorValue {document:Json;layout:Json;parameters:Json;name?:string}
export interface Fragment {root:string;nodes:Json;labels:Json;positions:Json;portModels:Json;treeDefinitions?:Json}
export function nodeId(){return 'node_'+crypto.randomUUID().replaceAll('-','')}
export function clone(value:EditorValue){return structuredClone(value)}
export function positions(tree:Json,collapsed:string[]=[]):Record<string,[number,number]>{
 const result:Record<string,[number,number]>={},active=new Set<string>();let column=0
 function visit(id:string,depth:number):number{
  if(active.has(id)||!tree.nodes[id])return column++*230+40
  active.add(id)
  const children=collapsed.includes(id)?[]:tree.nodes[id].children
  const x=children.length?children.map((c:string)=>visit(c,depth+1)).reduce((a:number,b:number)=>a+b,0)/children.length:column++*230+40
  result[id]=[x,depth*126+40];active.delete(id);return x
 }
 visit(tree.root_id,0)
 return result
}
export function descendants(tree:Json,id:string){
 const seen=new Set<string>()
 function visit(current:string){if(seen.has(current)||!tree.nodes[current])return;seen.add(current);tree.nodes[current].children.forEach(visit)}
 visit(id);return seen
}
export function parentOf(tree:Json,id:string):Json|undefined{return (Object.values(tree.nodes) as Json[]).find(n=>n.children.includes(id))}
export function canAdopt(tree:Json,id:string,parent:string,models:Json){
 if(!tree.nodes[id]||!tree.nodes[parent]||id===tree.root_id||descendants(tree,id).has(parent))return false
 const max=models[tree.nodes[parent].registration_id]?.maximum_children
 return max!==0&&(max===undefined||max<0||tree.nodes[parent].children.filter((child:string)=>child!==id).length<max)
}
export function reparent(tree:Json,id:string,parent:string,models?:Json,index?:number){
 if(id===tree.root_id)throw Error('根节点不能移动到其他节点下')
 if(descendants(tree,id).has(parent))throw Error('节点不能连接到自身或其子节点')
 if(!tree.nodes[parent])throw Error('请选择一个控制节点')
 if(models&&!canAdopt(tree,id,parent,models))throw Error('目标节点没有可用的子节点位置')
 for(const node of Object.values(tree.nodes) as Json[])node.children=node.children.filter((c:string)=>c!==id)
 const children=tree.nodes[parent].children
 children.splice(index===undefined?children.length:Math.max(0,Math.min(children.length,index)),0,id)
}
export function remove(tree:Json,id:string){
 if(id===tree.root_id)throw Error('根节点不能删除')
 const removed=descendants(tree,id)
 for(const node of Object.values(tree.nodes) as Json[])node.children=node.children.filter((c:string)=>!removed.has(c))
 for(const current of removed)delete tree.nodes[current]
}
export function copyFragment(tree:Json,id:string,layout:Json,portModels:Json={}):Fragment{
 const ids=descendants(tree,id)
 return structuredClone({root:id,nodes:Object.fromEntries([...ids].map(key=>[key,tree.nodes[key]])),labels:Object.fromEntries([...ids].filter(key=>layout.labels?.[key]).map(key=>[key,layout.labels[key]])),positions:Object.fromEntries([...ids].filter(key=>layout.positions?.[key]).map(key=>[key,layout.positions[key]])),portModels})
}
export function pasteFragment(tree:Json,fragment:Fragment,parent:string,layout:Json,models:Json={},index?:number){
 if(!tree.nodes[parent])throw Error('请选择粘贴位置')
 const max=models[tree.nodes[parent].registration_id]?.maximum_children
 if(max===0||max>=0&&tree.nodes[parent].children.length>=max)throw Error('当前节点没有可用的子节点位置')
 const mapping:Record<string,string>={},variables:Record<string,string>={}
 for(const key of Object.keys(fragment.nodes))mapping[key]=nodeId()
 for(const [key,node] of Object.entries(fragment.nodes) as [string,Json][]){
  for(const [name,binding] of Object.entries(node.ports||{}) as [string,Json][]){
   if((fragment.portModels[key]?.[name]?.direction==='OUTPUT'||name.startsWith('out_'))&&binding.kind==='blackboard_reference')variables[binding.key]=binding.key+'_copy_'+mapping[key].slice(-6)
  }
 }
 for(const [old,next] of Object.entries(mapping)){
  const node=structuredClone(fragment.nodes[old]);node.editor_id=next;node.children=node.children.map((child:string)=>mapping[child])
  for(const port of Object.values(node.ports||{}) as Json[])if(port.kind==='blackboard_reference'&&variables[port.key])port.key=variables[port.key]
  tree.nodes[next]=node
  if(fragment.labels[old])layout.labels[next]=fragment.labels[old]
  if(fragment.positions[old])layout.positions[next]=[fragment.positions[old][0]+28,fragment.positions[old][1]+28]
 }
 const children=tree.nodes[parent].children
 children.splice(index===undefined?children.length:index,0,mapping[fragment.root])
 return mapping[fragment.root]
}
export function duplicate(tree:Json,id:string,portModels:Json={},layout:Json={labels:{},positions:{}},models:Json={}){
 const parent=parentOf(tree,id)
 if(!parent)throw Error('请选择根节点下的片段')
 return pasteFragment(tree,copyFragment(tree,id,layout,portModels),parent.editor_id,layout,models,parent.children.indexOf(id)+1)
}

export function includeSubtrees(document:Json,fragment:Fragment):Fragment{
 const treeDefinitions:Json={}
 function visit(nodes:Json){for(const node of Object.values(nodes) as Json[]){const id=node.attributes?.ID;if(node.registration_id==='SubTree'&&id&&document.trees[id]&&!treeDefinitions[id]){treeDefinitions[id]=structuredClone(document.trees[id]);visit(document.trees[id].nodes)}}}
 visit(fragment.nodes)
 return {...fragment,treeDefinitions}
}
export function restoreSubtrees(document:Json,fragment:Fragment):Fragment{
 const copied=structuredClone(fragment),definitions=copied.treeDefinitions||{},names:Record<string,string>={},reserved=new Set(Object.keys(document.trees))
 function available(name:string){let target=name,index=1;do{target=name.slice(0,52)+'_copy_'+index++}while(reserved.has(target));reserved.add(target);return target}
 for(const [name,tree] of Object.entries(definitions)){
  names[name]=document.trees[name]&&JSON.stringify(document.trees[name])!==JSON.stringify(tree)?available(name):name
  reserved.add(names[name])
 }
 let changed=true
 while(changed){
  changed=false
  for(const [name,tree] of Object.entries(definitions) as [string,Json][]){
   if(names[name]!==name||!document.trees[name])continue
   if((Object.values(tree.nodes) as Json[]).some(node=>node.registration_id==='SubTree'&&names[node.attributes?.ID]&&names[node.attributes.ID]!==node.attributes.ID)){names[name]=available(name);changed=true}
  }
 }
 function rewrite(nodes:Json){for(const node of Object.values(nodes) as Json[])if(node.registration_id==='SubTree'&&names[node.attributes?.ID])node.attributes.ID=names[node.attributes.ID]}
 rewrite(copied.nodes)
 for(const [name,tree] of Object.entries(definitions) as [string,Json][]){
  if(!document.trees[names[name]]){
   rewrite(tree.nodes)
   const ids=Object.fromEntries(Object.keys(tree.nodes).map(id=>[id,nodeId()]))
   tree.nodes=Object.fromEntries((Object.values(tree.nodes) as Json[]).map(node=>{node.editor_id=ids[node.editor_id];node.children=node.children.map((id:string)=>ids[id]);return [node.editor_id,node]}))
   tree.root_id=ids[tree.root_id];tree.tree_id=names[name];document.trees[names[name]]=tree
  }
 }
 return copied
}
export function translateBranch(tree:Json,id:string,layout:Json,x:number,y:number){
 const locations={...positions(tree),...positions(tree,layout.collapsed||[]),...layout.positions},origin=locations[id]
 if(!origin)return
 for(const descendant of descendants(tree,id)){
  const point=locations[descendant]
  if(point)layout.positions[descendant]=[point[0]+x-origin[0],point[1]+y-origin[1]]
 }
}
export function orderSibling(tree:Json,id:string,delta:number,layout:Json){
 const parent=parentOf(tree,id);if(!parent)return
 const index=parent.children.indexOf(id),next=index+delta
 if(next<0||next>=parent.children.length)return
 const sibling=parent.children[next],locations={...positions(tree),...layout.positions},from=locations[id],to=locations[sibling]
 if(from&&to){translateBranch(tree,id,layout,to[0],to[1]);translateBranch(tree,sibling,layout,from[0],from[1])}
 ;[parent.children[index],parent.children[next]]=[parent.children[next],parent.children[index]]
}
export function canReferenceTree(document:Json,from:string,target:string){
 if(!target||!document.trees[target])return false
 const visited=new Set<string>()
 function reaches(id:string):boolean{
  if(id===from)return true
  if(visited.has(id)||!document.trees[id])return false
  visited.add(id)
  return (Object.values(document.trees[id].nodes) as Json[]).some(node=>node.registration_id==='SubTree'&&reaches(node.attributes?.ID))
 }
 return !reaches(target)
}
