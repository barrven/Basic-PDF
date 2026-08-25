import { TextLayer } from '../node_modules/pdfjs-dist/build/pdf.mjs'
import { appState, dispatch } from './state.js'
import { getPage, getPageTextContent, drawBlankPlaceholder, PAGE_SIZE_A4, visualPageSize } from './renderer.js'
import { handlePlacementClick, handlePlacementMove, isPlacing, exitPlacementMode } from './signature.js'
import { snapZoom } from './zoom.js'

let lastRenderToken = 0
let pageViews = [] // { index, el, canvas, textLayerEl, textLayer, highlightLayer, redactLayer, overlay, scale, pdfWidth, pdfHeight, renderedToken }
let pageObserver = null
let scrollFocusRaf = 0
let ignoreScrollSync = false
let pendingScrollAnchor = null
let wheelZoomAccum = 0
let wheelZoomAccumTimer = 0
const WHEEL_ZOOM_THRESHOLD = 80
let textPointerDown = null
const textLayerPaintListeners = new Set()
let previewIdle = Promise.resolve()

export function initPreview() {
  const pane = document.getElementById('preview-pane')
  const pagesHost = document.getElementById('preview-pages')

  pane.addEventListener('pointerdown', (e) => {
    if (e.target.closest?.('.textLayer')) {
      textPointerDown = { x: e.clientX, y: e.clientY }
      e.target.closest('.textLayer').classList.add('selecting')
    } else {
      textPointerDown = null
    }
  })

  document.addEventListener('pointerup', () => {
    for (const view of pageViews) {
      view.textLayerEl?.classList.remove('selecting')
    }
  })

  pane.addEventListener('click', (e) => {
    if (isPlacing()) {
      handlePlacementClick(e, pageViewFromEvent(e))
      return
    }
    if (e.target.closest('.sig-overlay')) return
    if (e.target.closest('.annot-redact-rect')) return
    if (clickFinishedTextDrag(e) || textSelectionIsNonCollapsed()) return
    if (appState.selectedSig) {
      dispatch({ type: 'SET_SELECTED_SIG', id: null })
    }
    if (appState.selectedAnnotation) {
      dispatch({ type: 'SET_SELECTED_ANNOTATION', id: null })
    }
  })

  pane.addEventListener('mousemove', (e) => {
    if (!isPlacing()) return
    handlePlacementMove(e, pageViewFromEvent(e))
  })

  pagesHost.addEventListener('click', (e) => {
    if (isPlacing()) return
    const redact = e.target.closest('.annot-redact-rect')
    if (redact) {
      e.stopPropagation()
      dispatch({ type: 'SET_SELECTED_ANNOTATION', id: redact.dataset.id })
      const pageEl = redact.closest('.preview-page')
      const idx = pageEl ? Number(pageEl.dataset.index) : -1
      if (idx >= 0 && idx !== appState.focusedPage) {
        dispatch({ type: 'SET_FOCUSED_PAGE', page: idx })
      }
      return
    }
    const overlay = e.target.closest('.sig-overlay')
    if (!overlay) return
    e.stopPropagation()
    dispatch({ type: 'SET_SELECTED_SIG', id: overlay.dataset.id })
    const pageEl = overlay.closest('.preview-page')
    const idx = pageEl ? Number(pageEl.dataset.index) : -1
    if (idx >= 0 && idx !== appState.focusedPage) {
      dispatch({ type: 'SET_FOCUSED_PAGE', page: idx })
    }
  })

  initOverlayInteractions()

  pane.addEventListener('scroll', () => {
    if (scrollFocusRaf) return
    scrollFocusRaf = requestAnimationFrame(() => {
      scrollFocusRaf = 0
      syncFocusedPageFromScroll()
    })
  }, { passive: true })

  pane.addEventListener('wheel', onPreviewWheel, { passive: false })

  window.addEventListener('resize', () => {
    if (appState.zoom === null && appState.filePath) {
      renderPreview()
    }
  })
  window.addEventListener('sidebar-resized', () => {
    if (appState.zoom === null && appState.filePath) {
      renderPreview()
    }
  })
}

