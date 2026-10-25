import {requestNavigation, reportError} from '../components/StudioDialogs'
import {AnimatePresence, motion} from 'motion/react'
import {springs, fade} from '../motion'
import {useLocale} from '../locale'
import {useEffect, useRef, useState} from 'react'
import type {ApiClient} from '../api'
import type {Workspace} from '../types'
import {ApiError} from '../api'
import {Icon} from '../components/Icon'
import {AnchoredPopover} from '../components/AnchoredPopover'
import {requestId, waitJob, type Json} from './shared'
import './robot-manager.css'

export type RobotSystem = {
    id: string; name: string; storage_path?: string; example_id: string | null; content: Json; configured: boolean; revision: number
    connection?: {domain_id: number; namespace: string} | null
}
export type RobotDirectory = {
    systems: RobotSystem[]; selected_id: string | null; active: boolean; running_state: string; switch_blocked_reason?: string | null
}
type Section = 'create' | 'manage' | 'import'
type ProjectBundle = {format: string; format_version: number; system: {name: string}; [key: string]: unknown}
type Props = {
    initialSection?: Section; onNavigate: (page: Workspace) => void; client: ApiClient | null; directory: RobotDirectory | null
    onRefresh: () => Promise<void>; onReconnect: () => Promise<void>; onClose?: () => void; onBusyChange?: (busy: boolean) => void
}

