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
    // Fetch CMaps and standard fonts on the main thread, not in the worker.
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

// ---- Render queue ----------------------------------------------------------
// Page rasterization is the expensive part of showing a document, and both the
// preview and the thumbnail list ask for it. Everything goes through this queue
// so that preview pages always run before thumbnails, only a couple of pages
// rasterize at once, and requests for pages that have scrolled away are
// dropped instead of rendered.

export const RENDER_PRIORITY = { PREVIEW: 0, THUMBNAIL: 1 }
const MAX_CONCURRENT_RENDERS = 2
const renderQueues = [[], []]
let activeRenders = 0

// run: async () => void. isWanted: checked when the job is picked; a job that
// is no longer wanted resolves false without running. rank: lower runs first
// within the same priority.
export function scheduleRender(priority, run, isWanted = () => true, rank = () => 0) {
  return new Promise((resolve, reject) => {
    renderQueues[priority].push({ run, isWanted, rank, resolve, reject })
    pumpRenderQueue()
  })
}

function takeNextRenderJob() {
  for (const queue of renderQueues) {
    let best = -1
    let bestRank = Infinity
    for (let i = queue.length - 1; i >= 0; i--) {
      const job = queue[i]
      if (!job.isWanted()) {
        queue.splice(i, 1)
        if (best > i) best--
        job.resolve(false)
        continue
      }
      const r = job.rank()
      if (r < bestRank) {
        bestRank = r
        best = i
      }
    }
    if (best >= 0) return queue.splice(best, 1)[0]
  }
  return null
}

function pumpRenderQueue() {
  while (activeRenders < MAX_CONCURRENT_RENDERS) {
    const job = takeNextRenderJob()
    if (!job) return
    activeRenders++
    Promise.resolve()
      .then(job.run)
      .then(() => job.resolve(true), job.reject)
      .finally(() => {
        activeRenders--
        pumpRenderQueue()
      })
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