function modalIsOpen() {
  const m = document.getElementById('modal-backdrop')
  const e = document.getElementById('error-modal-backdrop')
  const a = document.getElementById('about-modal-backdrop')
  return (m && !m.hidden) || (e && !e.hidden) || (a && !a.hidden)
}

function onPreviewWheel(e) {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  if (!appState.filePath || appState.pages.length === 0) return
  if (isPlacing() || modalIsOpen()) return

  let dy = e.deltaY
  if (e.deltaMode === 1) dy *= 16
  else if (e.deltaMode === 2) dy *= 48

  wheelZoomAccum += dy
  if (wheelZoomAccumTimer) clearTimeout(wheelZoomAccumTimer)
  wheelZoomAccumTimer = setTimeout(() => {
    wheelZoomAccum = 0
    wheelZoomAccumTimer = 0
  }, 250)
  if (Math.abs(wheelZoomAccum) < WHEEL_ZOOM_THRESHOLD) return

  const direction = wheelZoomAccum > 0 ? 'out' : 'in'
  wheelZoomAccum = 0

  const view = pageViewFromEvent(e)
  const currentScale = view?.scale ?? getCurrentScale()
  const current = appState.zoom ?? Math.round(currentScale * 100)
  const next = snapZoom(direction, current)
  if (next === appState.zoom) return
  if (appState.zoom == null && next === current) return

  pendingScrollAnchor = captureZoomAnchor(e)
  dispatch({ type: 'SET_ZOOM', zoom: next })
}

function captureZoomAnchor(e) {
  const pane = document.getElementById('preview-pane')
  const paneRect = pane.getBoundingClientRect()
  const view = pageViewFromEvent(e)
  if (view) {
    const elRect = view.el.getBoundingClientRect()
    return {
      pageIndex: view.index,
      pageYRatio: elRect.height > 0 ? (e.clientY - elRect.top) / elRect.height : 0,
      pageXRatio: elRect.width > 0 ? (e.clientX - elRect.left) / elRect.width : 0.5,
      cursorYInPane: e.clientY - paneRect.top,
      cursorXInPane: e.clientX - paneRect.left,
    }
  }
  return {
    pageIndex: pageIndexAtViewport(),
    pageYRatio: 0,
    pageXRatio: 0.5,
    cursorYInPane: Math.min(96, paneRect.height * 0.2),
    cursorXInPane: paneRect.width / 2,
  }
}

function restoreScrollAnchor(anchor) {
  const view = pageViews[anchor.pageIndex]
  const pane = document.getElementById('preview-pane')
  if (!view || !pane) return
  const paneRect = pane.getBoundingClientRect()
  const elRect = view.el.getBoundingClientRect()
  const pageTop = elRect.top - paneRect.top + pane.scrollTop
  const pageLeft = elRect.left - paneRect.left + pane.scrollLeft
  ignoreScrollSync = true
  pane.scrollTo({
    top: Math.max(0, pageTop + view.el.offsetHeight * anchor.pageYRatio - anchor.cursorYInPane),
    left: Math.max(0, pageLeft + view.el.offsetWidth * anchor.pageXRatio - anchor.cursorXInPane),
    behavior: 'auto',
  })
  requestAnimationFrame(() => {
    ignoreScrollSync = false
  })
}

function paneInnerWidth() {
  const pane = document.getElementById('preview-pane')
  return Math.max(80, pane.clientWidth - 48)
}

function scaleForWidth(pdfWidth) {
  if (appState.zoom === null) {
    return Math.max(0.05, paneInnerWidth() / pdfWidth)
  }
  return appState.zoom / 100
}

async function measurePage(entry) {
  if (entry.originalIndex === -1) {
    return visualPageSize(PAGE_SIZE_A4.width, PAGE_SIZE_A4.height, entry.rotation)
  }
  const page = await getPage(entry.sourceId, entry.originalIndex)
  const viewport = page.getViewport({ scale: 1, rotation: entry.rotation })
  return { width: viewport.width, height: viewport.height }
}

