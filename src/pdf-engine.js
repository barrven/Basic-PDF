import { PDFDocument, degrees, rgb, BlendMode } from '../node_modules/pdf-lib/dist/pdf-lib.esm.js'
import { appState, dispatch, PRIMARY_SOURCE_ID, createPageEntry, normalizeRotation } from './state.js'
import { setPrimarySource, clearPdfSources, openIsolatedPdf } from './renderer.js'
import { showToast, showErrorModal, withDocumentLoading } from './main.js'

const HIGHLIGHT_RGB = { r: 1, g: 229 / 255, b: 102 / 255 }

const LOAD_OPTS = { ignoreEncryption: true }

function basename(p) {
  if (!p) return ''
  return p.split(/[\\/]/).pop()
}

function confirmDiscardIfDirty() {
  if (!appState.filePath || !appState.dirty) return true
  return window.confirm('You have unsaved changes. Open a different file anyway?')
}

export async function openFile() {
  try {
    if (appState.loading) return
    if (!confirmDiscardIfDirty()) return
    const result = await window.electronAPI.openFile()
    if (!result) return
    const { path, buffer } = result
    await withDocumentLoading(() => loadFromBytes(path, buffer))
  } catch (err) {
    console.error(err)
    // loadFromBytes already presents the error modal.
  }
}

export async function openPath(filePath) {
  if (!filePath) return
  if (appState.loading) return
  if (!confirmDiscardIfDirty()) return
  try {
    await withDocumentLoading(async () => {
      let buffer
      try {
        buffer = await window.electronAPI.openFileBytes(filePath)
      } catch (err) {
        console.error(err)
        showErrorModal('Could not open this file. It may have been moved or deleted.')
        return
      }
      await loadFromBytes(filePath, buffer)
    })
  } catch (err) {
    // loadFromBytes already presents the error modal.
  }
}

export function initOsFileOpen() {
  if (!window.electronAPI?.onOpenPath) return
  window.electronAPI.onOpenPath((filePath) => {
    openPath(filePath)
  })
}

export async function loadFromBytes(filePath, bytes) {
  try {
    // Validate it loads with pdf-lib (catches malformed files).
    await PDFDocument.load(bytes, LOAD_OPTS)
    const pdfDoc = await setPrimarySource(bytes)
    const pageCount = pdfDoc.numPages
    const pages = []
    for (let i = 0; i < pageCount; i++) {
      const page = await pdfDoc.getPage(i + 1)
      pages.push(createPageEntry({
        sourceId: PRIMARY_SOURCE_ID,
        originalIndex: i,
        rotation: page.rotate,
      }))
    }
    dispatch({
      type: 'OPEN_FILE',
      path: filePath,
      bytes: bytes,
      pages,
    })
  } catch (err) {
    console.error(err)
    showErrorModal('Could not open this file. It may be corrupt or not a valid PDF.')
    throw err
  }
}

async function getSourceBytes(sourceId) {
  if (sourceId === PRIMARY_SOURCE_ID) {
    if (appState.fileBytes) return appState.fileBytes
    return await window.electronAPI.openFileBytes(appState.filePath)
  }
  const src = appState.sources[sourceId]
  if (!src) throw new Error(`Missing bytes for source ${sourceId}`)
  return src.bytes
}

async function toPngDataUrl(dataUrl) {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth || 1
  canvas.height = img.naturalHeight || 1
  canvas.getContext('2d').drawImage(img, 0, 0)
  return canvas.toDataURL('image/png')
}

async function embedSignatureImage(doc, dataUrl) {
  let url = dataUrl
  const isPng = url.startsWith('data:image/png')
  const isJpg = url.startsWith('data:image/jpeg') || url.startsWith('data:image/jpg')
  if (!isPng && !isJpg) url = await toPngDataUrl(url)
  const b64 = url.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '')
  const imgBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  if (url.startsWith('data:image/png')) return doc.embedPng(imgBytes)
  return doc.embedJpg(imgBytes)
}

