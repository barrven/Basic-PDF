import { appState, dispatch } from './state.js'
import { getLibrary, addToLibrary, removeFromLibrary } from './store.js'
import { showToast } from './main.js'

function nanoid() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

let uploadedDataUrl = null
let placementGhostImg = null
let placementImgNatural = { w: 1, h: 1 }

export function initSignature() {
  const backdrop = document.getElementById('modal-backdrop')
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) hideSignatureModal()
  })

  // Close X button.
  backdrop.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action="close-sig-modal"]')
    if (t) hideSignatureModal()
  })

  // Tab switching.
  backdrop.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab-btn')
    if (!tab) return
    const which = tab.dataset.tab
    document.querySelectorAll('#signature-modal .tab-btn').forEach((b) => {
      b.dataset.active = b.dataset.tab === which ? 'true' : 'false'
    })
    document.querySelectorAll('#signature-modal .tab-panel').forEach((p) => {
      p.dataset.active = p.dataset.panel === which ? 'true' : 'false'
    })
  })

  // Draw tab actions.
  backdrop.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-action]')
    if (!a) return
    const action = a.dataset.action
    if (action === 'clear-draw') {
      clearDrawCanvas()
    } else if (action === 'confirm-draw') {
      const canvas = document.getElementById('draw-canvas')
      if (drawCanvasIsBlank(canvas)) {
        const err = document.getElementById('draw-error')
        err.hidden = false
        err.textContent = 'Please draw a signature first'
        return
      }
      const dataUrl = canvas.toDataURL('image/png')
      await onSignatureConfirmed(dataUrl)
    } else if (action === 'browse-upload') {
      document.getElementById('upload-input').click()
    } else if (action === 'confirm-upload') {
      if (!uploadedDataUrl) return
      await onSignatureConfirmed(uploadedDataUrl)
    }
  })

  initDrawCanvas()
  initUploadZone()
  initErrorModal()
}

function initErrorModal() {
  const eb = document.getElementById('error-modal-backdrop')
  eb.addEventListener('click', (e) => {
    if (e.target === eb) hideErrorModal()
    const a = e.target.closest('[data-action="close-error-modal"]')
    if (a) hideErrorModal()
  })
}

function hideErrorModal() {
  document.getElementById('error-modal-backdrop').hidden = true
}

let isDrawing = false

function getDrawCtx(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.strokeStyle = '#111111'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  return ctx
}

function initDrawCanvas() {
  const canvas = document.getElementById('draw-canvas')
  const ctx = getDrawCtx(canvas)
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect()
    const sx = canvas.width / rect.width
    const sy = canvas.height / rect.height
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy }
  }

  canvas.addEventListener('pointerdown', (e) => {
    isDrawing = true
    canvas.setPointerCapture(e.pointerId)
    const { x, y } = pointerPos(e)
    ctx.beginPath()
    ctx.moveTo(x, y)
    const err = document.getElementById('draw-error')
    err.hidden = true
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!isDrawing) return
    const { x, y } = pointerPos(e)
    ctx.lineTo(x, y)
    ctx.stroke()
  })
  function stopDraw() { isDrawing = false }
  canvas.addEventListener('pointerup', stopDraw)
  canvas.addEventListener('pointerleave', stopDraw)
  canvas.addEventListener('pointercancel', stopDraw)
}

function clearDrawCanvas() {
  const canvas = document.getElementById('draw-canvas')
  const ctx = getDrawCtx(canvas)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const err = document.getElementById('draw-error')
  err.hidden = true
}

function drawCanvasIsBlank(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 3; i < data.length; i += 4 * 8) {
    if (data[i] > 0) return false
  }
  return true
}

function initUploadZone() {
  const zone = document.getElementById('upload-zone')
  const input = document.getElementById('upload-input')
  const preview = document.getElementById('upload-preview')
  const err = document.getElementById('upload-error')
  const confirmBtn = document.querySelector('[data-action="confirm-upload"]')

  function reset() {
    uploadedDataUrl = null
    preview.hidden = true
    preview.src = ''
    err.hidden = true
    confirmBtn.disabled = true
  }
  reset()

  function handleFile(file) {
    if (!file) return
    const valid = ['image/png', 'image/jpeg', 'image/webp']
    if (!valid.includes(file.type)) {
      err.hidden = false
      err.textContent = 'Only PNG, JPEG, or WebP images are accepted.'
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      uploadedDataUrl = reader.result
      preview.src = uploadedDataUrl
      preview.hidden = false
      err.hidden = true
      confirmBtn.disabled = false
    }
    reader.onerror = () => {
      err.hidden = false
      err.textContent = 'Could not read this file.'
    }
    reader.readAsDataURL(file)
  }

  zone.addEventListener('dragover', (e) => {
    e.preventDefault()
    zone.classList.add('dragover')
  })
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'))
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('dragover')
    const file = e.dataTransfer.files?.[0]
    handleFile(file)
  })
  input.addEventListener('change', (e) => {
    const file = e.target.files?.[0]
    handleFile(file)
    input.value = ''
  })
}

