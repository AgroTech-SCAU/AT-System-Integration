import {useId, useState, type ReactNode} from 'react'
import {motion} from 'motion/react'
import {springs, fade} from '../motion'
import {Icon} from './Icon'
import './disclosure-card.css'

type Props = {
  title: ReactNode
  summary?: ReactNode
  count?: number
  status?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

// Keep editors mounted so collapsing a section never discards an unfinished edit
export default function DisclosureCard({title, summary, count, status, actions, children, className = '', open, defaultOpen = false, onOpenChange}: Props) {
  const [expanded, setExpanded] = useState(defaultOpen)
  const id = useId(), isOpen = open ?? expanded
  const toggle = () => {const next = !isOpen; if (open === undefined) setExpanded(next); onOpenChange?.(next)}
  return <section className={`disclosure-card${isOpen ? ' is-open' : ''}${className ? ' ' + className : ''}`}>
    <header className="disclosure-card-heading">
      <button type="button" className="disclosure-card-toggle" data-motion="none" aria-expanded={isOpen} aria-controls={id} onClick={toggle}>
        <motion.span className="disclosure-card-chevron" animate={{rotate: isOpen ? 90 : 0}} transition={springs.quick}><Icon name="chevron-right"/></motion.span>
        <span className="disclosure-card-label"><span className="disclosure-card-title">{title}{count !== undefined && <span className="disclosure-card-count">{count}</span>}</span>{summary && <span className="disclosure-card-summary">{summary}</span>}</span>
        {status && <span className="disclosure-card-status">{status}</span>}
      </button>
      {actions && <div className="disclosure-card-actions">{actions}</div>}
    </header>
    <motion.div id={id} className="disclosure-card-collapse" initial={false} animate={{height: isOpen ? 'auto' : 0, opacity: isOpen ? 1 : 0}} transition={{height: springs.panel, opacity: fade}} aria-hidden={!isOpen} inert={!isOpen}>
      <div className="disclosure-card-content">{children}</div>
    </motion.div>
  </section>
}
