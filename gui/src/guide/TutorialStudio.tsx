import {useLocale} from '../locale'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ApiClient } from '../api'
import type { Workspace } from '../types'
import type { CourseId } from './courses'
import { Icon } from '../components/Icon'
import './tutorial-studio.css'

type Completion =
  | { event: string; action?: never; selector?: never }
  | { action: 'click'; selector: string; event?: never }

type Step = {
  chapter: string
  title: string
  page: Workspace
  target: string
  purpose: string
  instruction: string
  expected: string
  completion: Completion
  tab?: 'hsm' | 'tree' | 'template'
}
type Frame = { top: number; left: number; right: number; bottom: number }

const make = (chapter: string, title: string, page: Workspace, target: string, instruction: string, expected: string, completion: Completion, purpose: string, tab?: Step['tab']): Step =>
  ({ chapter, title, page, target, purpose, instruction, expected, completion, tab })

const createSteps = (example: boolean): Step[] => [
  make('创建机器人', example ? '选择番茄示例' : '选择空白机器人', 'overview', example ? 'create-tomato' : 'create-blank', example ? '点击「从示例创建」' : '点击「空白机器人」', '已选择创建方式', {event: example ? 'guide:source:tomato_picker' : 'guide:source:blank'}, '练习数据与正式机器人完全隔离'),
  make('创建机器人', '创建练习机器人', 'overview', 'create-robot-form', '填写名称，点击「创建机器人」', '机器人出现在列表中', {event: example ? 'robot:created:tomato_picker' : 'robot:created:blank'}, '创建不会切换当前正在运行的机器人'),
  make('创建机器人', '打开练习机器人', 'overview', 'robot-list', '点击练习机器人的「切换」', '进入机器人的 ROS 接口页面', {event: 'robot:selected'}, '接口、任务与流程属于各自的机器人工作区'),
]
const stateSteps: Step[] = [
  make('层级状态机', '打开状态编排', 'editor', 'task-tab-hsm', '点击「状态编排」', '显示状态层级与画布', {action: 'click', selector: '[data-guide="task-tab-hsm"]'}, '状态机组织业务状态和事件转换'),
  make('层级状态机', '选择一个状态', 'editor', 'hsm-state-tree', '在状态目录中选择一个状态', '画布标记选中的状态', {action: 'click', selector: '.wb-outline-select'}, '复合状态可以包含子状态'),
  make('层级状态机', '查看状态属性', 'editor', 'hsm-inspector-toggle', '点击工具栏的检查器按钮', '显示进入、持续和退出行为', {action: 'click', selector: '[data-guide="hsm-inspector-toggle"]'}, '每个阶段都可以关联 ROS 任务或行为树'),
  make('层级状态机', '保存状态机', 'editor', 'task-hsm-save', '点击「保存」', '状态机保存成功', {event: 'hsm:saved'}, '保存的流程可在运行台执行'),
]
const treeSteps: Step[] = [
  make('行为树', '打开行为树', 'editor', 'task-tab-tree', '点击「行为树」', '显示行为树工作区', {action: 'click', selector: '[data-guide="task-tab-tree"]'}, '行为树组织每个状态下的任务执行顺序'),
  make('行为树', '查看任务结构', 'editor', 'task-tree-canvas', '点击画布中的一个节点', '节点被选中，可在属性面板中配置', {action: 'click', selector: '.bw-node'}, '机器人任务与流程控制节点可以组合使用', 'tree'),
  make('行为树', '保存行为草稿', 'editor', 'tree-save', '点击「保存」', '草稿保存后结束本次练习', {event: 'tree:saved'}, '退出练习后恢复原来的工作区', 'tree'),
]
const basicSteps: Step[] = [
  ...createSteps(false), ...stateSteps, treeSteps[0],
  make('行为树', '新建行为树', 'editor', 'task-new', '点击「新建行为树」', '创建独立的行为草稿', {event: 'tree:created'}, '节点库提供 ROS 任务和常用流程控制节点', 'tree'),
  ...treeSteps.slice(1),
]
const tomatoSteps: Step[] = [...createSteps(true), ...stateSteps, ...treeSteps]

function spotlightRect(target: Element | null, viewport: Element | null): Frame | null {
  if (!target || !viewport) return null
  const rect = target.getBoundingClientRect()
  const bounds = viewport.getBoundingClientRect()
  const pad = 6
  const top = Math.max(bounds.top, rect.top - pad)
  const left = Math.max(bounds.left, rect.left - pad)
  const right = Math.min(bounds.right, rect.right + pad)
  const bottom = Math.min(bounds.bottom, rect.bottom + pad)
  return right > left && bottom > top ? { top, left, right, bottom } : null
}

