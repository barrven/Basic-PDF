import {
  PDFDocument, degrees, rgb, BlendMode, StandardFonts, TextRenderingMode,
  pushGraphicsState, popGraphicsState, beginText, endText, setTextRenderingMode,
  setFontAndSize, setTextMatrix, showText,
} from '../node_modules/pdf-lib/dist/pdf-lib.esm.js'
import { appState, dispatch, PRIMARY_SOURCE_ID, createPageEntry, normalizeRotation } from './state.js'
import { setPrimarySource, clearPdfSources, openIsolatedPdf } from './renderer.js'
import { showToast, showErrorModal, showNotice, hideNotice, withDocumentLoading } from './main.js'
import { addSignaturePlaceholder, documentHasSignature, SIGNED_SAVE_OPTIONS } from './pdf-signature.js'
import { detectForms, applyFormValuesToStorage } from './forms.js'
import { applyFieldValues, rebuildAcroForm, stripWidgetPageRefs } from './forms-save.js'
import { isMarkup, embedMarkupFont, drawMarkupOnPdfPage, drawMarkupOnCanvas } from './markup-save.js'

const HIGHLIGHT_RGB = { r: 1, g: 229 / 255, b: 102 / 255 }

const LOAD_OPTS = { ignoreEncryption: true }

function basename(p) {
  if (!p) return ''
  return p.split(/[\\/]/).pop()
}

// Save / Don't save / Cancel before something replaces or closes the document.
// Resolves true when it is safe to go ahead.
async function resolveUnsavedChanges(action) {
  if (!appState.filePath || !appState.dirty) return true
  const name = basename(appState.filePath) || 'this document'
  const choice = await window.nativeAPI.promptUnsaved(
    `Do you want to save changes to ${name} before ${action}?`,
  )
  if (choice === 'cancel') return false
  if (choice === 'save') {
    await save()
    return !appState.dirty // a failed or cancelled save keeps the file open
  }
  return true
}

