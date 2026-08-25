export const PRIMARY_SOURCE_ID = 'primary'

export function normalizeRotation(angle) {
  const n = Number(angle) || 0
  const wrapped = ((n % 360) + 360) % 360
  return (Math.round(wrapped / 90) * 90) % 360
}

export function createPageEntry({ sourceId = null, originalIndex, rotation = 0 } = {}) {
  return {
    id: crypto.randomUUID(),
    sourceId,
    originalIndex,
    rotation: normalizeRotation(rotation),
  }
}

function remapSignatures(oldPages, newPages, signatures) {
  if (!oldPages.length || !signatures.length) return signatures
  const idToNewIndex = new Map()
  for (let i = 0; i < newPages.length; i++) {
    const id = newPages[i]?.id
    if (id) idToNewIndex.set(id, i)
  }
  if (idToNewIndex.size === 0) return signatures
  return signatures
    .filter((s) => {
      const oldId = oldPages[s.pageIndex]?.id
      return oldId != null && idToNewIndex.has(oldId)
    })
    .map((s) => ({
      ...s,
      pageIndex: idToNewIndex.get(oldPages[s.pageIndex].id),
    }))
}

function remapSelection(oldPages, newPages, selectedPages) {
  const next = new Set()
  if (!selectedPages || selectedPages.size === 0) return next
  const idToNewIndex = new Map()
  for (let i = 0; i < newPages.length; i++) {
    const id = newPages[i]?.id
    if (id) idToNewIndex.set(id, i)
  }
  if (idToNewIndex.size === 0) return selectedPages
  for (const idx of selectedPages) {
    const id = oldPages[idx]?.id
    if (id != null && idToNewIndex.has(id)) next.add(idToNewIndex.get(id))
  }
  return next
}

function remapFocusedPage(oldPages, newPages, focusedPage) {
  const oldId = oldPages[focusedPage]?.id
  if (oldId) {
    const idx = newPages.findIndex((p) => p.id === oldId)
    if (idx >= 0) return idx
  }
  if (newPages.length === 0) return 0
  return Math.min(Math.max(0, focusedPage), newPages.length - 1)
}

export const appState = {
  filePath: null,
  fileBytes: null,
  // sourceId -> { bytes }. Inserted PDFs are stored here as separate sources;
  // primary bytes live on appState.fileBytes. buildOutputDoc merges across all
  // sources at save time.
  sources: {},
  pages: [],
  signatures: [],
  selectedPages: new Set(),
  focusedPage: 0,
  zoom: null,
  dirty: false,
  placementSig: null,
  selectedSig: null,
  loading: false,
  history: {
    past: [],
    future: [],
  },
}

const MAX_HISTORY = 50

