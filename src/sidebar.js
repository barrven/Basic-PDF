import { appState, dispatch } from './state.js'
import { getPage, drawBlankPlaceholder } from './renderer.js'

const SIDEBAR_MIN = 160
const SIDEBAR_MAX = 360
const SIDEBAR_DEFAULT = 220

let dragSourceIndex = null
let rightClickIndex = null

export function initSidebar() {
  const sidebar = document.getElementById('sidebar')
  const handle = document.getElementById('resize-handle')

  // Restore width.
  const saved = parseInt(localStorage.getItem('sidebarWidth') || '', 10)
  const width = Number.isFinite(saved) ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, saved)) : SIDEBAR_DEFAULT
  sidebar.style.width = width + 'px'

  initResize(handle, sidebar)

  const list = document.getElementById('thumbnail-list')
  list.addEventListener('click', onThumbClick)
  list.addEventListener('dragstart', onDragStart)
  list.addEventListener('dragover', onDragOver)
  list.addEventListener('dragleave', onDragLeave)
  list.addEventListener('drop', onDrop)
  list.addEventListener('dragend', onDragEnd)
  list.addEventListener('contextmenu', onContextMenu)
}

function initResize(handle, sidebar) {
  let dragging = false
  handle.addEventListener('pointerdown', (e) => {
    dragging = true
    handle.classList.add('dragging')
    handle.setPointerCapture(e.pointerId)
  })
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const rect = sidebar.getBoundingClientRect()
    let w = e.clientX - rect.left
    w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w))
    sidebar.style.width = w + 'px'
  })
  handle.addEventListener('pointerup', (e) => {
    if (!dragging) return
    dragging = false
    handle.classList.remove('dragging')
    handle.releasePointerCapture(e.pointerId)
    localStorage.setItem('sidebarWidth', String(sidebar.getBoundingClientRect().width | 0))
    // Notify preview to re-fit if applicable.
    window.dispatchEvent(new CustomEvent('sidebar-resized'))
  })
}

export async function renderThumbnails() {
  const list = document.getElementById('thumbnail-list')
  list.innerHTML = ''
  const sidebar = document.getElementById('sidebar')
  const canvasMax = Math.max(40, sidebar.clientWidth - 16 - 8)

  for (let i = 0; i < appState.pages.length; i++) {
    const entry = appState.pages[i]
    const item = document.createElement('div')
    item.className = 'thumbnail-item'
    item.dataset.index = String(i)
    item.draggable = true

    const canvas = document.createElement('canvas')
    item.appendChild(canvas)

    const label = document.createElement('span')
    label.className = 'thumb-label'
    label.textContent = String(i + 1)
    item.appendChild(label)

    list.appendChild(item)

    // Render asynchronously so the list paints quickly.
    renderThumbCanvas(entry, canvas, canvasMax).catch((err) => {
      console.error('thumbnail render failed', err)
      const errEl = document.createElement('div')
      errEl.className = 'render-error'
      errEl.textContent = 'Page could not be rendered'
      errEl.style.width = (canvasMax) + 'px'
      errEl.style.height = '80px'
      canvas.replaceWith(errEl)
    })
  }
  updateSelectionStyles()
}

async function renderThumbCanvas(entry, canvas, canvasMax) {
  if (entry.originalIndex === -1) {
    const ratio = 595 / 842
    const w = canvasMax
    const h = w / ratio
    drawBlankPlaceholder(canvas, w, h)
    return
  }
  const page = await getPage(entry.sourceId, entry.originalIndex)
  const baseViewport = page.getViewport({ scale: 1, rotation: entry.rotation })
  const scale = canvasMax / baseViewport.width
  const viewport = page.getViewport({ scale, rotation: entry.rotation })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
}

export function updateSelectionStyles() {
  const items = document.querySelectorAll('#thumbnail-list .thumbnail-item')
  items.forEach((el) => {
    const idx = Number(el.dataset.index)
    if (appState.selectedPages.has(idx)) {
      el.classList.add('selected')
    } else {
      el.classList.remove('selected')
    }
  })
}

function getItemIndex(target) {
  const item = target.closest('.thumbnail-item')
  if (!item) return null
  return Number(item.dataset.index)
}

function onThumbClick(e) {
  const idx = getItemIndex(e.target)
  if (idx === null) return
  if (e.shiftKey) {
    const start = Math.min(appState.focusedPage, idx)
    const end = Math.max(appState.focusedPage, idx)
    const next = new Set()
    for (let i = start; i <= end; i++) next.add(i)
    dispatch({ type: 'SET_SELECTED_PAGES', pages: next })
    dispatch({ type: 'SET_FOCUSED_PAGE', page: idx })
  } else if (e.ctrlKey || e.metaKey) {
    const next = new Set(appState.selectedPages)
    if (next.has(idx)) next.delete(idx)
    else next.add(idx)
    dispatch({ type: 'SET_SELECTED_PAGES', pages: next })
  } else {
    dispatch({ type: 'SET_SELECTED_PAGES', pages: new Set([idx]) })
    dispatch({ type: 'SET_FOCUSED_PAGE', page: idx })
  }
}

