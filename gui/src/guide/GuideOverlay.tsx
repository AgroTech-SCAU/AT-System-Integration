import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { courseSteps, courseTitle, type GuideSession } from './courses'
import type { Workspace } from '../types'
import './guide.css'

type Rectangle = { top: number; left: number; right: number; bottom: number; width: number; height: number }
const PAD = 7

export default function GuideOverlay({ session, activeWorkspace, onNext, onBack, onClose, onEvent, onGoToPage }: {
  activeWorkspace: Workspace
  session: GuideSession
  onNext: () => void
  onBack: () => void
  onClose: () => void
  onEvent: (name: string) => void
  onGoToPage: () => void
}) {
  const steps = courseSteps(session)
  const current = steps[session.index]
  const [rect, setRect] = useState<Rectangle | null>(null)
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight })
  const [found, setFound] = useState(false)
  const [tooltipHeight, setTooltipHeight] = useState(350)
  const tooltip = useRef<HTMLDivElement>(null)
  const selector = `[data-guide="${current.target}"]`
  const dockRight = viewport.width >= 1180

  // Give the tutorial its own space instead of placing a floating card over
  // large highlighted panels and blocking the controls underneath
  useLayoutEffect(() => {
    document.body.classList.toggle('guide-rail-active', dockRight)
    document.body.classList.toggle('guide-bottom-active', !dockRight)
    return () => {
      document.body.classList.remove('guide-rail-active', 'guide-bottom-active')
    }
  }, [dockRight])

  useEffect(() => {
    const handle = (event: Event) => {
      const name = (event as CustomEvent<string>).detail
      if (name === current.event) onEvent(name)
    }
    window.addEventListener('agro:guide-complete', handle)
    return () => window.removeEventListener('agro:guide-complete', handle)
  }, [current.event, onEvent])

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])

  useLayoutEffect(() => {
    const initial = document.querySelector(selector)
    if (initial) {
      const bounds = initial.getBoundingClientRect()
      const availableBottom = dockRight ? window.innerHeight - 28 : Math.round(window.innerHeight * .56)
      if (bounds.bottom > availableBottom || bounds.top < 52) {
        initial.scrollIntoView({ block: 'start', behavior: 'instant' })
      }
    }
    let observed: Element | null = null
    let resizeObserver: ResizeObserver | undefined
    function measure() {
      const element = document.querySelector(selector)
      if (element !== observed) {
        resizeObserver?.disconnect()
        observed = element
        if (element && typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(measure)
          resizeObserver.observe(element)
        }
      }
      const w = window.innerWidth, h = window.innerHeight
      setViewport(last => last.width === w && last.height === h ? last : { width: w, height: h })
      if (!element) { setRect(null); setFound(false); return }
      const r = element.getBoundingClientRect()
      const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < h
      setFound(visible)
      if (!visible) { setRect(null); return }
      const top = Math.max(0, r.top - PAD), left = Math.max(0, r.left - PAD)
      const right = Math.min(w, r.right + PAD), bottom = Math.min(h, r.bottom + PAD)
      const safeBottom = dockRight ? bottom : Math.min(bottom, Math.round(h * .58))
      setRect(safeBottom > top ? { top, left, right, bottom: safeBottom, width: right - left, height: safeBottom - top } : null)
    }
    measure()
    const timer = window.setInterval(measure, 280)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      resizeObserver?.disconnect()
    }
  }, [selector, dockRight])

  useLayoutEffect(() => {
    const element = tooltip.current
    if (!element) return
    const measure = () => setTooltipHeight(element.getBoundingClientRect().height)
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [current.id])

  const tooltipWidth = dockRight ? Math.min(370, viewport.width - 24) : Math.min(500, viewport.width - 24)
  const maxTop = Math.max(12, viewport.height - tooltipHeight - 12)
  let tooltipTop = Math.max(12, (viewport.height - tooltipHeight) / 2)
  let tooltipLeft = Math.max(12, (viewport.width - tooltipWidth) / 2)
  if (rect) {
    tooltipLeft = Math.max(12, Math.min(viewport.width - tooltipWidth - 12, rect.left))
    const below = rect.bottom + 14
    const above = rect.top - tooltipHeight - 14
    if (below + tooltipHeight <= viewport.height - 12) tooltipTop = below
    else if (above >= 12) tooltipTop = above
    else tooltipTop = Math.max(12, Math.min(maxTop, rect.left > viewport.width * .5 ? rect.top : rect.bottom - tooltipHeight))
  }
  if (dockRight) {
    tooltipTop = 58
    tooltipLeft = viewport.width - tooltipWidth - 16
  } else {
    tooltipTop = Math.max(12, viewport.height - tooltipHeight - 12)
    tooltipLeft = Math.max(12, (viewport.width - tooltipWidth) / 2)
  }
  const pieces = rect ? [
    { top: 0, left: 0, width: viewport.width, height: rect.top },
    { top: rect.bottom, left: 0, width: viewport.width, height: viewport.height - rect.bottom },
    { top: rect.top, left: 0, width: rect.left, height: rect.height },
    { top: rect.top, left: rect.right, width: viewport.width - rect.right, height: rect.height },
  ] : [{ top: 0, left: 0, width: viewport.width, height: viewport.height }]

  return createPortal(<div className="guide-layer" role="region" aria-label={courseTitle(session.course)}>
    {pieces.map((piece, index) => <div key={index} className="guide-shade" style={piece} />)}
    {rect && <div className="guide-highlight" style={rect} aria-hidden="true" />}
    <div ref={tooltip} key={current.id} className={`guide-tooltip ${dockRight ? 'guide-tooltip-docked' : 'guide-tooltip-bottom'}`} role="dialog" aria-label={current.title} style={{ top: tooltipTop, left: tooltipLeft, width: tooltipWidth }}>
      <div className="guide-tooltip-head"><span className="guide-course-label">{courseTitle(session.course)} · {current.chapter}</span><button aria-label="退出教学" title="退出教学" className="guide-close" onClick={onClose}>×</button></div>
      <div className="guide-progress-head"><span>第 {session.index + 1} 步，共 {steps.length} 步</span><span>{Math.round((session.index + 1) / steps.length * 100)}%</span></div>
      <div className="guide-progress-track" role="progressbar" aria-label="教学进度" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={session.index + 1}><span style={{ width: `${(session.index + 1) / steps.length * 100}%` }} /></div>
      <h3>{current.title}</h3>
      <div className="guide-detail"><strong>为什么做这一步</strong><p>{current.purpose}</p></div>
      <div className="guide-detail guide-detail-action"><strong>现在怎么操作</strong><p>{current.action}</p></div>
      <div className="guide-detail"><strong>完成后应该看到</strong><p>{current.expected}</p></div>
      {current.hint && <div className="guide-tip"><strong>补充说明</strong><p>{current.hint}</p></div>}
      {!found && <div className="guide-unavailable"><strong>暂时找不到操作位置</strong><p>{activeWorkspace !== current.workspace ? "当前不在该步骤的工作区，请先切换页面" : "目标可能尚未加载、当前面板未展开，或者前一项操作还没有成功"}</p>{activeWorkspace !== current.workspace && <button onClick={onGoToPage}>前往{({overview:"总览",system:"系统搭建",editor:"任务编排",runtime:"运行调试",templates:"任务编排",records:"记录报告",settings:"设置"} satisfies Record<Workspace,string>)[current.workspace]}</button>}</div>}
      <p className="guide-action-hint">{current.event ? '请在高亮区域完成操作，成功后会自动进入下一步' : '请查看高亮区域，理解后点击下一步'}</p>
      <div className="guide-actions"><button onClick={onBack} disabled={session.index === 0}>上一步</button><button onClick={onClose}>退出教学</button><button onClick={onNext} className={current.event ? '' : 'primary'}>{session.index === steps.length - 1 ? '完成教学' : current.event ? '暂时跳过' : '下一步'}</button></div>
    </div>
  </div>, document.body)
}
