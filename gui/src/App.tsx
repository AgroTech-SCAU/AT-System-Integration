import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiClient, ApiError } from './api'
import { Field, Panel, PendingDialog, Segmented } from './components/Foundation'
import { Icon } from './components/Icon'
import { messages } from './i18n'
import type { Observation, Settings, Workspace } from './types'
import SystemBuilder from './pages/SystemBuilder'
import RuntimePage from './pages/Runtime'
import Records from './pages/Records'
import TaskWorkspace from './pages/TaskWorkspace'
import Overview from './pages/Overview'
import RobotLibrary, {type RobotDirectory} from './pages/RobotLibrary'

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
  return path === 'templates' ? 'editor' : path === 'overview' || path === 'system' || path === 'runtime' || path === 'settings' || path === 'records' || path === 'editor' ? path : 'overview'
}

export default function App() {
  const [settings, setSettings] = useState(loadSettings)
  const [workspace, setWorkspace] = useState(currentWorkspace)
  const [client, setClient] = useState<ApiClient | null>(null)
  const active = useRef<ApiClient | null>(null)
  const observationRevision = useRef(0)
  const [observation, setObservation] = useState<Observation | null>(null)
  const [robotDirectory, setRobotDirectory] = useState<RobotDirectory|null>(null)
  const [leaving, setLeaving] = useState(false)
  const navigationTimer = useRef<ReturnType<typeof setTimeout>|null>(null)
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
    const back = () => {
      if (!window.dispatchEvent(new Event('agro:navigate', { cancelable: true }))) { history.pushState({}, '', `/ui/${workspace}`); return }
      setWorkspace(currentWorkspace())
    }
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  }, [workspace])
  useEffect(() => () => { active.current?.disconnect(); if (navigationTimer.current) clearTimeout(navigationTimer.current) }, [])
  useEffect(() => {
    let cancelled = false
    if (window.agroDesktop) {
      setBusy(true)
      window.agroDesktop.connectLocal().then(async token => {
        if (cancelled) return
        const target = new ApiClient(token)
        active.current = target
        setClient(target)
        await observe(target)
        await reloadRobots(target)
      }).catch(() => { if (!cancelled) setError('failed') })
        .finally(() => { if (!cancelled) setBusy(false) })
    }
    return () => { cancelled = true }
  }, [])

  async function reloadRobots(target: ApiClient) {
    try { const directory = await target.request<RobotDirectory>('/robot-systems'); if(active.current===target) setRobotDirectory(directory) }
    catch { if(active.current===target) setRobotDirectory(null) }
  }

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
        setRobotDirectory(null)
        history.replaceState(null, '', '/ui/overview')
        setWorkspace('overview')
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
    if (active.current === target) await reloadRobots(target)
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
    if(!window.dispatchEvent(new Event('agro:navigate',{cancelable:true})))return
    active.current?.disconnect()
    active.current = null
    fileRead.current++
    setClient(null)
    setRobotDirectory(null)
    setObservation(null)
    setPending(false)
    setBusy(false)
    setError(null)
    history.pushState(null, '', '/ui/overview')
    setWorkspace('overview')
  }
  function navigate(next: Workspace) {
    if(next===workspace || leaving)return
    if(!window.dispatchEvent(new Event('agro:navigate',{cancelable:true})))return
    setLeaving(true)
    navigationTimer.current=setTimeout(()=>{
      history.pushState(null, '', `/ui/${next}`)
      setWorkspace(next)
      setLeaving(false)
      navigationTimer.current=null
    },90)
  }
  async function reconnectLocal(){
    if(!window.agroDesktop)return
    setBusy(true)
    try {
      const token=await window.agroDesktop.connectLocal()
      const target=new ApiClient(token)
      active.current?.disconnect()
      active.current=target;setClient(target);setError(null)
      await observe(target);await reloadRobots(target)
    }catch {setError('failed')}finally{setBusy(false)}
  }
  async function refreshProjects(){
    if(client){await reloadRobots(client);await observe(client)}
  }
  const selectedRobot=robotDirectory?.systems.find(item=>item.id===robotDirectory.selected_id)
  const canUseRobot=Boolean(selectedRobot&&robotDirectory?.active)


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
          <div className="hero"><p className="eyebrow">AGROTECH · ROBOT STUDIO</p><h1>AgroTech</h1><p>{text.sidebarHint}</p></div>
          <p className="nav-caption">{text.workflow}</p>
          <nav aria-label={text.workflow}>
            {(['overview', 'system', 'editor', 'runtime'] as const).map((item, index) => <button className="nav-item" key={item} aria-current={workspace === item ? 'page' : undefined} onClick={() => navigate(item)}>
              <Icon name={item==='editor'?'templates':item} /><span>{text[item]}</span><small aria-hidden="true">0{index + 1}</small>
            </button>)}
          </nav>
          <p className="nav-caption">{text.application}</p>
          <button className="nav-item" aria-label={text.settings} aria-current={workspace === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Icon name="settings" /><span>{text.settings}</span></button>
          <button className="nav-item" aria-label={text.records} aria-current={workspace === 'records' ? 'page' : undefined} onClick={() => navigate('records')}><Icon name="runtime" /><span>{text.records}</span></button>
          <div className="sidebar-spacer" />
          <div className="runtime-card"><span className={`dot ${observation ? 'live' : ''}`} />{observation ? text.connected : text.offline}<small>本地运行环境</small><small>{selectedRobot?.name||'未选择机器人系统'}</small></div>
        </aside>
        <section className="content-wrap">
          <div className="top-status"><span className="breadcrumb">{text.subtitle} / {text[workspace]}</span><span className="pill">{text.localOnly}</span><span className="pill"><span className={`dot ${observation ? 'live' : ''}`} />{observation ? text.connected : text.offline}</span></div>
          <main className="content"><div key={workspace+':'+(robotDirectory?.selected_id||'none')} className={`page ${leaving?'page-leaving':'page-spring'}`}>
          <div className="page-heading"><div><p className="eyebrow">AGROTECH · WORKSPACE</p><h1>{workspace === 'settings' ? text.settingsTitle : text[workspace]}</h1><p className="page-description">{workspace === 'settings' ? text.settingsHint : text[workspace === 'overview' ? 'overviewHint' : workspace === 'system' ? 'systemHint' : workspace === 'templates' ? 'templateHint' : workspace === 'editor' ? 'editorHint' : 'runtimeHint']}</p></div>
            {client && <div className="buttons"><button disabled={busy} onClick={refresh}><Icon name="refresh" />{text.refresh}</button>{workspace!=='overview'&&<button onClick={()=>navigate('overview')}>选择机器人系统</button>}</div>}
          </div>
          {workspace === 'settings' ? <>
            <div className="workspace-grid settings-grid">
              <Panel title={text.appearance} subtitle={text.theme} icon="sun"><Segmented label={text.theme} value={settings.theme} options={[{ value: 'system', label: text.followSystem }, { value: 'dark', label: text.dark }, { value: 'light', label: text.light }]} onChange={value => setSettings({ ...settings, theme: value as Settings['theme'] })} /></Panel>
              <Panel title={text.language} icon="settings"><Segmented label={text.language} value={settings.language} options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]} onChange={value => setSettings({ ...settings, language: value as Settings['language'] })} /></Panel>
              <Panel title={text.layout} icon="templates"><label className="toggle"><input type="checkbox" checked={settings.compact} onChange={event => setSettings({ ...settings, compact: event.target.checked })} />{text.compact}</label></Panel>
            </div>
            {!window.agroDesktop && <Panel title="浏览器调试连接" subtitle="请输入本机会话凭据" icon="plug">
              <form onSubmit={connect}>
                <Field label={text.session}><input ref={credential} type="password" autoComplete="off" spellCheck={false} required aria-label={text.session} /></Field>
                <div className="buttons"><label className="file-button">{text.sessionFile}<input ref={fileInput} type="file" aria-label={text.sessionFile} onChange={async event => {
                  const file=event.target.files?.[0];const revision=++fileRead.current
                  if(!file)return
                  try {if(file.size>4096)throw new Error();const token=(await file.text()).trim()
                    if(revision!==fileRead.current||active.current)return
                    if(!token)throw new Error();if(credential.current)credential.current.value=token;setError(null)
                  }catch{if(revision===fileRead.current)setError('fileError')}
                  finally{if(revision===fileRead.current&&fileInput.current)fileInput.current.value=''}
                }}/></label><button type="submit" className="primary" disabled={busy}>{text.connect}</button></div>
              </form>
              {client&&<button onClick={disconnect}>断开浏览器观察</button>}
            </Panel>}
            
          </> : <>
          <div className={`observation-bar ${observation ? '' : 'unobserved'}`} role="status">
            <span className={`dot ${observation ? 'live' : ''}`} />
            <strong>{observation ? text.connected : text.offline}</strong>
            <span>{text.lastSeen} · {lastSeen ? lastSeen.toLocaleString(settings.language === 'zh' ? 'zh-CN' : 'en') : text.never}</span>
            <span className="endpoint">{selectedRobot?.name || "机器人系统工作台"}</span>
          </div>
          {error && <p className="error" role="alert">{text[error]}</p>}
          {workspace === 'overview' && <><RobotLibrary client={client} directory={robotDirectory} onRefresh={refreshProjects} onReconnect={reconnectLocal} onNavigate={navigate}/>{client&&canUseRobot&&observation&&<Overview observation={observation} language={settings.language} navigate={navigate} robotName={selectedRobot?.name||''}/>}</> }
          {client && <>
            {workspace === 'system' && selectedRobot && <SystemBuilder key={selectedRobot.id} client={client} observation={canUseRobot?observation:null} language={settings.language} changed={refreshProjects} robotSystem={selectedRobot} />}
            {workspace === 'editor' && canUseRobot && <TaskWorkspace client={client} observation={observation} language={settings.language} changed={() => observe(client)} />}
            {workspace === 'runtime' && canUseRobot && <RuntimePage client={client} observation={observation} language={settings.language} changed={() => observe(client)} />}
            {workspace === 'records' && canUseRobot && <Records client={client} observation={observation} language={settings.language} changed={() => observe(client)} />}
          </>}
          {workspace!=='overview' && (!client||!selectedRobot||(!canUseRobot&&workspace!=='system')) && <div className="library-empty-workspace"><Icon name="system"/><h2>{!selectedRobot?'请先选择机器人系统':'当前系统尚未应用'}</h2><p>{!client?'请到总览选择机器人系统':'请到总览选择并加载机器人系统'}</p><button className="primary" onClick={()=>navigate('overview')}>返回总览 →</button></div>}
          </>}
          </div></main>
        </section>
      </div>
    </div>
    <PendingDialog open={pending} text={text} error={error ? text[error] : undefined} onClose={() => setPending(false)} actions={<span className="muted">{text.futureActions}</span>} />
  </>
}