// Visual top-left coords (page already rotated) → pdf-lib unrotated media-box
// space. Same mapping as stamps: rotate the draw around the converted origin.
function visualRectToUnrotated(pdfPage, visX, visY, visW, visH) {
  const rotation = normalizeRotation(pdfPage.getRotation().angle)
  const { width: pageWidth, height: pageHeight } = pdfPage.getSize()
  if (rotation === 90) {
    return { x: visY + visH, y: visX, width: visW, height: visH, rotate: degrees(90) }
  }
  if (rotation === 180) {
    return { x: pageWidth - visX, y: visY + visH, width: visW, height: visH, rotate: degrees(180) }
  }
  if (rotation === 270) {
    return { x: pageWidth - visY - visH, y: pageHeight - visX, width: visW, height: visH, rotate: degrees(270) }
  }
  return { x: visX, y: pageHeight - visY - visH, width: visW, height: visH }
}

function drawSignatureOnPage(pdfPage, embeddedImg, sig) {
  const box = visualRectToUnrotated(pdfPage, sig.x, sig.y, sig.width, sig.height)
  pdfPage.drawImage(embeddedImg, {
    ...box,
    opacity: sig.opacity ?? 1,
  })
}

function drawAnnotRectsOnPage(pdfPage, annots, style) {
  for (const annot of annots) {
    for (const r of annot.rects) {
      const box = visualRectToUnrotated(pdfPage, r.x, r.y, r.width, r.height)
      pdfPage.drawRectangle({ ...box, ...style })
    }
  }
}

const RASTER_TARGET_SCALE = 2
const RASTER_MAX_EDGE = 3000

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode image'))
    img.src = dataUrl
  })
}

async function canvasToPngBytes(canvas) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode page image'))), 'image/png')
  })
  return new Uint8Array(await blob.arrayBuffer())
}

async function rasterizeRedactedPage(pdfJsDoc, entry, pageIndex) {
  const page = await pdfJsDoc.getPage(entry.originalIndex + 1)
  const base = page.getViewport({ scale: 1, rotation: entry.rotation })
  const scale = Math.min(RASTER_TARGET_SCALE, RASTER_MAX_EDGE / Math.max(base.width, base.height, 1))
  const viewport = page.getViewport({ scale, rotation: entry.rotation })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport }).promise

  const highlights = appState.annotations.filter((a) => a.type === 'highlight' && a.pageIndex === pageIndex)
  if (highlights.length) {
    ctx.save()
    ctx.globalCompositeOperation = 'multiply'
    for (const a of highlights) {
      ctx.fillStyle = a.color || '#ffe566'
      for (const r of a.rects) {
        ctx.fillRect(r.x * scale, r.y * scale, r.width * scale, r.height * scale)
      }
    }
    ctx.restore()
  }

  for (const sig of appState.signatures) {
    if (sig.pageIndex !== pageIndex) continue
    const img = await loadImage(sig.dataUrl)
    ctx.save()
    ctx.globalAlpha = sig.opacity ?? 1
    ctx.drawImage(img, sig.x * scale, sig.y * scale, sig.width * scale, sig.height * scale)
    ctx.restore()
  }

  ctx.fillStyle = '#000000'
  for (const a of appState.annotations) {
    if (a.type !== 'redact' || a.pageIndex !== pageIndex) continue
    for (const r of a.rects) {
      ctx.fillRect(r.x * scale, r.y * scale, r.width * scale, r.height * scale)
    }
  }

  return {
    bytes: await canvasToPngBytes(canvas),
    width: base.width,
    height: base.height,
  }
}

