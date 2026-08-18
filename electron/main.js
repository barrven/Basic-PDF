const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron')
const path = require('path')
const fs = require('fs')

let store = null
async function getStore() {
  if (store) return store
  const Store = (await import('electron-store')).default
  store = new Store({ name: 'pdf-editor' })
  return store
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#111111',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1C1C1C',
      symbolColor: '#E8E8E8',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.loadFile(path.join(__dirname, '..', 'index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('open-file', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win, {
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  const buffer = await fs.promises.readFile(filePath)
  return { path: filePath, buffer: new Uint8Array(buffer) }
})

ipcMain.handle('open-file-bytes', async (_event, filePath) => {
  const buffer = await fs.promises.readFile(filePath)
  return new Uint8Array(buffer)
})

ipcMain.handle('save-file', async (_event, filePath, buffer) => {
  await fs.promises.writeFile(filePath, Buffer.from(buffer))
  return true
})

ipcMain.handle('save-file-as', async (event, buffer, defaultName) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultName || 'document.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (result.canceled || !result.filePath) return null
  await fs.promises.writeFile(result.filePath, Buffer.from(buffer))
  return result.filePath
})

ipcMain.handle('show-context-menu', async (event, items) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  return await new Promise((resolve) => {
    let resolved = false
    const template = items.map((label) => ({
      label,
      click: () => {
        if (resolved) return
        resolved = true
        resolve(label)
      },
    }))
    const menu = Menu.buildFromTemplate(template)
    menu.popup({
      window: win,
      callback: () => {
        if (resolved) return
        resolved = true
        resolve(null)
      },
    })
  })
})

ipcMain.handle('store-get', async (_event, key) => {
  const s = await getStore()
  return s.get(key)
})

ipcMain.handle('store-set', async (_event, key, value) => {
  const s = await getStore()
  s.set(key, value)
  return true
})
