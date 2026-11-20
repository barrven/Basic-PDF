import { appState, dispatch, subscribe } from './state.js'
import { getPdfDoc, getPage, getPageTextContent } from './renderer.js'
import { scrollPreviewToFocused, scrollPreviewToPageOffset } from './preview.js'

// Sidebar outline view. Uses the PDF's own bookmarks when it has them and falls
// back to detecting headings from text size. Nodes point at pages of the
// composed document (appState.pages), so they follow reorder / delete / insert.

const MODE_KEY = 'sidebarView'
const MAX_DEPTH = 3
const MAX_DETECTED = 300

let mode = 'pages'
let generation = 0
let stale = true
let nodes = [] // { title, pageIndex, depth, hasChildren }
let source = 'none' // 'embedded' | 'detected' | 'none'
let status = 'idle' // 'idle' | 'building' | 'done'
let embeddedCache = { doc: null, tree: null }
let collapsed = new Set() // node keys
let rebuildTimer = 0

export function getSidebarView() {
  return mode
}

export function initOutline() {
  try {
    const saved = localStorage.getItem(MODE_KEY)
    if (saved === 'outline' || saved === 'pages') mode = saved
  } catch {}

  const tabs = document.getElementById('sidebar-tabs')
  tabs?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]')
    if (btn) setSidebarView(btn.dataset.view)
  })
  document.getElementById('outline-list')?.addEventListener('click', onOutlineClick)

  let prevPages = null
  let prevFile
  let prevFocused = -1
  subscribe(() => {
    const docChanged = prevPages !== appState.pages || prevFile !== appState.filePath
    prevPages = appState.pages
    prevFile = appState.filePath
    if (docChanged) {
      stale = true
      if (mode === 'outline') scheduleRebuild()
    }
    if (prevFocused !== appState.focusedPage) {
      prevFocused = appState.focusedPage
      updateCurrent()
    }
  })

  applyMode()
}

export function setSidebarView(next) {
  if (next !== 'pages' && next !== 'outline') return
  mode = next
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {}
  applyMode()
}

function applyMode() {
  const pagesEl = document.getElementById('thumbnail-list')
  const outlineEl = document.getElementById('outline-list')
  if (pagesEl) pagesEl.hidden = mode !== 'pages'
  if (outlineEl) outlineEl.hidden = mode !== 'outline'
  for (const btn of document.querySelectorAll('#sidebar-tabs [data-view]')) {
    const on = btn.dataset.view === mode
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
    btn.classList.toggle('active', on)
  }
  if (mode === 'outline') {
    if (stale) rebuild()
    else renderOutline()
  }
}

function scheduleRebuild() {
  clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(rebuild, 150)
}

// ─────────── Building ───────────

async function rebuild() {
  clearTimeout(rebuildTimer)
  const gen = ++generation
  stale = false
  if (!appState.filePath || appState.pages.length === 0) {
    nodes = []
    source = 'none'
    status = 'done'
    renderOutline()
    return
  }
  status = 'building'
  renderOutline()
  try {
    let result = await embeddedNodes()
    if (gen !== generation) return
    if (result && result.length) {
      source = 'embedded'
    } else {
      result = await detectedNodes(gen)
      if (gen !== generation) return
      source = result.length ? 'detected' : 'none'
    }
    nodes = result
  } catch (err) {
    console.error('outline failed', err)
    nodes = []
    source = 'none'
  }
  status = 'done'
  collapsed = new Set()
  renderOutline()
}

// The PDF's bookmark tree, resolved to original page indices once per document.
async function loadEmbeddedTree(doc) {
  if (embeddedCache.doc === doc) return embeddedCache.tree
  let tree = []
  try {
    const raw = await doc.getOutline()
    if (raw?.length) tree = await resolveItems(doc, raw, 0)
  } catch (err) {
    console.error('could not read PDF outline', err)
  }
  embeddedCache = { doc, tree }
  return tree
}

async function resolveItems(doc, items, depth) {
  const out = []
  for (const item of items) {
    let originalIndex = null
    let pdfX = null
    let pdfY = null
    try {
      let dest = item.dest
      if (typeof dest === 'string') dest = await doc.getDestination(dest)
      if (Array.isArray(dest) && dest.length) {
        const ref = dest[0]
        originalIndex = typeof ref === 'object' && ref !== null ? await doc.getPageIndex(ref) : ref
        // Position on the page: /XYZ left top zoom, /FitH top, /FitBH top, /FitR l b r t.
        const kind = dest[1]?.name
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
        if (kind === 'XYZ') {
          pdfX = num(dest[2])
          pdfY = num(dest[3])
        } else if (kind === 'FitH' || kind === 'FitBH') {
          pdfY = num(dest[2])
        } else if (kind === 'FitR') {
          pdfX = num(dest[2])
          pdfY = num(dest[5])
        }
      }
    } catch {
      originalIndex = null
    }
    out.push({
      title: String(item.title || '').trim() || '(untitled)',
      originalIndex: Number.isInteger(originalIndex) ? originalIndex : null,
      pdfX,
      pdfY,
      children: item.items?.length ? await resolveItems(doc, item.items, depth + 1) : [],
    })
  }
  return out
}

