import { appState, dispatch, createPageEntry, normalizeRotation } from './state.js'
import { openFile, save, saveAs, closeFile } from './pdf-engine.js'
import { addPdfSource } from './renderer.js'
import { showSignatureModal, toggleSigPopover } from './signature.js'
import { showErrorModal } from './main.js'

const ICONS = {
  open: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h4l2 2h6v7H2z"/></svg>`,
  save: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2h8l2 2v10H3z"/><path d="M5 2v4h6V2"/><path d="M5 10h6v4H5z"/></svg>`,
  'save-as': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2h8l2 2v10H3z"/><path d="M5 2v4h6V2"/><path d="M10.5 9.5l1 1L13.5 8.5"/></svg>`,
  'add-blank': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="2" width="9" height="12"/><path d="M7.5 6v4M5.5 8h4"/></svg>`,
  'insert-pdf': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="2" width="9" height="12"/><path d="M5 7h5M5 10h3"/></svg>`,
  'delete-pages': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10"/><path d="M5 4V2h6v2"/><path d="M4 4v10h8V4"/><path d="M7 7v5M9 7v5"/></svg>`,
  'rotate': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1 -1.5 -3.5"/><path d="M11.5 2v3h-3"/></svg>`,
  'add-signature': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12c2-4 4-6 5-6s1 3 2 3 2-4 4-4"/><path d="M2 14h12"/></svg>`,
  'close-file': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>`,
}

function makeButton(action, label, iconKey, opts = {}) {
  const btn = document.createElement('button')
  btn.className = 'toolbar-btn'
  btn.dataset.action = action
  btn.setAttribute('style', '-webkit-app-region: no-drag')
  if (opts.title) btn.title = opts.title
  const icon = document.createElement('span')
  icon.className = 'toolbar-icon'
  icon.innerHTML = ICONS[iconKey] ?? ''
  const labelEl = document.createElement('span')
  labelEl.className = 'toolbar-label'
  labelEl.textContent = label
  btn.appendChild(icon)
  btn.appendChild(labelEl)
  return btn
}

function makeSep() {
  const sep = document.createElement('div')
  sep.className = 'sep'
  return sep
}

export function initToolbar() {
  const bar = document.getElementById('toolbar')
  bar.innerHTML = ''

  bar.appendChild(makeButton('open', 'Open', 'open', { title: 'Open (Ctrl/Cmd+O)' }))
  bar.appendChild(makeButton('save', 'Save', 'save', { title: 'Save (Ctrl/Cmd+S)' }))
  bar.appendChild(makeButton('save-as', 'Save As', 'save-as', { title: 'Save As (Ctrl/Cmd+Shift+S)' }))
  bar.appendChild(makeSep())
  bar.appendChild(makeButton('add-blank', 'Add page', 'add-blank'))
  bar.appendChild(makeButton('insert-pdf', 'Insert PDF', 'insert-pdf'))
  bar.appendChild(makeButton('delete-pages', 'Delete', 'delete-pages'))
  bar.appendChild(makeSep())
  bar.appendChild(makeButton('rotate', 'Rotate', 'rotate', { title: 'Rotate page right (])' }))
  bar.appendChild(makeSep())

  // Signature button with embedded dropdown arrow
  const sigBtn = document.createElement('button')
  sigBtn.className = 'toolbar-btn signature-btn'
  sigBtn.dataset.action = 'add-signature'
  sigBtn.setAttribute('style', '-webkit-app-region: no-drag')
  sigBtn.title = 'Add a signature'
  const sigInner = document.createElement('span')
  sigInner.className = 'label-wrap'
  sigInner.innerHTML = `<span class="toolbar-icon">${ICONS['add-signature']}</span><span class="toolbar-label">Signature</span>`
  sigBtn.appendChild(sigInner)
  const sigArrow = document.createElement('button')
  sigArrow.className = 'sig-dropdown-arrow'
  sigArrow.dataset.action = 'sig-library'
  sigArrow.setAttribute('style', '-webkit-app-region: no-drag')
  sigArrow.title = 'Saved signatures'
  sigArrow.textContent = '▾'
  sigBtn.appendChild(sigArrow)
  bar.appendChild(sigBtn)

  bar.appendChild(makeSep())

  const spacer = document.createElement('div')
  spacer.className = 'toolbar-spacer'
  bar.appendChild(spacer)

  const counter = document.createElement('span')
  counter.id = 'page-counter'
  counter.className = 'page-counter'
  counter.textContent = '— / —'
  bar.appendChild(counter)

  const zoomGroup = document.createElement('div')
  zoomGroup.className = 'zoom-group'
  zoomGroup.setAttribute('style', '-webkit-app-region: no-drag')
  const zoomOut = document.createElement('button')
  zoomOut.dataset.action = 'zoom-out'
  zoomOut.textContent = '−'
  zoomOut.title = 'Zoom out'
  const zoomLabel = document.createElement('button')
  zoomLabel.id = 'zoom-label'
  zoomLabel.dataset.action = 'zoom-reset'
  zoomLabel.textContent = 'Fit'
  zoomLabel.title = 'Reset zoom (fit to width)'
  const zoomIn = document.createElement('button')
  zoomIn.dataset.action = 'zoom-in'
  zoomIn.textContent = '+'
  zoomIn.title = 'Zoom in'
  zoomGroup.appendChild(zoomOut)
  zoomGroup.appendChild(zoomLabel)
  zoomGroup.appendChild(zoomIn)
  bar.appendChild(zoomGroup)

  bar.appendChild(makeSep())
  bar.appendChild(makeButton('close-file', 'Close file', 'close-file', { title: 'Close current file' }))

  bar.addEventListener('click', onToolbarClick)
  updateToolbar()
}

const ZOOM_STEPS = [50, 67, 75, 90, 100, 125, 150, 175, 200]

function snapZoom(direction) {
  const current = appState.zoom ?? 100
  if (direction === 'in') {
    const next = ZOOM_STEPS.find((z) => z > current)
    return next ?? 200
  } else {
    const next = [...ZOOM_STEPS].reverse().find((z) => z < current)
    return next ?? 50
  }
}

async function onToolbarClick(e) {
  const target = e.target.closest('[data-action]')
  if (!target) return
  const action = target.dataset.action
  if (target.disabled) return
  switch (action) {
    case 'open':
      await openFile()
      break
    case 'save':
      await save()
      break
    case 'save-as':
      await saveAs()
      break
    case 'add-blank': {
      const insertAt = appState.focusedPage + 1
      const newPages = [...appState.pages]
      newPages.splice(insertAt, 0, createPageEntry({ sourceId: null, originalIndex: -1, rotation: 0 }))
      dispatch({ type: 'SET_PAGE_ORDER', pages: newPages })
      dispatch({ type: 'SET_FOCUSED_PAGE', page: insertAt })
      break
    }
    case 'insert-pdf': {
      await insertPdfFile()
      break
    }
    case 'delete-pages': {
      deleteSelectedPages()
      break
    }
    case 'rotate':
      rotateSelected(90)
      break
    case 'close-file':
      await closeFile()
      break
    case 'add-signature':
      e.stopPropagation()
      showSignatureModal()
      break
    case 'sig-library':
      e.stopPropagation()
      toggleSigPopover(target)
      break
    case 'zoom-out':
      dispatch({ type: 'SET_ZOOM', zoom: snapZoom('out') })
      break
    case 'zoom-in':
      dispatch({ type: 'SET_ZOOM', zoom: snapZoom('in') })
      break
    case 'zoom-reset':
      dispatch({ type: 'SET_ZOOM', zoom: null })
      break
  }
}

async function insertPdfFile() {
  const result = await window.electronAPI.openFile()
  if (!result) return
  try {
    const { PDFDocument } = await import('../node_modules/pdf-lib/dist/pdf-lib.esm.js')

    // Validate the file is a real PDF and get its page count.
    const insertedDoc = await PDFDocument.load(result.buffer, { ignoreEncryption: true })
    const insertCount = insertedDoc.getPageCount()
    if (insertCount === 0) return

    // Keep the inserted PDF as its own source. buildOutputDoc() already merges
    // across sources at save time, so we avoid re-encoding the primary bytes
    // on every insert.
    const sourceId = `inserted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await addPdfSource(sourceId, result.buffer)

    const insertAt = appState.focusedPage + 1
    const insertedEntries = Array.from({ length: insertCount }, (_, i) => {
      const angle = insertedDoc.getPage(i).getRotation().angle
      return createPageEntry({
        sourceId,
        originalIndex: i,
        rotation: normalizeRotation(angle),
      })
    })
    const newPages = [
      ...appState.pages.slice(0, insertAt),
      ...insertedEntries,
      ...appState.pages.slice(insertAt),
    ]

    // One atomic dispatch — a single render with the final pages/focusedPage,
    // so the preview can't race against an intermediate state.
    dispatch({
      type: 'INSERT_PAGES',
      sourceId,
      sourceBytes: result.buffer,
      pages: newPages,
      focusedPage: insertAt,
      shiftFromIndex: insertAt,
      shiftDelta: insertCount,
    })
  } catch (err) {
    console.error(err)
    showErrorModal('Could not insert this PDF. It may be corrupt or not a valid PDF.')
  }
}

