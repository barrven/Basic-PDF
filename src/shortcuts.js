import { appState, dispatch } from './state.js'
import { openFile, save, saveAs } from './pdf-engine.js'
import { exitPlacementMode, isPlacing } from './signature.js'

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
    if (appState.selectedPages.size === 0) return
    if (appState.pages.length - appState.selectedPages.size < 1) return
    const sel = appState.selectedPages
    const newPages = appState.pages.filter((_, i) => !sel.has(i))
    dispatch({ type: 'SET_PAGE_ORDER', pages: newPages })
    dispatch({ type: 'SET_SELECTED_PAGES', pages: new Set() })
    if (appState.focusedPage >= newPages.length) {
      dispatch({ type: 'SET_FOCUSED_PAGE', page: Math.max(0, newPages.length - 1) })
    }
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
  if (e.key === 'ArrowUp') {
    if (appState.focusedPage > 0) {
      e.preventDefault()
      dispatch({ type: 'SET_FOCUSED_PAGE', page: appState.focusedPage - 1 })
    }
    return
  }
  if (e.key === 'ArrowDown') {
    if (appState.focusedPage < appState.pages.length - 1) {
      e.preventDefault()
      dispatch({ type: 'SET_FOCUSED_PAGE', page: appState.focusedPage + 1 })
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
    const targets = appState.selectedPages.size > 0 ? [...appState.selectedPages] : [appState.focusedPage]
    const newPages = appState.pages.map((p, i) =>
      targets.includes(i) ? { ...p, rotation: (((p.rotation - 90) % 360) + 360) % 360 } : p
    )
    dispatch({ type: 'SET_PAGE_ORDER', pages: newPages })
    return
  }
  if (e.key === ']') {
    if (appState.pages.length === 0) return
    e.preventDefault()
    const targets = appState.selectedPages.size > 0 ? [...appState.selectedPages] : [appState.focusedPage]
    const newPages = appState.pages.map((p, i) =>
      targets.includes(i) ? { ...p, rotation: (p.rotation + 90) % 360 } : p
    )
    dispatch({ type: 'SET_PAGE_ORDER', pages: newPages })
    return
  }
}
