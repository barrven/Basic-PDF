import { appState, dispatch } from './state.js'
import { openFile, save, saveAs } from './pdf-engine.js'
import { exitPlacementMode, isPlacing } from './signature.js'
import { deleteSelectedPages, rotateSelected } from './toolbar.js'

export function initShortcuts() {
  document.addEventListener('keydown', onKeyDown)
}

function isTypingTarget(el) {
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

function modalIsOpen() {
  const m = document.getElementById('modal-backdrop')
  const e = document.getElementById('error-modal-backdrop')
  return (m && !m.hidden) || (e && !e.hidden)
}

async function onKeyDown(e) {
  if (isTypingTarget(e.target)) return
  const mod = e.metaKey || e.ctrlKey

  if (mod && !e.shiftKey && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault()
    await openFile()
    return
  }
  if (mod && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    if (appState.filePath) await save()
    return
  }
  if (mod && e.shiftKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    if (appState.filePath) await saveAs()
    return
  }
  if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault()
    dispatch({ type: 'UNDO' })
    return
  }
  if ((mod && e.shiftKey && (e.key === 'z' || e.key === 'Z')) || (mod && (e.key === 'y' || e.key === 'Y'))) {
    e.preventDefault()
    dispatch({ type: 'REDO' })
    return
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (modalIsOpen()) return
    e.preventDefault()
    if (appState.selectedSig) {
      dispatch({ type: 'DELETE_SIGNATURE', id: appState.selectedSig })
      return
    }
    deleteSelectedPages()
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    if (isPlacing()) {
      exitPlacementMode()
      return
    }
    if (appState.selectedSig) {
      dispatch({ type: 'SET_SELECTED_SIG', id: null })
      return
    }
    if (modalIsOpen()) {
      const m = document.getElementById('modal-backdrop')
      if (m && !m.hidden) m.hidden = true
      const er = document.getElementById('error-modal-backdrop')
      if (er && !er.hidden) er.hidden = true
    }
    return
  }
  if (e.key === 'PageDown' || e.key === 'PageUp') {
    if (modalIsOpen()) return
    const pane = document.getElementById('preview-pane')
    if (!pane || !appState.filePath) return
    e.preventDefault()
    const dir = e.key === 'PageDown' ? 1 : -1
    pane.scrollBy({ top: dir * pane.clientHeight * 0.9, behavior: 'auto' })
    return
  }
  if (e.key === 'ArrowUp') {
    if (appState.focusedPage > 0) {
      e.preventDefault()
      const next = appState.focusedPage - 1
      dispatch({ type: 'SET_FOCUSED_PAGE', page: next })
      if (!e.shiftKey) dispatch({ type: 'SET_SELECTED_PAGES', pages: new Set([next]) })
    }
    return
  }
  if (e.key === 'ArrowDown') {
    if (appState.focusedPage < appState.pages.length - 1) {
      e.preventDefault()
      const next = appState.focusedPage + 1
      dispatch({ type: 'SET_FOCUSED_PAGE', page: next })
      if (!e.shiftKey) dispatch({ type: 'SET_SELECTED_PAGES', pages: new Set([next]) })
    }
    return
  }
  if (mod && (e.key === 'a' || e.key === 'A')) {
    if (appState.pages.length === 0) return
    e.preventDefault()
    const all = new Set()
    for (let i = 0; i < appState.pages.length; i++) all.add(i)
    dispatch({ type: 'SET_SELECTED_PAGES', pages: all })
    return
  }
  if (e.key === '[') {
    if (appState.pages.length === 0) return
    e.preventDefault()
    rotateSelected(-90)
    return
  }
  if (e.key === ']') {
    if (appState.pages.length === 0) return
    e.preventDefault()
    rotateSelected(90)
    return
  }
}