function targetPageIndices() {
  if (appState.selectedPages.size > 0) return [...appState.selectedPages]
  if (appState.pages.length === 0) return []
  return [appState.focusedPage]
}

export function deleteSelectedPages() {
  const sel = new Set(targetPageIndices())
  if (sel.size === 0) return
  if (appState.pages.length - sel.size < 1) return
  const newPages = appState.pages.filter((_, i) => !sel.has(i))
  dispatch({ type: 'SET_PAGE_ORDER', pages: newPages })
  dispatch({ type: 'SET_SELECTED_PAGES', pages: new Set([appState.focusedPage]) })
}

export function rotateSelected(delta) {
  const targetIndices = targetPageIndices()
  if (targetIndices.length === 0) return
  const newPages = appState.pages.map((p, i) =>
    targetIndices.includes(i)
      ? { ...p, rotation: normalizeRotation(p.rotation + delta) }
      : p
  )
  dispatch({ type: 'SET_PAGE_ORDER', pages: newPages })
}

export function updateToolbar() {
  const fileOpen = appState.filePath !== null
  const map = {
    save: !fileOpen,
    'save-as': !fileOpen,
    'add-blank': !fileOpen,
    'insert-pdf': !fileOpen,
    'rotate': !fileOpen,
    'close-file': !fileOpen,
    'delete-pages':
      !fileOpen ||
      appState.pages.length <= 1,
  }
  for (const [action, disabled] of Object.entries(map)) {
    const btn = document.querySelector(`#toolbar [data-action="${action}"]`)
    if (btn) btn.disabled = disabled
  }
  const currentZoom = appState.zoom ?? 100
  const zoomOutBtn = document.querySelector('#toolbar [data-action="zoom-out"]')
  const zoomInBtn = document.querySelector('#toolbar [data-action="zoom-in"]')
  if (zoomOutBtn) zoomOutBtn.disabled = !fileOpen || currentZoom <= 50
  if (zoomInBtn) zoomInBtn.disabled = !fileOpen || currentZoom >= 200
  const zoomLabelBtn = document.getElementById('zoom-label')
  if (zoomLabelBtn) zoomLabelBtn.disabled = !fileOpen
}

export function updatePageCounter() {
  const counter = document.getElementById('page-counter')
  if (!counter) return
  if (!appState.filePath || appState.pages.length === 0) {
    counter.textContent = '— / —'
  } else {
    counter.textContent = `${appState.focusedPage + 1} / ${appState.pages.length}`
  }
}

export function updateZoomLabel() {
  const el = document.getElementById('zoom-label')
  if (!el) return
  el.textContent = appState.zoom === null ? 'Fit' : appState.zoom + '%'
}