export function showSignatureModal() {
  const bd = document.getElementById('modal-backdrop')
  bd.hidden = false
  clearDrawCanvas()
  // Default to draw tab.
  document.querySelectorAll('#signature-modal .tab-btn').forEach((b) => {
    b.dataset.active = b.dataset.tab === 'draw' ? 'true' : 'false'
  })
  document.querySelectorAll('#signature-modal .tab-panel').forEach((p) => {
    p.dataset.active = p.dataset.panel === 'draw' ? 'true' : 'false'
  })
  // Reset upload.
  const preview = document.getElementById('upload-preview')
  preview.hidden = true
  preview.src = ''
  uploadedDataUrl = null
  document.getElementById('upload-error').hidden = true
  document.querySelector('[data-action="confirm-upload"]').disabled = true
  const confirmLabel = canPlaceSignature() ? 'Use signature' : 'Save signature'
  document.querySelector('[data-action="confirm-draw"]').textContent = confirmLabel
  document.querySelector('[data-action="confirm-upload"]').textContent = confirmLabel
  // Focus.
  const first = document.querySelector('#signature-modal .tab-btn[data-active="true"]')
  if (first) first.focus()
}

export function hideSignatureModal() {
  document.getElementById('modal-backdrop').hidden = true
}

async function nextSigName() {
  const lib = await getLibrary()
  return 'Signature ' + (lib.length + 1)
}

function knockOutPaper(imageData) {
  const d = imageData.data
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]
    if (a === 0) continue
    const r = d[i]
    const g = d[i + 1]
    const b = d[i + 2]
    const minc = Math.min(r, g, b)
    const maxc = Math.max(r, g, b)
    const nearlyGray = maxc - minc < 40
    if (minc >= 248 && nearlyGray) {
      d[i + 3] = 0
      continue
    }
    if (minc >= 200 && nearlyGray) {
      d[i + 3] = Math.round(a * ((248 - minc) / 48))
    }
  }
}

function opaqueBounds(imageData) {
  const { width, height, data } = imageData
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < minX) return null
  const pad = 2
  const x = Math.max(0, minX - pad)
  const y = Math.max(0, minY - pad)
  return {
    x,
    y,
    w: Math.min(width, maxX + 1 + pad) - x,
    h: Math.min(height, maxY + 1 + pad) - y,
  }
}

async function toTransparentPng(dataUrl) {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const src = document.createElement('canvas')
  src.width = img.naturalWidth || 1
  src.height = img.naturalHeight || 1
  const ctx = src.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, src.width, src.height)
  knockOutPaper(imageData)
  ctx.putImageData(imageData, 0, 0)
  const box = opaqueBounds(imageData)
  if (!box || (box.x === 0 && box.y === 0 && box.w === src.width && box.h === src.height)) {
    return src.toDataURL('image/png')
  }
  const out = document.createElement('canvas')
  out.width = box.w
  out.height = box.h
  out.getContext('2d').drawImage(src, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h)
  return out.toDataURL('image/png')
}

function canPlaceSignature() {
  return Boolean(appState.filePath && appState.pages.length > 0)
}

async function onSignatureConfirmed(dataUrl) {
  const transparent = await toTransparentPng(dataUrl)
  const name = await nextSigName()
  await addToLibrary({ id: nanoid(), name, dataUrl: transparent, createdAt: Date.now() })
  hideSignatureModal()
  if (canPlaceSignature()) {
    enterPlacementMode(transparent)
  } else {
    showToast('Saved to library')
  }
}

function startPlacement(dataUrl) {
  dispatch({ type: 'SET_PLACEMENT_SIG', dataUrl })
  const pane = document.getElementById('preview-pane')
  pane.style.cursor = 'crosshair'
  const ghost = document.getElementById('placement-ghost')
  ghost.innerHTML = ''
  const img = document.createElement('img')
  img.src = dataUrl
  ghost.appendChild(img)
  ghost.hidden = false
  placementGhostImg = img
  img.onload = () => {
    placementImgNatural = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 }
    const canvas =
      document.querySelector(`.preview-page[data-index="${appState.focusedPage}"] canvas`) ||
      document.querySelector('.preview-page canvas')
    const widthPx = (canvas?.width || 600) * 0.30
    const heightPx = widthPx * (placementImgNatural.h / placementImgNatural.w)
    ghost.style.width = widthPx + 'px'
    ghost.style.height = heightPx + 'px'
  }
  pane.classList.add('is-placing')
}

export function enterPlacementMode(dataUrl) {
  if (!canPlaceSignature()) {
    showToast('Open a PDF to place a signature')
    return
  }
  toTransparentPng(dataUrl)
    .then((transparent) => startPlacement(transparent))
    .catch((err) => {
      console.error(err)
      startPlacement(dataUrl)
    })
}

