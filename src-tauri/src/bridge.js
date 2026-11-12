// Injected by the Rust shell before any page script runs. Defines
// window.nativeAPI, the renderer's only route to native OS access, on top of
// the Tauri commands in lib.rs, and draws the window's caption buttons.
;(() => {
  if (window.nativeAPI) return

  // window.__TAURI__ is injected separately; resolve it at call time.
  const invoke = (cmd, args, options) => window.__TAURI__.core.invoke(cmd, args, options)

  const readBytes = async (path) => new Uint8Array(await invoke('read_file_bytes', { path }))
  const toBytes = (buffer) => (buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer))
  // Raw request bodies cannot carry JSON args, so the path rides in a header.
  const header = (value) => encodeURIComponent(value ?? '')

  const themeListeners = []
  let themeSubscribed = false

  window.nativeAPI = {
    openFile: async () => {
      const path = await invoke('pick_open_file')
      if (!path) return null
      return { path, buffer: await readBytes(path) }
    },
    openFileBytes: (path) => readBytes(path),
    saveFile: (path, buffer) =>
      invoke('save_file', toBytes(buffer), { headers: { 'x-path': header(path) } }),
    saveFileAs: async (buffer, defaultName) => {
      const path = await invoke('pick_save_path', { defaultName: defaultName || 'document.pdf' })
      if (!path) return null
      await invoke('save_file', toBytes(buffer), { headers: { 'x-path': header(path) } })
      return path
    },
    showContextMenu: (items) => invoke('show_context_menu', { items }),
    getStoreValue: async (key) => (await invoke('store_get', { key })) ?? undefined,
    setStoreValue: (key, value) => invoke('store_set', { key, value }),
    setDirty: (dirty) => {
      invoke('set_dirty', { dirty: !!dirty }).catch(() => {})
    },
    getAppInfo: () => invoke('get_app_info'),
    getTheme: () => invoke('get_theme'),
    setTheme: (preference) => invoke('set_theme', { preference }),
    onThemeUpdated: (callback) => {
      themeListeners.push(callback)
      if (themeSubscribed) return
      themeSubscribed = true
      window.__TAURI__.event.listen('theme-updated', (event) => {
        for (const listener of themeListeners) listener(event.payload)
      })
    },
    // Pull model: the shell holds the launch path until the renderer asks.
    onOpenPath: (callback) => {
      invoke('take_pending_open_path').then((path) => {
        if (path) callback(path)
      })
    },
  }

  // ---- Frameless window chrome -------------------------------------------
  // Tauri cannot overlay native caption buttons on an HTML title bar on
  // Windows, so the window is frameless and the buttons are built here inside
  // #window-controls-spacer, which the layout reserves.

  const CAPTION_CSS = `
    #window-controls-spacer { display: flex; align-items: stretch; margin-right: -12px; }
    .caption-btn { flex: 1; height: 100%; padding: 0; border: 0; border-radius: 0; background: transparent;
      color: var(--text-primary); display: inline-flex; align-items: center; justify-content: center; cursor: default; }
    .caption-btn:hover { background: var(--hover-strong); }
    .caption-btn.caption-close:hover { background: #C42B1C; color: #FFFFFF; }
    .caption-btn svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1; }
  `
  const ICONS = {
    minimize: 'M0 5.5h10',
    maximize: 'M0.5 0.5h9v9h-9z',
    restore: 'M2.5 2.5v-2h7v7h-2M0.5 2.5h7v7h-7z',
    close: 'M0 0l10 10M10 0l-10 10',
  }
  const SVG_NS = 'http://www.w3.org/2000/svg'

  const icon = (name) => {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 10 10')
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', ICONS[name])
    svg.appendChild(path)
    return svg
  }

  const captionButton = (name, label, onClick) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'caption-btn caption-' + name
    btn.title = label
    btn.setAttribute('aria-label', label)
    btn.tabIndex = -1
    btn.appendChild(icon(name))
    btn.addEventListener('click', onClick)
    return btn
  }

  const installWindowChrome = () => {
    const titlebar = document.getElementById('titlebar')
    const host = document.getElementById('window-controls-spacer')
    if (!titlebar || !host) return

    const style = document.createElement('style')
    style.textContent = CAPTION_CSS
    document.head.appendChild(style)

    const maxBtn = captionButton('maximize', 'Maximize', () => invoke('window_toggle_maximize').then(showMaximized))
    function showMaximized(maximized) {
      maxBtn.replaceChildren(icon(maximized ? 'restore' : 'maximize'))
      const label = maximized ? 'Restore' : 'Maximize'
      maxBtn.title = label
      maxBtn.setAttribute('aria-label', label)
    }
    host.append(
      captionButton('minimize', 'Minimize', () => invoke('window_minimize')),
      maxBtn,
      captionButton('close', 'Close', () => invoke('window_close'))
    )

    // Maximize state also changes via Win+Up, snapping, or dragging the bar.
    const syncMaximized = () => invoke('window_is_maximized').then(showMaximized).catch(() => {})
    window.addEventListener('resize', syncMaximized)
    syncMaximized()

    // Drag the window by the title bar, except from its interactive parts.
    const INTERACTIVE = 'button, input, a, #titlebar-actions, #window-controls-spacer'
    titlebar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest(INTERACTIVE)) return
      e.preventDefault()
      if (e.detail === 2) invoke('window_toggle_maximize').then(showMaximized)
      else invoke('window_start_drag')
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installWindowChrome, { once: true })
  } else {
    installWindowChrome()
  }
})()
