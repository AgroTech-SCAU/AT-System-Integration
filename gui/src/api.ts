import type { Observation } from './types'

export class ApiError extends Error {
  constructor(public readonly kind: 'unauthorized' | 'offline' | 'response', public readonly details: {path:string;code:string;reason:string}[] = [], public operation?: string) { super(kind) }
}

export class ApiClient {
  #credential: string
  #requests = new Set<AbortController>()
  constructor(credential: string, private readonly basePath = '') { this.#credential = credential }

  scoped(prefix: string): ApiClient {
    return new ApiClient(this.#credential, prefix)
  }

  disconnect() {
    this.#credential = ''
    for (const request of this.#requests) request.abort()
    this.#requests.clear()
  }

  async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, timeoutMs=12000): Promise<T> {
    if (!this.#credential) throw new ApiError('unauthorized')
    const controller = new AbortController()
    this.#requests.add(controller)
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(this.basePath + path, {
        method, headers: { Authorization: `Bearer ${this.#credential}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal
      })
      if (response.status === 401) {
        this.disconnect()
        throw new ApiError('unauthorized')
      }
      if (!response.ok) {
        const problem = await response.json().catch(() => ({}))
        throw new ApiError('response', problem.errors || [{ path: '$', code: 'http_error', reason: '请求未被接受' }])
      }
      return await response.json() as T
    } catch (error) {
      const operation = method==='GET'?'读取失败':path.includes('/copy')?'创建副本失败':method==='DELETE'?'删除失败':path.includes('/start')||path.includes('/operations')?'执行请求失败':path.includes('/tasks')?'任务保存失败':path.includes('/state-machines')?'状态机操作失败':path.includes('/interface-workspaces')?'子系统工作区操作失败':'配置未能保存'
      if (error instanceof ApiError) { error.operation ||= operation; throw error }
      throw new ApiError('offline', [], operation)
    } finally {
      clearTimeout(timer)
      this.#requests.delete(controller)
      signal?.removeEventListener('abort', abort)
    }
  }

  async observe(): Promise<Observation> {
    const [system, packages, control, tasks] = await Promise.all([
      this.request<Observation['system']>('/system/status'),
      this.request<Observation['packages']>('/packages'),
      this.request<Observation['control']>('/control/status'),
      this.request<Observation['tasks']>('/tasks')
    ])
    return { system, packages, control, tasks }
  }
}
