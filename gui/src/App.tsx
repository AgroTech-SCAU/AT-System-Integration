import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiClient, ApiError } from './api'
import { Field, Panel, PendingDialog, Segmented, StatusCard } from './components/Foundation'
import { Icon } from './components/Icon'
import { messages } from './i18n'
import type { Observation, Settings, Workspace } from './types'

const SETTINGS_KEY = 'agro.gui.appearance'
function loadSettings(): Settings {
  const defaults: Settings = { theme: 'system', language: 'zh', compact: false }
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') as Partial<Settings>
    return { theme: value.theme === 'light' || value.theme === 'dark' ? value.theme : 'system', language: value.language === 'en' ? 'en' : 'zh', compact: value.compact === true }
  } catch { return defaults }
}
function currentWorkspace(): Workspace {
  const path = location.pathname.split('/')[2]
  return path === 'templates' || path === 'runtime' || path === 'settings' ? path : 'system'
}

export default function App() {
  const [settings, setSettings] = useState(loadSettings)
  const [workspace, setWorkspace] = useState(currentWorkspace)
  const [client, setClient] = useState<ApiClient | null>(null)
  const active = useRef<ApiClient | null>(null)
  const observationRevision = useRef(0)
  const [observation, setObservation] = useState<Observation | null>(null)
  const [lastSeen, setLastSeen] = useState<Date | null>(null)
  const [error, setError] = useState<'unauthorized' | 'failed' | 'fileError' | null>(null)
  const [pending, setPending] = useState(false)
  const [busy, setBusy] = useState(false)
  const credential = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const fileRead = useRef(0)
  const text = messages(settings.language)

  useEffect(() => {
    const preferred = window.matchMedia('(prefers-color-scheme: light)')
    const applyTheme = () => {
      document.documentElement.dataset.theme = settings.theme === 'system' ? (preferred.matches ? 'light' : 'dark') : settings.theme
    }
    applyTheme()
    preferred.addEventListener('change', applyTheme)
    document.documentElement.lang = settings.language === 'zh' ? 'zh-CN' : 'en'
    document.title = `AgroTech · ${text.brand}`
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* 设置存储不可用时仍保留当前界面 */ }
    return () => preferred.removeEventListener('change', applyTheme)
  }, [settings, text.brand])
  useEffect(() => {
    const back = () => setWorkspace(currentWorkspace())
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  }, [])
  useEffect(() => () => { active.current?.disconnect() }, [])

  async function observe(target: ApiClient) {
    const revision = ++observationRevision.current
    try {
      const result = await target.observe()
      if (active.current !== target || observationRevision.current !== revision) return
      setObservation(result)
      setLastSeen(new Date())
      setError(null)
    } catch (cause) {
      if (active.current !== target) return
      if (cause instanceof ApiError && cause.kind === 'unauthorized') {
        setObservation(null)
        target.disconnect()
        active.current = null
        setClient(null)
        history.replaceState(null, '', '/ui/system')
        setWorkspace('system')
        setPending(false)
        setError('unauthorized')
      } else if (observationRevision.current === revision) {
        setObservation(null)
        setError('failed')
      }
    }
  }
  useEffect(() => {
    if (!client) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      if (stopped) return
      await observe(client!)
      if (!stopped && active.current === client) timer = setTimeout(poll, 2000)
    }
    timer = setTimeout(poll, 2000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [client])

  async function connect(event: FormEvent) {
    event.preventDefault()
    const token = credential.current?.value.trim() || ''
    if (!token || busy) return
    if (credential.current) credential.current.value = ''
    if (fileInput.current) fileInput.current.value = ''
    fileRead.current++
    active.current?.disconnect()
    const target = new ApiClient(token)
    active.current = target
    setClient(target)
    setObservation(null)
    setError(null)
    setBusy(true)
    setPending(true)
    await observe(target)
    if (active.current === target || active.current === null) { setBusy(false); setPending(false) }
  }
  async function refresh() {
    if (!client || busy) return
    setBusy(true)
    setPending(true)
    await observe(client)
    setBusy(false)
    setPending(false)
  }
  function disconnect() {
    active.current?.disconnect()
    active.current = null
    fileRead.current++
    setClient(null)
    setObservation(null)
    setPending(false)
    setBusy(false)
    setError(null)
    navigate('system')
  }
  function navigate(next: Workspace) {
    history.pushState(null, '', `/ui/${next}`)
    setWorkspace(next)
  }

  return <>
    <div className={`app ${settings.compact ? 'compact' : ''}`}>
      <header className="titlebar">
        <div className="brand-mini"><Icon name="system" /><strong>AgroTech Launcher</strong></div>
        <span className="title-center">{text.brand}</span>
        <div className="title-actions"><button disabled={pending} className="title-button" aria-label={text.appearance} onClick={() => setSettings({ ...settings, theme: document.documentElement.dataset.theme === 'light' ? 'dark' : 'light' })}><Icon name="sun" /></button>
          <button disabled={pending} className="title-button" aria-label={text.openSettings} onClick={() => navigate('settings')}><Icon name="settings" /></button>
          {window.agroDesktop && <div className="window-controls">
            <button className="title-button" aria-label={text.minimizeWindow} onClick={() => void window.agroDesktop?.minimize()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg></button>
            <button className="title-button" aria-label={text.maximizeWindow} onClick={() => void window.agroDesktop?.maximize()}><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1" /></svg></button>
            <button className="title-button window-close" aria-label={text.closeWindow} onClick={() => void window.agroDesktop?.close()}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 3 10 10M13 3 3 13" /></svg></button>
          </div>}</div>
      </header>
      <div className="shell" inert={pending}>
        <aside className="sidebar">
          <div className="hero"><p className="eyebrow">AGROTECH · WORKSPACE</p><h1>AgroTech</h1><p>{text.sidebarHint}</p></div>
          <p className="nav-caption">{text.workflow}</p>
          <nav aria-label={text.workflow}>
            {(['system', 'templates', 'runtime'] as const).map((item, index) => <button className="nav-item" key={item} aria-current={workspace === item ? 'page' : undefined} onClick={() => navigate(item)}>
              <Icon name={item} /><span>{text[item]}</span><small aria-hidden="true">0{index + 1}</small>
            </button>)}
          </nav>
          <p className="nav-caption">{text.application}</p>
          <button className="nav-item" aria-label={text.settings} aria-current={workspace === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Icon name="settings" /><span>{text.settings}</span></button>
          <div className="sidebar-spacer" />
          <div className="runtime-card"><span className={`dot ${observation ? 'live' : ''}`} />{observation ? text.connected : text.offline}<small>{location.origin}</small><small>{observation?.system.system_id || text.waiting}</small></div>
        </aside>
        <section className="content-wrap">
          <div className="top-status"><span className="breadcrumb">{text.subtitle} / {text[workspace]}</span><span className="pill">{text.localOnly}</span><span className="pill"><span className={`dot ${observation ? 'live' : ''}`} />{observation ? text.connected : text.offline}</span></div>
          <main className="content"><div className="page">
          <div className="page-heading"><div><p className="eyebrow">AGROTECH · WORKSPACE</p><h1>{workspace === 'settings' ? text.settingsTitle : text[workspace]}</h1><p className="page-description">{workspace === 'settings' ? text.settingsHint : text[workspace === 'system' ? 'systemHint' : workspace === 'templates' ? 'templateHint' : 'runtimeHint']}</p></div>
            {client && <div className="buttons"><button disabled={busy} onClick={refresh}><Icon name="refresh" />{text.refresh}</button><button onClick={disconnect}>{text.disconnect}</button></div>}
          </div>
          {workspace === 'settings' ? <>
            <div className="workspace-grid settings-grid">
              <Panel title={text.appearance} subtitle={text.theme} icon="sun"><Segmented label={text.theme} value={settings.theme} options={[{ value: 'system', label: text.followSystem }, { value: 'dark', label: text.dark }, { value: 'light', label: text.light }]} onChange={value => setSettings({ ...settings, theme: value as Settings['theme'] })} /></Panel>
              <Panel title={text.language} icon="settings"><Segmented label={text.language} value={settings.language} options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]} onChange={value => setSettings({ ...settings, language: value as Settings['language'] })} /></Panel>
              <Panel title={text.layout} icon="templates"><label className="toggle"><input type="checkbox" checked={settings.compact} onChange={event => setSettings({ ...settings, compact: event.target.checked })} />{text.compact}</label></Panel>
            </div><p className="callout">{text.settingsHint}</p>
          </> : <>
          <div className={`observation-bar ${observation ? '' : 'unobserved'}`} role="status">
            <span className={`dot ${observation ? 'live' : ''}`} />
            <strong>{observation ? text.connected : text.offline}</strong>
            <span>{text.lastSeen} · {lastSeen ? lastSeen.toLocaleString(settings.language === 'zh' ? 'zh-CN' : 'en') : text.never}</span>
            <span className="endpoint">{location.origin}</span>
          </div>
          {error && <p className="error" role="alert">{text[error]}</p>}
          {!client && <div className="workspace-grid connection"><Panel title={text.connectTitle} subtitle={text.connectionHint} icon="plug">
            <form onSubmit={connect}>
              <Field label={text.session}><input ref={credential} type="password" autoComplete="off" spellCheck={false} required aria-label={text.session} /></Field>
              <div className="buttons"><label className="file-button">{text.sessionFile}<input ref={fileInput} type="file" aria-label={text.sessionFile} onChange={async event => {
                const file = event.target.files?.[0]
                const revision = ++fileRead.current
                if (!file) return
                try {
                  if (file.size > 4096) throw new Error()
                  const value = (await file.text()).trim()
                  if (revision !== fileRead.current || active.current) return
                  if (!value) throw new Error()
                  if (credential.current) credential.current.value = value
                  setError(null)
                } catch { if (revision === fileRead.current) setError('fileError') }
                finally { if (revision === fileRead.current && fileInput.current) fileInput.current.value = '' }
              }} /></label><button type="submit" className="primary" disabled={busy}>{text.connect}</button></div>
            </form>
          </Panel><Panel title={text.connectionSummary} subtitle={text.localOnly} icon="runtime"><p className="summary-caption">AGENT</p><p className="summary-name">{text.waiting}</p><dl className="kv"><dt>{text.agent}</dt><dd><code>{location.origin}</code></dd><dt>{text.session}</dt><dd>{text.never}</dd></dl><p className="callout">{text.runtimeHint}</p></Panel></div>}
          {workspace === 'templates' ? <Panel title={text.templateTitle} subtitle={text.templateHint} icon="templates">
            <div className="canvas-placeholder"><span className="tree-icon" aria-hidden="true">◇<br />┌──┴──┐<br />◇　　◇</span><h3>{text.canvas}</h3><p>{text.canvasHint}</p></div>
          </Panel> : <>
            <p className="workspace-hint">{workspace === 'system' ? text.systemHint : text.runtimeHint}</p>
            {observation ? <>
              <div className="cards">
                <StatusCard label={text.systemState} value={observation.system.state} tone={observation.system.state.includes('FAULT') || observation.system.state === 'STOP_UNCONFIRMED' ? 'danger' : 'neutral'} />
                <StatusCard label={text.mode} value={observation.control.mode} tone={observation.control.mode === 'FAULT' ? 'danger' : 'neutral'} />
                <StatusCard label={text.estop} value={observation.control.estop ? text.active : text.inactive} tone={observation.control.estop ? 'danger' : 'neutral'} />
              </div>
              <div className="workspace-grid"><Panel title={text.modules} icon="system"><div className="table-wrap"><table><thead><tr><th>{text.modules}</th><th>{text.process}</th><th>{text.interface}</th></tr></thead><tbody>
                {Object.entries(observation.system.modules).map(([name, status]) => <tr key={name}><td>{name}</td><td>{status.process ? text.yes : text.no}</td><td>{status.interface ? text.yes : text.no}</td></tr>)}
              </tbody></table></div><p className="snapshot"><span>{text.snapshot}</span><code>{observation.system.snapshot_id}</code></p></Panel>
              {workspace === 'system' ? <Panel title={text.packages} icon="plug">{observation.packages.packages.length === 0 ? <p>{text.emptyPackages}</p> : observation.packages.packages.map(item =>
                <div className="package-row" key={item.package_id}><div><strong>{item.package_id}</strong><p className="capabilities">{item.capabilities.map(capability => capability.capability_id).join(' · ')}</p></div><span className="badge">{item.enabled ? text.enabled : text.disabled}</span></div>)}</Panel>
                : <Panel title={text.tasks} icon="runtime">{observation.tasks.tasks.length === 0 ? <p className="muted">{text.emptyTasks}</p> : observation.tasks.tasks.map(task =>
                  <div className="task-row" key={task.task_run_id}><code>{task.task_run_id}</code><strong>{task.state}</strong></div>)}</Panel>}
              </div>
            </> : <section className="panel empty-state"><span className="empty-icon" aria-hidden="true">◎</span><p>{text.noObservation}</p></section>}
          </>}
          </>}
          </div></main>
        </section>
      </div>
    </div>
    <PendingDialog open={pending} text={text} error={error ? text[error] : undefined} onClose={() => setPending(false)} actions={<span className="muted">{text.futureActions}</span>} />
  </>
}
