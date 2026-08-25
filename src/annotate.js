import { Util } from '../node_modules/pdfjs-dist/build/pdf.mjs'
import { appState, dispatch, subscribe } from './state.js'
import { textLayerFromSelection, getPageViewByIndex } from './preview.js'
import { isPlacing } from './signature.js'
import { showToast } from './main.js'

export const HIGHLIGHT_COLOR = '#ffe566'
export const HIGHLIGHT_RGB = { r: 1, g: 229 / 255, b: 102 / 255 }

let popoverRaf = 0
let didToastRedact = false

export function initAnnotate() {
  const pop = document.getElementById('annotate-popover')
  if (!pop) return

  pop.addEventListener('mousedown', (e) => e.preventDefault())
  document.getElementById('annotate-highlight')?.addEventListener('click', () => {
    applyHighlightFromSelection()
  })
  document.getElementById('annotate-redact')?.addEventListener('click', () => {
    applyRedactFromSelection()
  })

  document.addEventListener('selectionchange', scheduleAnnotatePopover)

  const pane = document.getElementById('preview-pane')
  pane?.addEventListener('scroll', () => {
    if (!isAnnotatePopoverOpen()) return
    scheduleAnnotatePopover()
  }, { passive: true })

  window.addEventListener('resize', () => {
    if (!isAnnotatePopoverOpen()) return
    scheduleAnnotatePopover()
  })

  subscribe(() => {
    if (isPlacing() || !appState.filePath) hideAnnotatePopover()
  })
}

export function isAnnotatePopoverOpen() {
  const pop = document.getElementById('annotate-popover')
  return !!(pop && !pop.hidden)
}

export function hideAnnotatePopover() {
  const pop = document.getElementById('annotate-popover')
  if (!pop || pop.hidden) return false
  pop.hidden = true
  return true
}

function setAnnotateButtonLabel(btn, swatchClass, label) {
  if (!btn) return
  const swatch = document.createElement('span')
  swatch.className = 'annot-swatch ' + swatchClass
  swatch.setAttribute('aria-hidden', 'true')
  btn.replaceChildren(swatch, document.createTextNode(label))
}

function scheduleAnnotatePopover() {
  if (popoverRaf) cancelAnimationFrame(popoverRaf)
  popoverRaf = requestAnimationFrame(() => {
    popoverRaf = 0
    syncAnnotatePopover()
  })
}

function syncAnnotatePopover() {
  const pop = document.getElementById('annotate-popover')
  if (!pop) return
  if (isPlacing() || !appState.filePath) {
    pop.hidden = true
    return
  }
  const draft = getTextSelectionForAnnotate()
  if (!draft) {
    pop.hidden = true
    return
  }

  const overlapping = overlappingAnnotations(draft)
  setAnnotateButtonLabel(
    document.getElementById('annotate-highlight'),
    'annot-swatch-highlight',
    overlapping.some((a) => a.type === 'highlight') ? 'Remove highlight' : 'Highlight',
  )
  setAnnotateButtonLabel(
    document.getElementById('annotate-redact'),
    'annot-swatch-redact',
    overlapping.some((a) => a.type === 'redact') ? 'Remove redaction' : 'Redact',
  )

  const sel = window.getSelection()
  const range = sel?.rangeCount ? sel.getRangeAt(0) : null
  if (!range) {
    pop.hidden = true
    return
  }
  pop.hidden = false
  const rect = range.getBoundingClientRect()
  const w = pop.offsetWidth
  const h = pop.offsetHeight
  let left = rect.left + rect.width / 2 - w / 2
  let top = rect.top - h - 8
  if (top < 8) top = rect.bottom + 8
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8)
  pop.style.left = left + 'px'
  pop.style.top = top + 'px'
}

export function rectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y
}

export function mergeLineRects(rects) {
  if (rects.length <= 1) return rects.map((r) => ({ ...r }))
  const sorted = rects.map((r) => ({ ...r })).sort((a, b) => a.y - b.y || a.x - b.x)
  const merged = []
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    if (!last) {
      merged.push(r)
      continue
    }
    const yTol = Math.max(1.5, Math.min(last.height, r.height) * 0.4)
    const hTol = Math.max(2, Math.min(last.height, r.height) * 0.5)
    const sameLine = Math.abs(r.y - last.y) <= yTol && Math.abs(r.height - last.height) <= hTol
    const touching = r.x <= last.x + last.width + 3
    if (sameLine && touching) {
      const right = Math.max(last.x + last.width, r.x + r.width)
      const bottom = Math.max(last.y + last.height, r.y + r.height)
      last.x = Math.min(last.x, r.x)
      last.y = Math.min(last.y, r.y)
      last.width = right - last.x
      last.height = bottom - last.y
    } else {
      merged.push(r)
    }
  }
  return merged
}