function clearPageViews() {
  if (pageObserver) {
    pageObserver.disconnect()
    pageObserver = null
  }
  for (const view of pageViews) {
    try { view.textLayer?.cancel() } catch {}
    view.textLayer = null
  }
  pageViews = []
  const host = document.getElementById('preview-pages')
  if (host) host.innerHTML = ''
}

function syncPlacementPointerEvents() {
  const pane = document.getElementById('preview-pane')
  if (!pane) return
  pane.classList.toggle('is-placing', isPlacing())
}

function ensureObserver() {
  const pane = document.getElementById('preview-pane')
  if (pageObserver) pageObserver.disconnect()
  pageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const index = Number(entry.target.dataset.index)
      renderPageCanvas(index, lastRenderToken).catch((err) => {
        console.error('preview page render failed', err)
      })
    }
  }, { root: pane, rootMargin: '800px 0px' })
}

export function whenPreviewIdle() {
  return previewIdle
}

export function addTextLayerPaintListener(fn) {
  textLayerPaintListeners.add(fn)
  return () => textLayerPaintListeners.delete(fn)
}

function markTextLayerPainted(view) {
  if (!view) return
  view.textLayerPainted = true
  for (const fn of textLayerPaintListeners) {
    try { fn(view.index) } catch (err) { console.error(err) }
  }
}

export async function waitForTextLayer(pageIndex) {
  const existing = pageViews[pageIndex]
  if (existing?.textLayerPainted) return existing
  return new Promise((resolve) => {
    let settled = false
    let timer = 0
    const finish = (view) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      remove()
      resolve(view || null)
    }
    const remove = addTextLayerPaintListener((index) => {
      if (index !== pageIndex) return
      const view = pageViews[pageIndex]
      if (view?.textLayerPainted) finish(view)
    })
    const view = pageViews[pageIndex]
    if (view?.textLayerPainted) {
      finish(view)
      return
    }
    if (view) {
      renderPageCanvas(pageIndex, lastRenderToken).catch((err) => console.error(err))
    }
    timer = setTimeout(() => finish(pageViews[pageIndex] || null), 10000)
  })
}

export async function renderPreview() {
  let releaseIdle
  previewIdle = new Promise((resolve) => { releaseIdle = resolve })
  try {
    await renderPreviewInner()
  } finally {
    releaseIdle()
  }
}

async function renderPreviewInner() {
  const pane = document.getElementById('preview-pane')
  const container = document.getElementById('preview-container')
  const host = document.getElementById('preview-pages')
  const empty = document.getElementById('empty-state')
  const myToken = ++lastRenderToken

  if (!appState.filePath || appState.pages.length === 0) {
    pendingScrollAnchor = null
    clearPageViews()
    if (container) container.hidden = true
    if (empty) empty.hidden = false
    return
  }
  if (empty) empty.hidden = true
  if (container) container.hidden = false

  const sizes = await Promise.all(appState.pages.map(async (entry) => {
    try {
      return await measurePage(entry)
    } catch (err) {
      console.error('preview measure failed', err)
      return { ...PAGE_SIZE_A4 }
    }
  }))
  if (myToken !== lastRenderToken) return

  clearPageViews()
  ensureObserver()

  for (let i = 0; i < appState.pages.length; i++) {
    const size = sizes[i] || PAGE_SIZE_A4
    const scale = scaleForWidth(size.width)
    const pxW = Math.max(1, Math.floor(size.width * scale))
    const pxH = Math.max(1, Math.floor(size.height * scale))

    const el = document.createElement('div')
    el.className = 'preview-page'
    el.dataset.index = String(i)
    el.style.width = pxW + 'px'
    el.style.height = pxH + 'px'

    const canvas = document.createElement('canvas')
    canvas.width = pxW
    canvas.height = pxH
    canvas.style.width = pxW + 'px'
    canvas.style.height = pxH + 'px'
    el.appendChild(canvas)

    const highlightLayer = document.createElement('div')
    highlightLayer.className = 'annot-highlight-layer'
    el.appendChild(highlightLayer)

    const textLayerEl = document.createElement('div')
    textLayerEl.className = 'textLayer'
    el.appendChild(textLayerEl)

    const redactLayer = document.createElement('div')
    redactLayer.className = 'annot-redact-layer'
    el.appendChild(redactLayer)

    const overlay = document.createElement('div')
    overlay.className = 'signature-overlay-layer'
    el.appendChild(overlay)

    host.appendChild(el)
    pageViews.push({
      index: i,
      el,
      canvas,
      textLayerEl,
      textLayer: null,
      textLayerPainted: false,
      highlightLayer,
      redactLayer,
      overlay,
      scale,
      pdfWidth: size.width,
      pdfHeight: size.height,
      renderedToken: -1,
    })
    pageObserver.observe(el)
  }

  syncPlacementPointerEvents()
  renderSignatureOverlays()
  renderAnnotationOverlays()
  const focused = pageViews[appState.focusedPage]
  if (focused) {
    renderPageCanvas(appState.focusedPage, myToken).catch((err) => console.error(err))
  }
  requestAnimationFrame(() => {
    if (myToken !== lastRenderToken) return
    if (pendingScrollAnchor) {
      const anchor = pendingScrollAnchor
      pendingScrollAnchor = null
      restoreScrollAnchor(anchor)
      return
    }
    if (focused) scrollPreviewToFocused({ force: true })
  })
}

