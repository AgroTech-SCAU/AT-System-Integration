import type { Language } from './types'

const zh = {
  overview: '总览', overviewHint: '管理机器人系统，查看模块与任务状态',
  editor: '任务编排', editorHint: '选择当前系统的任务模板，或从空白行为树开始编排',
  records: '记录与报告',
  minimizeWindow: '最小化窗口', maximizeWindow: '最大化或还原窗口', closeWindow: '关闭应用窗口',
  settings: '设置', openSettings: '打开设置', workflow: '工作流', application: '应用', settingsTitle: '偏好设置', settingsHint: '外观、语言与布局', followSystem: '跟随系统', layout: '布局', connectionSummary: '连接概览', localOnly: '本机管理', sidebarHint: '搭建机器人 · 编排任务 · 运行调试',
  brand: '农业机器人系统集成', subtitle: '机器人工作台', system: '系统搭建', templates: '模板任务', runtime: '运行调试',
  connectTitle: '连接本机管理服务', connectionHint: '选择本机会话文件或输入凭据，凭据只驻留当前页面内存',
  session: '会话凭据', sessionFile: '选择会话文件', connect: '连接', disconnect: '断开观察',
  connected: '已连接', offline: '未连接', lastSeen: '更新时间', never: '尚未连接',
  unauthorized: '会话已失效，请重新连接', failed: '连接失败，当前状态未观测', fileError: '无法读取会话文件',
  refresh: '刷新状态', pendingTitle: '正在执行', pendingDescription: '正在读取机器人状态', close: '关闭观察',
  pendingHint: '关闭窗口不会中断正在执行的任务', operationArea: '操作区',
  futureActions: '正在执行的任务请到运行调试中停止', theme: '主题', light: '浅色', dark: '深色',
  language: '语言', compact: '紧凑布局', appearance: '外观', agent: '本机管理服务',
  packages: '已注册接入包', emptyPackages: '未注册接入包', enabled: '已启用', disabled: '未启用',
  systemHint: '配置视觉、导航、机械臂、电控后端及参数',
  templateTitle: '任务模板', templateHint: '配置任务参数与标定资产',
  canvas: '行为树画布', canvasHint: '编辑任务节点与连接',
  systemState: '系统状态', mode: '整机模式', estop: '急停', active: '已触发', inactive: '未触发',
  modules: '后端模块', process: '进程存在', interface: '接口就绪', yes: '是', no: '否',
  tasks: '当前任务', emptyTasks: '尚无任务', snapshot: '系统快照',
  runtimeHint: '启动机器人系统、运行任务并查看执行结果',
  noObservation: '正在获取系统状态', error: '错误', waiting: '等待连接'
}
const en: typeof zh = {
  overview: 'Overview', overviewHint: 'Manage robots and inspect system and task status',
  editor: 'Task composition', editorHint: 'Configure tasks for your selected robot system or start from a blank behavior tree',
  records: 'Records and reports',
  minimizeWindow: 'Minimize window', maximizeWindow: 'Maximize or restore window', closeWindow: 'Close application window',
  settings: 'Settings', openSettings: 'Open settings', workflow: 'WORKFLOW', application: 'APPLICATION', settingsTitle: 'Preferences', settingsHint: 'Appearance, language and layout', followSystem: 'System', layout: 'Layout', connectionSummary: 'Connection overview', localOnly: 'Local management', sidebarHint: 'Build · Compose · Run',
  brand: 'Agricultural system integration', subtitle: 'Robot workspace', system: 'System builder', templates: 'Task templates', runtime: 'Runtime',
  connectTitle: 'Connect to local management service', connectionHint: 'Select a local session file or enter a credential, kept only in page memory',
  session: 'Session credential', sessionFile: 'Select session file', connect: 'Connect', disconnect: 'Disconnect observation',
  connected: 'Connected', offline: 'Disconnected', lastSeen: 'Updated', never: 'Not connected',
  unauthorized: 'Session expired, reconnect to continue', failed: 'Connection failed, current state is unobserved', fileError: 'Unable to read session file',
  refresh: 'Refresh status', pendingTitle: 'In progress', pendingDescription: 'Reading robot system status', close: 'Close observation',
  pendingHint: 'Closing this dialog does not stop running tasks', operationArea: 'Actions',
  futureActions: 'Stop active tasks in Runtime', theme: 'Theme', light: 'Light', dark: 'Dark',
  language: 'Language', compact: 'Compact layout', appearance: 'Appearance', agent: 'Local management service',
  packages: 'Registered packages', emptyPackages: 'No registered packages', enabled: 'Enabled', disabled: 'Disabled',
  systemHint: 'Configure backends, capability bindings and runtime settings',
  templateTitle: 'Task templates', templateHint: 'Configure task parameters and calibration assets',
  canvas: 'Behavior tree canvas', canvasHint: 'Edit nodes and connections',
  systemState: 'System state', mode: 'Control mode', estop: 'Emergency stop', active: 'Active', inactive: 'Inactive',
  modules: 'Backend modules', process: 'Process present', interface: 'Interface ready', yes: 'Yes', no: 'No',
  tasks: 'Current tasks', emptyTasks: 'No tasks yet', snapshot: 'System snapshot',
  runtimeHint: 'Start the robot system, run tasks and inspect results',
  noObservation: 'Loading system status', error: 'Error', waiting: 'Waiting for connection'
}
export function messages(language: Language) { return language === 'zh' ? zh : en }
export type Messages = typeof zh
