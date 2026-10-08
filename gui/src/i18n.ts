import type { Language } from './types'

const zh = {
  editor: '任务设计', editorHint: '编辑控制结构与数据绑定，校验后发布固定定义，运行观察始终使用原任务快照',
  records: '记录与报告',
  minimizeWindow: '最小化窗口', maximizeWindow: '最大化或还原窗口', closeWindow: '关闭应用窗口',
  settings: '设置', openSettings: '打开设置', workflow: '工作流', application: '应用', settingsTitle: '让工作台适合你', settingsHint: '偏好会自动保存，不影响 Agent 持有的任务', followSystem: '跟随系统', layout: '布局', connectionSummary: '连接概览', localOnly: '本机管理', sidebarHint: '系统搭建 · 任务模板 · 运行观察',
  brand: '农业机器人系统集成', subtitle: '本机管理工作台', system: '系统搭建', templates: '模板任务', runtime: '运行调试',
  connectTitle: '连接本机 Agent', connectionHint: '选择本机会话文件或输入凭据，凭据只驻留当前页面内存',
  session: '会话凭据', sessionFile: '选择会话文件', connect: '连接', disconnect: '断开观察',
  connected: '正在观察', offline: '未观测', lastSeen: '最后成功观测', never: '尚未连接',
  unauthorized: '会话已失效，请重新连接', failed: '连接失败，当前状态未观测', fileError: '无法读取会话文件',
  refresh: '刷新状态', pendingTitle: '正在执行', pendingDescription: '正在读取 Agent 状态', close: '关闭观察',
  pendingHint: '关闭此窗口仅关闭等待观察，后台持有的任务继续运行', operationArea: '操作区',
  futureActions: '取消任务和停止系统将在运行操作阶段开放', theme: '主题', light: '浅色', dark: '深色',
  language: '语言', compact: '紧凑布局', appearance: '外观', agent: '本机 Agent',
  packages: '已注册接入包', emptyPackages: '未注册接入包', enabled: '已启用', disabled: '未启用',
  systemHint: '导入接入包描述，编辑后端与角色绑定，校验草稿并在停止态应用',
  templateTitle: '模板任务工作区', templateHint: '创建模板方案，绑定模拟标定资产并检查参数与摘要',
  canvas: '行为树画布将在后续阶段开放', canvasHint: '此工作区保留画布位置，当前不编辑或执行任务',
  systemState: '系统状态', mode: '整机模式', estop: '急停', active: '已触发', inactive: '未触发',
  modules: '后端模块', process: '进程存在', interface: '接口就绪', yes: '是', no: '否',
  tasks: 'Agent 持有的任务', emptyTasks: '尚无任务', snapshot: '系统快照',
  runtimeHint: '只读观察不会启动、取消或停止任务，断线后旧状态不再代表当前可用',
  noObservation: '等待本机 Agent 的新鲜状态', error: '错误', waiting: '等待连接'
}
const en: typeof zh = {
  editor: 'Task design', editorHint: 'Edit control flow and data bindings, validate and publish a frozen definition, then observe the original task snapshot',
  records: 'Records and reports',
  minimizeWindow: 'Minimize window', maximizeWindow: 'Maximize or restore window', closeWindow: 'Close application window',
  settings: 'Settings', openSettings: 'Open settings', workflow: 'WORKFLOW', application: 'APPLICATION', settingsTitle: 'Make the workspace yours', settingsHint: 'Preferences are saved automatically without changing Agent tasks', followSystem: 'System', layout: 'Layout', connectionSummary: 'Connection overview', localOnly: 'Local management', sidebarHint: 'System builder · Task templates · Runtime observation',
  brand: 'Agricultural system integration', subtitle: 'Local management console', system: 'System builder', templates: 'Task templates', runtime: 'Runtime',
  connectTitle: 'Connect to local Agent', connectionHint: 'Select a local session file or enter a credential, kept only in page memory',
  session: 'Session credential', sessionFile: 'Select session file', connect: 'Connect', disconnect: 'Disconnect observation',
  connected: 'Observing', offline: 'Unobserved', lastSeen: 'Last observed', never: 'Not connected',
  unauthorized: 'Session expired, reconnect to continue', failed: 'Connection failed, current state is unobserved', fileError: 'Unable to read session file',
  refresh: 'Refresh status', pendingTitle: 'In progress', pendingDescription: 'Reading Agent status', close: 'Close observation',
  pendingHint: 'Closing this dialog only closes observation, Agent tasks continue running', operationArea: 'Actions',
  futureActions: 'Task cancellation and system stop will be available in the runtime operations step', theme: 'Theme', light: 'Light', dark: 'Dark',
  language: 'Language', compact: 'Compact layout', appearance: 'Appearance', agent: 'Local Agent',
  packages: 'Registered packages', emptyPackages: 'No registered packages', enabled: 'Enabled', disabled: 'Disabled',
  systemHint: 'Shows the actual registry and runtime configuration, import and draft editing will follow',
  templateTitle: 'Task templates workspace', templateHint: 'Template parameters and assets will be available in a later step',
  canvas: 'Behavior tree canvas will be available in a later phase', canvasHint: 'Reserved canvas space, no task editing or execution here',
  systemState: 'System state', mode: 'Control mode', estop: 'Emergency stop', active: 'Active', inactive: 'Inactive',
  modules: 'Backend modules', process: 'Process present', interface: 'Interface ready', yes: 'Yes', no: 'No',
  tasks: 'Tasks held by Agent', emptyTasks: 'No tasks yet', snapshot: 'System snapshot',
  runtimeHint: 'Read-only observation never starts, cancels or stops tasks, stale state is unavailable after a disconnect',
  noObservation: 'Waiting for fresh local Agent status', error: 'Error', waiting: 'Waiting for connection'
}
export function messages(language: Language) { return language === 'zh' ? zh : en }
export type Messages = typeof zh