export async function openFile() {
  try {
    if (appState.loading) return
    if (!(await resolveUnsavedChanges('opening another file'))) return
    const result = await window.nativeAPI.openFile()
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
  if (!(await resolveUnsavedChanges('opening another file'))) return
  try {
    await withDocumentLoading(async () => {
      let buffer
      try {
        buffer = await window.nativeAPI.openFileBytes(filePath)
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
  if (!window.nativeAPI?.onOpenPath) return
  window.nativeAPI.onOpenPath((filePath) => {
    openPath(filePath)
  })
}

export async function loadFromBytes(filePath, bytes) {
  try {
    // Validate it loads with pdf-lib (catches malformed files).
    const validated = await PDFDocument.load(bytes, LOAD_OPTS)
    const alreadySigned = documentHasSignature(validated)
    hideNotice()
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
    const forms = await detectForms(PRIMARY_SOURCE_ID)
    dispatch({
      type: 'OPEN_FILE',
      path: filePath,
      bytes: bytes,
      pages,
      formFields: forms.fields,
    })
    if (alreadySigned) {
      showNotice('This PDF already has a digital signature. Saving changes here will remove it.')
    }
    if (forms.xfa) {
      showToast("This PDF uses an XFA form, which isn't supported. Its fields can't be filled.", 4500)
    }
  } catch (err) {
    console.error(err)
    showErrorModal('Could not open this file. It may be corrupt or not a valid PDF.')
    throw err
  }
}

async function getSourceBytes(sourceId) {
  if (sourceId === PRIMARY_SOURCE_ID) {
    if (appState.fileBytes) return appState.fileBytes
    return await window.nativeAPI.openFileBytes(appState.filePath)
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
  // Burn the user's form edits into the image: pdf.js draws widgets from
  // annotationStorage when annotationMode is ENABLE_STORAGE (3).
  await applyFormValuesToStorage(pdfJsDoc, entry.sourceId, entry.originalIndex)
  await page.render({ canvasContext: ctx, viewport, annotationMode: 3 }).promise

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

  drawMarkupOnCanvas(ctx, appState.annotations.filter((a) => isMarkup(a) && a.pageIndex === pageIndex), scale)

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
    textRuns: await collectVisibleTextRuns(page, viewport, pageIndex, scale),
  }
}

// Text of a flattened page that is NOT under a redaction box, as runs in
// output-page space (pt, top-left origin, page at its saved rotation). A run is
// one text item, trimmed character by character (assuming even advance widths)
// so only the glyphs a box touches are dropped.
export function trimTextItem(str, left, width, top, bottom, redactRects) {
  if (!str || !(width > 0)) return []
  const hit = redactRects.filter((r) => r.y < bottom && r.y + r.height > top)
  if (!hit.length) return [{ str, left, width }]
  const step = width / str.length
  const pieces = []
  for (let i = 0; i < str.length; i++) {
    const x0 = left + i * step
    const x1 = x0 + step
    if (hit.some((r) => r.x < x1 - 0.01 && r.x + r.width > x0 + 0.01)) continue
    const prev = pieces[pieces.length - 1]
    if (prev && prev.end === i) prev.end = i + 1
    else pieces.push({ start: i, end: i + 1 })
  }
  return pieces.map((p) => ({
    str: str.slice(p.start, p.end),
    left: left + p.start * step,
    width: (p.end - p.start) * step,
  }))
}

async function collectVisibleTextRuns(page, viewport, pageIndex, scale) {
  const redactRects = []
  for (const a of appState.annotations) {
    if (a.type !== 'redact' || a.pageIndex !== pageIndex) continue
    for (const r of a.rects) redactRects.push(r)
  }
  let content
  try {
    content = await page.getTextContent()
  } catch {
    return []
  }
  const vt = viewport.transform
  const runs = []
  for (const item of content.items || []) {
    if (!item.str || !item.transform) continue
    const t = item.transform
    // viewport.transform * item.transform → visual (canvas) space at `scale`.
    const m = [
      vt[0] * t[0] + vt[2] * t[1],
      vt[1] * t[0] + vt[3] * t[1],
      vt[0] * t[2] + vt[2] * t[3],
      vt[1] * t[2] + vt[3] * t[3],
      vt[0] * t[4] + vt[2] * t[5] + vt[4],
      vt[1] * t[4] + vt[3] * t[5] + vt[5],
    ]
    const size = Math.hypot(m[2], m[3]) / scale
    const advance = Math.hypot(m[0], m[1]) / scale // pt per user-space unit
    const width = (item.width || 0) * (advance / Math.hypot(t[0], t[1]) || 0)
    const angle = Math.atan2(m[1], m[0])
    const x = m[4] / scale
    const y = m[5] / scale
    if (!(size > 0) || !(width > 0)) continue
    // Redaction boxes are axis-aligned; only trim unrotated runs exactly, and
    // drop rotated runs that touch any box rather than risk leaking text.
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    if (Math.abs(sin) > 0.01) {
      const bx0 = Math.min(x, x + cos * width), bx1 = Math.max(x, x + cos * width)
      const by0 = Math.min(y, y + sin * width) - size, by1 = Math.max(y, y + sin * width)
      const touches = redactRects.some((r) => r.x < bx1 && r.x + r.width > bx0 && r.y < by1 && r.y + r.height > by0)
      if (!touches) runs.push({ str: item.str, x, y, size, width, angle })
      continue
    }
    const pieces = trimTextItem(item.str, x, width, y - size, y + size * 0.25, redactRects)
    for (const p of pieces) runs.push({ str: p.str, x: p.left, y, size, width: p.width, angle: 0 })
  }
  return runs
}

// Invisible, searchable text over a flattened page image.
async function addInvisibleText(newDoc, pageToAdd, runs, pageHeight, fontHolder) {
  if (!runs.length) return
  fontHolder.font ??= await newDoc.embedFont(StandardFonts.Helvetica)
  const font = fontHolder.font
  const supported = new Set(font.getCharacterSet())
  pageToAdd.setFont(font)
  const fontKey = pageToAdd.fontKey
  const ops = []
  for (const run of runs) {
    let text = ''
    for (const ch of run.str) if (supported.has(ch.codePointAt(0))) text += ch
    if (!text.trim()) continue
    const natural = font.widthOfTextAtSize(text, run.size)
    if (!(natural > 0)) continue
    const sx = run.width / natural
    const cos = Math.cos(-run.angle)
    const sin = Math.sin(-run.angle)
    ops.push(
      pushGraphicsState(),
      beginText(),
      setTextRenderingMode(TextRenderingMode.Invisible),
      setFontAndSize(fontKey, run.size),
      setTextMatrix(cos * sx, sin * sx, -sin, cos, run.x, pageHeight - run.y),
      showText(font.encodeText(text)),
      endText(),
      popGraphicsState(),
    )
  }
  if (ops.length) pageToAdd.pushOperators(...ops)
}

let lastFormFailures = 0

async function buildOutputDoc() {
  const newDoc = await PDFDocument.create()
  const srcDocs = new Map() // sourceId -> pdf-lib PDFDocument
  const rasterDocs = new Map() // sourceId -> isolated pdf.js PDFDocumentProxy
  const flattened = new Set()
  let formFailures = 0
  let markupFont = null
  const textFont = {}
  async function getSrcDoc(sourceId) {
    if (srcDocs.has(sourceId)) return srcDocs.get(sourceId)
    const bytes = await getSourceBytes(sourceId)
    const doc = await PDFDocument.load(bytes, LOAD_OPTS)
    // Fill in the user's form edits while the source still owns its AcroForm.
    formFailures += applyFieldValues(doc, sourceId, appState.fieldValues)
    if (Object.keys(appState.formFields).length) stripWidgetPageRefs(doc)
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
      const markups = pageAnnots.filter(isMarkup)
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
          // The image hides the page's text, so put back every glyph that is
          // not under a redaction box as invisible text (searchable, selectable).
          try {
            await addInvisibleText(newDoc, pageToAdd, raster.textRuns || [], raster.height, textFont)
          } catch (err) {
            console.error('could not restore text on redacted page', err)
          }
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
      if (markups.length) {
        markupFont ??= await embedMarkupFont(newDoc)
        drawMarkupOnPdfPage(pageToAdd, markups, markupFont)
      }
    }

    if (Object.keys(appState.formFields).length) rebuildAcroForm(newDoc)
    lastFormFailures = formFailures

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

function pendingDigitalSignature() {
  return appState.signatures.find((s) => s.digital && s.identityId && s.pageIndex < appState.pages.length) || null
}

// buildOutputDoc() plus, when a digital signature is pending, the signing step.
// Signing must be the last thing that touches the bytes.
async function buildOutputBytes() {
  const newDoc = await buildOutputDoc()
  const sig = pendingDigitalSignature()
  if (!sig) return newDoc.save()
  addSignaturePlaceholder(newDoc, newDoc.getPage(sig.pageIndex), sig, {
    name: sig.signerLabel || '',
    reason: sig.reason || '',
    location: sig.location || '',
  })
  const unsigned = await newDoc.save(SIGNED_SAVE_OPTIONS)
  return window.nativeAPI.signPdf(unsigned, sig.identityId)
}

export async function saveDocument(targetPath) {
  if (!appState.filePath) return
  try {
    const bytes = await buildOutputBytes()
    await window.nativeAPI.saveFile(targetPath, bytes)
    if (targetPath !== appState.filePath) {
      dispatch({ type: 'SET_FILE_PATH', path: targetPath })
    }
    dispatch({ type: 'SET_DIRTY', dirty: false })
    showToast(
      lastFormFailures ? `Saved, but ${lastFormFailures} form field(s) could not be written.` : 'Saved ✓',
      lastFormFailures ? 4500 : 2000,
    )
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
  if (hasRedactions() || pendingDigitalSignature()) {
    await withDocumentLoading(() => saveDocument(appState.filePath), 'Saving…')
    return
  }
  await saveDocument(appState.filePath)
}

export async function closeFile() {
  if (!appState.filePath) return
  if (!(await resolveUnsavedChanges('closing'))) return
  clearPdfSources()
  dispatch({ type: 'CLOSE_FILE' })
}

export async function saveAs() {
  if (!appState.filePath) return
  try {
    const bytes = hasRedactions() || pendingDigitalSignature()
      ? await withDocumentLoading(buildOutputBytes, 'Saving…')
      : await buildOutputBytes()
    const defaultName = basename(appState.filePath) || 'document.pdf'
    const newPath = await window.nativeAPI.saveFileAs(bytes, defaultName)
    if (!newPath) return
    dispatch({ type: 'SET_FILE_PATH', path: newPath })
    dispatch({ type: 'SET_DIRTY', dirty: false })
    showToast('Saved ✓', 2000)
  } catch (err) {
    console.error(err)
    showErrorModal('Save failed: ' + (err && err.message ? err.message : String(err)))
  }
}

// Print only the document: render the output pages (edits, stamps, redactions
// applied) to images in a print-only container; @media print hides the UI.
// Pages are rendered one at a time into blob URLs so large files stay light.
const PRINT_MAX_EDGE = 2200 // px on the long edge, about 200 dpi on Letter/A4

export async function printDocument() {
  if (!appState.filePath) return
  let root = null
  const urls = []
  const cleanup = () => {
    root?.remove()
    root = null
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u))
  }
  let cancelled = false
  const cancelBtn = document.getElementById('loading-cancel')
  const onCancel = () => { cancelled = true }
  cancelBtn?.addEventListener('click', onCancel)
  try {
    await withDocumentLoading(async () => {
      const label = document.querySelector('#loading-overlay p')
      if (cancelBtn) cancelBtn.hidden = false
      const bytes = await (await buildOutputDoc()).save()
      if (cancelled) return
      const pdf = await openIsolatedPdf(bytes)
      root = document.createElement('div')
      root.id = 'print-root'
      document.body.appendChild(root)
      for (let i = 1; i <= pdf.numPages; i++) {
        if (cancelled) break
        if (label) label.textContent = `Preparing to print… page ${i} of ${pdf.numPages}`
        const page = await pdf.getPage(i)
        const base = page.getViewport({ scale: 1 })
        const vp = page.getViewport({ scale: PRINT_MAX_EDGE / Math.max(base.width, base.height) })
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(vp.width)
        canvas.height = Math.floor(vp.height)
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, background: '#ffffff' }).promise
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'))
        canvas.width = canvas.height = 0
        page.cleanup()
        const url = URL.createObjectURL(blob)
        urls.push(url)
        const img = document.createElement('img')
        img.className = 'print-page'
        img.src = url
        root.appendChild(img)
        await img.decode().catch(() => {})
      }
      await pdf.destroy()
    }, 'Preparing to print…')
    if (cancelled) {
      cleanup()
      showToast('Print cancelled', 2000)
      return
    }
    window.addEventListener('afterprint', cleanup, { once: true })
    window.print()
  } catch (err) {
    cleanup()
    console.error(err)
    showErrorModal('Print failed: ' + (err && err.message ? err.message : String(err)))
  } finally {
    cancelBtn?.removeEventListener('click', onCancel)
    if (cancelBtn) cancelBtn.hidden = true
  }
}