function sameFrame(a: Frame | null, b: Frame | null) {
  if (!a || !b) return a === b
  return Math.abs(a.top - b.top) < .5 && Math.abs(a.left - b.left) < .5 &&
    Math.abs(a.right - b.right) < .5 && Math.abs(a.bottom - b.bottom) < .5
}

// The highlighted opening is excluded from a single blurred overlay
// This avoids four separately composited blur layers during scrolling
function spotlightCutout(focus: Frame | null): string | undefined {
  if (!focus) return undefined
  const { top, left, right, bottom } = focus
  return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left}px ${top}px, ${left}px ${bottom}px, ${right}px ${bottom}px, ${right}px ${top}px, ${left}px ${top}px)`
}

export default function TutorialStudio({ course, client: _client, onClose, children }: { course: CourseId; client: ApiClient; onClose: () => void; children: ReactNode }) {
 const {t}=useLocale()

  const steps = useMemo(() => course === 'tomato' ? tomatoSteps : basicSteps, [course])
  const [index, setIndex] = useState(0)
  const [focus, setFocus] = useState<Frame | null>(null)
  const [completed, setCompleted] = useState(false)
  const [validationIssue, setValidationIssue] = useState<string[]>([])
  const [repairMode, setRepairMode] = useState(false)
  const [open, setOpen] = useState(true)
  const root = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const step = steps[index]

  // A step advances only after its exact successful operation, never from a ready-looking screen
  useEffect(() => {
    let done = false
    let advanceTimer: number | undefined
    setCompleted(false)
    setValidationIssue([])
    setRepairMode(false)
    const advance = () => {
      if (done) return
      done = true
      setCompleted(true)
      advanceTimer = window.setTimeout(() => {
        if (index === steps.length - 1) closeRef.current()
        else setIndex(value => value + 1)
      }, 220)
    }
    const onOperation = (event: Event) => {
      if ('event' in step.completion && (event as CustomEvent<string>).detail === step.completion.event) advance()
    }
    const onClick = (event: Event) => {
      const completion = step.completion
      if (!('action' in completion) || completion.action !== 'click' || !completion.selector) return
      const element = event.target
      if (element instanceof Element && element.closest(completion.selector)) advance()
    }
    window.addEventListener('agro:guide-complete', onOperation)
    const element = root.current
    element?.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('agro:guide-complete', onOperation)
      element?.removeEventListener('click', onClick, true)
      if (advanceTimer !== undefined) window.clearTimeout(advanceTimer)
    }
  }, [index, step, steps])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent<Workspace>('agro:tutorial:navigate', { detail: step.page }))
    if (step.tab) window.dispatchEvent(new Event('agro:guide:' + step.tab))
  }, [index, step])

  // Keep diagnostics visible during guided validation instead of silently waiting for success
  useEffect(() => {
    if (step.completion.event !== 'tree:validated') return
    const failed=(event:Event) => {
      const details=(event as CustomEvent<string[]>).detail
      setValidationIssue(Array.isArray(details)?details.slice(0,5):[t("校验尚未通过")])
      setRepairMode(false)
    }
    const edited=()=>{setValidationIssue([]);setRepairMode(false)}
    const repair=()=>setRepairMode(true)
    window.addEventListener('agro:tutorial:tree-validation-failed',failed)
    window.addEventListener('agro:tutorial:tree-edited',edited)
    window.addEventListener('agro:tutorial:tree-repair',repair)
    return ()=>{
      window.removeEventListener('agro:tutorial:tree-validation-failed',failed)
      window.removeEventListener('agro:tutorial:tree-edited',edited)
      window.removeEventListener('agro:tutorial:tree-repair',repair)
    }
  }, [step])
  const activeTarget=validationIssue.length?(repairMode?'task-tree-node-settings':'tree-validation-feedback'):step.target

  // Measure at most once per animation frame and scroll only when a new target appears
  // Avoid a smooth-scroll + polling loop, which was forcing constant repaint of the blur
  useLayoutEffect(() => {
    const selector = `[data-guide="${activeTarget}"]`
    const viewport = root.current?.querySelector('.tutorial-real-app') || null
    let animationFrame = 0
    let observed: Element | null = null
    let positioned = false
    const resizeObserver = new ResizeObserver(() => schedule())

    function measure() {
      const element = root.current?.querySelector(selector) || null
      if (element !== observed) {
        if (observed) resizeObserver.unobserve(observed)
        observed = element
        positioned = false
        if (element) resizeObserver.observe(element)
      }
      if (element && !positioned) {
        positioned = true
        element.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' })
        schedule()
      }
      const next = spotlightRect(element, viewport)
      setFocus(previous => sameFrame(previous, next) ? previous : next)
    }

    function schedule() {
      if (animationFrame) return
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0
        measure()
      })
    }

    setFocus(null)
    if (viewport) resizeObserver.observe(viewport)
    const mutations = new MutationObserver(schedule)
    if (viewport) mutations.observe(viewport, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()
    return () => {
      window.cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [index, step, activeTarget])

  const skipStep = () => {
    if (completed) return
    if (index === steps.length - 1) onClose()
    else setIndex(value => value + 1)
  }

  const cutout = spotlightCutout(focus)

  return <div ref={root} className="tutorial-root tutorial-shared" role="dialog" aria-modal="true" aria-label={t("独立教学工作台")}>
    <div className="tutorial-real-app">{children}</div>
    <div className="tutorial-mask" aria-hidden="true" style={cutout ? { clipPath: cutout } : undefined} />
    {focus && <div className="tutorial-spotlight" aria-hidden="true" style={{ top: focus.top, left: focus.left, width: focus.right - focus.left, height: focus.bottom - focus.top }} />}
    <aside className={'tutorial-coach' + (!open ? ' tutorial-coach-collapsed' : '')} aria-label={t("教学指导")}>
      <div className="tutorial-coach-top"><div><small>{course === 'tomato' ? t("番茄采摘 · 操作教程") : t("通用机器人 · 操作教程")}</small><strong>{t(step.chapter)}</strong></div><button aria-label={open ? t("收起指导") : t("展开指导")} onClick={() => setOpen(value => !value)}><Icon name={open ? 'chevron-down' : 'chevron-up'} /></button></div>
      {open && <>
        <div className="tutorial-coach-body">
        <div className="tutorial-progress"><span>{t("第 {0} 步，共 {1} 步", {0:index+1,1:steps.length})}</span><span>{Math.round((index + 1) / steps.length * 100)}%</span></div>
        <div className="tutorial-progress-track"><span style={{ width: `${(index + 1) / steps.length * 100}%` }} /></div>
        <h2>{t(step.title)}</h2>
        <div className="tutorial-coach-section"><strong>{t("目标")}</strong><p>{t(step.purpose)}</p></div>
        <div className="tutorial-coach-section important"><strong>{t("操作")}</strong><p>{t(step.instruction)}</p></div>
        <div className="tutorial-coach-section"><strong>{t("完成后")}</strong><p>{t(step.expected)}</p></div>
        {validationIssue.length>0&&<div className="tutorial-coach-hint" role="alert"><Icon name="info"/><div><strong>{t("校验未通过")}</strong>{validationIssue.map((message,i)=><p key={i}>{message}</p>)}<button className="tutorial-prep-button" onClick={()=>setRepairMode(value=>!value)}>{repairMode?t("返回校验结果"):t("修改节点设置")}</button><p>{t("修改完成后重新点击「校验树」")}</p></div></div>}
        {!focus && <div className="tutorial-coach-hint"><Icon name="info" /><div><p>{t("操作区域尚未显示，等待页面加载后自动定位")}</p><button className="tutorial-prep-button" onClick={() => window.dispatchEvent(new CustomEvent<Workspace>('agro:tutorial:navigate', { detail: step.page }))}>{t("重新定位")}</button></div></div>}
        <div className={'tutorial-coach-status' + (completed ? ' complete' : '')} role="status"><Icon name={completed ? 'check-circle' : 'mouse-pointer-2'} />{completed ? t("操作完成 · 自动进入下一步") : t("完成高亮区域的操作后自动继续")}</div>
        </div>
        <div className="tutorial-coach-actions"><button onClick={onClose}>{t("退出教学")}</button><button disabled={index === 0 || completed} onClick={() => setIndex(value => Math.max(0, value - 1))}>{t("上一步")}</button><button className="tutorial-primary" disabled={completed} onClick={skipStep}>{t("跳过此步")}</button></div>
        <p className="tutorial-coach-foot">{t("跳过仅略过指引，不执行对应操作 · 退出后返回原工作区")}</p>
      </>}
    </aside>
  </div>
}