function problem(error: unknown, translate:(text:string)=>string=text=>text) {
    return error instanceof ApiError ? error.details?.map(item => translate(item.reason)).join('；') || '连接暂时不可用，请重试' : error instanceof Error ? error.message : String(error)
}
function downloadJson(project: ProjectBundle) {
    const blob = new Blob([JSON.stringify(project, null, 2) + '\n'], {type: 'application/json'})
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = project.system.name.replace(/[\\/:*?"<>|]/g, '_') + '.agrobot.json'
    document.body.append(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
}

export default function RobotLibrary({client, directory, onRefresh, onReconnect, onNavigate, onClose, onBusyChange, initialSection = 'manage'}: Props) {
 const {t}=useLocale()

    const [section, setSection] = useState<Section | 'rename' | 'delete'>(initialSection)
    const [name, setName] = useState(''), [storagePath,setStoragePath] = useState(''), [openPath,setOpenPath] = useState('')
    const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failed, setFailed] = useState(false)
    const [phase, setPhase] = useState(''), [query, setQuery] = useState('')
    const [target, setTarget] = useState<RobotSystem | null>(null), [editName, setEditName] = useState('')
    const [menu, setMenu] = useState<{robot: RobotSystem; anchor: HTMLButtonElement} | null>(null)
    const [highlight, setHighlight] = useState('')
    const root = useRef<HTMLDivElement>(null), fileInput = useRef<HTMLInputElement>(null), operation = useRef(false)
    const systems = directory?.systems || []
    const locked = busy || !client
    const switchReason = directory?.switch_blocked_reason || (directory && directory.running_state !== 'STOPPED' ? t("机器人正在运行，停止后可以切换") : '')
    const filtered = systems.filter(robot => `${robot.name} ${robot.connection?.namespace || ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    const title = {manage: t("机器人管理"), create: t("新建机器人"), import: t("导入机器人"), rename: t("重命名机器人"), delete: t("删除机器人")}[section]

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
        catch (error) {reportError(error);setFailed(true); setMessage(problem(error,t))}
        finally {operation.current = false; setBusy(false); setPhase('')}
    }
    async function enter(robot: RobotSystem) {
        if (!client || locked) return
        if (robot.id === directory?.selected_id && (directory.active || !robot.configured)) {onNavigate('overview'); return}
        if (switchReason) return
        if (!await requestNavigation()) return
        await perform(async () => {
            if (!robot.configured) await client.request(`/robot-systems/${robot.id}/select-blank`, 'POST', {})
            else {
                const result = await client.request<{management_job_id: string}>(`/robot-systems/${robot.id}/activate`, 'POST', {request_id: requestId()})
                await waitJob(client, result.management_job_id, () => setPhase(t("正在切换至 {0}", {0: robot.name})))
            }
            await onRefresh()
            onNavigate('overview')
        }, t("正在切换至 {0}", {0: robot.name}))
    }
    async function create() {
        if (!client || !name.trim() || !storagePath.trim()) return
        await perform(async () => {
            const robot = await client.request<RobotSystem>('/robot-systems', 'POST', {name: name.trim(), storage_path:storagePath.trim()})
            await onRefresh()
            setName(''); setQuery(''); setSection('manage'); setHighlight(robot.id)
            setMessage(t("已创建 {0}，点击切换即可打开", {0: robot.name}))
        }, t("正在创建机器人"))
    }
    async function openDirectory(){
        if(!client||!openPath.trim())return
        await perform(async()=>{const robot=await client.request<RobotSystem>('/robot-profiles/open','POST',{path:openPath.trim()});if(!robot.configured)await client.request(`/robot-systems/${robot.id}/select-blank`,'POST',{});else{const job=await client.request<{management_job_id:string}>(`/robot-systems/${robot.id}/activate`,'POST',{request_id:requestId()});await waitJob(client,job.management_job_id,()=>{})}await onRefresh();setSection('manage');setHighlight(robot.id);onNavigate('overview')},t('正在打开工程'))
    }
    async function acceptImport(bundle: unknown) {
        if (!client || bundle === null) return
        await perform(async () => {
            if (!bundle || typeof bundle !== 'object') throw new Error(t("工程文件不是有效的机器人项目"))
            const robot = await client.request<RobotSystem>('/robot-systems/import', 'POST', {bundle})
            await onRefresh()
            setQuery(''); setSection('manage'); setHighlight(robot.id)
            setMessage(t("已导入 {0}，点击切换即可打开", {0: robot.name}))
        }, t("正在导入机器人"))
    }
    async function importProject() {
        if (locked) return
        if (window.agroDesktop) {
            try {await acceptImport(await window.agroDesktop.openRobotProject())}
            catch (error) {reportError(error);setFailed(true); setMessage(problem(error,t))}
        } else fileInput.current?.click()
    }
    async function browseFile(file?: File) {
        if (!file) return
        try {
            if (file.size > 6 * 1024 * 1024) throw new Error(t("工程文件不能超过 6 MiB"))
            await acceptImport(JSON.parse(await file.text()) as unknown)
        } catch (error) {reportError(error);setFailed(true); setMessage(t("无法读取工程文件：") + problem(error,t))}
        finally {if (fileInput.current) fileInput.current.value = ''}
    }
    async function exportProject(robot: RobotSystem) {
        if (!client) return
        await perform(async () => {
            const bundle = await client.request<ProjectBundle>(`/robot-systems/${robot.id}/export`)
            const saved = window.agroDesktop ? await window.agroDesktop.saveRobotProject(bundle) : (downloadJson(bundle), true)
            if (saved) setMessage(t("已导出 {0}", {0: robot.name}))
        }, t("正在导出 {0}", {0: robot.name}))
    }
    async function rename() {
        if (!client || !target || !editName.trim()) return
        await perform(async () => {
            const robot = await client.request<RobotSystem>(`/robot-systems/${target.id}/name`, 'PUT', {name: editName.trim(), revision: target.revision})
            await onRefresh()
            setSection('manage'); setHighlight(robot.id); setQuery(''); setMessage(t("已重命名为 {0}", {0: robot.name}))
        }, t("正在保存名称"))
    }
    async function remove() {
        if (!client || !target || editName !== target.name || switchReason) return
        if (target.id === directory?.selected_id && !await requestNavigation()) return
        await perform(async () => {
            if (target.id === directory?.selected_id) await client.request('/robot-systems/deselect', 'POST', {})
            await client.request(`/robot-systems/${target.id}`, 'DELETE')
            await onRefresh()
            setSection('manage'); setTarget(null); setMessage(t("已删除 {0}", {0: target.name}))
        }, t("正在删除机器人"))
    }
    function edit(robot: RobotSystem, mode: 'rename' | 'delete') {
        changeSection(mode); setTarget(robot); setEditName(mode === 'rename' ? robot.name : '')
    }

    return <div className="robot-manager" ref={root} aria-busy={busy} onKeyDown={event => {
        if (event.key !== 'Escape') return
        if (busy || section !== 'manage') {event.preventDefault(); event.stopPropagation(); if (!busy) changeSection('manage')}
    }}>
        <header className="robot-manager-heading">
            <div>{section !== 'manage' && <button className="robot-manager-back" aria-label={t("返回机器人列表")} disabled={busy} onClick={() => changeSection('manage')}><Icon name="arrow-left"/></button>}<h2>{title}</h2>{section === 'manage' && <span className="robot-manager-count">{systems.length}</span>}</div>
            {onClose && <button className="robot-manager-close" aria-label={t("关闭机器人管理")} disabled={busy} onClick={onClose}><Icon name="x"/></button>}
        </header>
        {!client && <div className="library-connection-note"><Icon name="plug"/><span>{window.agroDesktop ? t("本机服务连接失败，请重试") : t("请先在设置中连接会话")}</span>{window.agroDesktop && <button onClick={() => void onReconnect()} disabled={busy}>{t("重新连接")}</button>}</div>}
        <motion.div key={section} className="robot-manager-body" initial={{opacity:0,x:section==='manage'?-8:8}} animate={{opacity:1,x:0}} transition={springs.panel}>
        {section === 'manage' ? <>
            <div className="robot-manager-toolbar">
                <div className="robot-manager-search"><Icon name="search"/><input data-initial-focus aria-label={t("搜索机器人")} placeholder={t("搜索机器人")} value={query} onChange={event => setQuery(event.target.value)}/>{query && <button aria-label={t("清空搜索")} onClick={() => setQuery('')}><Icon name="x"/></button>}</div>
                <button disabled={busy} onClick={() => changeSection('import')}><Icon name="import"/>{t("打开工程")}</button>
                <button className="primary" disabled={locked} onClick={() => changeSection('create')}><Icon name="plus"/>{t("新建机器人")}</button>
            </div>
            <ul className="robot-manager-list" aria-label={t("我的机器人")}>{filtered.map(robot => {
                const current = robot.id === directory?.selected_id
                const duplicate = systems.some(other => other.id !== robot.id && other.name === robot.name)
                return <motion.li layout="position" initial={{opacity:0,y:4}} animate={{opacity:1,y:0}} transition={springs.spatial} key={robot.id} data-robot-id={robot.id} className={`robot-manager-row${current ? ' is-current' : ''}${highlight === robot.id ? ' is-highlighted' : ''}`}>
                    <button className="robot-row-open" aria-label={current ? t("打开当前机器人 {0}", {0: robot.name}) : t("切换至 {0}", {0: robot.name})} title={!current && switchReason ? t(switchReason) : robot.name}
                        disabled={locked || (!current && !!switchReason)} onClick={() => void enter(robot)}>
                        <span className="robot-row-avatar"><Icon name="association"/></span>
                        <span className="robot-row-description"><strong>{robot.name}</strong><small>{robot.connection ? `Domain ${robot.connection.domain_id} · ${robot.connection.namespace}` : t("尚未设置 ROS 连接")}{robot.storage_path && <span className="robot-row-identity"> · {robot.storage_path}</span>}{duplicate && <span className="robot-row-identity"> · {robot.id.slice(-6)}</span>}</small></span>
                        {current ? <span className="robot-current-badge"><span/>{t("使用中")}</span> : <span className="robot-switch-label">{t("切换")}<Icon name="chevron-right"/></span>}
                    </button>
                    <button className="robot-row-more" aria-label={t("{0}的更多操作", {0: robot.name})} aria-haspopup="menu" aria-expanded={menu?.robot.id === robot.id} disabled={locked}
                        onClick={event => setMenu(menu?.robot.id === robot.id ? null : {robot, anchor: event.currentTarget})}><Icon name="more"/></button>
                </motion.li>
            })}{!filtered.length && <li className="robot-manager-empty"><Icon name={query ? 'search' : 'association'}/><strong>{query ? t("没有找到机器人") : t("还没有机器人")}</strong><p>{query ? t("试试其他名称或命名空间") : t("新建一个机器人，或导入已有工程")}</p>{!query && <button disabled={locked} onClick={() => changeSection('create')}>{t("新建机器人")}<Icon name="plus"/></button>}</li>}</ul>
            {switchReason && systems.some(robot => robot.id !== directory?.selected_id) && <p className="robot-switch-note"><Icon name="info"/>{t(switchReason)}</p>}
        </> : section === 'create' ? <form className="robot-manager-form" onSubmit={event => {event.preventDefault(); void create()}}>
            <fieldset disabled={locked}><label className="field robot-manager-name"><span>{t("机器人名称")}</span><input data-initial-focus value={name} onChange={event => setName(event.target.value)} maxLength={60} placeholder={t("机器人名称")} required/></label>
                <label className="field"><span>{t("机器人存储位置")}</span><input required value={storagePath} onChange={e=>setStoragePath(e.target.value)} placeholder="/path/to/Bringup/src/robot-profile"/>{window.agroDesktop&&<button type="button" onClick={async()=>{const path=await window.agroDesktop!.chooseInterfaceFolder();if(path)setStoragePath(path)}}>{t("选择文件夹")}</button>}</label><p className="robot-form-hint">{t("任务、流程和标定资产保存在此目录，新建工程请选择空目录")}</p>
                <footer><button type="button" onClick={() => changeSection('manage')}>{t("取消")}</button><button className="primary" type="submit" disabled={!name.trim() || !storagePath.trim() || busy}>{t("创建机器人")}</button></footer>
            </fieldset>
        </form> : section === 'import' ? <div className="robot-manager-form robot-import-form">
            <div className="robot-import-art"><Icon name="association"/></div><h3>{t("打开机器人工程")}</h3><p>{t("选择包含 robot.json 的目录，打开工程不会启动设备")}</p><label className="field"><span>{t("工程目录")}</span><input value={openPath} onChange={e=>setOpenPath(e.target.value)}/></label>{window.agroDesktop&&<button onClick={async()=>{const path=await window.agroDesktop!.chooseInterfaceFolder();if(path)setOpenPath(path)}}>{t("选择文件夹")}</button>}<button className="primary" disabled={locked||!openPath.trim()} onClick={()=>void openDirectory()}>{t("打开工程")}</button>
            <details><summary>{t("导入旧工程文件")}</summary><button disabled={locked} onClick={() => void importProject()}><Icon name="import"/>{t("选择工程文件")}</button><small>.agrobot.json</small></details>
            <footer><button disabled={busy} onClick={() => changeSection('manage')}>{t("返回列表")}</button></footer>
        </div> : target && <form className="robot-manager-form" onSubmit={event => {event.preventDefault(); if (section === 'rename') void rename(); else void remove()}}>
            <fieldset disabled={locked}><div className="robot-edit-summary"><span className="robot-row-avatar"><Icon name="association"/></span><strong>{target.name}</strong></div>
                {section === 'delete' && <p className="robot-delete-explanation">{t("从最近工程中移除此机器人，存储目录中的任务和流程仍保留")}<br/>{t("需要时可重新打开工程目录")}</p>}
                <label className="field robot-manager-name"><span>{section === 'rename' ? t("新名称") : t("输入机器人名称以确认删除")}</span><input data-initial-focus value={editName} maxLength={60} onFocus={event => {if (section === 'rename') event.target.select()}} onChange={event => setEditName(event.target.value)} placeholder={target.name} required/></label>
                <footer><button type="button" onClick={() => changeSection('manage')}>{t("取消")}</button>{section === 'rename' ? <button className="primary" type="submit" disabled={busy || !editName.trim() || editName.trim() === target.name}>{t("保存名称")}</button> : <button className="danger-button" type="submit" disabled={busy || editName !== target.name || !!switchReason}>{t("删除机器人")}</button>}</footer>
            </fieldset>
        </form>}
        </motion.div>
        <input ref={fileInput} type="file" accept=".json,.agrobot.json,application/json" hidden onChange={event => void browseFile(event.target.files?.[0])}/>
        {(message || phase) && <div className={`robot-manager-status${failed ? ' is-error' : ''}`} role={failed ? 'alert' : 'status'}>{busy && <span className="robot-operation-spinner"/>}<span>{t(phase || message)}</span>{failed && <button aria-label={t("关闭提示")} onClick={() => setMessage('')}><Icon name="x"/></button>}</div>}
        <AnimatePresence>{menu && <AnchoredPopover anchor={menu.anchor} label={t("{0}的操作", {0: menu.robot.name})} role="menu" className="robot-row-menu" onClose={() => setMenu(null)}>
            <button role="menuitem" onClick={() => edit(menu.robot, 'rename')}><Icon name="edit"/>{t("重命名")}</button>
            <button role="menuitem" tabIndex={-1} onClick={() => void exportProject(menu.robot)}><Icon name="export"/>{t("导出工程")}</button>
            <div className="robot-menu-separator"/>
            <button role="menuitem" tabIndex={-1} className="robot-menu-delete" disabled={!!switchReason} title={switchReason ? t(switchReason) : undefined} onClick={() => edit(menu.robot, 'delete')}><Icon name="trash"/>{t("删除机器人")}</button>
            {switchReason && <small>{t(switchReason)}</small>}
        </AnchoredPopover>}</AnimatePresence>
    </div>
}
