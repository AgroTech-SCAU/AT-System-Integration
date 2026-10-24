import {useState} from 'react'
import {AnimatePresence} from 'motion/react'
import {AnchoredPopover} from './AnchoredPopover'
import {Icon} from './Icon'
import {useLocale} from '../locale'

export default function StudioSelect({label,value,options,onChange,searchable=false,disabled=false}:{label:string;value:string;options:{value:string;label:string;hint?:string}[];onChange:(value:string)=>void;searchable?:boolean;disabled?:boolean}){
 const {t}=useLocale()
 const [anchor,setAnchor]=useState<HTMLButtonElement|null>(null),[search,setSearch]=useState('')
 return <><button type="button" disabled={disabled} className="ros-select-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={!!anchor} onClick={event=>setAnchor(anchor?null:event.currentTarget)}><span>{options.find(option=>option.value===value)?.label||value}</span><Icon name="chevron-down"/></button><AnimatePresence>{anchor&&<AnchoredPopover anchor={anchor} label={label} role="listbox" align="start" className="ros-select-options" onClose={()=>{setAnchor(null);setSearch('')}}>{searchable&&<div className="ros-search"><Icon name="search"/><input autoFocus aria-label={t("搜索选项")} placeholder={t("搜索选项")} value={search} onChange={event=>setSearch(event.target.value)}/></div>}<div className="ros-select-scroll">{options.filter(option=>option.label.toLowerCase().includes(search.toLowerCase())).map(option=><button key={option.value} type="button" role="option" aria-selected={option.value===value} onClick={()=>{if(option.value!==value)onChange(option.value);setSearch('');setAnchor(null)}}><span><strong>{option.label}</strong>{option.hint&&<small>{option.hint}</small>}</span><span aria-hidden="true">{option.value===value?'✓':''}</span></button>)}</div></AnchoredPopover>}</AnimatePresence></>
}
