const { contextBridge, ipcRenderer } = require('electron')

let queuedOpenPath = null
let openPathHandler = null

ipcRenderer.on('open-path', (_event, filePath) => {
  if (openPathHandler) {
    openPathHandler(filePath)
  } else {
    queuedOpenPath = filePath
  }
})

contextBridge.exposeInMainWorld('electronAPI', {
  openFile:        ()                    => ipcRenderer.invoke('open-file'),
  openFileBytes:   (path)                => ipcRenderer.invoke('open-file-bytes', path),
  saveFile:        (path, buffer)        => ipcRenderer.invoke('save-file', path, buffer),
  saveFileAs:      (buffer, defaultName) => ipcRenderer.invoke('save-file-as', buffer, defaultName),
  showContextMenu: (items)               => ipcRenderer.invoke('show-context-menu', items),
  getStoreValue:   (key)                 => ipcRenderer.invoke('store-get', key),
  setStoreValue:   (key, value)          => ipcRenderer.invoke('store-set', key, value),
  onOpenPath: (callback) => {
    openPathHandler = callback
    if (queuedOpenPath) {
      const filePath = queuedOpenPath
      queuedOpenPath = null
      callback(filePath)
    }
  },
})
