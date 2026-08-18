import { PDFDocument, degrees } from '../node_modules/pdf-lib/dist/pdf-lib.esm.js'
import { appState, dispatch, PRIMARY_SOURCE_ID } from './state.js'
import { setPrimarySource } from './renderer.js'
import { showToast, showErrorModal } from './main.js'

function basename(p) {
  if (!p) return ''
  return p.split(/[\\/]/).pop()
}

export async function openFile() {
  try {
    const result = await window.electronAPI.openFile()
    if (!result) return
    const { path, buffer } = result
    await loadFromBytes(path, buffer)
  } catch (err) {
    console.error(err)
    showErrorModal('Could not open this file. It may be corrupt or not a valid PDF.')
  }
}

export async function loadFromBytes(filePath, bytes) {
  try {
    // Validate it loads with pdf-lib (catches malformed files).
    await PDFDocument.load(bytes)
    const pdfDoc = await setPrimarySource(bytes)
    const pageCount = pdfDoc.numPages
    const pages = []
    for (let i = 0; i < pageCount; i++) {
      pages.push({ sourceId: PRIMARY_SOURCE_ID, originalIndex: i, rotation: 0 })
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

async function buildOutputDoc() {
  const newDoc = await PDFDocument.create()
  const srcDocs = new Map() // sourceId -> pdf-lib PDFDocument
  async function getSrcDoc(sourceId) {
    if (srcDocs.has(sourceId)) return srcDocs.get(sourceId)
    const bytes = await getSourceBytes(sourceId)
    const doc = await PDFDocument.load(bytes)
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
    if (entry.rotation) {
      pageToAdd.setRotation(degrees(entry.rotation))
    }
  }

  for (const sig of appState.signatures) {
    if (sig.pageIndex < 0 || sig.pageIndex >= appState.pages.length) continue
    const pdfPage = newDoc.getPage(sig.pageIndex)
    const b64 = sig.dataUrl.replace(/^data:image\/\w+;base64,/, '')
    const imgBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    let embeddedImg
    if (sig.dataUrl.startsWith('data:image/png')) {
      embeddedImg = await newDoc.embedPng(imgBytes)
    } else {
      embeddedImg = await newDoc.embedJpg(imgBytes)
    }
    // Signatures anchor to the un-rotated page coordinate system; sig.x/y are
    // PDF.js top-left, so flip y into pdf-lib's bottom-left space.
    const pageHeight = pdfPage.getHeight()
    const pdfLibY = pageHeight - sig.y - sig.height
    pdfPage.drawImage(embeddedImg, {
      x: sig.x,
      y: pdfLibY,
      width: sig.width,
      height: sig.height,
      opacity: sig.opacity ?? 1,
    })
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
