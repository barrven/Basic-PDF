import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs'
import { PRIMARY_SOURCE_ID } from './state.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../node_modules/pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).href

const pdfDocs = new Map() // sourceId -> pdf.js PDFDocumentProxy
let primaryBytes = null

async function loadPdfSource(sourceId, bytes) {
  // pdf.js consumes the buffer; clone so callers retain ownership.
  const copy = bytes.slice()
  const loadingTask = pdfjsLib.getDocument({ data: copy })
  const doc = await loadingTask.promise
  pdfDocs.set(sourceId, doc)
  return doc
}

export async function setPrimarySource(bytes) {
  pdfDocs.clear()
  primaryBytes = bytes
  return loadPdfSource(PRIMARY_SOURCE_ID, bytes)
}

export async function addPdfSource(sourceId, bytes) {
  return loadPdfSource(sourceId, bytes)
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
