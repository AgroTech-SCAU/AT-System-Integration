import type { Observation } from './types'

export class ApiError extends Error {
  constructor(public readonly kind: 'unauthorized' | 'offline' | 'response') { super(kind) }
}

export class ApiClient {
  #credential: string
  #requests = new Set<AbortController>()
  constructor(credential: string) { this.#credential = credential }

  disconnect() {
    this.#credential = ''
    for (const request of this.#requests) request.abort()
    this.#requests.clear()
  }

  async #read<T>(path: string): Promise<T> {
    if (!this.#credential) throw new ApiError('unauthorized')
    const controller = new AbortController()
    this.#requests.add(controller)
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const response = await fetch(path, {
        method: 'GET', headers: { Authorization: `Bearer ${this.#credential}` },
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal
      })
      if (response.status === 401) {
        this.disconnect()
        throw new ApiError('unauthorized')
      }
      if (!response.ok) throw new ApiError('response')
      return await response.json() as T
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError('offline')
    } finally {
      clearTimeout(timer)
      this.#requests.delete(controller)
    }
  }

  async observe(): Promise<Observation> {
    const [system, packages, control, tasks] = await Promise.all([
      this.#read<Observation['system']>('/system/status'),
      this.#read<Observation['packages']>('/packages'),
      this.#read<Observation['control']>('/control/status'),
      this.#read<Observation['tasks']>('/tasks')
    ])
    return { system, packages, control, tasks }
  }
}
