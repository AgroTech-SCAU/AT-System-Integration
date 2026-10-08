import type {Json} from '../shared'
export interface EditorValue {document:Json;layout:Json;parameters:Json}
export function nodeId(){return 'node_'+crypto.randomUUID().replaceAll('-','')}
export function clone(value:EditorValue){return structuredClone(value)}
export function positions(tree:Json,collapsed:string[]=[]):Record<string,[number,number]>{
 const result:Record<string,[number,number]>={},active=new Set<string>();let column=0
 function visit(id:string,depth:number):number{if(active.has(id)||!tree.nodes[id])return column++*220+20;active.add(id);const children=collapsed.includes(id)?[]:tree.nodes[id].children;const x=children.length?children.map((c:string)=>visit(c,depth+1)).reduce((a:number,b:number)=>a+b,0)/children.length:column++*220+20;result[id]=[x,depth*115+20];active.delete(id);return x}visit(tree.root_id,0);for(const id of Object.keys(tree.nodes))if(!result[id])result[id]=[column++*220+20,20];return result
}
export function reparent(tree:Json,id:string,parent:string){
 const seen=new Set<string>();function descendants(current:string){if(seen.has(current))return;seen.add(current);tree.nodes[current]?.children.forEach(descendants)}descendants(id)
 if(seen.has(parent))throw Error('不能把祖先挂到后代')
 for(const node of Object.values(tree.nodes) as Json[])node.children=node.children.filter((c:string)=>c!==id)
 if(parent)tree.nodes[parent].children.push(id);else tree.root_id=id
}
export function remove(tree:Json,id:string){
 const removed=new Set<string>();function visit(current:string){if(removed.has(current))return;removed.add(current);tree.nodes[current]?.children.forEach(visit)}visit(id)
 for(const node of Object.values(tree.nodes) as Json[])node.children=node.children.filter((c:string)=>!removed.has(c))
 for(const current of removed)delete tree.nodes[current]
}
export function duplicate(tree:Json,id:string,portModels:Json={}){
 const mapping:Record<string,string>={},variables:Record<string,string>={}
 function collect(current:string){mapping[current]=nodeId();const node=tree.nodes[current];for(const [name,value] of Object.entries(node.ports) as [string,Json][])if((portModels[current]?.[name]?.direction==='OUTPUT'||name.startsWith('out_'))&&value.kind==='blackboard_reference')variables[value.key]=value.key+'_copy_'+mapping[current].slice(-6);node.children.forEach(collect)}collect(id)
 for(const [old,next] of Object.entries(mapping)){const node=structuredClone(tree.nodes[old]);node.editor_id=next;node.children=node.children.map((c:string)=>mapping[c]);for(const port of Object.values(node.ports) as Json[])if(port.kind==='blackboard_reference'&&variables[port.key])port.key=variables[port.key];tree.nodes[next]=node}
 const parent=(Object.values(tree.nodes) as Json[]).find(n=>n.children.includes(id));if(parent)parent.children.splice(parent.children.indexOf(id)+1,0,mapping[id]);return mapping[id]
}
