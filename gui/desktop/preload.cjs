const { contextBridge, ipcRenderer } = require('electron')

// 仅公开固定窗口操作，不暴露 Node、文件系统或任意 IPC 通道
contextBridge.exposeInMainWorld('agroDesktop', Object.freeze({
  minimize: () => ipcRenderer.invoke('agro:window', 'minimize'),
  maximize: () => ipcRenderer.invoke('agro:window', 'maximize'),
  close: () => ipcRenderer.invoke('agro:window', 'close')
}))