export function exitPlacementMode() {
  dispatch({ type: 'SET_PLACEMENT_SIG', dataUrl: null })
  const pane = document.getElementById('preview-pane')
  pane.style.cursor = 'default'
  pane.classList.remove('is-placing')
  const ghost = document.getElementById('placement-ghost')
  ghost.hidden = true
  ghost.innerHTML = ''
  placementGhostImg = null
}

export function isPlacing() {
  return appState.placementSig !== null
}

export function handlePlacementMove(e, pageView) {
  const ghost = document.getElementById('placement-ghost')
  const container = document.getElementById('preview-container')
  const cRect = container.getBoundingClientRect()
  // Position inside container coordinate space so it overlays pages correctly.
  const x = e.clientX - cRect.left
  const y = e.clientY - cRect.top
  ghost.style.left = x + 'px'
  ghost.style.top = y + 'px'
  if (pageView && placementImgNatural.w) {
    const widthPx = pageView.pdfWidth * pageView.scale * 0.30
    const heightPx = widthPx * (placementImgNatural.h / placementImgNatural.w)
    ghost.style.width = widthPx + 'px'
    ghost.style.height = heightPx + 'px'
  }
}

export function handlePlacementClick(e, pageView) {
  if (!appState.placementSig) return
  if (!pageView) {
    exitPlacementMode()
    return
  }
  const rect = pageView.canvas.getBoundingClientRect()
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
    exitPlacementMode()
    return
  }
  const x = (e.clientX - rect.left) / pageView.scale
  const y = (e.clientY - rect.top) / pageView.scale
  const width = pageView.pdfWidth * 0.30
  const height = width * (placementImgNatural.h / placementImgNatural.w)
  dispatch({
    type: 'ADD_SIGNATURE',
    signature: {
      id: nanoid(),
      pageIndex: pageView.index,
      x,
      y,
      width,
      height,
      opacity: 1,
      dataUrl: appState.placementSig,
    },
  })
  exitPlacementMode()
}

// ─────────── Signature library popover ───────────

let popoverOpen = false

export async function toggleSigPopover(anchorBtn) {
  const pop = document.getElementById('sig-popover')
  if (popoverOpen) {
    closeSigPopover()
    return
  }
  await renderSigPopover()
  const rect = anchorBtn.getBoundingClientRect()
  pop.style.top = rect.bottom + 4 + 'px'
  pop.style.left = Math.max(8, rect.right - 240) + 'px'
  pop.hidden = false
  popoverOpen = true
  setTimeout(() => {
    document.addEventListener('mousedown', onDocMouseDown, { once: true })
  }, 0)
}

function onDocMouseDown(e) {
  const pop = document.getElementById('sig-popover')
  if (!pop.contains(e.target) && !e.target.closest('[data-action="sig-library"]')) {
    closeSigPopover()
  } else {
    document.addEventListener('mousedown', onDocMouseDown, { once: true })
  }
}

function closeSigPopover() {
  const pop = document.getElementById('sig-popover')
  pop.hidden = true
  popoverOpen = false
}

async function renderSigPopover() {
  const pop = document.getElementById('sig-popover')
  pop.innerHTML = ''
  const lib = await getLibrary()
  if (lib.length === 0) {
    const p = document.createElement('p')
    p.textContent = 'No saved signatures yet.'
    p.style.color = 'var(--text-muted)'
    p.style.padding = '12px'
    p.style.margin = '0'
    pop.appendChild(p)
    return
  }
  // Newest first.
  for (let i = lib.length - 1; i >= 0; i--) {
    const sig = lib[i]
    const row = document.createElement('div')
    row.className = 'sig-library-row'

    const btn = document.createElement('button')
    btn.className = 'sig-library-item'
    btn.type = 'button'
    const img = document.createElement('img')
    img.src = sig.dataUrl
    btn.appendChild(img)
    const span = document.createElement('span')
    span.textContent = sig.name
    btn.appendChild(span)
    if (!canPlaceSignature()) {
      btn.title = 'Open a PDF to place this signature'
    }
    btn.addEventListener('click', () => {
      if (!canPlaceSignature()) {
        showToast('Open a PDF to place a signature')
        return
      }
      closeSigPopover()
      enterPlacementMode(sig.dataUrl)
    })

    const del = document.createElement('button')
    del.className = 'sig-library-delete'
    del.type = 'button'
    del.title = 'Delete saved signature'
    del.setAttribute('aria-label', 'Delete ' + (sig.name || 'signature'))
    del.textContent = '×'
    del.addEventListener('click', async (e) => {
      e.stopPropagation()
      await removeFromLibrary(sig.id)
      await renderSigPopover()
    })

    row.appendChild(btn)
    row.appendChild(del)
    pop.appendChild(row)
  }
}