function onDragStart(e) {
  const idx = getItemIndex(e.target)
  if (idx === null) return
  dragSourceIndex = idx
  e.dataTransfer.effectAllowed = 'move'
  // Required to allow drop in some browsers.
  try {
    e.dataTransfer.setData('text/plain', String(idx))
  } catch {}
}

function onDragOver(e) {
  const item = e.target.closest('.thumbnail-item')
  if (!item) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  const rect = item.getBoundingClientRect()
  const before = e.clientY - rect.top < rect.height / 2
  document.querySelectorAll('#thumbnail-list .thumbnail-item').forEach((el) => {
    if (el !== item) {
      el.classList.remove('drop-above', 'drop-below')
    }
  })
  item.classList.toggle('drop-above', before)
  item.classList.toggle('drop-below', !before)
}

function onDragLeave(e) {
  const item = e.target.closest('.thumbnail-item')
  if (!item) return
  if (!item.contains(e.relatedTarget)) {
    item.classList.remove('drop-above', 'drop-below')
  }
}

function onDrop(e) {
  const item = e.target.closest('.thumbnail-item')
  if (!item) return
  e.preventDefault()
  const targetIdx = Number(item.dataset.index)
  const rect = item.getBoundingClientRect()
  const before = e.clientY - rect.top < rect.height / 2
  let insertAt = before ? targetIdx : targetIdx + 1

  if (dragSourceIndex === null) return
  if (insertAt === dragSourceIndex || insertAt === dragSourceIndex + 1) {
    clearDropMarkers()
    return
  }
  const newPages = [...appState.pages]
  const [moved] = newPages.splice(dragSourceIndex, 1)
  if (dragSourceIndex < insertAt) insertAt -= 1
  newPages.splice(insertAt, 0, moved)
  dispatch({ type: 'SET_PAGE_ORDER', pages: newPages })
  // Move focus to new index of moved page.
  dispatch({ type: 'SET_FOCUSED_PAGE', page: insertAt })
  dispatch({ type: 'SET_SELECTED_PAGES', pages: new Set([insertAt]) })
  clearDropMarkers()
}

function onDragEnd() {
  dragSourceIndex = null
  clearDropMarkers()
}

function clearDropMarkers() {
  document.querySelectorAll('#thumbnail-list .thumbnail-item').forEach((el) => {
    el.classList.remove('drop-above', 'drop-below')
  })
}

async function onContextMenu(e) {
  const idx = getItemIndex(e.target)
  if (idx === null) return
  e.preventDefault()
  rightClickIndex = idx
  const choice = await window.electronAPI.showContextMenu([
    'Delete page',
    'Rotate left',
    'Rotate right',
    'Duplicate page',
    'Insert blank page after',
  ])
  if (!choice) return
  applyContextChoice(choice, rightClickIndex)
}

function applyContextChoice(choice, idx) {
  switch (choice) {
    case 'Delete page': {
      if (appState.pages.length <= 1) return
      const newPages = appState.pages.filter((_, i) => i !== idx)
      dispatch({ type: 'SET_PAGE_ORDER', pages: newPages })
      const newFocus = Math.min(appState.focusedPage, newPages.length - 1)
      dispatch({ type: 'SET_FOCUSED_PAGE', page: Math.max(0, newFocus) })
      const newSel = new Set()
      for (const s of appState.selectedPages) {
        if (s < idx) newSel.add(s)
        else if (s > idx) newSel.add(s - 1)
      }
      dispatch({ type: 'SET_SELECTED_PAGES', pages: newSel })
      break
    }
    case 'Rotate left': {
      const newPages = appState.pages.map((p, i) =>
        i === idx ? { ...p, rotation: (((p.rotation - 90) % 360) + 360) % 360 } : p
      )
      dispatch({ type: 'SET_PAGE_ORDER', pages: newPages })
      break
    }
    case 'Rotate right': {
      const newPages = appState.pages.map((p, i) =>
        i === idx ? { ...p, rotation: (p.rotation + 90) % 360 } : p
      )
      dispatch({ type: 'SET_PAGE_ORDER', pages: newPages })
      break
    }
    case 'Duplicate page': {
      const newPages = [...appState.pages]
      newPages.splice(idx + 1, 0, { ...appState.pages[idx] })
      dispatch({ type: 'SET_PAGE_ORDER', pages: newPages })
      dispatch({ type: 'SET_FOCUSED_PAGE', page: idx + 1 })
      break
    }
    case 'Insert blank page after': {
      const newPages = [...appState.pages]
      newPages.splice(idx + 1, 0, { sourceId: null, originalIndex: -1, rotation: 0 })
      dispatch({ type: 'SET_PAGE_ORDER', pages: newPages })
      dispatch({ type: 'SET_FOCUSED_PAGE', page: idx + 1 })
      break
    }
  }
}

export function scrollFocusedIntoView() {
  const el = document.querySelector(
    `#thumbnail-list .thumbnail-item[data-index="${appState.focusedPage}"]`
  )
  if (el) el.scrollIntoView({ block: 'nearest' })
}
