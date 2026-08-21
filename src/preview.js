import { appState, dispatch } from './state.js'
import { getPage, drawBlankPlaceholder, PAGE_SIZE_A4, visualPageSize } from './renderer.js'
import { handlePlacementClick, handlePlacementMove, isPlacing, exitPlacementMode } from './signature.js'

let currentScale = 1
let currentPdfPageWidth = 0
let currentPdfPageHeight = 0
let lastRenderToken = 0

export function initPreview() {
  const pane = document.getElementById('preview-pane')
  const canvas = document.getElementById('preview-canvas')
  const container = document.getElementById('preview-container')
  const layer = document.getElementById('signature-overlay-layer')

  pane.addEventListener('click', (e) => {
    if (isPlacing()) {
      handlePlacementClick(e, currentScale, canvas)
      return
    }
    if (e.target === canvas || e.target === pane || e.target === container) {
      if (appState.selectedSig) {
        dispatch({ type: 'SET_SELECTED_SIG', id: null })
      }
    }
  })

  pane.addEventListener('mousemove', (e) => {
    if (!isPlacing()) return
    handlePlacementMove(e)
  })

  layer.addEventListener('click', (e) => {
    const overlay = e.target.closest('.sig-overlay')
    if (!overlay) return
    e.stopPropagation()
    dispatch({ type: 'SET_SELECTED_SIG', id: overlay.dataset.id })
  })

  initOverlayInteractions()
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

export async function renderPreview() {
  const canvas = document.getElementById('preview-canvas')
  const pane = document.getElementById('preview-pane')
  const empty = document.getElementById('empty-state')
  const overlayLayer = document.getElementById('signature-overlay-layer')
  const myToken = ++lastRenderToken
  if (!appState.filePath || appState.pages.length === 0) {
    canvas.width = 0
    canvas.height = 0
    overlayLayer.innerHTML = ''
    if (empty) empty.hidden = false
    return
  }
  if (empty) empty.hidden = true

  const entry = appState.pages[appState.focusedPage]
  if (!entry) return
  try {
    if (entry.originalIndex === -1) {
      const size = visualPageSize(PAGE_SIZE_A4.width, PAGE_SIZE_A4.height, entry.rotation)
      let scale
      if (appState.zoom === null) {
        scale = (pane.clientWidth - 48) / size.width
      } else {
        scale = appState.zoom / 100
      }
      currentScale = scale
      currentPdfPageWidth = size.width
      currentPdfPageHeight = size.height
      drawBlankPlaceholder(canvas, size.width * scale, size.height * scale)
    } else {
      const page = await getPage(entry.sourceId, entry.originalIndex)
      const baseViewport = page.getViewport({ scale: 1, rotation: entry.rotation })
      let scale
      if (appState.zoom === null) {
        scale = (pane.clientWidth - 48) / baseViewport.width
      } else {
        scale = appState.zoom / 100
      }
      currentScale = scale
      currentPdfPageWidth = baseViewport.width
      currentPdfPageHeight = baseViewport.height
      const viewport = page.getViewport({ scale, rotation: entry.rotation })
      // Render offscreen so a newer request can start without hitting
      // pdf.js's "same canvas during multiple render()" error.
      const offscreen = document.createElement('canvas')
      offscreen.width = Math.floor(viewport.width)
      offscreen.height = Math.floor(viewport.height)
      const ctx = offscreen.getContext('2d')
      await page.render({ canvasContext: ctx, viewport }).promise
      if (myToken !== lastRenderToken) return
      canvas.width = offscreen.width
      canvas.height = offscreen.height
      canvas.getContext('2d').drawImage(offscreen, 0, 0)
    }
  } catch (err) {
    if (myToken !== lastRenderToken) return
    if (err && err.name === 'RenderingCancelledException') return
    console.error('preview render failed', err)
    const ctx = canvas.getContext('2d')
    canvas.width = 600
    canvas.height = 80
    ctx.fillStyle = '#2A2A2A'
    ctx.fillRect(0, 0, 600, 80)
    ctx.fillStyle = '#888888'
    ctx.font = '14px "DM Sans", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Page could not be rendered', 300, 40)
  }
  renderSignatureOverlays()
}

export function renderSignatureOverlays() {
  const layer = document.getElementById('signature-overlay-layer')
  if (!layer) return
  layer.innerHTML = ''
  for (const sig of appState.signatures) {
    if (sig.pageIndex !== appState.focusedPage) continue
    const div = document.createElement('div')
    div.className = 'sig-overlay'
    div.dataset.id = sig.id
    div.style.left = sig.x * currentScale + 'px'
    div.style.top = sig.y * currentScale + 'px'
    div.style.width = sig.width * currentScale + 'px'
    div.style.height = sig.height * currentScale + 'px'
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

function initOverlayInteractions() {
  const layer = document.getElementById('signature-overlay-layer')

  let mode = null // 'move' | 'resize'
  let activeId = null
  let activeHandle = null
  let startPointer = null
  let startSig = null
  let didPushHistory = false

  layer.addEventListener('pointerdown', (e) => {
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
    didPushHistory = false
    layer.setPointerCapture(e.pointerId)
    e.preventDefault()
    e.stopPropagation()
  })

  layer.addEventListener('pointermove', (e) => {
    if (!mode || !startSig) return
    if (!didPushHistory) {
      dispatch({ type: 'PUSH_HISTORY_SNAPSHOT' })
      didPushHistory = true
    }
    const dx = (e.clientX - startPointer.x) / currentScale
    const dy = (e.clientY - startPointer.y) / currentScale
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
    try { layer.releasePointerCapture(e.pointerId) } catch {}
    mode = null
    activeId = null
    activeHandle = null
    startPointer = null
    startSig = null
    didPushHistory = false
  }
  layer.addEventListener('pointerup', endDrag)
  layer.addEventListener('pointercancel', endDrag)
}

export function getCurrentScale() {
  return currentScale
}

export function getCurrentPageDimensions() {
  return { width: currentPdfPageWidth, height: currentPdfPageHeight }
}

export function cancelPlacementOnEscape() {
  if (isPlacing()) {
    exitPlacementMode()
    return true
  }
  return false
}
