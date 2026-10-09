import { useEffect, useRef, type ReactNode } from 'react'
import type { Messages } from '../i18n'
import { Icon } from './Icon'

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>
}
export function StatusCard({ label, value, tone = 'neutral' }: { label: string; value: ReactNode; tone?: 'neutral' | 'good' | 'danger' }) {
  return <article className={`status-card ${tone}`}><span>{label}</span><strong>{value}</strong></article>
}
export function PendingDialog({ open, text, error, onClose, actions }: {
  open: boolean; text: Messages; error?: string; onClose: () => void; actions?: ReactNode
}) {
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    close.current?.focus()
    return () => { previous?.focus() }
  }, [open])
  if (!open) return null
  return <div className="pending-backdrop">
    <div ref={dialog} className="pending-dialog" role="dialog" aria-modal="true" aria-labelledby="pending-title"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); onClose() }
        if (event.key === 'Tab') {
          const items = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)')
          if (!items?.length) return
          const first = items[0], last = items[items.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
      }}>
      <div className="pending-body"><div className="spinner" aria-hidden="true" />
        <h2 id="pending-title">{text.pendingTitle}</h2><p role="status">{text.pendingDescription}</p>
        {error && <p className="error" role="alert">{error}</p>}<p className="muted">{text.pendingHint}</p>
      </div>
      <footer className="pending-actions" aria-label={text.operationArea}>
        {actions}<button ref={close} onClick={onClose}>{text.close}</button>
      </footer>
    </div>
  </div>
}

export function Panel({ title, subtitle, icon = 'system', children }: {
  title: string; subtitle?: string; icon?: Parameters<typeof Icon>[0]['name']; children: ReactNode
}) {
  return <section className="panel"><header className="card-head"><Icon name={icon} /><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></header><div className="card-body">{children}</div></section>
}

export function Segmented({ label, value, options, onChange }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void
}) {
  return <fieldset className="segmented-field"><legend>{label}</legend><div className="segmented">
    {options.map(option => <label key={option.value} className={value === option.value ? 'selected' : ''}>
      <input type="radio" name={label} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} /><span>{option.label}</span>
    </label>)}
  </div></fieldset>
}