export function getTextSelectionForAnnotate() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const layer = textLayerFromSelection()
  if (!layer) return null
  const pageEl = layer.closest('.preview-page')
  if (!pageEl) return null
  const index = Number(pageEl.dataset.index)
  const view = getPageViewByIndex(index)
  if (!view) return null

  const focusNode = sel.focusNode
  const focusEl = focusNode?.nodeType === Node.ELEMENT_NODE ? focusNode : focusNode?.parentElement
  if (focusEl && !layer.contains(focusEl) && focusEl !== layer) return null

  const range = sel.getRangeAt(0)
  const pageRect = view.el.getBoundingClientRect()
  const scale = view.scale || 1
  const raw = []
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue
    if (r.bottom < pageRect.top || r.top > pageRect.bottom) continue
    if (r.right < pageRect.left || r.left > pageRect.right) continue
    raw.push({
      x: (r.left - pageRect.left) / scale,
      y: (r.top - pageRect.top) / scale,
      width: r.width / scale,
      height: r.height / scale,
    })
  }
  const rects = mergeLineRects(raw)
  if (!rects.length) return null
  return { pageIndex: index, rects }
}

function expandRects(rects, type) {
  return rects.map((r) => {
    const padY = type === 'redact' ? r.height * 0.12 : r.height * 0.08
    const padX = type === 'redact' ? 0.6 : 0
    return {
      x: r.x - padX,
      y: r.y - padY,
      width: r.width + padX * 2,
      height: r.height + padY * 2,
    }
  })
}

function overlappingAnnotations(draft) {
  if (!draft) return []
  return appState.annotations.filter((a) => {
    if (a.pageIndex !== draft.pageIndex) return false
    return a.rects.some((ar) => draft.rects.some((dr) => rectsOverlap(ar, dr)))
  })
}

function createAnnotation(type, draft) {
  return {
    id: crypto.randomUUID(),
    type,
    pageIndex: draft.pageIndex,
    rects: expandRects(draft.rects, type),
    color: type === 'highlight' ? HIGHLIGHT_COLOR : '#000000',
  }
}

function clearWindowSelection() {
  const sel = window.getSelection()
  if (sel) sel.removeAllRanges()
}

function toggleOrAdd(type) {
  const draft = getTextSelectionForAnnotate()
  if (!draft) return false
  const overlapping = overlappingAnnotations(draft).filter((a) => a.type === type)
  if (overlapping.length) {
    dispatch({ type: 'DELETE_ANNOTATIONS', ids: overlapping.map((a) => a.id) })
  } else {
    dispatch({ type: 'ADD_ANNOTATION', annotation: createAnnotation(type, draft) })
    if (type === 'redact' && !didToastRedact) {
      didToastRedact = true
      showToast('Redacted text is removed from the page when you save.', 3500)
    }
  }
  clearWindowSelection()
  hideAnnotatePopover()
  return true
}

export function applyHighlightFromSelection() {
  return toggleOrAdd('highlight')
}

export function applyRedactFromSelection() {
  return toggleOrAdd('redact')
}

export function textItemVisualRect(item, viewport) {
  if (!item?.transform || !viewport?.transform) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const tx = Util.transform(viewport.transform, item.transform)
  const height = Math.hypot(tx[2], tx[3])
  const tmScale = Math.hypot(item.transform[0], item.transform[1]) || 1
  const width = (item.width || 0) * (Math.hypot(tx[0], tx[1]) / tmScale)
  return {
    x: tx[4],
    y: tx[5] - height,
    width,
    height,
  }
}

function hitVisualRects(hit, items, viewport) {
  let remaining = hit.length
  let offset = hit.offset
  const rects = []
  for (let i = hit.itemIndex; i < items.length && remaining > 0; i++) {
    const item = items[i]
    const str = item.str || ''
    const start = i === hit.itemIndex ? offset : 0
    if (start > str.length) break
    const take = Math.min(remaining, str.length - start)
    if (take > 0 && str.length > 0) {
      const full = textItemVisualRect(item, viewport)
      const frac0 = start / str.length
      const frac1 = (start + take) / str.length
      rects.push({
        x: full.x + full.width * frac0,
        y: full.y,
        width: full.width * (frac1 - frac0),
        height: full.height,
      })
      remaining -= take
    } else if (take <= 0) {
      break
    }
  }
  return rects
}

export function filterHitsCoveredByRedactions(hits, items, viewport, pageIndex) {
  const redacts = appState.annotations.filter((a) => a.type === 'redact' && a.pageIndex === pageIndex)
  if (!redacts.length || !hits.length) return hits
  return hits.filter((hit) => {
    const rects = hitVisualRects(hit, items, viewport)
    return !rects.some((hr) => redacts.some((a) => a.rects.some((rr) => rectsOverlap(hr, rr))))
  })
}
