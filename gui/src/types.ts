export interface ModuleStatus {
  process: boolean
  interface: boolean
  state?: string
  reason?: unknown
}
export interface SystemStatus {
  system_id: string
  system_run_id: string | null
  snapshot_id: string
  state: string
  mode: string
  estop: boolean
  accepting_operations: boolean
  modules: Record<string, ModuleStatus>
}
export interface PackageDescription {
  package_id: string
  enabled: boolean
  capabilities: { capability_id: string }[]
}
export interface TaskSummary {
  task_run_id: string
  state: string
  result?: unknown
  stop_confirmed?: boolean
}
export interface Observation {
  system: SystemStatus
  packages: { packages: PackageDescription[] }
  control: { mode: string; estop: boolean }
  tasks: { tasks: TaskSummary[] }
}
export type Workspace = 'system' | 'templates' | 'runtime' | 'settings' | 'records' | 'editor'
export type Language = 'zh' | 'en'
export interface Settings { theme: 'system' | 'dark' | 'light'; language: Language; compact: boolean }

declare global {
  interface Window {
    agroDesktop?: { connectLocal(): Promise<string>; copyReport(taskId: string): Promise<void>; exportReport(taskId: string): Promise<void>; exportTreeXml(draftId: string): Promise<void>; minimize(): Promise<void>; maximize(): Promise<void>; close(): Promise<void> }
  }
}