async function renderPageCanvas(index, token) {
  const view = pageViews[index]
  if (!view) return
  if (token !== lastRenderToken) return
  if (view.renderedToken === token) return
  const entry = appState.pages[index]
  if (!entry) return

  try {
    if (entry.originalIndex === -1) {
      drawBlankPlaceholder(view.canvas, view.canvas.width, view.canvas.height)
      view.renderedToken = token
      markTextLayerPainted(view)
      return
    }
    const page = await getPage(entry.sourceId, entry.originalIndex)
    if (token !== lastRenderToken) return
    const viewport = page.getViewport({ scale: view.scale, rotation: entry.rotation })
    const offscreen = document.createElement('canvas')
    offscreen.width = Math.floor(viewport.width)
    offscreen.height = Math.floor(viewport.height)
    const ctx = offscreen.getContext('2d')
    await page.render({ canvasContext: ctx, viewport }).promise
    if (token !== lastRenderToken) return
    const dest = view.canvas.getContext('2d')
    dest.clearRect(0, 0, view.canvas.width, view.canvas.height)
    dest.drawImage(offscreen, 0, 0, view.canvas.width, view.canvas.height)
    view.renderedToken = token
    await renderPageTextLayer(view, viewport, token, entry)
  } catch (err) {
    if (token !== lastRenderToken) return
    if (err && err.name === 'RenderingCancelledException') return
    if (err && err.name === 'AbortException') return
    console.error('preview render failed', err)
    const styles = getComputedStyle(document.documentElement)
    const ctx = view.canvas.getContext('2d')
    ctx.fillStyle = styles.getPropertyValue('--render-error-bg').trim() || '#2A2A2A'
    ctx.fillRect(0, 0, view.canvas.width, view.canvas.height)
    ctx.fillStyle = styles.getPropertyValue('--text-muted').trim() || '#888888'
    ctx.font = '14px "DM Sans", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Page could not be rendered', view.canvas.width / 2, view.canvas.height / 2)
    view.renderedToken = token
    markTextLayerPainted(view)
  }
}

function isTextLayerCancel(err) {
  return err && (err.name === 'AbortException' || /cancelled/i.test(err.message || ''))
}

