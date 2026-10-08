const { contextBridge, ipcRenderer } = require('electron')

// 仅公开固定窗口操作，不暴露 Node、文件系统或任意 IPC 通道
contextBridge.exposeInMainWorld('agroDesktop', Object.freeze({
  exportTreeXml: draftId => ipcRenderer.invoke('agro:tree-xml', draftId),
  copyReport: taskId => ipcRenderer.invoke('agro:report', taskId, 'copy'),
  exportReport: taskId => ipcRenderer.invoke('agro:report', taskId, 'export'),
  connectLocal: () => ipcRenderer.invoke('agro:local-session'),
  openRobotProject: () => ipcRenderer.invoke('agro:project-open'),
  saveRobotProject: bundle => ipcRenderer.invoke('agro:project-save', bundle),
  minimize: () => ipcRenderer.invoke('agro:window', 'minimize'),
  maximize: () => ipcRenderer.invoke('agro:window', 'maximize'),
  close: () => ipcRenderer.invoke('agro:window', 'close')
}))