const listeners = new Set()

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify() {
  for (const fn of listeners) {
    try { fn() } catch (err) { console.error(err) }
  }
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

function snapshot() {
  return deepClone({
    pages: appState.pages,
    signatures: appState.signatures,
  })
}

function pushHistory() {
  appState.history.past.push(snapshot())
  if (appState.history.past.length > MAX_HISTORY) {
    appState.history.past.shift()
  }
  appState.history.future = []
}

export function dispatch(action) {
  switch (action.type) {
    case 'OPEN_FILE': {
      appState.filePath = action.path
      appState.fileBytes = action.bytes
      appState.sources = {}
      appState.pages = action.pages
      appState.signatures = []
      appState.selectedPages = action.pages.length > 0 ? new Set([0]) : new Set()
      appState.focusedPage = 0
      appState.dirty = false
      appState.placementSig = null
      appState.selectedSig = null
      appState.zoom = null
      appState.history.past = []
      appState.history.future = []
      break
    }
    case 'CLOSE_FILE': {
      appState.filePath = null
      appState.fileBytes = null
      appState.sources = {}
      appState.pages = []
      appState.signatures = []
      appState.selectedPages = new Set()
      appState.focusedPage = 0
      appState.dirty = false
      appState.placementSig = null
      appState.selectedSig = null
      appState.zoom = null
      appState.loading = false
      appState.history.past = []
      appState.history.future = []
      break
    }
    case 'SET_LOADING': {
      appState.loading = Boolean(action.loading)
      break
    }
    case 'ADD_SOURCE': {
      appState.sources = { ...appState.sources, [action.sourceId]: { bytes: action.bytes } }
      break
    }
    case 'SET_FILE_BYTES': {
      appState.fileBytes = action.bytes
      break
    }
    case 'SHIFT_SIGNATURES_AFTER': {
      appState.signatures = appState.signatures.map((s) =>
        s.pageIndex >= action.fromIndex
          ? { ...s, pageIndex: s.pageIndex + action.delta }
          : s
      )
      break
    }
    case 'INSERT_PAGES': {
      // Snapshot BEFORE any mutation so undo restores pages and the
      // pre-shift signature positions together.
      pushHistory()
      if (action.sourceId && action.sourceBytes) {
        appState.sources = {
          ...appState.sources,
          [action.sourceId]: { bytes: action.sourceBytes },
        }
      }
      const oldPages = appState.pages
      appState.signatures = remapSignatures(oldPages, action.pages, appState.signatures)
      appState.selectedPages = remapSelection(oldPages, action.pages, appState.selectedPages)
      appState.pages = action.pages
      appState.focusedPage =
        action.focusedPage != null
          ? action.focusedPage
          : remapFocusedPage(oldPages, action.pages, appState.focusedPage)
      appState.dirty = true
      break
    }
    case 'SET_PAGE_ORDER': {
      pushHistory()
      const oldPages = appState.pages
      appState.signatures = remapSignatures(oldPages, action.pages, appState.signatures)
      appState.selectedPages = remapSelection(oldPages, action.pages, appState.selectedPages)
      appState.focusedPage = remapFocusedPage(oldPages, action.pages, appState.focusedPage)
      appState.pages = action.pages
      if (appState.selectedSig && !appState.signatures.some((s) => s.id === appState.selectedSig)) {
        appState.selectedSig = null
      }
      appState.dirty = true
      break
    }
    case 'SET_ROTATION': {
      pushHistory()
      const indices = new Set(action.indices)
      appState.pages = appState.pages.map((p, i) =>
        indices.has(i) ? { ...p, rotation: action.rotation } : p
      )
      appState.dirty = true
      break
    }
    case 'ADD_SIGNATURE': {
      pushHistory()
      appState.signatures = [...appState.signatures, action.signature]
      appState.dirty = true
      break
    }
    case 'MOVE_SIGNATURE': {
      appState.signatures = appState.signatures.map((s) =>
        s.id === action.id ? { ...s, x: action.x, y: action.y } : s
      )
      appState.dirty = true
      break
    }
    case 'RESIZE_SIGNATURE': {
      appState.signatures = appState.signatures.map((s) =>
        s.id === action.id
          ? { ...s, x: action.x, y: action.y, width: action.width, height: action.height }
          : s
      )
      appState.dirty = true
      break
    }
    case 'COMMIT_SIGNATURE_TRANSFORM': {
      // Snapshot AFTER the live transform so undo restores the pre-drag state.
      // The drag handler should call pushHistorySnapshot BEFORE first mutation.
      break
    }
    case 'PUSH_HISTORY_SNAPSHOT': {
      pushHistory()
      break
    }
    case 'DELETE_SIGNATURE': {
      pushHistory()
      appState.signatures = appState.signatures.filter((s) => s.id !== action.id)
      if (appState.selectedSig === action.id) appState.selectedSig = null
      appState.dirty = true
      break
    }
    case 'SET_SELECTED_PAGES': {
      appState.selectedPages = action.pages
      break
    }
    case 'SET_FOCUSED_PAGE': {
      appState.focusedPage = action.page
      break
    }
    case 'SET_ZOOM': {
      appState.zoom = action.zoom
      break
    }
    case 'SET_DIRTY': {
      appState.dirty = action.dirty
      break
    }
    case 'SET_PLACEMENT_SIG': {
      appState.placementSig = action.dataUrl
      break
    }
    case 'SET_SELECTED_SIG': {
      appState.selectedSig = action.id
      break
    }
    case 'SET_FILE_PATH': {
      appState.filePath = action.path
      break
    }
    case 'UNDO': {
      if (appState.history.past.length === 0) break
      appState.history.future.unshift(snapshot())
      const prev = appState.history.past.pop()
      appState.pages = prev.pages
      appState.signatures = prev.signatures
      // Clear selections that may be invalid.
      appState.selectedPages = new Set()
      if (appState.focusedPage >= appState.pages.length) {
        appState.focusedPage = Math.max(0, appState.pages.length - 1)
      }
      appState.selectedSig = null
      appState.dirty = true
      break
    }
    case 'REDO': {
      if (appState.history.future.length === 0) break
      appState.history.past.push(snapshot())
      const next = appState.history.future.shift()
      appState.pages = next.pages
      appState.signatures = next.signatures
      appState.selectedPages = new Set()
      if (appState.focusedPage >= appState.pages.length) {
        appState.focusedPage = Math.max(0, appState.pages.length - 1)
      }
      appState.selectedSig = null
      appState.dirty = true
      break
    }
    default:
      console.warn('Unknown action', action)
  }
  notify()
}
