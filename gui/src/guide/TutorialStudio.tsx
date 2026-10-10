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

const basicSteps: Step[] = [
  make('创建工程', '选择空白机器人', 'overview', 'create-blank', '点击「空白机器人」', '创建方式切换为空白工程', { event: 'guide:source:blank' }, '从空白工程开始，后端与任务均由用户配置'),
  make('创建工程', '创建练习机器人', 'overview', 'create-robot-form', '填写机器人名称，再点击「创建并选择」', '创建成功后自动进入系统搭建', { event: 'robot:created:blank' }, '练习工程存放在隔离工作区，不影响正式工程'),
  make('系统接入', '选择系统类别', 'system', 'system-categories', '点击「视觉系统」类别卡片，打开接入界面', '显示接入包选择与能力预览', { event: 'system:category-opened' }, '四大系统用于分类，自定义系统也使用相同接入过程'),
  make('系统接入', '选择模拟接入包', 'system', 'system-package-select', '展开「已有接入描述」，选择内置模拟接入包', '显示模拟能力列表与建议的后端标识', { event: 'system:package-selected' }, '接入描述定义能力，模拟适配器负责实际执行'),
  make('系统接入', '添加后端', 'system', 'system-backend-confirm', '检查后端名称，点击「添加后端」', '后端出现在已接入列表中，能力映射自动生成', { event: 'system:backend-added' }, '后端可以提供一个或多个任务能力'),
  make('系统接入', '应用系统配置', 'system', 'system-save-config', '确认新增后端后，点击「保存并应用」并等待结果', '当前机器人完成配置应用', { event: 'system:applied' }, '应用需要通过配置校验与停止态保护'),
  make('层级状态机', '打开 HSM 编辑器', 'editor', 'task-tab-hsm', '点击「层级状态机」', '显示状态层级、生命周期和事件转换', { event: 'task:hsm-selected' }, 'HSM 决定当前业务状态与状态转换'),
  make('层级状态机', '选择一个状态', 'editor', 'hsm-state-tree', '点击状态层级中的「待命」子状态', '右侧显示该状态的属性', { action: 'click', selector: '.hsm-state' }, '子状态可以拥有自己的 Entry、Do 和 Exit'),
  make('层级状态机', '新增状态事件', 'editor', 'hsm-transitions', '在「新事件名称」输入 start_work，然后点击「添加事件转换」', '转换关系出现在当前状态的事件列表中', { event: 'hsm:transition-added' }, '事件与 Guard 共同决定状态是否允许转换'),
  make('层级状态机', '保存状态机', 'editor', 'task-hsm-save', '点击「保存状态机」，等待保存完成', '状态机出现在已保存定义中', { event: 'hsm:saved' }, '未保存的状态编辑不会改变已发布任务'),
  make('行为树', '打开 BT 编辑器', 'editor', 'task-tab-tree', '点击「行为树」选项卡', '进入节点库与任务画布', { event: 'task:tree-selected' }, 'BT 定义状态内的任务动作与执行顺序'),
  make('行为树', '新建行为树', 'editor', 'task-new', '点击「新建任务」', '创建可编辑的行为树草稿', { event: 'tree:created' }, '草稿允许保存和修改，不会自动启动设备', 'tree'),
  make('行为树', '添加流程节点', 'editor', 'task-tree-workspace', '在节点库选择可添加的控制节点，点击「添加到当前流程」', '新节点加入行为树结构', { event: 'tree:node-added' }, '控制节点决定顺序、选择和重复策略', 'tree'),
  make('行为树', '保存任务草稿', 'editor', 'tree-save', '点击「保存草稿」并等待保存完成', '草稿持久化成功', { event: 'tree:saved' }, '草稿保存与任务发布是两个独立操作', 'tree'),
  make('行为树', '校验行为树', 'editor', 'tree-validate', '点击「校验树」，有错误时按诊断修改后重新校验', '结构与数据约束校验通过', { event: 'tree:validated' }, '校验包含节点结构、端口与能力映射', 'tree'),
  make('行为树', '发布任务定义', 'editor', 'tree-publish', '点击「发布定义」，等待发布成功', '生成可供状态机引用的固定任务定义', { event: 'tree:published' }, '发布需要有效的系统配置与行为树执行器', 'tree'),
  make('关联任务', '返回状态机', 'editor', 'task-tab-hsm', '点击「层级状态机」', '显示刚保存的状态机及可用任务定义', { event: 'task:hsm-selected' }, '状态机的生命周期动作可以关联发布的 BT'),
  make('关联任务', '设置 Do 关联', 'editor', 'hsm-lifecycle', '选中「待命」子状态，在 Do 下拉列表中选择刚发布的行为树', '状态的持续行为引用新的 BT', { event: 'hsm:tree-bound' }, 'Do 在状态激活期间运行对应行为树', 'hsm'),
  make('关联任务', '保存关联', 'editor', 'task-hsm-save', '再次点击「保存状态机」', '状态机与行为树关联被保存', { event: 'hsm:saved' }, '保存前可同时设置 Entry 和 Exit', 'hsm'),
  make('运行调试', '启动模拟系统', 'runtime', 'runtime-start', '点击「启动系统」并等待模拟模块就绪', '运行核心确认系统启动完成', { event: 'system:started' }, '教学只使用隔离的 Mock 后端'),
  make('运行调试', '启动状态机', 'runtime', 'runtime-hsm', '在业务状态机区域选择已保存定义，点击「启动状态机」', '运行区显示当前状态与生命周期', { event: 'hsm:started' }, '状态机通过已有执行器调度关联行为树'),
  make('运行调试', '停止状态机', 'runtime', 'runtime-hsm', '在业务状态机区域点击「停止状态机」，等待停止确认', '状态机结束当前运行', { event: 'hsm:stopped' }, '停止流程必须遵守任务取消与设备停止确认'),
  make('运行调试', '安全停止模拟系统', 'runtime', 'runtime-stop', '点击「停止系统」，等待操作完成', '自动结束教学并返回原工作区', { event: 'system:stopped' }, '教学结束后，隔离工程会被清理'),
]