async function renderPageTextLayer(view, viewport, token, entry) {
  const layerEl = view.textLayerEl
  if (!layerEl) {
    if (token === lastRenderToken) markTextLayerPainted(view)
    return
  }
  try {
    try { view.textLayer?.cancel() } catch {}
    view.textLayer = null
    layerEl.replaceChildren()
    layerEl.style.setProperty('--scale-factor', String(viewport.scale))

    let textContent
    try {
      textContent = await getPageTextContent(entry.sourceId, entry.originalIndex)
    } catch (err) {
      if (token !== lastRenderToken || isTextLayerCancel(err)) return
      console.error('text content failed', err)
      return
    }
    if (token !== lastRenderToken) return
    if (!textContent?.items?.length) return

    const layer = new TextLayer({
      textContentSource: textContent,
      container: layerEl,
      viewport,
    })
    view.textLayer = layer
    try {
      await layer.render()
    } catch (err) {
      if (token !== lastRenderToken || isTextLayerCancel(err)) return
      console.error('text layer render failed', err)
      return
    }
    if (token !== lastRenderToken) {
      try { layer.cancel() } catch {}
      return
    }
    const end = document.createElement('div')
    end.className = 'endOfContent'
    layerEl.append(end)
    applyRedactionTextLocks(view)
  } finally {
    if (token === lastRenderToken && pageViews[view.index] === view) {
      markTextLayerPainted(view)
    }
  }
}

export function textLayerFromSelection() {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const node = sel.anchorNode
  if (!node) return null
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
  return el?.closest('.textLayer') || null
}

export function getPageViewByIndex(index) {
  return pageViews[index] || null
}

export function textSelectionIsActive() {
  return !!textLayerFromSelection()
}

export function textSelectionIsNonCollapsed() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) return false
  return textSelectionIsActive()
}

function clickFinishedTextDrag(e) {
  const start = textPointerDown
  textPointerDown = null
  if (!start) return false
  const dx = e.clientX - start.x
  const dy = e.clientY - start.y
  return (dx * dx + dy * dy) > 9
}

export function selectAllTextInActiveLayer() {
  const sel = window.getSelection()
  if (!sel) return false
  const layer = textLayerFromSelection()
  if (!layer || !layer.querySelector('span')) return false
  const range = document.createRange()
  range.selectNodeContents(layer)
  const end = layer.querySelector('.endOfContent')
  if (end) range.setEndBefore(end)
  sel.removeAllRanges()
  sel.addRange(range)
  return true
}

function spanSourceText(span) {
  return span.dataset.findText ?? span.textContent ?? ''
}

function restoreFindSpan(span) {
  if (span.dataset.findText == null) return
  span.textContent = span.dataset.findText
  delete span.dataset.findText
}

function segmentsFromHit(divs, hit) {
  let remaining = hit.length
  let offset = hit.offset
  const segs = []
  for (let i = hit.itemIndex; i < divs.length && remaining > 0; i++) {
    const text = spanSourceText(divs[i])
    const start = i === hit.itemIndex ? offset : 0
    if (start > text.length) break
    const take = Math.min(remaining, text.length - start)
    if (take > 0) {
      segs.push({ itemIndex: i, offset: start, length: take })
      remaining -= take
    }
  }
  return segs
}

function paintSpanHighlights(span, ranges) {
  const original = spanSourceText(span)
  span.dataset.findText = original
  const ordered = ranges.slice().sort((a, b) => a.offset - b.offset)
  span.textContent = ''
  let cursor = 0
  for (const r of ordered) {
    const start = Math.max(0, Math.min(original.length, r.offset))
    const end = Math.max(start, Math.min(original.length, r.offset + r.length))
    if (start < cursor) continue
    if (start > cursor) span.append(original.slice(cursor, start))
    const mark = document.createElement('span')
    mark.className = r.isCurrent ? 'find-match find-match-current' : 'find-match'
    mark.dataset.findIdx = String(r.matchIndex)
    mark.textContent = original.slice(start, end)
    span.append(mark)
    cursor = end
  }
  if (cursor < original.length) span.append(original.slice(cursor))
}

function paintViewHighlights(view, hits) {
  const divs = view.textLayer?.textDivs
  if (!divs || divs.length === 0) return
  for (const span of divs) restoreFindSpan(span)
  if (!hits.length) return
  const rangesByDiv = new Map()
  for (const hit of hits) {
    for (const seg of segmentsFromHit(divs, hit)) {
      let list = rangesByDiv.get(seg.itemIndex)
      if (!list) {
        list = []
        rangesByDiv.set(seg.itemIndex, list)
      }
      list.push({
        offset: seg.offset,
        length: seg.length,
        matchIndex: hit.matchIndex,
        isCurrent: hit.isCurrent,
      })
    }
  }
  for (const [itemIndex, ranges] of rangesByDiv) {
    const span = divs[itemIndex]
    if (!span || !span.isConnected) continue
    paintSpanHighlights(span, ranges)
  }
}

