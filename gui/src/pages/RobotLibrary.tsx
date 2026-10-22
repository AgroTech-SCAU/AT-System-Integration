import {useEffect, useRef, useState} from 'react'
import type {ApiClient} from '../api'
import type {Workspace} from '../types'
import {ApiError} from '../api'
import {Icon} from '../components/Icon'
import {AnchoredPopover} from '../components/AnchoredPopover'
import {guideCompleted} from '../guide/courses'
import {requestId, waitJob, type Json} from './shared'
import './robot-manager.css'

export type RobotSystem = {
    id: string; name: string; example_id: string | null; content: Json; configured: boolean; revision: number
    connection?: {domain_id: number; namespace: string} | null
}
export type RobotDirectory = {
    systems: RobotSystem[]; selected_id: string | null; active: boolean; running_state: string; switch_blocked_reason?: string | null
    examples: {id: string; title: string; description: string; simulation: boolean}[]
}
type Section = 'create' | 'manage' | 'import'
type ProjectBundle = {format: string; format_version: number; system: {name: string}; [key: string]: unknown}
type Props = {
    initialSection?: Section; onNavigate: (page: Workspace) => void; client: ApiClient | null; directory: RobotDirectory | null
    onRefresh: () => Promise<void>; onReconnect: () => Promise<void>; onClose?: () => void; onBusyChange?: (busy: boolean) => void
}