// Map the bookmark tree onto the composed pages. Entries whose page was deleted
// are dropped, and their children move up a level.
async function embeddedNodes() {
  const doc = getPdfDoc()
  if (!doc) return null
  const tree = await loadEmbeddedTree(doc)
  if (!tree.length) return null
  const byOriginal = new Map()
  appState.pages.forEach((p, i) => {
    if (p.sourceId === 'primary' && p.originalIndex >= 0 && !byOriginal.has(p.originalIndex)) {
      byOriginal.set(p.originalIndex, i)
    }
  })
  const out = []
  const walk = (items, depth) => {
    for (const item of items) {
      const pageIndex = item.originalIndex === null ? undefined : byOriginal.get(item.originalIndex)
      const start = out.length
      if (pageIndex !== undefined) {
        out.push({ title: item.title, pageIndex, depth, hasChildren: false, pdfX: item.pdfX, pdfY: item.pdfY })
        walk(item.children, depth + 1)
        if (out.length > start + 1) out[start].hasChildren = true
      } else {
        walk(item.children, depth)
      }
    }
  }
  walk(tree, 0)
  return out
}

// Fallback for PDFs without bookmarks: lines set noticeably larger than the
// body text are treated as headings; the three largest sizes become levels.
async function detectedNodes(gen) {
  const sizeChars = new Map() // rounded size -> character count
  const pageLines = []
  for (let i = 0; i < appState.pages.length; i++) {
    if (gen !== generation) return []
    const entry = appState.pages[i]
    if (entry.originalIndex === -1 || !entry.sourceId) {
      pageLines.push([])
      continue
    }
    let content
    try {
      content = await getPageTextContent(entry.sourceId, entry.originalIndex)
    } catch {
      pageLines.push([])
      continue
    }
    const lines = []
    let current = null
    for (const item of content.items) {
      if (!item.str || !item.transform) continue
      const size = Math.round(Math.hypot(item.transform[2], item.transform[3]) * 2) / 2
      if (size <= 0) continue
      const y = item.transform[5]
      const text = item.str
      if (text.trim()) sizeChars.set(size, (sizeChars.get(size) || 0) + text.trim().length)
      if (current && Math.abs(current.y - y) < 2) {
        current.text += text
        current.size = Math.max(current.size, text.trim() ? size : 0)
      } else {
        current = { y, x: item.transform[4], text, size: text.trim() ? size : 0 }
        lines.push(current)
      }
    }
    pageLines.push(lines)
    if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0)) // keep the UI responsive
  }

  let body = 0
  let best = -1
  for (const [size, chars] of sizeChars) {
    if (chars > best) {
      best = chars
      body = size
    }
  }
  if (!body) return []

  let candidates = []
  pageLines.forEach((lines, pageIndex) => {
    let prev = null // previous heading line on this page, to join wrapped headings
    for (const line of lines) {
      const text = line.text.replace(/\s+/g, ' ').trim()
      const isHeading =
        line.size >= body * 1.2 &&
        line.size >= body + 1 &&
        text.length >= 2 &&
        !/^[\d\s.\-–]+$/.test(text) // page numbers
      if (!isHeading) {
        prev = null
        continue
      }
      // A heading that wraps onto a second line (same size, tight spacing) is one entry.
      if (prev && prev.size === line.size && prev.y - line.y > 0 && prev.y - line.y < line.size * 1.6) {
        prev.cand.title += ' ' + text
        prev.y = line.y
        continue
      }
      const cand = { title: text, pageIndex, size: line.size, pdfX: line.x, pdfY: line.y + line.size }
      candidates.push(cand)
      prev = { cand, size: line.size, y: line.y }
    }
  })
  candidates = candidates.filter((c) => c.title.length <= 100)

  // Running headers / footers repeat on many pages; they are not sections.
  const pagesByTitle = new Map()
  for (const c of candidates) {
    const set = pagesByTitle.get(c.title) || new Set()
    set.add(c.pageIndex)
    pagesByTitle.set(c.title, set)
  }
  candidates = candidates.filter((c) => pagesByTitle.get(c.title).size < 3)
  if (!candidates.length || candidates.length > MAX_DETECTED) return []

  // Sizes within 1pt of each other are the same level (rounding and font hinting
  // make one heading style vary slightly). The three largest levels are kept.
  const distinct = [...new Set(candidates.map((c) => c.size))].sort((a, b) => b - a)
  const levels = [] // representative (largest) size per level
  for (const s of distinct) {
    if (!levels.length || levels[levels.length - 1] - s >= 1) levels.push(s)
  }
  const levelOf = (size) => levels.findIndex((l) => l - size < 1)
  const keep = levels.slice(0, MAX_DEPTH)
  const usable = candidates
    .map((c) => ({ ...c, depth: levelOf(c.size) }))
    .filter((c) => c.depth >= 0 && c.depth < keep.length)
  return usable.map((c, i) => {
    const next = usable[i + 1]
    return {
      title: c.title,
      pageIndex: c.pageIndex,
      depth: c.depth,
      hasChildren: !!next && next.depth > c.depth,
      pdfX: c.pdfX,
      pdfY: c.pdfY,
    }
  })
}

