import type {FieldSchema} from './pages/SchemaMessageForm'
export type DataContract={type:string;unit?:string;[key:string]:any}
function stable(value:any):string{return value&&typeof value==='object'&&!Array.isArray(value)?JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(stable(value[key]))]))):JSON.stringify(value)}
export function contractReason(source:DataContract,target:DataContract):string{
 for(const [key,label] of [['type','数据类型'],['unit','单位'],['frame_id','坐标系'],['clock_domain','时间域'],['frame_path','坐标系字段'],['stamp_path','采样时间字段']])if(target[key]!=null&&source[key]!==target[key])return label+'不一致，需要明确转换'
 const a=source.extensions||{},b=target.extensions||{}
 if(b.ros_type&&a.ros_type!==b.ros_type)return 'ROS 字段类型不一致或尚未声明'
 if(b.ros_shape&&stable(a.ros_shape||{})!==stable(b.ros_shape))return '消息结构或数组边界不一致'
 if(target.minimum!=null&&(source.minimum==null||source.minimum<target.minimum)||target.maximum!=null&&(source.maximum==null||source.maximum>target.maximum))return '来源数值范围不能保证满足目标范围'
 if(target.choices?.length&&(!source.choices?.length||source.choices.some((value:unknown)=>!target.choices.includes(value))))return '来源可选值不能保证满足目标限制'
 if(target.max_age_s!=null&&(source.max_age_s==null||source.max_age_s>target.max_age_s))return '来源数据有效期不满足目标要求'
 return ''
}
export function wireShape(schema:FieldSchema):Record<string,unknown>{return Object.fromEntries([...['type','kind','length','max_length','min','max'].filter(key=>(schema as any)[key]!==undefined&&!(schema.kind==='integer'&&['min','max'].includes(key)&&Math.abs((schema as any)[key])>Number.MAX_SAFE_INTEGER)).map(key=>[key,(schema as any)[key]]),...(schema.fields?[['fields',Object.fromEntries(Object.entries(schema.fields).map(([name,child])=>[name,wireShape(child)]))]]:[]),...(schema.item?[['item',wireShape(schema.item)]]:[])])}
export function fieldContract(schema:FieldSchema):DataContract{
 const type=['array','object'].includes(schema.kind)?'json':schema.kind,numeric=['integer','number'].includes(type)
 return {type,...(numeric?{unit:schema.unit||(schema.options?.length?'1':'unspecified'),...(schema.min!==undefined?{minimum:schema.kind==='integer'?Math.max(-Number.MAX_SAFE_INTEGER,schema.min):schema.min}:{}),...(schema.max!==undefined?{maximum:schema.kind==='integer'?Math.min(Number.MAX_SAFE_INTEGER,schema.max):schema.max}:{})}:{}),...(schema.options?.length?{choices:schema.options.map(option=>option.value)}:{}),extensions:{ros_type:schema.type,ros_shape:wireShape(schema)}}
}
export function schemaPaths(fields:Record<string,FieldSchema>,prefix=''):{path:string;schema:FieldSchema}[]{return Object.entries(fields).flatMap(([name,schema])=>[{path:prefix+name,schema},...(schema.fields?schemaPaths(schema.fields,prefix+name+'.'):[])])}
