import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs'
import { PRIMARY_SOURCE_ID } from './state.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../node_modules/pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href

const CMAP_URL = new URL('../node_modules/pdfjs-dist/cmaps/', import.meta.url).href
const STANDARD_FONT_DATA_URL = new URL(
  '../node_modules/pdfjs-dist/standard_fonts/',
  import.meta.url
).href

const pdfDocs = new Map() // sourceId -> pdf.js PDFDocumentProxy
const textContentCache = new Map() // `${sourceId}:${originalIndex}` -> Promise<TextContent>
let primaryBytes = null

function textContentKey(sourceId, originalIndex) {
  return sourceId + ':' + originalIndex
}

function clearTextContentCache() {
  textContentCache.clear()
}

async function loadPdfSource(sourceId, bytes) {
  // pdf.js consumes the buffer; clone so callers retain ownership.
  const copy = bytes.slice()
  const loadingTask = pdfjsLib.getDocument({
    data: copy,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    // Worker-side fetch of file:// CMaps/fonts is unreliable in Electron.
    useWorkerFetch: false,
  })
  const doc = await loadingTask.promise
  pdfDocs.set(sourceId, doc)
  return doc
}

export async function setPrimarySource(bytes) {
  pdfDocs.clear()
  clearTextContentCache()
  primaryBytes = bytes
  return loadPdfSource(PRIMARY_SOURCE_ID, bytes)
}

export async function addPdfSource(sourceId, bytes) {
  return loadPdfSource(sourceId, bytes)
}

export function clearPdfSources() {
  pdfDocs.clear()
  clearTextContentCache()
  primaryBytes = null
}

export function getPdfDoc() {
  return pdfDocs.get(PRIMARY_SOURCE_ID) || null
}

export function getPdfDocBytes() {
  return primaryBytes
}

export async function getPage(sourceId, originalIndex) {
  const doc = pdfDocs.get(sourceId)
  if (!doc) throw new Error(`No PDF loaded for source ${sourceId}`)
  // PDF.js is 1-indexed.
  return await doc.getPage(originalIndex + 1)
}

export async function getPageTextContent(sourceId, originalIndex) {
  const key = textContentKey(sourceId, originalIndex)
  const cached = textContentCache.get(key)
  if (cached) return cached
  const promise = (async () => {
    const page = await getPage(sourceId, originalIndex)
    return page.getTextContent()
  })()
  textContentCache.set(key, promise)
  try {
    return await promise
  } catch (err) {
    textContentCache.delete(key)
    throw err
  }
}

export function drawBlankPlaceholder(canvas, width, height) {
  canvas.width = Math.floor(width)
  canvas.height = Math.floor(height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#F4F4F4'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#888888'
  ctx.font = '12px "DM Sans", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('Blank page', canvas.width / 2, canvas.height / 2)
}

export const PAGE_SIZE_A4 = { width: 595, height: 842 }

export function visualPageSize(width, height, rotation) {
  const rot = ((rotation % 360) + 360) % 360
  if (rot === 90 || rot === 270) return { width: height, height: width }
  return { width, height }
}

export async function openIsolatedPdf(bytes) {
  const copy = bytes.slice()
  const loadingTask = pdfjsLib.getDocument({
    data: copy,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    useWorkerFetch: false,
  })
  return loadingTask.promise
}
