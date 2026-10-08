// Electron 窗口壳，业务与认证继续由同源 Agent API 管理
const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard } = require('electron')
const path = require('node:path')
const crypto = require('node:crypto')
const fs = require('node:fs')

function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`缺少 ${name}`)
  return process.argv[index + 1]
}
let url, dataDirectory
try {
  url = new URL(option('--url'))
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.port || url.pathname !== '/ui/' || url.username || url.password || url.search || url.hash) {
    throw new Error('桌面入口必须是已核对的本机 Agent /ui/')
  }
  dataDirectory = path.resolve(option('--data-dir'), crypto.createHash('sha256').update(url.origin).digest('hex').slice(0, 16))
} catch (error) {
  console.error(error.message)
  app.exit(1)
}
if (url && dataDirectory) {
  app.setName('AgroTech Launcher')
  fs.mkdirSync(dataDirectory, { recursive: true })
  app.setPath('userData', dataDirectory)
  app.setPath('sessionData', dataDirectory)
  let win
  function allowed(value) {
    try {
      const target = new URL(value)
      return target.origin === url.origin && target.pathname.startsWith('/ui/') && !target.search && !target.hash
    } catch { return false }
  }
  function trusted(event) {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
        !allowed(event.senderFrame.url)) throw new Error('拒绝非工作台窗口请求')
  }
  if (!app.requestSingleInstanceLock()) app.quit()
  else {
    app.on('second-instance', () => {
      if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
    })
    app.whenReady().then(async () => {
      Menu.setApplicationMenu(null)
      win = new BrowserWindow({
        width: 1300, height: 900, minWidth: 640, minHeight: 480,
        frame: false, show: false, backgroundColor: '#0a0a10',
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'),
          contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
      })
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('will-navigate', (event, target) => { if (!allowed(target)) event.preventDefault() })
      win.webContents.on('will-redirect', (event, target) => { if (!allowed(target)) event.preventDefault() })
      win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      win.webContents.session.setPermissionCheckHandler(() => false)
      win.webContents.session.on('will-download', event => event.preventDefault())
      // 只允许当前 Agent，同源请求不携带桌面文件访问能力
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        try { callback({ cancel: new URL(details.url).origin !== url.origin }) }
        catch { callback({ cancel: true }) }
      })
      ipcMain.handle('agro:window', (event, action) => {
        trusted(event)
        if (action === 'minimize') win.minimize()
        else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize() }
        else if (action === 'close') win.close()
        else throw new Error('未知窗口操作')
      })
      async function localSession() {
        const file = option('--session-file')
        if (fs.statSync(file).mode & 0o077) throw new Error('本机会话权限无效')
        const secret = fs.readFileSync(file, 'utf8').trim()
        const expected = JSON.parse(option('--identity'))
        const response = await fetch(new URL('/agent/identity', url), {
          headers: { Authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(3000)
        })
        if (!response.ok) throw new Error('本机后台认证失败')
        const actual = await response.json()
        if (!secret || Object.entries(expected).some(([key,value]) => actual[key] !== value)) {
          throw new Error('本机后台身份发生变化')
        }
        return secret
      }
      ipcMain.handle('agro:local-session', event => { trusted(event); return localSession() })
      ipcMain.handle('agro:report', async (event, taskId, action) => {
        trusted(event)
        if (!/^task_[a-z0-9_]+$/.test(taskId) || !['copy', 'export'].includes(action)) throw new Error('报告请求无效')
        const secret = await localSession()
        const response = await fetch(new URL(`/tasks/${taskId}/report`, url), {
          headers: { Authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(5000)
        })
        if (!response.ok) throw new Error('报告读取失败')
        const text = JSON.stringify(await response.json(), null, 2)
        if (action === 'copy') clipboard.writeText(text)
        else {
          const result = await dialog.showSaveDialog(win, { defaultPath: taskId + '.report.json', filters: [{ name: 'JSON Report', extensions: ['json'] }] })
          if (!result.canceled && result.filePath) fs.writeFileSync(result.filePath, text, { mode: 0o600 })
        }
      })
      ipcMain.handle('agro:tree-xml', async (event, draftId) => {
        trusted(event)
        if (!/^draft_[a-z0-9_]+$/.test(draftId)) throw new Error('树导出请求无效')
        const secret = await localSession()
        const response = await fetch(new URL(`/trees/drafts/${draftId}/xml`, url), {
          headers: { Authorization: `Bearer ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(5000)
        })
        if (!response.ok) throw new Error('XML 导出校验失败')
        const document = await response.json()
        const result = await dialog.showSaveDialog(win, { defaultPath: draftId + '.xml', filters: [{ name: 'BehaviorTree XML', extensions: ['xml'] }] })
        if (!result.canceled && result.filePath) fs.writeFileSync(result.filePath, document.xml, { mode: 0o600 })
      })
      // 工程文件仅由文件对话框选择，渲染进程无任意文件系统访问能力
      ipcMain.handle('agro:project-open', async event => {
        trusted(event)
        const picked = await dialog.showOpenDialog(win, { properties: ['openFile'],
          filters: [{ name: '机器人系统工程', extensions: ['json'] }] })
        if (picked.canceled || !picked.filePaths[0]) return null
        const filepath = picked.filePaths[0]
        if (fs.statSync(filepath).size > 6 * 1024 * 1024) throw new Error('工程文件不能超过 6 MiB')
        return JSON.parse(fs.readFileSync(filepath, 'utf8'))
      })
      ipcMain.handle('agro:project-save', async (event, bundle) => {
        trusted(event)
        if (!bundle || bundle.format !== 'agrotech.robot-system' || bundle.format_version !== 1) throw new Error('工程格式无效')
        const data = JSON.stringify(bundle, null, 2)
        if (Buffer.byteLength(data) > 6 * 1024 * 1024) throw new Error('工程文件不能超过 6 MiB')
        const result = await dialog.showSaveDialog(win, { defaultPath: 'robot-system.agrobot.json',
          filters: [{ name: '机器人系统工程', extensions: ['json'] }] })
        if (result.canceled || !result.filePath) return false
        fs.writeFileSync(result.filePath, data + '\n', { mode: 0o600 })
        return true
      })
      win.webContents.on('will-prevent-unload', async event => {
        const result = await dialog.showMessageBox(win,{type:'question',buttons:['继续编辑','放弃修改并关闭'],defaultId:0,cancelId:0,message:'树草稿尚未保存'})
        if(result.response===1) { event.preventDefault(); win.destroy() }
      })
      win.once('ready-to-show' , () => win.show())
      await win.loadURL(url.href)
    }).catch(error => {
      console.error(error.message)
      dialog.showErrorBox('AgroTech Launcher', '桌面无法打开，请检查 Agent 和安装资源')
      app.exit(1)
    })
    // 窗口生命周期与机器人运行分开，退出桌面不终止 Agent
    app.on('window-all-closed', () => app.quit())
  }
}
