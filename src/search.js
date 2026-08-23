import { appState, dispatch } from './state.js'
import { getPageTextContent } from './renderer.js'
import {
  scrollPreviewToFocused,
  waitForTextLayer,
  whenPreviewIdle,
  addTextLayerPaintListener,
  applyFindHighlights,
  applyFindHighlightsForPage,
  clearFindHighlights,
  scrollCurrentFindMatchIntoView,
} from './preview.js'

const DEBOUNCE_MS = 200

let barOpen = false
let debounceTimer = 0
let searchGen = 0
let revealGen = 0
let searching = false
let matches = []
let currentIndex = -1

export function isFindBarOpen() {
  return barOpen
}

export function initSearch() {
  const bar = document.getElementById('find-bar')
  const input = document.getElementById('find-input')
  const prev = document.getElementById('find-prev')
  const next = document.getElementById('find-next')
  const close = document.getElementById('find-close')
  if (!bar || !input) return

  input.addEventListener('input', () => {
    scheduleSearch()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      moveMatch(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeFindBar()
    }
  })
  for (const btn of [prev, next, close]) {
    btn?.addEventListener('mousedown', (e) => e.preventDefault())
  }
  prev?.addEventListener('click', () => moveMatch(-1))
  next?.addEventListener('click', () => moveMatch(1))
  close?.addEventListener('click', () => closeFindBar())

  addTextLayerPaintListener((pageIndex) => {
    if (!barOpen || !matches.length) return
    applyFindHighlightsForPage(pageIndex, matches, currentIndex)
  })
}

export function openFindBar() {
  const bar = document.getElementById('find-bar')
  const input = document.getElementById('find-input')
  if (!bar || !input) return
  bar.hidden = false
  barOpen = true
  input.focus()
  input.select()
  updateStatus()
  if (input.value.trim()) scheduleSearch(true)
}

export function closeFindBar() {
  const bar = document.getElementById('find-bar')
  if (!bar) return
  bar.hidden = true
  barOpen = false
  searchGen += 1
  revealGen += 1
  searching = false
  matches = []
  currentIndex = -1
  clearFindHighlights()
  updateStatus()
}

export function onSearchDocumentChanged() {
  if (!barOpen) {
    matches = []
    currentIndex = -1
    searching = false
    return
  }
  scheduleSearch(true)
}

function scheduleSearch(immediate = false) {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = 0
  }
  if (immediate) {
    runSearch()
    return
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = 0
    runSearch()
  }, DEBOUNCE_MS)
}

export function findHitsInItems(items, query, page, pageIndex) {
  const q = query.toLowerCase()
  if (!q) return []
  let joined = ''
  const starts = []
  for (let i = 0; i < items.length; i++) {
    starts.push(joined.length)
    joined += items[i].str || ''
  }
  const hay = joined.toLowerCase()
  const hits = []
  let from = 0
  while (from + q.length <= hay.length) {
    const at = hay.indexOf(q, from)
    if (at < 0) break
    let itemIndex = 0
    for (let i = starts.length - 1; i >= 0; i--) {
      if (at >= starts[i]) {
        itemIndex = i
        break
      }
    }
    hits.push({
      pageId: page.id,
      pageIndex,
      itemIndex,
      offset: at - starts[itemIndex],
      length: q.length,
    })
    from = at + q.length
  }
  return hits
}

async function runSearch() {
  const input = document.getElementById('find-input')
  const query = (input?.value || '').trim()
  const gen = ++searchGen
  revealGen += 1
  matches = []
  currentIndex = -1
  clearFindHighlights()

  if (!query || !appState.filePath || appState.pages.length === 0) {
    searching = false
    updateStatus()
    return
  }

  searching = true
  updateStatus()
  const preferred = appState.focusedPage
  let pendingReveal = true
  const pages = appState.pages

  for (let i = 0; i < pages.length; i++) {
    if (gen !== searchGen) return
    const entry = pages[i]
    if (entry.originalIndex === -1) continue
    try {
      const textContent = await getPageTextContent(entry.sourceId, entry.originalIndex)
      if (gen !== searchGen) return
      const hits = findHitsInItems(textContent.items || [], query, entry, i)
      if (hits.length) matches = matches.concat(hits)
    } catch (err) {
      console.error('find extract failed', err)
    }
    if (pendingReveal) {
      const idx = matches.findIndex((m) => m.pageIndex >= preferred)
      if (idx >= 0) {
        currentIndex = idx
        pendingReveal = false
        updateStatus()
        revealCurrent()
      }
    }
    updateStatus()
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0))
  }

  if (gen !== searchGen) return
  if (pendingReveal && matches.length) {
    currentIndex = 0
    pendingReveal = false
    revealCurrent()
  }
  searching = false
  updateStatus()
  if (matches.length && currentIndex >= 0) {
    applyFindHighlights(matches, currentIndex)
  }
}

function moveMatch(delta) {
  if (!matches.length) return
  if (currentIndex < 0) currentIndex = 0
  else currentIndex = (currentIndex + delta + matches.length) % matches.length
  updateStatus()
  revealCurrent()
}

async function revealCurrent() {
  const hit = matches[currentIndex]
  if (!hit) return
  const gen = ++revealGen
  if (hit.pageIndex !== appState.focusedPage) {
    dispatch({ type: 'SET_FOCUSED_PAGE', page: hit.pageIndex })
  }
  await whenPreviewIdle()
  if (gen !== revealGen) return
  scrollPreviewToFocused({ force: true })
  await waitForTextLayer(hit.pageIndex)
  if (gen !== revealGen) return
  applyFindHighlights(matches, currentIndex)
  scrollCurrentFindMatchIntoView()
}

function updateStatus() {
  const status = document.getElementById('find-status')
  const prev = document.getElementById('find-prev')
  const next = document.getElementById('find-next')
  const hasMatches = matches.length > 0
  if (prev) prev.disabled = !hasMatches
  if (next) next.disabled = !hasMatches
  if (!status) return
  if (!barOpen) {
    status.textContent = ''
    return
  }
  const query = (document.getElementById('find-input')?.value || '').trim()
  if (!query) {
    status.textContent = ''
    return
  }
  if (searching && !hasMatches) {
    status.textContent = '…'
    return
  }
  if (searching) {
    const n = currentIndex >= 0 ? currentIndex + 1 : 0
    status.textContent = n + ' of …'
    return
  }
  if (!hasMatches) {
    status.textContent = 'No matches'
    return
  }
  status.textContent = (currentIndex + 1) + ' of ' + matches.length
}
