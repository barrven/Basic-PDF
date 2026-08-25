const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } = require('electron')
const path = require('path')
const fs = require('fs')
const pkg = require('../package.json')

// Chromium on Windows tries to rotate GPU shader caches on launch. A leftover
// lock (previous instance, Explorer indexer, antivirus) logs
// "Unable to move the cache: Access is denied" and
// "Gpu Cache Creation failed: -2" even though the window still opens.
// This app does not need a persistent GPU shader cache.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
  for (const dir of ['GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']) {
    try {
      fs.rmSync(path.join(app.getPath('userData'), dir), { recursive: true, force: true })
    } catch {}
  }
}

let mainWindow = null
let pendingOpenPath = null
let store = null
let rendererDirty = false

async function getStore() {
  if (store) return store
  const Store = (await import('electron-store')).default
  store = new Store({ name: 'basic-pdf' })
  migrateLegacyStore(store)
  return store
}

function isPdfPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false
  if (filePath.startsWith('-')) return false
  return filePath.toLowerCase().endsWith('.pdf')
}

// Windows Default Apps launches the exe with the PDF as an argv entry.
// Packaged: [exe, file.pdf]  Dev: [electron, ., file.pdf]
function pdfPathFromArgv(argv, cwd = process.cwd()) {
  if (!Array.isArray(argv)) return null
  for (const arg of argv) {
    if (!isPdfPath(arg)) continue
    if (arg === process.execPath) continue
    return path.resolve(cwd, arg)
  }
  return null
}

function sendOpenPath() {
  if (!pendingOpenPath || !mainWindow || mainWindow.isDestroyed()) return
  const filePath = pendingOpenPath
  pendingOpenPath = null
  mainWindow.webContents.send('open-path', filePath)
}

function queueOpenPath(filePath) {
  if (!filePath) return
  pendingOpenPath = filePath
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.webContents.isLoadingMainFrame()) return
  sendOpenPath()
}

// macOS delivers the file via this event, which can fire before ready.
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  if (isPdfPath(filePath)) queueOpenPath(path.resolve(filePath))
})

queueOpenPath(pdfPathFromArgv(process.argv))

// One-time migration from older store filenames.
function migrateLegacyStore(newStore) {
  if (Object.keys(newStore.store).length > 0) return
  const userData = app.getPath('userData')
  for (const filename of ['basicpdf.json', 'pdf-editor.json']) {
    const legacyPath = path.join(userData, filename)
    if (!fs.existsSync(legacyPath)) continue
    try {
      const legacyData = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'))
      newStore.set(legacyData)
      return
    } catch {}
  }
}

function normalizeTheme(value) {
  return value === 'light' || value === 'dark' ? value : 'system'
}

function windowChrome() {
  if (nativeTheme.shouldUseDarkColors) {
    return {
      backgroundColor: '#111111',
      overlayColor: '#1C1C1C',
      symbolColor: '#E8E8E8',
    }
  }
  return {
    backgroundColor: '#D8D8D8',
    overlayColor: '#F4F4F4',
    symbolColor: '#1A1A1A',
  }
}

function applyWindowChrome() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const chrome = windowChrome()
  mainWindow.setBackgroundColor(chrome.backgroundColor)
  try {
    mainWindow.setTitleBarOverlay({
      color: chrome.overlayColor,
      symbolColor: chrome.symbolColor,
      height: 36,
    })
  } catch {}
}

function themePayload(preference) {
  return {
    preference: normalizeTheme(preference),
    dark: nativeTheme.shouldUseDarkColors,
  }
}

function broadcastTheme(preference) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('theme-updated', themePayload(preference))
}

async function applyStoredTheme() {
  const s = await getStore()
  nativeTheme.themeSource = normalizeTheme(s.get('theme'))
}

nativeTheme.on('updated', () => {
  applyWindowChrome()
  if (!app.isReady()) return
  getStore()
    .then((s) => broadcastTheme(s.get('theme')))
    .catch(() => broadcastTheme('system'))
})

function createWindow() {
  const chrome = windowChrome()
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: chrome.backgroundColor,
    icon: path.join(__dirname, '..', 'icon.png'),
    title: 'Basic PDF',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: chrome.overlayColor,
      symbolColor: chrome.symbolColor,
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Keep Ctrl/Cmd+wheel for the preview zoom handler; do not zoom the whole UI.
  win.webContents.setVisualZoomLevelLimits(1, 1)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  win.webContents.on('did-finish-load', () => {
    sendOpenPath()
  })
  win.on('close', (e) => {
    if (!rendererDirty) return
    const result = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Cancel', 'Close without saving'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Unsaved changes',
      message: 'You have unsaved changes. Close without saving?',
    })
    if (result !== 1) {
      e.preventDefault()
      return
    }
    rendererDirty = false
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  mainWindow = win
  rendererDirty = false
  win.loadFile(path.join(__dirname, '..', 'index.html'))
}

app.whenReady().then(async () => {
  await applyStoredTheme()
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, '..', 'icon.png'))
  }
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

ipcMain.on('set-dirty', (_event, dirty) => {
  rendererDirty = !!dirty
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

ipcMain.handle('get-app-info', () => ({
  name: pkg.productName || 'Basic PDF',
  version: app.getVersion(),
  description: 'A lightweight desktop PDF editor',
  author: pkg.author || 'barrven',
  license: pkg.license || 'MIT',
  copyright: '© 2026 barrven',
}))

ipcMain.handle('get-theme', async () => {
  const s = await getStore()
  return themePayload(s.get('theme'))
})

ipcMain.handle('set-theme', async (_event, preference) => {
  const next = normalizeTheme(preference)
  const s = await getStore()
  s.set('theme', next)
  nativeTheme.themeSource = next
  applyWindowChrome()
  return themePayload(next)
})