const tomatoSteps: Step[] = [
  make('创建工程', '选择番茄示例', 'overview', 'create-tomato', '点击「从示例创建」中的番茄采摘示例', '选择番茄机器人模板', { event: 'guide:source:tomato_picker' }, '示例仅用于教学和模拟'),
  make('创建工程', '创建练习机器人', 'overview', 'create-robot-form', '确认机器人名称，点击「创建并选择」', '创建并激活番茄模拟机器人', { event: 'robot:created:tomato_picker' }, '练习数据与正式机器人完全隔离'),
  make('系统接入', '查看模拟后端', 'system', 'system-backend-config', '点击任一后端的「配置与能力」', '展开能力与参数详情', { event: 'system:detail-opened' }, '示例已包含视觉、导航、机械臂和电控能力'),
  ...basicSteps.slice(6,10),
  make('行为树', '打开 BT 编辑器', 'editor', 'task-tab-tree', '点击「行为树」选项卡', '显示节点库与任务画布', { event: 'task:tree-selected' }, 'BT 负责采摘的条件判断与动作执行'),
  make('行为树', '复制采摘行为树', 'editor', 'task-tree-create-example', '点击「从当前系统示例创建」', '生成独立可编辑的采摘任务草稿', { event: 'task:example-created' }, '模板不会覆盖其他任务定义', 'tree'),
  make('行为树', '查看任务结构', 'editor', 'task-tree-canvas', '点击画布中的任一行为树节点', '对应节点的属性和数据端口显示在右侧', { action: 'click', selector: '.tree-node' }, '先查看已有结构，避免直接更改复杂任务', 'tree'),
  make('行为树', '保存采摘任务草稿', 'editor', 'tree-save', '点击「保存草稿」', '当前草稿保存完成', { event: 'tree:saved' }, '草稿可随时继续编辑', 'tree'),
  make('行为树', '检查采摘任务', 'editor', 'tree-validate', '点击「校验树」，必要时按提示修复', '任务检查成功', { event: 'tree:validated' }, '节点契约和端口数据必须有效', 'tree'),
  make('行为树', '发布采摘任务', 'editor', 'tree-publish', '点击「发布定义」', '发布的行为树可关联到 HSM', { event: 'tree:published' }, '执行定义与运行草稿相互隔离', 'tree'),
  ...basicSteps.slice(16,19),
  make('运行调试', '启动模拟系统', 'runtime', 'runtime-start', '点击「启动系统」并等待就绪', '模拟后端启动完成', { event: 'system:started' }, '不操作真实底盘或机械臂'),
  make('运行调试', '启动状态机', 'runtime', 'runtime-hsm', '选择刚保存的状态机，点击「启动状态机」', '进入业务状态机运行状态', { event: 'hsm:started' }, '关联 BT 的结果可驱动事件'),
  make('运行调试', '停止状态机', 'runtime', 'runtime-hsm', '点击「停止状态机」并等待结束', '完成状态机停止', { event: 'hsm:stopped' }, '确认动作已经结束'),
  make('运行调试', '结束练习', 'runtime', 'runtime-stop', '点击「停止系统」', '自动退出教学并恢复原工作区', { event: 'system:stopped' }, '练习工程结束后销毁'),
]

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
  const steps = useMemo(() => course === 'tomato' ? tomatoSteps : basicSteps, [course])
  const [index, setIndex] = useState(0)
  const [focus, setFocus] = useState<Frame | null>(null)
  const [completed, setCompleted] = useState(false)
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

  // Measure at most once per animation frame and scroll only when a new target appears
  // Avoid a smooth-scroll + polling loop, which was forcing constant repaint of the blur
  useLayoutEffect(() => {
    const selector = `[data-guide="${step.target}"]`
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
  }, [index, step])

  const skipStep = () => {
    if (completed) return
    if (index === steps.length - 1) onClose()
    else setIndex(value => value + 1)
  }

  const cutout = spotlightCutout(focus)

  return <div ref={root} className="tutorial-root tutorial-shared" role="dialog" aria-modal="true" aria-label="独立教学工作台">
    <div className="tutorial-real-app">{children}</div>
    <div className="tutorial-mask" aria-hidden="true" style={cutout ? { clipPath: cutout } : undefined} />
    {focus && <div className="tutorial-spotlight" aria-hidden="true" style={{ top: focus.top, left: focus.left, width: focus.right - focus.left, height: focus.bottom - focus.top }} />}
    <aside className={'tutorial-coach' + (!open ? ' tutorial-coach-collapsed' : '')} aria-label="教学指导">
      <div className="tutorial-coach-top"><div><small>{course === 'tomato' ? '番茄采摘 · 操作教程' : '通用机器人 · 操作教程'}</small><strong>{step.chapter}</strong></div><button aria-label={open ? '收起指导' : '展开指导'} onClick={() => setOpen(value => !value)}><Icon name={open ? 'chevron-down' : 'chevron-up'} /></button></div>
      {open && <>
        <div className="tutorial-coach-body">
        <div className="tutorial-progress"><span>第 {index + 1} 步 / 共 {steps.length} 步</span><span>{Math.round((index + 1) / steps.length * 100)}%</span></div>
        <div className="tutorial-progress-track"><span style={{ width: `${(index + 1) / steps.length * 100}%` }} /></div>
        <h2>{step.title}</h2>
        <div className="tutorial-coach-section"><strong>目标</strong><p>{step.purpose}</p></div>
        <div className="tutorial-coach-section important"><strong>操作</strong><p>{step.instruction}</p></div>
        <div className="tutorial-coach-section"><strong>完成后</strong><p>{step.expected}</p></div>
        {!focus && <div className="tutorial-coach-hint"><Icon name="info" /><div><p>操作区域尚未显示，等待页面加载后自动定位</p><button className="tutorial-prep-button" onClick={() => window.dispatchEvent(new CustomEvent<Workspace>('agro:tutorial:navigate', { detail: step.page }))}>重新定位</button></div></div>}
        <div className={'tutorial-coach-status' + (completed ? ' complete' : '')} role="status"><Icon name={completed ? 'check-circle' : 'mouse-pointer-2'} />{completed ? '操作完成 · 自动进入下一步' : '完成高亮区域的操作后自动继续'}</div>
        </div>
        <div className="tutorial-coach-actions"><button onClick={onClose}>退出教学</button><button disabled={index === 0 || completed} onClick={() => setIndex(value => Math.max(0, value - 1))}>上一步</button><button className="tutorial-primary" disabled={completed} onClick={skipStep}>跳过此步</button></div>
        <p className="tutorial-coach-foot">跳过仅略过指引，不执行对应操作 · 退出后返回原工作区</p>
      </>}
    </aside>
  </div>
}