function problem(error: unknown) {
    return error instanceof ApiError ? error.details?.map(item => item.reason).join('；') || '连接暂时不可用，请重试' : error instanceof Error ? error.message : String(error)
}
function downloadJson(project: ProjectBundle) {
    const blob = new Blob([JSON.stringify(project, null, 2) + '\n'], {type: 'application/json'})
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = project.system.name.replace(/[\\/:*?"<>|]/g, '_') + '.agrobot.json'
    document.body.append(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export default function RobotLibrary({client, directory, onRefresh, onReconnect, onNavigate, onClose, onBusyChange, initialSection = 'manage'}: Props) {
    const [section, setSection] = useState<Section | 'rename' | 'delete'>(initialSection)
    const [name, setName] = useState(''), [source, setSource] = useState<'blank' | 'tomato_picker'>('blank')
    const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failed, setFailed] = useState(false)
    const [phase, setPhase] = useState(''), [query, setQuery] = useState('')
    const [target, setTarget] = useState<RobotSystem | null>(null), [editName, setEditName] = useState('')
    const [menu, setMenu] = useState<{robot: RobotSystem; anchor: HTMLButtonElement} | null>(null)
    const [highlight, setHighlight] = useState('')
    const root = useRef<HTMLDivElement>(null), fileInput = useRef<HTMLInputElement>(null), operation = useRef(false)
    const examples = directory?.examples || [], systems = directory?.systems || []
    const locked = busy || !client
    const switchReason = directory?.switch_blocked_reason || (directory && directory.running_state !== 'STOPPED' ? '机器人正在运行，停止后可以切换' : '')
    const filtered = systems.filter(robot => `${robot.name} ${robot.connection?.namespace || ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    const title = {manage: '机器人管理', create: '新建机器人', import: '导入机器人', rename: '重命名机器人', delete: '删除机器人'}[section]

    useEffect(() => {setSection(initialSection)}, [initialSection])
    useEffect(() => {onBusyChange?.(busy)}, [busy, onBusyChange])
    useEffect(() => {
        const frame = requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>('input[data-initial-focus]')?.focus())
        return () => cancelAnimationFrame(frame)
    }, [section, target?.id])
    useEffect(() => {
        if (!highlight) return
        root.current?.querySelector(`[data-robot-id="${highlight}"]`)?.scrollIntoView({block: 'nearest'})
    }, [highlight, section])

    function changeSection(next: typeof section) {
        if (busy) return
        setSection(next); setMessage(''); setFailed(false); setMenu(null)
    }
    async function perform(work: () => Promise<void>, progress: string) {
        if (!client || operation.current) return
        operation.current = true; setBusy(true); setFailed(false); setMessage(''); setPhase(progress); setMenu(null)
        try {await work()}
        catch (error) {setFailed(true); setMessage(problem(error))}
        finally {operation.current = false; setBusy(false); setPhase('')}
    }
    async function enter(robot: RobotSystem) {
        if (!client || locked) return
        if (robot.id === directory?.selected_id && (directory.active || !robot.configured)) {onNavigate('overview'); return}
        if (switchReason) return
        if (!window.dispatchEvent(new Event('agro:navigate', {cancelable: true}))) return
        await perform(async () => {
            if (!robot.configured) await client.request(`/robot-systems/${robot.id}/select-blank`, 'POST', {})
            else {
                const result = await client.request<{management_job_id: string}>(`/robot-systems/${robot.id}/activate`, 'POST', {request_id: requestId()})
                await waitJob(client, result.management_job_id, () => setPhase(`正在切换至 ${robot.name}`))
            }
            await onRefresh()
            onNavigate('overview')
        }, `正在切换至 ${robot.name}`)
    }
    async function create() {
        if (!client || !name.trim()) return
        await perform(async () => {
            const robot = await client.request<RobotSystem>('/robot-systems', 'POST', {name: name.trim(), example_id: source === 'blank' ? null : source})
            await onRefresh()
            setName(''); setQuery(''); setSection('manage'); setHighlight(robot.id)
            setMessage(`已创建 ${robot.name}，点击切换即可打开`)
            guideCompleted(`robot:created:${source}`)
        }, '正在创建机器人')
    }
    async function acceptImport(bundle: unknown) {
        if (!client || bundle === null) return
        await perform(async () => {
            if (!bundle || typeof bundle !== 'object') throw new Error('工程文件不是有效的机器人项目')
            const robot = await client.request<RobotSystem>('/robot-systems/import', 'POST', {bundle})
            await onRefresh()
            setQuery(''); setSection('manage'); setHighlight(robot.id)
            setMessage(`已导入 ${robot.name}，点击切换即可打开`)
        }, '正在导入机器人')
    }
    async function importProject() {
        if (locked) return
        if (window.agroDesktop) {
            try {await acceptImport(await window.agroDesktop.openRobotProject())}
            catch (error) {setFailed(true); setMessage(problem(error))}
        } else fileInput.current?.click()
    }
    async function browseFile(file?: File) {
        if (!file) return
        try {
            if (file.size > 6 * 1024 * 1024) throw new Error('工程文件不能超过 6 MiB')
            await acceptImport(JSON.parse(await file.text()) as unknown)
        } catch (error) {setFailed(true); setMessage('无法读取工程文件：' + problem(error))}
        finally {if (fileInput.current) fileInput.current.value = ''}
    }
    async function exportProject(robot: RobotSystem) {
        if (!client) return
        await perform(async () => {
            const bundle = await client.request<ProjectBundle>(`/robot-systems/${robot.id}/export`)
            const saved = window.agroDesktop ? await window.agroDesktop.saveRobotProject(bundle) : (downloadJson(bundle), true)
            if (saved) setMessage(`已导出 ${robot.name}`)
        }, `正在导出 ${robot.name}`)
    }
    async function rename() {
        if (!client || !target || !editName.trim()) return
        await perform(async () => {
            const robot = await client.request<RobotSystem>(`/robot-systems/${target.id}/name`, 'PUT', {name: editName.trim(), revision: target.revision})
            await onRefresh()
            setSection('manage'); setHighlight(robot.id); setQuery(''); setMessage(`已重命名为 ${robot.name}`)
        }, '正在保存名称')
    }
    async function remove() {
        if (!client || !target || editName !== target.name || switchReason) return
        if (target.id === directory?.selected_id && !window.dispatchEvent(new Event('agro:navigate', {cancelable: true}))) return
        await perform(async () => {
            if (target.id === directory?.selected_id) await client.request('/robot-systems/deselect', 'POST', {})
            await client.request(`/robot-systems/${target.id}`, 'DELETE')
            await onRefresh()
            setSection('manage'); setTarget(null); setMessage(`已删除 ${target.name}`)
        }, '正在删除机器人')
    }
    function edit(robot: RobotSystem, mode: 'rename' | 'delete') {
        changeSection(mode); setTarget(robot); setEditName(mode === 'rename' ? robot.name : '')
    }

    return <div className="robot-manager" ref={root} aria-busy={busy} onKeyDown={event => {
        if (event.key !== 'Escape') return
        if (busy || section !== 'manage') {event.preventDefault(); event.stopPropagation(); if (!busy) changeSection('manage')}
    }}>
        <header className="robot-manager-heading" data-guide="guide-selected-robot">
            <div>{section !== 'manage' && <button className="robot-manager-back" aria-label="返回机器人列表" disabled={busy} onClick={() => changeSection('manage')}><Icon name="arrow-left"/></button>}<h2>{title}</h2>{section === 'manage' && <span className="robot-manager-count">{systems.length}</span>}</div>
            {onClose && <button className="robot-manager-close" aria-label="关闭机器人管理" disabled={busy} onClick={onClose}><Icon name="x"/></button>}
        </header>
        {!client && <div className="library-connection-note"><Icon name="plug"/><span>{window.agroDesktop ? '本机服务连接失败，请重试' : '请先在设置中连接会话'}</span>{window.agroDesktop && <button onClick={() => void onReconnect()} disabled={busy}>重新连接</button>}</div>}
        {section === 'manage' ? <>
            <div className="robot-manager-toolbar">
                <div className="robot-manager-search"><Icon name="search"/><input data-initial-focus aria-label="搜索机器人" placeholder="搜索机器人" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button aria-label="清空搜索" onClick={() => setQuery('')}><Icon name="x"/></button>}</div>
                <button disabled={busy} onClick={() => changeSection('import')}><Icon name="import"/>导入</button>
                <button className="primary" disabled={locked} onClick={() => changeSection('create')}><Icon name="plus"/>新建机器人</button>
            </div>
            <ul className="robot-manager-list" aria-label="我的机器人">{filtered.map(robot => {
                const current = robot.id === directory?.selected_id
                const duplicate = systems.some(other => other.id !== robot.id && other.name === robot.name)
                return <li key={robot.id} data-robot-id={robot.id} className={`robot-manager-row${current ? ' is-current' : ''}${highlight === robot.id ? ' is-highlighted' : ''}`}>
                    <button className="robot-row-open" aria-label={current ? `打开当前机器人 ${robot.name}` : `切换至 ${robot.name}`} title={!current && switchReason ? switchReason : robot.name}
                        disabled={locked || (!current && !!switchReason)} onClick={() => void enter(robot)}>
                        <span className="robot-row-avatar"><Icon name="association"/></span>
                        <span className="robot-row-description"><strong>{robot.name}</strong><small>{robot.connection ? `Domain ${robot.connection.domain_id} · ${robot.connection.namespace}` : '尚未设置 ROS 连接'}{duplicate && <span className="robot-row-identity"> · {robot.id.slice(-6)}</span>}</small></span>
                        {current ? <span className="robot-current-badge"><span/>使用中</span> : <span className="robot-switch-label">切换<Icon name="chevron-right"/></span>}
                    </button>
                    <button className="robot-row-more" aria-label={`${robot.name}的更多操作`} aria-haspopup="menu" aria-expanded={menu?.robot.id === robot.id} disabled={locked}
                        onClick={event => setMenu(menu?.robot.id === robot.id ? null : {robot, anchor: event.currentTarget})}><Icon name="more"/></button>
                </li>
            })}{!filtered.length && <li className="robot-manager-empty"><Icon name={query ? 'search' : 'association'}/><strong>{query ? '没有找到机器人' : '还没有机器人'}</strong><p>{query ? '试试其他名称或命名空间' : '新建一个机器人，或导入已有工程'}</p>{!query && <button disabled={locked} onClick={() => changeSection('create')}>新建机器人<Icon name="plus"/></button>}</li>}</ul>
            {switchReason && systems.some(robot => robot.id !== directory?.selected_id) && <p className="robot-switch-note"><Icon name="info"/>{switchReason}</p>}
        </> : section === 'create' ? <form className="robot-manager-form" data-guide="create-robot-form" onSubmit={event => {event.preventDefault(); void create()}}>
            <fieldset disabled={locked}><label className="field robot-manager-name" data-guide="create-robot-name"><span>机器人名称</span><input data-initial-focus value={name} onChange={event => setName(event.target.value)} maxLength={60} placeholder="例如：番茄采摘机器人" required/></label>
                <span className="robot-form-label">创建方式</span><div className="robot-source-options">
                    <button type="button" data-guide="create-blank" className={source === 'blank' ? 'is-chosen' : ''} aria-pressed={source === 'blank'} onClick={() => {setSource('blank'); guideCompleted('guide:source:blank')}}><Icon name="association"/><strong>空白机器人</strong><small>连接 ROS，创建任务与流程</small><span aria-hidden="true">{source === 'blank' ? '✓' : ''}</span></button>
                    {examples.map(example => <button type="button" key={example.id} data-guide="create-tomato" className={source === example.id ? 'is-chosen' : ''} aria-pressed={source === example.id} onClick={() => {setSource('tomato_picker'); if (!name.trim()) setName(example.title); guideCompleted('guide:source:tomato_picker')}}><Icon name="templates"/><strong>从示例创建</strong><small>{example.title}</small><span aria-hidden="true">{source === example.id ? '✓' : ''}</span></button>)}
                </div><p className="robot-form-hint">同名机器人会自动添加序号，创建后可在列表中切换</p>
                <footer><button type="button" onClick={() => changeSection('manage')}>取消</button><button data-guide="create-robot-submit" className="primary" type="submit" disabled={!name.trim() || busy}>创建机器人</button></footer>
            </fieldset>
        </form> : section === 'import' ? <div className="robot-manager-form robot-import-form">
            <div className="robot-import-art"><Icon name="association"/></div><h3>导入机器人工程</h3><p>恢复机器人任务和流程，随后连接 ROS 环境</p>
            <button className="primary" disabled={locked} onClick={() => void importProject()}><Icon name="import"/>选择工程文件</button><small>.agrobot.json</small>
            <footer><button disabled={busy} onClick={() => changeSection('manage')}>返回列表</button></footer>
        </div> : target && <form className="robot-manager-form" onSubmit={event => {event.preventDefault(); if (section === 'rename') void rename(); else void remove()}}>
            <fieldset disabled={locked}><div className="robot-edit-summary"><span className="robot-row-avatar"><Icon name="association"/></span><strong>{target.name}</strong></div>
                {section === 'delete' && <p className="robot-delete-explanation">将删除此机器人的任务草稿和流程，运行记录与已发布定义保留<br/>此操作无法撤销</p>}
                <label className="field robot-manager-name"><span>{section === 'rename' ? '新名称' : '输入机器人名称以确认删除'}</span><input data-initial-focus value={editName} maxLength={60} onFocus={event => {if (section === 'rename') event.target.select()}} onChange={event => setEditName(event.target.value)} placeholder={target.name} required/></label>
                <footer><button type="button" onClick={() => changeSection('manage')}>取消</button>{section === 'rename' ? <button className="primary" type="submit" disabled={busy || !editName.trim() || editName.trim() === target.name}>保存名称</button> : <button className="danger-button" type="submit" disabled={busy || editName !== target.name || !!switchReason}>删除机器人</button>}</footer>
            </fieldset>
        </form>}
        <input ref={fileInput} type="file" accept=".json,.agrobot.json,application/json" hidden onChange={event => void browseFile(event.target.files?.[0])}/>
        {(message || phase) && <div className={`robot-manager-status${failed ? ' is-error' : ''}`} role={failed ? 'alert' : 'status'}>{busy && <span className="robot-operation-spinner"/>}<span>{phase || message}</span>{failed && <button aria-label="关闭提示" onClick={() => setMessage('')}><Icon name="x"/></button>}</div>}
        {menu && <AnchoredPopover anchor={menu.anchor} label={`${menu.robot.name}的操作`} role="menu" className="robot-row-menu" onClose={() => setMenu(null)}>
            <button role="menuitem" onClick={() => edit(menu.robot, 'rename')}><Icon name="edit"/>重命名</button>
            <button role="menuitem" tabIndex={-1} onClick={() => void exportProject(menu.robot)}><Icon name="export"/>导出工程</button>
            <div className="robot-menu-separator"/>
            <button role="menuitem" tabIndex={-1} className="robot-menu-delete" disabled={!!switchReason} title={switchReason || undefined} onClick={() => edit(menu.robot, 'delete')}><Icon name="trash"/>删除机器人</button>
            {switchReason && <small>{switchReason}</small>}
        </AnchoredPopover>}
    </div>
}
