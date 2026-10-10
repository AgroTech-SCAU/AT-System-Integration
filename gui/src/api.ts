import type { Observation } from './types'

export class ApiError extends Error {
  constructor(public readonly kind: 'unauthorized' | 'offline' | 'response', public readonly details: {path:string;code:string;reason:string}[] = []) { super(kind) }
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

  async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.#credential) throw new ApiError('unauthorized')
    const controller = new AbortController()
    this.#requests.add(controller)
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(() => controller.abort(), 12000)
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
      if (error instanceof ApiError) throw error
      throw new ApiError('offline')
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
