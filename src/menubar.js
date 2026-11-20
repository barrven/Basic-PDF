import { appState, dispatch } from './state.js'
import { openFile, save, saveAs, closeFile, printDocument } from './pdf-engine.js'
import { insertPdfFile, deleteSelectedPages, rotateSelected } from './toolbar.js'
import { showSignatureModal } from './signature.js'
import { openFindBar } from './search.js'
import { openAboutModal } from './about.js'
import { closeThemePopover } from './theme.js'
import { showToast, showErrorModal } from './main.js'

// Each item: { id, label, shortcut?, run, enabled(ctx) } or { sep: true }.
const MENUS = [
  {
    id: 'file',
    label: 'File',
    items: [
      { id: 'open', label: 'Open…', shortcut: 'Ctrl+O', run: () => openFile(), enabled: (c) => !c.busy },
      { sep: true },
      { id: 'save', label: 'Save', shortcut: 'Ctrl+S', run: () => save(), enabled: (c) => c.fileOpen && !c.busy },
      { id: 'save-as', label: 'Save As…', shortcut: 'Ctrl+Shift+S', run: () => saveAs(), enabled: (c) => c.fileOpen && !c.busy },
      { id: 'print', label: 'Print…', shortcut: 'Ctrl+P', run: () => printDocument(), enabled: (c) => c.fileOpen && !c.busy },
      { sep: true },
      { id: 'insert-pdf', label: 'Insert PDF…', run: () => insertPdfFile(), enabled: (c) => c.fileOpen && !c.busy },
      { sep: true },
      {
        id: 'open-parent-folder', label: 'Open Parent Folder',
        run: async () => {
          try {
            await window.nativeAPI.revealInFolder(appState.filePath)
          } catch (err) {
            console.error(err)
            showErrorModal('Could not open the folder. The file may have been moved or deleted.')
          }
        },
        enabled: (c) => c.fileOpen && !c.busy,
      },
      {
        id: 'copy-file-path', label: 'Copy File Path',
        run: async () => {
          try {
            await navigator.clipboard.writeText(appState.filePath)
            showToast('File path copied')
          } catch (err) {
            console.error(err)
            showErrorModal('Could not copy the file path to the clipboard.')
          }
        },
        enabled: (c) => c.fileOpen && !c.busy,
      },
      { sep: true },
      { id: 'close-file', label: 'Close File', run: () => closeFile(), enabled: (c) => c.fileOpen && !c.busy },
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      {
        id: 'undo', label: 'Undo', shortcut: 'Ctrl+Z',
        run: () => dispatch({ type: 'UNDO' }),
        enabled: (c) => c.fileOpen && !c.busy && appState.history.past.length > 0,
      },
      {
        id: 'redo', label: 'Redo', shortcut: 'Ctrl+Y',
        run: () => dispatch({ type: 'REDO' }),
        enabled: (c) => c.fileOpen && !c.busy && appState.history.future.length > 0,
      },
      { sep: true },
      { id: 'find', label: 'Find…', shortcut: 'Ctrl+F', run: () => openFindBar(), enabled: (c) => c.fileOpen && !c.busy },
      { sep: true },
      { id: 'rotate-left', label: 'Rotate Page Left', shortcut: '[', run: () => rotateSelected(-90), enabled: (c) => c.fileOpen && !c.busy },
      { id: 'rotate-right', label: 'Rotate Page Right', shortcut: ']', run: () => rotateSelected(90), enabled: (c) => c.fileOpen && !c.busy },
      {
        id: 'delete-pages', label: 'Delete Page', shortcut: 'Del',
        run: () => deleteSelectedPages(),
        enabled: (c) => c.fileOpen && !c.busy && appState.pages.length > 1,
      },
      { sep: true },
      { id: 'add-signature', label: 'Add Signature…', run: () => showSignatureModal(), enabled: (c) => !c.busy },
    ],
  },
  {
    id: 'help',
    label: 'Help',
    items: [
      { id: 'about', label: 'About Basic PDF', run: () => openAboutModal(), enabled: () => true },
    ],
  },
]

