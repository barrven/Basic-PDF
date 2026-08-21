import { PDFDocument, degrees } from '../node_modules/pdf-lib/dist/pdf-lib.esm.js'
import { appState, dispatch, PRIMARY_SOURCE_ID, createPageEntry, normalizeRotation } from './state.js'
import { setPrimarySource, clearPdfSources } from './renderer.js'
import { showToast, showErrorModal } from './main.js'

const LOAD_OPTS = { ignoreEncryption: true }

function basename(p) {
  if (!p) return ''
  return p.split(/[\\/]/).pop()
}

export async function openFile() {
  try {
    if (appState.filePath && appState.dirty) {
      const ok = window.confirm('You have unsaved changes. Open a different file anyway?')
      if (!ok) return
    }
    const result = await window.electronAPI.openFile()
    if (!result) return
    const { path, buffer } = result
    await loadFromBytes(path, buffer)
  } catch (err) {
    console.error(err)
    // loadFromBytes already presents the error modal.
  }
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

// sig.x/y are PDF.js visual top-left coords (page already rotated). pdf-lib
// draws in unrotated media-box space, so convert and rotate the image to match.
function drawSignatureOnPage(pdfPage, embeddedImg, sig) {
  const rotation = normalizeRotation(pdfPage.getRotation().angle)
  const { width: pageWidth, height: pageHeight } = pdfPage.getSize()
  const visX = sig.x
  const visY = sig.y
  const visW = sig.width
  const visH = sig.height
  const opts = { width: visW, height: visH, opacity: sig.opacity ?? 1 }

  if (rotation === 90) {
    pdfPage.drawImage(embeddedImg, {
      ...opts,
      x: visY + visH,
      y: visX,
      rotate: degrees(90),
    })
    return
  }
  if (rotation === 180) {
    pdfPage.drawImage(embeddedImg, {
      ...opts,
      x: pageWidth - visX,
      y: visY + visH,
      rotate: degrees(180),
    })
    return
  }
  if (rotation === 270) {
    pdfPage.drawImage(embeddedImg, {
      ...opts,
      x: pageWidth - visY - visH,
      y: pageHeight - visX,
      rotate: degrees(270),
    })
    return
  }
  pdfPage.drawImage(embeddedImg, {
    ...opts,
    x: visX,
    y: pageHeight - visY - visH,
  })
}

async function buildOutputDoc() {
  const newDoc = await PDFDocument.create()
  const srcDocs = new Map() // sourceId -> pdf-lib PDFDocument
  async function getSrcDoc(sourceId) {
    if (srcDocs.has(sourceId)) return srcDocs.get(sourceId)
    const bytes = await getSourceBytes(sourceId)
    const doc = await PDFDocument.load(bytes, LOAD_OPTS)
    srcDocs.set(sourceId, doc)
    return doc
  }

  for (const entry of appState.pages) {
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
  }

  for (const sig of appState.signatures) {
    if (sig.pageIndex < 0 || sig.pageIndex >= appState.pages.length) continue
    const pdfPage = newDoc.getPage(sig.pageIndex)
    const embeddedImg = await embedSignatureImage(newDoc, sig.dataUrl)
    drawSignatureOnPage(pdfPage, embeddedImg, sig)
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

export async function save() {
  if (!appState.filePath) return
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
    const newDoc = await buildOutputDoc()
    const bytes = await newDoc.save()
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
