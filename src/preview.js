import { appState, dispatch } from './state.js'
import { getPage, drawBlankPlaceholder, PAGE_SIZE_A4, visualPageSize } from './renderer.js'
import { handlePlacementClick, handlePlacementMove, isPlacing, exitPlacementMode } from './signature.js'
import { snapZoom } from './zoom.js'

let lastRenderToken = 0
let pageViews = [] // { index, el, canvas, overlay, scale, pdfWidth, pdfHeight, renderedToken }
let pageObserver = null
let scrollFocusRaf = 0
let ignoreScrollSync = false
let pendingScrollAnchor = null
let wheelZoomAccum = 0
let wheelZoomAccumTimer = 0
const WHEEL_ZOOM_THRESHOLD = 80

export function initPreview() {
  const pane = document.getElementById('preview-pane')
  const pagesHost = document.getElementById('preview-pages')

  pane.addEventListener('click', (e) => {
    if (isPlacing()) {
      handlePlacementClick(e, pageViewFromEvent(e))
      return
    }
    if (e.target.closest('.sig-overlay')) return
    if (appState.selectedSig) {
      dispatch({ type: 'SET_SELECTED_SIG', id: null })
    }
  })

  pane.addEventListener('mousemove', (e) => {
    if (!isPlacing()) return
    handlePlacementMove(e, pageViewFromEvent(e))
  })

  pagesHost.addEventListener('click', (e) => {
    if (isPlacing()) return
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
  return (m && !m.hidden) || (e && !e.hidden)
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
  pageViews = []
  const host = document.getElementById('preview-pages')
  if (host) host.innerHTML = ''
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

export async function renderPreview() {
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

    const overlay = document.createElement('div')
    overlay.className = 'signature-overlay-layer'
    el.appendChild(overlay)

    host.appendChild(el)
    pageViews.push({
      index: i,
      el,
      canvas,
      overlay,
      scale,
      pdfWidth: size.width,
      pdfHeight: size.height,
      renderedToken: -1,
    })
    pageObserver.observe(el)
  }

  renderSignatureOverlays()
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
    } else {
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
    }
    view.renderedToken = token
  } catch (err) {
    if (token !== lastRenderToken) return
    if (err && err.name === 'RenderingCancelledException') return
    console.error('preview render failed', err)
    const ctx = view.canvas.getContext('2d')
    ctx.fillStyle = '#2A2A2A'
    ctx.fillRect(0, 0, view.canvas.width, view.canvas.height)
    ctx.fillStyle = '#888888'
    ctx.font = '14px "DM Sans", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Page could not be rendered', view.canvas.width / 2, view.canvas.height / 2)
    view.renderedToken = token
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