let openId = null

function ctx() {
  return { fileOpen: appState.filePath !== null, busy: appState.loading }
}

export function initMenubar() {
  const bar = document.getElementById('menubar')
  if (!bar) return
  bar.innerHTML = ''
  for (const menu of MENUS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'menubar-btn'
    btn.dataset.menu = menu.id
    btn.setAttribute('role', 'menuitem')
    btn.setAttribute('aria-haspopup', 'menu')
    btn.setAttribute('aria-expanded', 'false')
    btn.textContent = menu.label
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (openId === menu.id) closeMenu()
      else openMenu(menu.id)
    })
    // Once one menu is open, hovering another header switches to it.
    btn.addEventListener('mouseenter', () => {
      if (openId && openId !== menu.id) openMenu(menu.id)
    })
    bar.appendChild(btn)
  }

  const pop = document.getElementById('menu-popover')
  if (pop) {
    pop.addEventListener('click', (e) => {
      const el = e.target.closest('[data-item]')
      if (!el || el.disabled) return
      const menu = MENUS.find((m) => m.id === openId)
      const item = menu?.items.find((i) => i.id === el.dataset.item)
      closeMenu()
      if (item) Promise.resolve(item.run()).catch((err) => console.error(err))
    })
  }
}

function renderPopover(menu) {
  const pop = document.getElementById('menu-popover')
  pop.innerHTML = ''
  pop.setAttribute('role', 'menu')
  pop.setAttribute('aria-label', menu.label)
  const c = ctx()
  for (const item of menu.items) {
    if (item.sep) {
      const sep = document.createElement('div')
      sep.className = 'menu-sep'
      sep.setAttribute('role', 'separator')
      pop.appendChild(sep)
      continue
    }
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'menu-item'
    el.dataset.item = item.id
    el.setAttribute('role', 'menuitem')
    el.disabled = !item.enabled(c)
    const label = document.createElement('span')
    label.className = 'menu-item-label'
    label.textContent = item.label
    el.appendChild(label)
    if (item.shortcut) {
      const sc = document.createElement('span')
      sc.className = 'menu-item-shortcut'
      sc.textContent = item.shortcut
      el.appendChild(sc)
    }
    pop.appendChild(el)
  }
}

function openMenu(id) {
  const menu = MENUS.find((m) => m.id === id)
  const btn = document.querySelector(`#menubar [data-menu="${id}"]`)
  const pop = document.getElementById('menu-popover')
  if (!menu || !btn || !pop) return
  closeThemePopover()
  renderPopover(menu)
  const rect = btn.getBoundingClientRect()
  pop.hidden = false
  pop.style.top = rect.bottom + 2 + 'px'
  pop.style.left = Math.max(4, rect.left) + 'px'
  const first = openId === null
  openId = id
  syncButtons()
  if (first) {
    setTimeout(() => document.addEventListener('mousedown', onDocMouseDown), 0)
  }
}

export function closeMenu() {
  const pop = document.getElementById('menu-popover')
  if (pop) pop.hidden = true
  if (openId !== null) document.removeEventListener('mousedown', onDocMouseDown)
  openId = null
  syncButtons()
}

export function isMenuOpen() {
  return openId !== null
}

function syncButtons() {
  for (const btn of document.querySelectorAll('#menubar .menubar-btn')) {
    btn.setAttribute('aria-expanded', btn.dataset.menu === openId ? 'true' : 'false')
  }
}

function onDocMouseDown(e) {
  if (e.target.closest('#menu-popover') || e.target.closest('#menubar')) return
  closeMenu()
}

// Keep an open menu's enabled states current (e.g. after a load finishes).
export function updateMenubar() {
  if (openId === null) return
  const menu = MENUS.find((m) => m.id === openId)
  if (menu) renderPopover(menu)
}