// ─────────── Rendering ───────────

function nodeKey(i) {
  return `${i}:${nodes[i].title}`
}

function renderOutline() {
  const list = document.getElementById('outline-list')
  if (!list || mode !== 'outline') return
  list.replaceChildren()

  const message = (text) => {
    const p = document.createElement('p')
    p.className = 'outline-empty'
    p.textContent = text
    list.appendChild(p)
  }

  if (!appState.filePath) return message('No PDF open.')
  if (status === 'building') return message('Building outline…')
  if (!nodes.length) return message('No section headings found in this document.')

  const frag = document.createDocumentFragment()
  let hideBelow = Infinity // depth at/below which items are hidden by a collapsed ancestor
  nodes.forEach((n, i) => {
    if (n.depth > hideBelow) return
    hideBelow = Infinity
    const row = document.createElement('div')
    row.className = 'outline-item'
    row.dataset.index = String(i)
    row.dataset.page = String(n.pageIndex)
    row.title = `${n.title} (page ${n.pageIndex + 1})`
    row.style.paddingLeft = 6 + n.depth * 14 + 'px'
    row.setAttribute('role', 'button')
    row.tabIndex = 0

    const caret = document.createElement('span')
    caret.className = 'outline-caret'
    if (n.hasChildren) {
      const isCollapsed = collapsed.has(nodeKey(i))
      caret.textContent = isCollapsed ? '▸' : '▾'
      caret.dataset.toggle = '1'
      if (isCollapsed) hideBelow = n.depth
    }
    row.appendChild(caret)

    const title = document.createElement('span')
    title.className = 'outline-title'
    title.textContent = n.title
    title.title = n.title
    row.appendChild(title)

    const pg = document.createElement('span')
    pg.className = 'outline-page'
    pg.textContent = String(n.pageIndex + 1)
    row.appendChild(pg)
    frag.appendChild(row)
  })
  list.appendChild(frag)

  if (source === 'detected') {
    const note = document.createElement('p')
    note.className = 'outline-note'
    note.textContent = 'No bookmarks in this PDF. Headings are detected from text size.'
    list.appendChild(note)
  }
  updateCurrent()
}

function updateCurrent() {
  if (mode !== 'outline') return
  const rows = document.querySelectorAll('#outline-list .outline-item')
  let currentRow = null
  for (const row of rows) {
    // Last visible heading that starts on or before the focused page.
    if (Number(row.dataset.page) <= appState.focusedPage) currentRow = row
  }
  for (const row of rows) row.classList.toggle('current', row === currentRow)
}

function onOutlineClick(e) {
  const row = e.target.closest('.outline-item')
  if (!row) return
  if (e.target.closest('[data-toggle]')) {
    const key = nodeKey(Number(row.dataset.index))
    if (collapsed.has(key)) collapsed.delete(key)
    else collapsed.add(key)
    renderOutline()
    return
  }
  const page = Number(row.dataset.page)
  const node = nodes[Number(row.dataset.index)]
  if (page !== appState.focusedPage) {
    dispatch({ type: 'SET_SELECTED_PAGES', pages: new Set([page]) })
    dispatch({ type: 'SET_FOCUSED_PAGE', page })
  }
  jumpToNode(node, page)
}

// Scroll so the heading itself (not just its page) is at the top of the viewport.
async function jumpToNode(node, page) {
  let ratio = 0
  const entry = appState.pages[page]
  if (node && entry && entry.originalIndex >= 0 && node.pdfY != null) {
    try {
      const pdfPage = await getPage(entry.sourceId, entry.originalIndex)
      const viewport = pdfPage.getViewport({ scale: 1, rotation: entry.rotation })
      const [, vy] = viewport.convertToViewportPoint(node.pdfX ?? 0, node.pdfY ?? 0)
      if (Number.isFinite(vy) && viewport.height > 0) ratio = vy / viewport.height
    } catch {
      ratio = 0
    }
  }
  if (ratio > 0) scrollPreviewToPageOffset(page, ratio)
  else scrollPreviewToFocused({ force: true })
}
