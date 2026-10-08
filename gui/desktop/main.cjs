// Electron 窗口壳，业务与认证继续由同源 Agent API 管理
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron')
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
      win.once('ready-to-show', () => win.show())
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
