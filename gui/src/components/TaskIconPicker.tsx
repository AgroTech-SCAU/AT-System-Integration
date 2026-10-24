import {AnimatePresence} from 'motion/react'
import {useLocale} from '../locale'
import {useState} from 'react'
import {AnchoredPopover} from './AnchoredPopover'
import {Icon} from './Icon'

const icons = [
  {id: 'generic', name: '通用'},
  {id: 'navigation', name: '导航'},
  {id: 'vision', name: '感知'},
  {id: 'arm', name: '机械臂'},
  {id: 'operations', name: '人机交互'},
  {id: 'mechanical', name: '系统诊断'},
  {id: 'electrical', name: '电控'},
]

export function TaskIcon({value}: {value?: string}) {
  const selected = icons.find(icon => icon.id === value)
  return selected && selected.id !== 'generic' ? <img className="studio-task-icon" src={`/ui/brand/${selected.id}.png`} alt=""/> : <span className="studio-task-icon studio-task-icon-generic"><Icon name="boxes"/></span>
}

export function TaskIconPicker({value, onChange, label='任务图标'}: {value?: string; onChange: (value: string) => void; label?:string}) {
 const {t}=useLocale()

  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const selected = icons.find(icon => icon.id === value) || icons[0]
  return <div className="task-icon-picker">
    <button type="button" className="task-icon-trigger" aria-label={t(label)+' · '+t(selected.name)} title={t(label)}
      aria-haspopup="listbox" aria-expanded={!!anchor} onClick={event => setAnchor(anchor ? null : event.currentTarget)}>
      <TaskIcon value={selected.id}/><Icon name="chevron-down"/>
    </button>
    <AnimatePresence>{anchor && <AnchoredPopover anchor={anchor} onClose={() => setAnchor(null)} label={t(label)} role="listbox" columns={3} align="start" className="task-icon-options">
      {icons.map(icon => <button type="button" role="option" aria-selected={selected.id === icon.id} tabIndex={selected.id === icon.id ? 0 : -1} key={icon.id}
        onClick={() => {onChange(icon.id); setAnchor(null)}}>
        <TaskIcon value={icon.id}/><span>{t(icon.name)}</span>
        {selected.id === icon.id && <span className="task-icon-check" aria-hidden="true">✓</span>}
      </button>)}
    </AnchoredPopover>}</AnimatePresence>
  </div>
}