async function buildOutputDoc() {
  const newDoc = await PDFDocument.create()
  const srcDocs = new Map() // sourceId -> pdf-lib PDFDocument
  const rasterDocs = new Map() // sourceId -> isolated pdf.js PDFDocumentProxy
  const flattened = new Set()
  async function getSrcDoc(sourceId) {
    if (srcDocs.has(sourceId)) return srcDocs.get(sourceId)
    const bytes = await getSourceBytes(sourceId)
    const doc = await PDFDocument.load(bytes, LOAD_OPTS)
    srcDocs.set(sourceId, doc)
    return doc
  }
  async function getRasterDoc(sourceId) {
    if (rasterDocs.has(sourceId)) return rasterDocs.get(sourceId)
    const bytes = await getSourceBytes(sourceId)
    const doc = await openIsolatedPdf(bytes)
    rasterDocs.set(sourceId, doc)
    return doc
  }

  try {
    for (let pageIndex = 0; pageIndex < appState.pages.length; pageIndex++) {
      const entry = appState.pages[pageIndex]
      const pageAnnots = appState.annotations.filter((a) => a.pageIndex === pageIndex)
      const highlights = pageAnnots.filter((a) => a.type === 'highlight')
      const redacts = pageAnnots.filter((a) => a.type === 'redact')
      const canFlatten = redacts.length > 0 && entry.originalIndex !== -1 && entry.sourceId

      if (canFlatten) {
        try {
          const rasterDoc = await getRasterDoc(entry.sourceId)
          const raster = await rasterizeRedactedPage(rasterDoc, entry, pageIndex)
          const img = await newDoc.embedPng(raster.bytes)
          const pageToAdd = newDoc.addPage([raster.width, raster.height])
          pageToAdd.drawImage(img, {
            x: 0,
            y: 0,
            width: raster.width,
            height: raster.height,
          })
          flattened.add(pageIndex)
          continue
        } catch (err) {
          console.error('redaction flatten failed, drawing opaque boxes', err)
        }
      }

      let pageToAdd
      if (entry.originalIndex === -1) {
        pageToAdd = newDoc.addPage([595, 842])
      } else {
        const srcDoc = await getSrcDoc(entry.sourceId)
        // Fresh copy each time so duplicated pages don't share a reference.
        const [copy] = await newDoc.copyPages(srcDoc, [entry.originalIndex])
        pageToAdd = newDoc.addPage(copy)
      }
      // Always set, including 0 — copyPages keeps the source /Rotate, so rotating
      // a page back to 0 would otherwise be ignored.
      pageToAdd.setRotation(degrees(normalizeRotation(entry.rotation)))

      if (highlights.length) {
        drawAnnotRectsOnPage(pageToAdd, highlights, {
          color: rgb(HIGHLIGHT_RGB.r, HIGHLIGHT_RGB.g, HIGHLIGHT_RGB.b),
          blendMode: BlendMode.Multiply,
        })
      }
      if (redacts.length) {
        drawAnnotRectsOnPage(pageToAdd, redacts, {
          color: rgb(0, 0, 0),
        })
      }
    }

    for (const sig of appState.signatures) {
      if (sig.pageIndex < 0 || sig.pageIndex >= appState.pages.length) continue
      if (flattened.has(sig.pageIndex)) continue
      const pdfPage = newDoc.getPage(sig.pageIndex)
      const embeddedImg = await embedSignatureImage(newDoc, sig.dataUrl)
      drawSignatureOnPage(pdfPage, embeddedImg, sig)
    }
  } finally {
    for (const doc of rasterDocs.values()) {
      try { await doc.destroy() } catch {}
    }
  }

  return newDoc
}

export async function saveDocument(targetPath) {
  if (!appState.filePath) return
  try {
    const newDoc = await buildOutputDoc()
    const bytes = await newDoc.save()
    await window.electronAPI.saveFile(targetPath, bytes)
    if (targetPath !== appState.filePath) {
      dispatch({ type: 'SET_FILE_PATH', path: targetPath })
    }
    dispatch({ type: 'SET_DIRTY', dirty: false })
    showToast('Saved ✓', 2000)
  } catch (err) {
    console.error(err)
    showErrorModal('Save failed: ' + (err && err.message ? err.message : String(err)))
  }
}

function hasRedactions() {
  return appState.annotations.some((a) => a.type === 'redact')
}

export async function save() {
  if (!appState.filePath) return
  if (hasRedactions()) {
    await withDocumentLoading(() => saveDocument(appState.filePath), 'Saving…')
    return
  }
  await saveDocument(appState.filePath)
}

export async function closeFile() {
  if (!appState.filePath) return
  if (appState.dirty) {
    const ok = window.confirm('You have unsaved changes. Close without saving?')
    if (!ok) return
  }
  clearPdfSources()
  dispatch({ type: 'CLOSE_FILE' })
}

export async function saveAs() {
  if (!appState.filePath) return
  try {
    const build = async () => {
      const newDoc = await buildOutputDoc()
      return newDoc.save()
    }
    const bytes = hasRedactions()
      ? await withDocumentLoading(build, 'Saving…')
      : await build()
    const defaultName = basename(appState.filePath) || 'document.pdf'
    const newPath = await window.electronAPI.saveFileAs(bytes, defaultName)
    if (!newPath) return
    dispatch({ type: 'SET_FILE_PATH', path: newPath })
    dispatch({ type: 'SET_DIRTY', dirty: false })
    showToast('Saved ✓', 2000)
  } catch (err) {
    console.error(err)
    showErrorModal('Save failed: ' + (err && err.message ? err.message : String(err)))
  }
}
