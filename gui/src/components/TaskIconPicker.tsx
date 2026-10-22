import {useState} from 'react'
import {AnchoredPopover} from './AnchoredPopover'
import {Icon} from './Icon'

const icons = [
  {id: 'navigation', name: '导航'},
  {id: 'vision', name: '感知'},
  {id: 'arm', name: '机械臂'},
  {id: 'operations', name: '人机交互'},
  {id: 'mechanical', name: '系统诊断'},
  {id: 'electrical', name: '电控'},
]

export function TaskIconPicker({value, onChange}: {value?: string; onChange: (value: string) => void}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const selected = icons.find(icon => icon.id === value) || icons[0]
  return <div className="task-icon-picker">
    <button type="button" className="task-icon-trigger" aria-label={`任务图标：${selected.name}`} title="选择任务图标"
      aria-haspopup="listbox" aria-expanded={!!anchor} onClick={event => setAnchor(anchor ? null : event.currentTarget)}>
      <img src={`/ui/brand/${selected.id}.png`} alt=""/><Icon name="chevron-down"/>
    </button>
    {anchor && <AnchoredPopover anchor={anchor} onClose={() => setAnchor(null)} label="任务图标" role="listbox" columns={3} align="start" className="task-icon-options">
      {icons.map(icon => <button type="button" role="option" aria-selected={selected.id === icon.id} tabIndex={selected.id === icon.id ? 0 : -1} key={icon.id}
        onClick={() => {onChange(icon.id); setAnchor(null)}}>
        <img src={`/ui/brand/${icon.id}.png`} alt=""/><span>{icon.name}</span>
        {selected.id === icon.id && <span className="task-icon-check" aria-hidden="true">✓</span>}
      </button>)}
    </AnchoredPopover>}
  </div>
}
