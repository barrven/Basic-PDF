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

const themeUpdatedListeners = []

ipcRenderer.on('theme-updated', (_event, info) => {
  for (const listener of themeUpdatedListeners) listener(info)
})

contextBridge.exposeInMainWorld('electronAPI', {
  openFile:        ()                    => ipcRenderer.invoke('open-file'),
  openFileBytes:   (path)                => ipcRenderer.invoke('open-file-bytes', path),
  saveFile:        (path, buffer)        => ipcRenderer.invoke('save-file', path, buffer),
  saveFileAs:      (buffer, defaultName) => ipcRenderer.invoke('save-file-as', buffer, defaultName),
  showContextMenu: (items)               => ipcRenderer.invoke('show-context-menu', items),
  getStoreValue:   (key)                 => ipcRenderer.invoke('store-get', key),
  setStoreValue:   (key, value)          => ipcRenderer.invoke('store-set', key, value),
  getTheme:        ()                    => ipcRenderer.invoke('get-theme'),
  setTheme:        (preference)          => ipcRenderer.invoke('set-theme', preference),
  onThemeUpdated: (callback) => {
    themeUpdatedListeners.push(callback)
  },
  onOpenPath: (callback) => {
    openPathHandler = callback
    if (queuedOpenPath) {
      const filePath = queuedOpenPath
      queuedOpenPath = null
      callback(filePath)
    }
  },
})
