import { useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../api'
import type { Workspace } from '../types'
import { ApiError } from '../api'
import { Icon } from '../components/Icon'
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

export default function RobotLibrary({ client, directory, onRefresh, onReconnect, onNavigate }: { onNavigate: (page: Workspace) => void; client: ApiClient | null; directory: RobotDirectory | null; onRefresh: () => Promise<void>; onReconnect: () => Promise<void> }) {
    const [name, setName] = useState('')
    const [source, setSource] = useState<'blank' | 'tomato_picker'>('blank')
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState('')
    const [phase, setPhase] = useState('')
    const fileInput = useRef<HTMLInputElement>(null)
    useEffect(() => { setMessage('') }, [client, directory?.selected_id])
    const selected = directory?.systems.find(item => item.id === directory.selected_id)
    const examples = directory?.examples || []
    const locked = busy || !client
    async function enter(system: RobotSystem) {
        if (!client) return
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
    return <>
        <div className="library-heading"><div><span className="eyebrow">ROBOT SYSTEMS</span><h2>机器人系统</h2><p>创建、导入或打开机器人系统</p></div>{selected && <span className="library-current">当前：{selected.name}</span>}</div>
        {!client && <div className="library-connection-note"><Icon name="plug" /><span>{window.agroDesktop ? '本机服务连接失败，请重试' : '浏览器调试需要在设置中连接会话'}</span>{window.agroDesktop && <button className="primary" onClick={() => void onReconnect()} disabled={busy}>重新连接</button>}</div>}
        {selected && !directory?.active && <div className="library-connection-note"><Icon name="system" /><span>已选择「{selected.name}」，{selected.configured ? '配置尚未应用' : '请继续搭建并应用系统配置'}；</span><button className="primary" disabled={!client} onClick={() => onNavigate('system')}>系统搭建 →</button></div>}
        <div className="library-columns library-columns-three">
            <section className="library-pane"><div className="library-pane-header"><span className="library-icon">＋</span><div><h3>新建系统</h3><p>从空白或内置示例创建</p></div></div>
                <div className="create-source-grid">
                    <button className={'create-source ' + (source === 'blank' ? 'chosen' : '')} aria-pressed={source === 'blank'} onClick={() => { setSource('blank'); setName('') }}><Icon name="system" /><strong>空白机器人</strong><small>按需求搭建后端和任务</small></button>
                    {examples.map(example => <button key={example.id} className={'create-source ' + (source === example.id ? 'chosen' : '')} aria-pressed={source === example.id} onClick={() => { setSource('tomato_picker'); setName(example.title) }}><Icon name="templates" /><strong>从示例创建</strong><small>{example.title}</small></button>)}
                </div>
                <label className="field robot-name-field"><span>机器人系统名称</span><input value={name} onChange={event => setName(event.target.value)} maxLength={60} placeholder="例如：我的农业机器人" /></label>
                <button className="primary library-action" disabled={locked || !name.trim()} onClick={() => void create()}>创建并选择 <span aria-hidden>→</span></button>

            </section>
            <section className="library-pane"><div className="library-pane-header"><span className="library-icon"><Icon name="templates" /></span><div><h3>导入系统</h3><p>从工程文件恢复配置与任务草稿</p></div></div>
                <div className="library-import-visual"><Icon name="system" /><strong>机器人系统工程</strong><small>支持 .agrobot.json</small></div>
                <button className="library-action" disabled={locked} onClick={() => void importProject()}>选择工程文件并导入 →</button>
                <input ref={fileInput} type="file" accept=".json,.agrobot.json,application/json" hidden onChange={event => void browseFile(event.target.files?.[0])} />
                <p className="muted">导入后请检查系统配置与任务，再启动设备</p>
            </section>
            <section className="library-pane"><div className="library-pane-header"><span className="library-icon"><Icon name="system" /></span><div><h3>选择已有系统</h3><p>打开或导出已保存系统</p></div></div>
                {directory?.systems.length ? <div className="robot-library-list">{directory.systems.map(system => <div key={system.id} className={'saved-robot ' + (system.id === directory.selected_id ? 'selected' : '')}><span className="robot-avatar"><Icon name="system" /></span><div className="saved-robot-main"><strong>{system.name}</strong><small>{system.example_id === 'tomato_picker' ? '来自番茄示例' : '自建或导入'} · {system.configured ? '已配置' : '待搭建'}</small></div><div className="saved-robot-actions"><button disabled={locked} onClick={() => void exportProject(system)}>导出</button><button disabled={locked || (system.id === directory.selected_id && directory.active)} onClick={() => void enter(system)}>{system.id === directory.selected_id && directory.active ? '使用中' : '选择'}</button></div></div>)}</div> : <div className="robot-library-empty"><Icon name="system" /><strong>还没有已保存系统</strong><p>可以从左侧创建空白系统，也可以导入工程文件</p></div>}
                <p className="muted">请先停止当前任务和设备，再切换系统</p>
            </section>
        </div>
        {(message || phase) && <p className={message.startsWith('导入失败') || message.startsWith('导出失败') || message.startsWith('无法') ? 'error' : 'callout'} role="status">{message || `正在切换机器人系统 · ${phase}`}</p>}
    </>
}
