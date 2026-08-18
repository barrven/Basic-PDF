const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  openFile:        ()                    => ipcRenderer.invoke('open-file'),
  openFileBytes:   (path)                => ipcRenderer.invoke('open-file-bytes', path),
  saveFile:        (path, buffer)        => ipcRenderer.invoke('save-file', path, buffer),
  saveFileAs:      (buffer, defaultName) => ipcRenderer.invoke('save-file-as', buffer, defaultName),
  showContextMenu: (items)               => ipcRenderer.invoke('show-context-menu', items),
  getStoreValue:   (key)                 => ipcRenderer.invoke('store-get', key),
  setStoreValue:   (key, value)          => ipcRenderer.invoke('store-set', key, value),
})
