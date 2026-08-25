import { appState, dispatch, subscribe } from './state.js'
import { initToolbar, updateToolbar, updatePageCounter, updateZoomLabel } from './toolbar.js'
import { initSidebar, renderThumbnails, updateSelectionStyles, scrollFocusedIntoView } from './sidebar.js'
import { initPreview, renderPreview, renderSignatureOverlays, scrollPreviewToFocused, whenPreviewIdle } from './preview.js'
import { initSignature } from './signature.js'
import { initShortcuts } from './shortcuts.js'
import { initSearch, onSearchDocumentChanged } from './search.js'
import { initOsFileOpen } from './pdf-engine.js'
import { initTheme } from './theme.js'

// ─────────── Toast ───────────

let toastTimeout = null

export function showToast(message, ms = 2000) {
  const t = document.getElementById('toast')
  if (!t) return
  t.textContent = message
  t.hidden = false
  if (toastTimeout) clearTimeout(toastTimeout)
  toastTimeout = setTimeout(() => {
    t.hidden = true
    toastTimeout = null
  }, ms)
}

export function updateLoadingOverlay() {
  const el = document.getElementById('loading-overlay')
  if (el) el.hidden = !appState.loading
  const workspace = document.getElementById('workspace')
  if (workspace) workspace.setAttribute('aria-busy', appState.loading ? 'true' : 'false')
}

export async function withDocumentLoading(work) {
  dispatch({ type: 'SET_LOADING', loading: true })
  try {
    return await work()
  } finally {
    try {
      await whenPreviewIdle()
    } catch (err) {
      console.error(err)
    }
    dispatch({ type: 'SET_LOADING', loading: false })
  }
}

export function showErrorModal(message) {
  const eb = document.getElementById('error-modal-backdrop')
  const msg = document.getElementById('error-modal-message')
  if (msg) msg.textContent = message
  if (eb) eb.hidden = false
}

// ─────────── Render loop ───────────

let prevState = {
  pagesRef: null,
  signaturesRef: null,
  selectedPagesRef: null,
  focusedPage: -1,
  zoom: 'init',
  dirty: null,
  filePath: undefined,
  selectedSig: undefined,
  pagesLength: -1,
}

function basename(p) {
  if (!p) return ''
  return p.split(/[\\/]/).pop()
}

function updateTitle() {
  const name = basename(appState.filePath)
  const fileEl = document.getElementById('filename')
  if (!appState.filePath) {
    document.title = 'Basic PDF'
    if (fileEl) fileEl.textContent = ''
  } else if (appState.dirty) {
    document.title = '● ' + name
    if (fileEl) fileEl.textContent = '● ' + name
  } else {
    document.title = name
    if (fileEl) fileEl.textContent = name
  }
}

export function render() {
  const pagesChanged = prevState.pagesRef !== appState.pages
  const focusedChanged = prevState.focusedPage !== appState.focusedPage
  const zoomChanged = prevState.zoom !== appState.zoom
  const sigsChanged = prevState.signaturesRef !== appState.signatures
  const selChanged = prevState.selectedPagesRef !== appState.selectedPages
  const dirtyChanged = prevState.dirty !== appState.dirty
  const fileChanged = prevState.filePath !== appState.filePath
  const selectedSigChanged = prevState.selectedSig !== appState.selectedSig
  const lengthChanged = prevState.pagesLength !== appState.pages.length

  if (pagesChanged || fileChanged) {
    renderThumbnails().catch((e) => console.error(e))
    onSearchDocumentChanged()
  }
  if (pagesChanged || zoomChanged || fileChanged) {
    renderPreview().catch((e) => console.error(e))
  } else if (sigsChanged || selectedSigChanged) {
    renderSignatureOverlays()
  }
  if (focusedChanged && !pagesChanged && !zoomChanged && !fileChanged) {
    scrollPreviewToFocused()
  }
  if (selChanged) {
    updateSelectionStyles()
  }
  if (focusedChanged || pagesChanged) {
    scrollFocusedIntoView()
  }
  if (focusedChanged || lengthChanged || fileChanged) {
    updatePageCounter()
  }
  if (zoomChanged || fileChanged) {
    updateZoomLabel()
  }
  if (dirtyChanged || fileChanged) {
    updateTitle()
  }
  updateLoadingOverlay()
  // Toolbar enable/disable depends on lots of things; just re-evaluate.
  updateToolbar()

  prevState = {
    pagesRef: appState.pages,
    signaturesRef: appState.signatures,
    selectedPagesRef: appState.selectedPages,
    focusedPage: appState.focusedPage,
    zoom: appState.zoom,
    dirty: appState.dirty,
    filePath: appState.filePath,
    selectedSig: appState.selectedSig,
    pagesLength: appState.pages.length,
  }
}

// ─────────── Boot ───────────

let lastSentDirty = null

function syncDirtyToMain() {
  if (!window.electronAPI?.setDirty) return
  const dirty = !!appState.dirty
  if (dirty === lastSentDirty) return
  lastSentDirty = dirty
  window.electronAPI.setDirty(dirty)
}

function init() {
  initTheme()
  initToolbar()
  initSidebar()
  initPreview()
  initSignature()
  initSearch()
  initShortcuts()

  subscribe(render)
  subscribe(syncDirtyToMain)

  // Initial render — empty state.
  render()
  syncDirtyToMain()

  initOsFileOpen()

  // Uncaught rejection toast.
  window.addEventListener('unhandledrejection', (e) => {
    console.error('unhandledrejection', e.reason)
    showToast('An unexpected error occurred.')
  })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true })
} else {
  init()
}