export function applyFindHighlights(matches, currentIndex) {
  const byPage = new Map()
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    let list = byPage.get(m.pageIndex)
    if (!list) {
      list = []
      byPage.set(m.pageIndex, list)
    }
    list.push({ ...m, matchIndex: i, isCurrent: i === currentIndex })
  }
  for (const view of pageViews) {
    if (!view.textLayerPainted) continue
    paintViewHighlights(view, byPage.get(view.index) || [])
  }
}

export function applyFindHighlightsForPage(pageIndex, matches, currentIndex) {
  const view = pageViews[pageIndex]
  if (!view?.textLayerPainted) return
  const hits = []
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    if (m.pageIndex !== pageIndex) continue
    hits.push({ ...m, matchIndex: i, isCurrent: i === currentIndex })
  }
  paintViewHighlights(view, hits)
}

export function setCurrentFindHighlight(currentIndex) {
  for (const el of document.querySelectorAll('.textLayer .find-match-current')) {
    el.classList.remove('find-match-current')
  }
  if (currentIndex < 0) return
  for (const el of document.querySelectorAll(`.textLayer [data-find-idx="${currentIndex}"]`)) {
    el.classList.add('find-match-current')
  }
}

export function scrollCurrentFindMatchIntoView() {
  const el = document.querySelector('.textLayer .find-match-current')
  const pane = document.getElementById('preview-pane')
  if (!el || !pane) return
  const paneRect = pane.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  const pad = 24
  const fullyVisible = elRect.top >= paneRect.top + pad && elRect.bottom <= paneRect.bottom - pad
  if (fullyVisible) return
  const elCenter = elRect.top + elRect.height / 2
  const paneCenter = paneRect.top + paneRect.height / 2
  ignoreScrollSync = true
  pane.scrollTo({
    top: Math.max(0, pane.scrollTop + (elCenter - paneCenter)),
    behavior: 'auto',
  })
  document.documentElement.scrollTop = 0
  document.body.scrollTop = 0
  requestAnimationFrame(() => {
    ignoreScrollSync = false
  })
}

export function clearFindHighlights() {
  for (const view of pageViews) {
    const divs = view.textLayer?.textDivs
    if (!divs) continue
    for (const span of divs) restoreFindSpan(span)
  }
}

export function renderSignatureOverlays() {
  for (const view of pageViews) {
    const layer = view.overlay
    if (!layer) continue
    layer.innerHTML = ''
    for (const sig of appState.signatures) {
      if (sig.pageIndex !== view.index) continue
      const div = document.createElement('div')
      div.className = 'sig-overlay'
      div.dataset.id = sig.id
      div.style.left = sig.x * view.scale + 'px'
      div.style.top = sig.y * view.scale + 'px'
      div.style.width = sig.width * view.scale + 'px'
      div.style.height = sig.height * view.scale + 'px'
      div.style.opacity = String(sig.opacity ?? 1)
      const img = document.createElement('img')
      img.src = sig.dataUrl
      img.style.width = '100%'
      img.style.height = '100%'
      img.style.display = 'block'
      img.draggable = false
      div.appendChild(img)
      if (appState.selectedSig === sig.id) {
        div.classList.add('sig-selected')
        const positions = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
        for (const pos of positions) {
          const h = document.createElement('div')
          h.className = `sig-handle sig-handle-${pos}`
          h.dataset.handle = pos
          div.appendChild(h)
        }
      }
      layer.appendChild(div)
    }
  }
}

function annotRectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y
}

