import DisclosureCard from '../components/DisclosureCard'
import {useLocale} from '../locale'
import type {DataContract} from '../data-contracts'

export default function DataContractEditor({value,onChange,disabled=false}:{value:DataContract;onChange:(value:DataContract)=>void;disabled?:boolean}){
 const {t}=useLocale()
 const update=(key:string,next:unknown)=>{const copy={...value};if(next===undefined||next==='')delete copy[key];else copy[key]=next;onChange(copy)}
 return <div style={{gridColumn:'1 / -1'}}><DisclosureCard title={t('数据语义')} summary={[value.frame_id,value.clock_domain,value.max_age_s?value.max_age_s+' s':''].filter(Boolean).join(' · ')||t('未声明空间与时效约束')}><fieldset disabled={disabled} className="ros-form-grid" style={{border:0,padding:0,margin:0,minWidth:0}}>
  <label className="field"><span>{t('坐标系')}</span><input value={value.frame_id||''} onChange={e=>update('frame_id',e.target.value)}/></label>
  {value.type==='json'&&<label className="field"><span>{t('坐标系字段')}</span><input value={value.frame_path||''} placeholder="header.frame_id" onChange={e=>update('frame_path',e.target.value)}/></label>}
  <label className="field"><span>{t('时间域')}</span><select value={value.clock_domain||''} onChange={e=>update('clock_domain',e.target.value)}><option value="">{t('不设置')}</option><option value="system">{t('系统时钟')}</option><option value="ros">{t('ROS 时钟')}</option>{value.clock_domain&&!['system','ros'].includes(value.clock_domain)&&<option>{value.clock_domain}</option>}</select></label>
  {value.type==='json'&&<label className="field"><span>{t('采样时间字段')}</span><input value={value.stamp_path||''} placeholder="header.stamp" onChange={e=>update('stamp_path',e.target.value)}/></label>}
  <label className="field"><span>{t('有效期秒数')}</span><input type="number" min="0.001" step="0.1" value={value.max_age_s??''} onChange={e=>update('max_age_s',e.target.value===''?undefined:Number(e.target.value))}/></label>
  <p className="ros-field-hint">{t('声明采样时间字段后按消息采样时间检查，未声明时流程仅检查变量写入后的有效期')}</p>
 </fieldset></DisclosureCard></div>
}
