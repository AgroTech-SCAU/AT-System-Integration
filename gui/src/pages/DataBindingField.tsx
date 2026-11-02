import DisclosureCard from '../components/DisclosureCard'
import StudioSelect from '../components/StudioSelect'
import {contractSummary,type DataContract} from '../data-contracts'
import {useLocale} from '../locale'

export type BindingChoice={value:string;label:string;contract?:DataContract;reason?:string;hint?:string;priority?:number}
export default function DataBindingField({name,label,contract,value,choices,fallback,onChange,onManage,output=false}:{name:string;label:string;contract:DataContract;value:string;choices:BindingChoice[];fallback:string;onChange:(value:string)=>void;onManage:()=>void;output?:boolean}){
 const {t}=useLocale()
 const selected=choices.find(choice=>choice.value===value)
 const compatible=choices.filter(choice=>!choice.reason).sort((a,b)=>(a.priority??0)-(b.priority??0))
 const unavailable=choices.filter(choice=>!!choice.reason)
 const visible=selected?.reason?[selected,...compatible]:compatible
 const missing=!!value&&!selected
 const sourceContract=output?contract:selected?.contract,targetContract=output?selected?.contract:contract
 const options=[{value:'',label:fallback},...visible.map(choice=>({value:choice.value,label:choice.label,hint:[choice.hint,contractSummary(choice.contract),choice.reason&&t(choice.reason)].filter(Boolean).join(' · '),disabled:!!choice.reason})),...(missing?[{value,label:value,hint:t('已绑定来源不存在'),disabled:true}]:[])]
 return <div className="wb-data-binding" data-binding-field={name}>
  <div className="wb-data-binding-heading"><code>{name}</code><small>{contractSummary(contract)}</small></div>
  <StudioSelect label={label} value={value} options={options} onChange={onChange} searchable/>
  {selected?.hint&&<p className="wb-data-binding-note">{selected.hint}</p>}
  {(selected?.reason||missing)&&<div className="wb-data-binding-error" role="status"><strong>{missing?t('已绑定来源不存在'):t(selected!.reason!)}</strong>{selected?.contract&&<><span>{t('来源声明')} · {contractSummary(sourceContract)}</span><span>{t('目标要求')} · {contractSummary(targetContract)}</span></>}<button className="wb-text-button" onClick={onManage}>{t('管理状态变量')}</button></div>}
  {!!unavailable.length&&<DisclosureCard className="is-compact wb-binding-unavailable" title={t(output?'不兼容的目标变量':'不兼容的来源')} count={unavailable.length}>{unavailable.map(choice=><div key={choice.value}><strong>{choice.label}</strong><p>{t(choice.reason!)}</p><small>{t(output?'目标要求':'来源声明')} · {contractSummary(choice.contract)}</small></div>)}</DisclosureCard>}
 </div>
}
