import {createPortal} from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../api'
import type { Workspace } from '../types'
import { ApiError } from '../api'
import { Icon } from '../components/Icon'
import { guideCompleted } from '../guide/courses'
import { requestId, waitJob, type Json } from './shared'

export type RobotSystem = { id: string; name: string; example_id: string | null; content: Json; configured: boolean; revision: number }
export type RobotDirectory = { systems: RobotSystem[]; selected_id: string | null; active: boolean; running_state: string; examples: { id: string; title: string; description: string; simulation: boolean }[] }
type ProjectBundle = { format: string; format_version: number; system: { name: string };[key: string]: unknown }

function problem(error: unknown) {
    return error instanceof ApiError ? error.details?.map(item => item.reason).join('；') || error.message : error instanceof Error ? error.message : String(error)
}
function downloadJson(project: ProjectBundle) {
    const text = JSON.stringify(project, null, 2) + '\n'
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = project.system.name.replace(/[\\/:*?"<>|]/g, '_') + '.agrobot.json'
    document.body.append(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export default function RobotLibrary({ client, directory, onRefresh, onReconnect, onNavigate, onCreated }: { onNavigate: (page: Workspace) => void; client: ApiClient | null; directory: RobotDirectory | null; onRefresh: () => Promise<void>; onReconnect: () => Promise<void>; onCreated?: (robot: RobotSystem, source: 'blank' | 'tomato_picker') => void }) {
    const [name, setName] = useState('')
    const [source, setSource] = useState<'blank' | 'tomato_picker'>('blank')
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState('')
    const [phase, setPhase] = useState('')
    const [manageOpen, setManageOpen] = useState(false)
    const [deleting, setDeleting] = useState<RobotSystem | null>(null)
    const [deleteName, setDeleteName] = useState('')
    const fileInput = useRef<HTMLInputElement>(null)
    useEffect(() => { setMessage('') }, [client, directory?.selected_id])
    const selected = directory?.systems.find(item => item.id === directory.selected_id)
    const examples = directory?.examples || []
    const locked = busy || !client
    async function enter(system: RobotSystem) {
        if (!client) return
        if (system.id === directory?.selected_id && (directory?.active || !system.configured)) {
            onNavigate('system'); return
        }
        setBusy(true); setMessage(''); setPhase('')
        try {
            if (!system.configured) { await client.request(`/robot-systems/${system.id}/select-blank`, 'POST', {}) }
            else {
                const result = await client.request<{ management_job_id: string }>(`/robot-systems/${system.id}/activate`, 'POST', { request_id: requestId() })
                await waitJob(client, result.management_job_id, setPhase)
            }
            await onRefresh()
            setMessage('已选择「' + system.name + '」')
        } catch (error) { setMessage(problem(error)) }
        finally { setBusy(false); setPhase('') }
    }
    async function create() {
        if (!client || !name.trim()) return
        setBusy(true); setMessage(''); setPhase('')
        try {
            const robot = await client.request<RobotSystem>('/robot-systems', 'POST', { name: name.trim(), example_id: source === 'blank' ? null : source })
            setName('')
            await enterCreated(robot)
            onCreated?.(robot, source)
            guideCompleted(`robot:created:${source}`)
            onNavigate('system')
        } catch (error) { setMessage(problem(error)); await onRefresh().catch(() => { }) }
        finally { setBusy(false); setPhase('') }
    }
    async function enterCreated(robot: RobotSystem) {
        if (!client) return
        if (!robot.configured) await client.request(`/robot-systems/${robot.id}/select-blank`, 'POST', {})
        else {
            const result = await client.request<{ management_job_id: string }>(`/robot-systems/${robot.id}/activate`, 'POST', { request_id: requestId() })
            await waitJob(client, result.management_job_id, setPhase)
        }
        await onRefresh()
        setMessage('已创建「' + robot.name + '」')
    }
    async function acceptImport(bundle: unknown) {
        if (!client || bundle === null) return
        setBusy(true); setMessage('')
        try {
            if (!bundle || typeof bundle !== 'object') throw new Error('工程文件不是 JSON 对象')
            const robot = await client.request<RobotSystem>('/robot-systems/import', 'POST', { bundle })
            await onRefresh()
            setMessage('已导入「' + robot.name + '」，请在已有系统中选择')
        } catch (error) { setMessage('导入失败：' + problem(error)) }
        finally { setBusy(false) }
    }
    async function importProject() {
        if (locked) return
        if (window.agroDesktop) {
            try { await acceptImport(await window.agroDesktop.openRobotProject()) }
            catch (error) { setMessage('读取工程文件失败：' + problem(error)) }
        } else { fileInput.current?.click() }
    }
    async function browseFile(file?: File) {
        if (!file) return
        if (file.size > 6 * 1024 * 1024) { setMessage('工程文件不能超过 6 MiB'); return }
        try { await acceptImport(JSON.parse(await file.text()) as unknown) }
        catch (error) { setMessage('无法读取工程文件：' + problem(error)) }
        finally { if (fileInput.current) fileInput.current.value = '' }
    }
    async function exportProject(system: RobotSystem) {
        if (!client || busy) return
        setBusy(true); setMessage('')
        try {
            const bundle = await client.request<ProjectBundle>(`/robot-systems/${system.id}/export`)
            const saved = window.agroDesktop ? await window.agroDesktop.saveRobotProject(bundle) : (downloadJson(bundle), true)
            if (saved) setMessage('已导出「' + system.name + '」')
        } catch (error) { setMessage('导出失败：' + problem(error)) }
        finally { setBusy(false) }
    }
    async function removeProject() {
        if (!client || !deleting || busy || deleteName !== deleting.name) return
        setBusy(true); setMessage('')
        try {
            // After an explicit name confirmation, release the selected workspace first.
            // Server-side deselection AND deletion both require confirmed STOPPED state.
            if (deleting.id === directory?.selected_id) {
                await client.request('/robot-systems/deselect', 'POST', {})
            }
            await client.request(`/robot-systems/${deleting.id}`, 'DELETE')
            const removed = deleting.name
            setDeleting(null); setDeleteName('')
            await onRefresh()
            setMessage('已删除「' + removed + '」')
        } catch (error) { setMessage('删除失败：' + problem(error)) }
        finally { setBusy(false) }
    }
    async function closeCurrent() {
        if (!client || busy) return
        setBusy(true); setMessage('')
        try {
            await client.request('/robot-systems/deselect', 'POST', {})
            await onRefresh()
            setMessage('工作区已关闭')
        } catch (error) { setMessage('关闭失败：' + problem(error)) }
        finally { setBusy(false) }
    }
    return <>
        <div className="library-heading" data-guide="guide-selected-robot"><div><span className="eyebrow">项目</span><h2>机器人工作台</h2><p>管理当前工程与本地机器人项目</p></div>{selected && <span className="library-current">当前：{selected.name}</span>}</div>
        {!client && <div className="library-connection-note"><Icon name="plug" /><span>{window.agroDesktop ? '本机服务连接失败，请重试' : '浏览器调试需要在设置中连接会话'}</span>{window.agroDesktop && <button className="primary" onClick={() => void onReconnect()} disabled={busy}>重新连接</button>}</div>}
        {selected && <div className="project-continue"><div><span className="eyebrow">CURRENT WORKSPACE</span><h3>{selected.name}</h3><p>{directory?.active ? '配置已应用' : '配置未应用'}</p></div><div className="project-continue-actions"><button className="primary" onClick={()=>onNavigate('system')}>系统接入 →</button><button onClick={()=>onNavigate('editor')}>设计任务 →</button>{directory?.active&&<button onClick={()=>onNavigate('runtime')}>运行调试 →</button>}<button disabled={locked || directory?.running_state !== 'STOPPED'} title="仅在系统与所有操作确认停止后关闭" onClick={()=>void closeCurrent()}>关闭工作区</button></div></div>}
        {selected && !directory?.active && <div className="library-connection-note"><Icon name="system" /><span>「{selected.name}」{selected.configured ? '配置未激活' : '待配置'}</span><button className="primary" disabled={!client} onClick={() => onNavigate('system')}>系统搭建 →</button></div>}
        <div className="studio-project-tools"><h3>项目管理</h3><p>新建、导入及切换机器人项目</p>{selected&&<button onClick={()=>setManageOpen(value=>!value)}>{manageOpen?'收起项目管理':'新建、导入或切换机器人 →'}</button>}</div>
        {(!selected||manageOpen)&&<div className="library-columns library-columns-three">
            <section className="library-pane"><div className="library-pane-header"><span className="library-icon"><Icon name="boxes" /></span><div><h3>新建系统</h3><p>创建空白工程或使用示例</p></div></div>
                <div className="create-source-grid">
                    <button data-guide="create-blank" className={'create-source ' + (source === 'blank' ? 'chosen' : '')} aria-pressed={source === 'blank'} onClick={() => { setSource('blank'); setName('');guideCompleted('guide:source:blank') }}><Icon name="system" /><strong>空白机器人</strong><small>空白配置与任务</small></button>
                    {examples.map(example => <button key={example.id} data-guide="create-tomato" className={'create-source ' + (source === example.id ? 'chosen' : '')} aria-pressed={source === example.id} onClick={() => { setSource('tomato_picker'); setName(example.title);guideCompleted('guide:source:tomato_picker') }}><Icon name="templates" /><strong>从示例创建</strong><small>{example.title}</small></button>)}
                </div>
                <div data-guide="create-robot-form"><label data-guide="create-robot-name" className="field robot-name-field"><span>机器人系统名称</span><input value={name} onChange={event => setName(event.target.value)} maxLength={60} placeholder="例如：我的农业机器人" /></label>
                <button data-guide="create-robot-submit" className="primary library-action" disabled={locked || !name.trim()} onClick={() => void create()}>创建并选择 <span aria-hidden>→</span></button></div>

            </section>
            <section className="library-pane"><div className="library-pane-header"><span className="library-icon"><Icon name="templates" /></span><div><h3>导入系统</h3><p>从工程文件恢复配置与任务草稿</p></div></div>
                <div className="library-import-visual"><Icon name="system" /><strong>工程文件</strong><small>.agrobot.json</small></div>
                <button className="library-action" disabled={locked} onClick={() => void importProject()}>选择工程文件并导入 →</button>
                <input ref={fileInput} type="file" accept=".json,.agrobot.json,application/json" hidden onChange={event => void browseFile(event.target.files?.[0])} />
                <p className="muted">导入工程需重新核验配置与运行条件</p>
            </section>
            <section className="library-pane"><div className="library-pane-header"><span className="library-icon"><Icon name="system" /></span><div><h3>已有工程</h3><p>打开、导出与删除</p></div></div>
                {directory?.systems.length ? <div className="robot-library-list">{directory.systems.map(system => <div key={system.id} className={'saved-robot ' + (system.id === directory.selected_id ? 'selected' : '')}><span className="robot-avatar"><Icon name="system" /></span><div className="saved-robot-main"><strong>{system.name}</strong><small>{system.example_id === 'tomato_picker' ? '来自番茄示例' : '自建或导入'} · {system.configured ? '已配置' : '待搭建'}</small></div><div className="saved-robot-actions"><button disabled={locked} onClick={() => void enter(system)}>{system.id === directory.selected_id ? '继续' : '选择'}</button><button disabled={locked} onClick={() => void exportProject(system)}>导出</button><button className="danger-quiet" title={directory.running_state !== 'STOPPED' ? '请先停止机器人系统及任务' : '删除前需输入机器人名称确认'} disabled={locked || directory.running_state !== 'STOPPED'} onClick={() => { setMessage(''); setDeleting(system); setDeleteName('') }}>删除</button></div></div>)}</div> : <div className="robot-library-empty"><Icon name="system" /><strong>还没有已保存系统</strong><p>创建工程或导入现有配置</p></div>}
                <p className="muted">切换项目需要系统处于安全停止状态</p>
            </section>
        </div>}
        {(message || phase) && <p className={message.startsWith('导入失败') || message.startsWith('导出失败') || message.startsWith('删除失败') || message.startsWith('无法') ? 'error' : 'callout'} role="status">{message || `正在切换机器人系统 · ${phase}`}</p>}
        {deleting && createPortal(<div className="robot-delete-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) { setDeleting(null); setDeleteName('') } }}>
            <section role="alertdialog" aria-modal="true" aria-labelledby="robot-delete-title" className="robot-delete-dialog">
                <h3 id="robot-delete-title">删除机器人系统</h3>
                <p>将删除「{deleting.name}」及其未发布的任务草稿和任务方案</p>
                <p>删除后无法恢复，运行记录与已发布定义将保留</p>
                <label className="field"><span>输入系统名称以确认删除</span><input autoFocus value={deleteName} onChange={event => setDeleteName(event.target.value)} placeholder={deleting.name} disabled={busy} /></label>
                {message.startsWith('删除失败') && <p className="error" role="alert">{message}</p>}
                <div className="robot-delete-actions"><button disabled={busy} onClick={() => { setDeleting(null); setDeleteName(''); setMessage('') }}>取消</button><button className="danger-button" disabled={busy || deleteName !== deleting.name} onClick={() => void removeProject()}>{busy ? '删除中…' : '确认删除'}</button></div>
            </section>
        </div>, document.body)}
    </>
}
