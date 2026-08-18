import { appState, dispatch } from './state.js'
import { getLibrary, addToLibrary } from './store.js'

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

function initDrawCanvas() {
  const canvas = document.getElementById('draw-canvas')
  const ctx = canvas.getContext('2d')
  // Initialize white background.
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = '#111111'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

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
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#FFFFFF'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = '#111111'
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const err = document.getElementById('draw-error')
  err.hidden = true
}

function drawCanvasIsBlank(canvas) {
  const ctx = canvas.getContext('2d')
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  // Scan with stride for performance.
  for (let i = 0; i < data.length; i += 4 * 8) {
    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) return false
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

async function onSignatureConfirmed(dataUrl) {
  const name = await nextSigName()
  await addToLibrary({ id: nanoid(), name, dataUrl, createdAt: Date.now() })
  hideSignatureModal()
  enterPlacementMode(dataUrl)
}

export function enterPlacementMode(dataUrl) {
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
    const canvas = document.getElementById('preview-canvas')
    const widthPx = (canvas.width || 600) * 0.30
    const heightPx = widthPx * (placementImgNatural.h / placementImgNatural.w)
    ghost.style.width = widthPx + 'px'
    ghost.style.height = heightPx + 'px'
  }
}

export function exitPlacementMode() {
  dispatch({ type: 'SET_PLACEMENT_SIG', dataUrl: null })
  const pane = document.getElementById('preview-pane')
  pane.style.cursor = 'default'
  const ghost = document.getElementById('placement-ghost')
  ghost.hidden = true
  ghost.innerHTML = ''
  placementGhostImg = null
}

export function isPlacing() {
  return appState.placementSig !== null
}

export function handlePlacementMove(e) {
  const ghost = document.getElementById('placement-ghost')
  const pane = document.getElementById('preview-pane')
  const paneRect = pane.getBoundingClientRect()
  const container = document.getElementById('preview-container')
  const cRect = container.getBoundingClientRect()
  // Position inside container coordinate space so it overlays canvas correctly.
  const x = e.clientX - cRect.left
  const y = e.clientY - cRect.top
  ghost.style.left = x + 'px'
  ghost.style.top = y + 'px'
  void paneRect
}

export function handlePlacementClick(e, currentScale, canvas) {
  if (!appState.placementSig) return
  const rect = canvas.getBoundingClientRect()
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
    // Click outside the canvas exits placement mode.
    exitPlacementMode()
    return
  }
  const x = (e.clientX - rect.left) / currentScale
  const y = (e.clientY - rect.top) / currentScale
  const baseWidthPdf = canvas.width / currentScale
  const width = baseWidthPdf * 0.30
  const height = width * (placementImgNatural.h / placementImgNatural.w)
  dispatch({
    type: 'ADD_SIGNATURE',
    signature: {
      id: nanoid(),
      pageIndex: appState.focusedPage,
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
    const btn = document.createElement('button')
    btn.className = 'sig-library-item'
    const img = document.createElement('img')
    img.src = sig.dataUrl
    btn.appendChild(img)
    const span = document.createElement('span')
    span.textContent = sig.name
    btn.appendChild(span)
    btn.addEventListener('click', () => {
      closeSigPopover()
      enterPlacementMode(sig.dataUrl)
    })
    pop.appendChild(btn)
  }
}
