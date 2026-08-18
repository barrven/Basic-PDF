import { appState, subscribe } from './state.js'
import { initToolbar, updateToolbar, updatePageCounter, updateZoomLabel } from './toolbar.js'
import { initSidebar, renderThumbnails, updateSelectionStyles, scrollFocusedIntoView } from './sidebar.js'
import { initPreview, renderPreview, renderSignatureOverlays } from './preview.js'
import { initSignature } from './signature.js'
import { initShortcuts } from './shortcuts.js'

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
    document.title = 'BasicPDF'
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
  }
  if (pagesChanged || focusedChanged || zoomChanged || fileChanged) {
    renderPreview().catch((e) => console.error(e))
  } else if (sigsChanged || selectedSigChanged) {
    renderSignatureOverlays()
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

function init() {
  initToolbar()
  initSidebar()
  initPreview()
  initSignature()
  initShortcuts()

  subscribe(render)

  // Initial render — empty state.
  render()

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