function applyRedactionTextLocks(view) {
  const divs = view.textLayer?.textDivs
  if (!divs) return
  for (const span of divs) {
    span.style.userSelect = ''
    span.style.pointerEvents = ''
    span.removeAttribute('aria-hidden')
  }
  const redacts = appState.annotations.filter((a) => a.type === 'redact' && a.pageIndex === view.index)
  if (!redacts.length) return
  const scale = view.scale || 1
  const pageRect = view.el.getBoundingClientRect()
  for (const span of divs) {
    const sr = span.getBoundingClientRect()
    if (sr.width < 1 || sr.height < 1) continue
    const box = {
      x: (sr.left - pageRect.left) / scale,
      y: (sr.top - pageRect.top) / scale,
      width: sr.width / scale,
      height: sr.height / scale,
    }
    const covered = redacts.some((a) => a.rects.some((r) => annotRectsOverlap(r, box)))
    if (covered) {
      span.style.userSelect = 'none'
      span.style.pointerEvents = 'none'
      span.setAttribute('aria-hidden', 'true')
    }
  }
}

function paintAnnotRects(layer, annotations, className, scale) {
  if (!layer) return
  layer.replaceChildren()
  for (const annot of annotations) {
    for (const r of annot.rects) {
      const div = document.createElement('div')
      div.className = className
      div.dataset.id = annot.id
      div.style.left = r.x * scale + 'px'
      div.style.top = r.y * scale + 'px'
      div.style.width = r.width * scale + 'px'
      div.style.height = r.height * scale + 'px'
      if (annot.type === 'highlight' && annot.color) {
        div.style.background = annot.color
      }
      if (annot.id === appState.selectedAnnotation) {
        div.classList.add('annot-selected')
      }
      layer.appendChild(div)
    }
  }
}

export function renderAnnotationOverlays() {
  for (const view of pageViews) {
    const scale = view.scale || 1
    const onPage = appState.annotations.filter((a) => a.pageIndex === view.index)
    paintAnnotRects(
      view.highlightLayer,
      onPage.filter((a) => a.type === 'highlight'),
      'annot-highlight-rect',
      scale,
    )
    paintAnnotRects(
      view.redactLayer,
      onPage.filter((a) => a.type === 'redact'),
      'annot-redact-rect',
      scale,
    )
    if (view.textLayerPainted) applyRedactionTextLocks(view)
  }
}

function pageViewFromEvent(e) {
  const el = e.target.closest?.('.preview-page')
  if (el) {
    const idx = Number(el.dataset.index)
    return pageViews[idx] || null
  }
  const x = e.clientX
  const y = e.clientY
  for (const view of pageViews) {
    const rect = view.canvas.getBoundingClientRect()
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return view
    }
  }
  return null
}

function pageIndexAtViewport() {
  const pane = document.getElementById('preview-pane')
  if (!pane || pageViews.length === 0) return 0
  const paneRect = pane.getBoundingClientRect()
  const anchor = paneRect.top + Math.min(96, paneRect.height * 0.2)
  let best = 0
  let bestDist = Infinity
  for (const view of pageViews) {
    const r = view.el.getBoundingClientRect()
    if (r.top <= anchor && r.bottom >= anchor) return view.index
    const dist = Math.min(Math.abs(r.top - anchor), Math.abs(r.bottom - anchor))
    if (dist < bestDist) {
      bestDist = dist
      best = view.index
    }
  }
  return best
}

function syncFocusedPageFromScroll() {
  if (ignoreScrollSync) return
  if (!appState.filePath || pageViews.length === 0) return
  const idx = pageIndexAtViewport()
  if (idx === appState.focusedPage) return
  dispatch({ type: 'SET_FOCUSED_PAGE', page: idx })
  if (appState.selectedPages.size <= 1) {
    dispatch({ type: 'SET_SELECTED_PAGES', pages: new Set([idx]) })
  }
}

export function scrollPreviewToFocused(opts = {}) {
  const view = pageViews[appState.focusedPage]
  if (!view) return
  const pane = document.getElementById('preview-pane')
  if (!pane) return
  const paneRect = pane.getBoundingClientRect()
  const elRect = view.el.getBoundingClientRect()
  const visible = elRect.bottom > paneRect.top + 8 && elRect.top < paneRect.bottom - 8
  if (!opts.force && visible && elRect.top < paneRect.top + paneRect.height * 0.6) {
    return
  }
  const top = elRect.top - paneRect.top + pane.scrollTop - 8
  ignoreScrollSync = true
  pane.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
  requestAnimationFrame(() => {
    ignoreScrollSync = false
  })
}

