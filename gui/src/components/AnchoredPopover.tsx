import {motion, useIsPresent} from 'motion/react'
import {menuTransition, fade} from '../motion'
import {useLayoutEffect, useRef, type ReactNode} from 'react'

export function AnchoredPopover({anchor, children, onClose, label, className = '', role = 'dialog', columns = 1, align = 'end', positionKey}: {
  anchor: HTMLElement; children: ReactNode; onClose: () => void; label: string
  className?: string; role?: 'dialog' | 'menu' | 'listbox'; columns?: number; align?: 'start' | 'end'; positionKey?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const present=useIsPresent()
  useLayoutEffect(()=>{if(!present&&panel.current){panel.current.inert=true;if(panel.current.contains(document.activeElement))anchor.focus()}},[present,anchor])
  useLayoutEffect(() => {
    const node = panel.current!
    const position = () => {
      const rect = anchor.getBoundingClientRect(), size = {width: node.offsetWidth, height: node.offsetHeight}
      const below = rect.bottom + 8
      node.style.left = `${Math.max(8, Math.min(align === 'start' ? rect.left : rect.right - size.width, window.innerWidth - size.width - 8))}px`
      node.style.setProperty('--popover-origin', `${Math.max(12,Math.min(size.width-12,rect.left+rect.width/2-Math.max(8,Math.min(align==='start'?rect.left:rect.right-size.width,window.innerWidth-size.width-8))))}px ${below+size.height<=window.innerHeight-8?'0%':'100%'}`)
      node.style.top = `${Math.max(8, Math.min(below + size.height <= window.innerHeight - 8 ? below : rect.top - size.height - 8, window.innerHeight - size.height - 8))}px`
    }
    node.showPopover()
    position()
    const initial = node.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)')
      || node.querySelector<HTMLElement>('[aria-selected="true"], [aria-checked="true"]')
      || node.querySelector<HTMLElement>('button:not(:disabled)')
    initial?.focus()
    const dismiss = (event: globalThis.PointerEvent) => {
      if (role === 'menu' && event.button === 0 && !node.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', dismiss, true)
    const escape = (event: KeyboardEvent) => {
      if (role === 'menu' && event.key === 'Escape') {event.preventDefault(); onClose()}
    }
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', escape)
      if (node.contains(document.activeElement) || document.activeElement === document.body) anchor.focus()
    }
  }, [anchor, align, positionKey])

  return <motion.div initial={{opacity:0,scale:.985,y:-2}} animate={{opacity:1,scale:1,y:0}} exit={{opacity:0,scale:.99,y:-1,transition:fade}} transition={menuTransition} ref={panel} aria-hidden={!present} popover={role==='menu'?'manual':'auto'} role={role} aria-label={label} className={`studio-popover ${className}`}
    onToggle={event => {if (present && event.newState === 'closed') onClose()}}
    onKeyDown={event => {
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); onClose(); return}
      if (event.key === 'Tab') return
      // Dialogs contain forms, whose native text and checkbox keys must remain intact
      if (role === 'dialog' || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return
      const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const step = {ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns}[event.key]
      if (step !== undefined || event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); event.stopPropagation()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + step! + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }}>{children}</motion.div>
}