function initOverlayInteractions() {
  const host = document.getElementById('preview-pages')

  let mode = null // 'move' | 'resize'
  let activeId = null
  let activeHandle = null
  let startPointer = null
  let startSig = null
  let didPushHistory = false
  let dragScale = 1

  host.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.sig-handle')
    const overlay = e.target.closest('.sig-overlay')
    if (handle && overlay) {
      mode = 'resize'
      activeId = overlay.dataset.id
      activeHandle = handle.dataset.handle
    } else if (overlay) {
      mode = 'move'
      activeId = overlay.dataset.id
    } else {
      return
    }
    const sig = appState.signatures.find((s) => s.id === activeId)
    if (!sig) return
    startSig = { ...sig }
    startPointer = { x: e.clientX, y: e.clientY }
    dragScale = pageViews[sig.pageIndex]?.scale ?? 1
    didPushHistory = false
    host.setPointerCapture(e.pointerId)
    e.preventDefault()
    e.stopPropagation()
  })

  host.addEventListener('pointermove', (e) => {
    if (!mode || !startSig) return
    if (!didPushHistory) {
      dispatch({ type: 'PUSH_HISTORY_SNAPSHOT' })
      didPushHistory = true
    }
    const dx = (e.clientX - startPointer.x) / dragScale
    const dy = (e.clientY - startPointer.y) / dragScale
    if (mode === 'move') {
      const nx = startSig.x + dx
      const ny = startSig.y + dy
      dispatch({ type: 'MOVE_SIGNATURE', id: activeId, x: nx, y: ny })
    } else if (mode === 'resize') {
      const r = startSig.width / startSig.height
      let newX = startSig.x
      let newY = startSig.y
      let newW = startSig.width
      let newH = startSig.height
      const min = 20
      switch (activeHandle) {
        case 'nw': {
          newW = Math.max(min, startSig.width - dx)
          newH = newW / r
          newX = startSig.x + (startSig.width - newW)
          newY = startSig.y + (startSig.height - newH)
          break
        }
        case 'ne': {
          newW = Math.max(min, startSig.width + dx)
          newH = newW / r
          newY = startSig.y + (startSig.height - newH)
          break
        }
        case 'se': {
          newW = Math.max(min, startSig.width + dx)
          newH = newW / r
          break
        }
        case 'sw': {
          newW = Math.max(min, startSig.width - dx)
          newH = newW / r
          newX = startSig.x + (startSig.width - newW)
          break
        }
        case 'n': {
          newH = Math.max(min, startSig.height - dy)
          newW = newH * r
          newY = startSig.y + (startSig.height - newH)
          break
        }
        case 's': {
          newH = Math.max(min, startSig.height + dy)
          newW = newH * r
          break
        }
        case 'e': {
          newW = Math.max(min, startSig.width + dx)
          newH = newW / r
          break
        }
        case 'w': {
          newW = Math.max(min, startSig.width - dx)
          newH = newW / r
          newX = startSig.x + (startSig.width - newW)
          break
        }
      }
      dispatch({
        type: 'RESIZE_SIGNATURE',
        id: activeId,
        x: newX,
        y: newY,
        width: newW,
        height: newH,
      })
    }
  })

  function endDrag(e) {
    if (!mode) return
    try { host.releasePointerCapture(e.pointerId) } catch {}
    mode = null
    activeId = null
    activeHandle = null
    startPointer = null
    startSig = null
    didPushHistory = false
  }
  host.addEventListener('pointerup', endDrag)
  host.addEventListener('pointercancel', endDrag)
}

export function getCurrentScale() {
  return pageViews[appState.focusedPage]?.scale ?? 1
}

export function getCurrentPageDimensions() {
  const view = pageViews[appState.focusedPage]
  if (!view) return { width: 0, height: 0 }
  return { width: view.pdfWidth, height: view.pdfHeight }
}

export function cancelPlacementOnEscape() {
  if (isPlacing()) {
    exitPlacementMode()
    return true
  }
  return false
}
