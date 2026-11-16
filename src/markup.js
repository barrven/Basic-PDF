import { appState, dispatch, subscribe } from './state.js'
import { getPageViewByIndex } from './preview.js'
import { isPlacing, exitPlacementMode } from './signature.js'
import { applyHighlightFromSelection, applyRedactFromSelection } from './annotate.js'
import { showToast } from './main.js'
import { TEXT_BASELINE, TEXT_LINE_HEIGHT, DEFAULT_FONT_SIZE } from './markup-save.js'

// Drawn markup annotations share appState.annotations with highlight/redact.
// Types: 'text' | 'rect' | 'ellipse' | 'line' | 'draw'. All coordinates are in
// pdf.js visual top-left page space (same as stamps and highlights).
export const MARKUP_TYPES = new Set(['text', 'rect', 'ellipse', 'line', 'draw'])

const SVG_NS = 'http://www.w3.org/2000/svg'
const MIN_SIZE = 3

let tool = null
let drag = null
let editor = null

export function getActiveTool() {
  return tool
}

export function initMarkup() {
  const host = document.getElementById('preview-pages')
  if (!host) return

  host.addEventListener('mousedown', (e) => {
    // Keep focus from jumping away from a freshly created text editor.
    if (tool && !e.target.closest('.markup-text-editor')) e.preventDefault()
  })
  host.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('pointermove', onPointerMove)
  document.addEventListener('pointerup', onPointerUp)
  document.addEventListener('pointercancel', cancelDrag)

  // Pages are rebuilt on open / zoom / reorder; repaint markup when they are.
  new MutationObserver(paintAll).observe(host, { childList: true })

  host.addEventListener('click', (e) => {
    if (tool) return
    const item = e.target.closest('.markup-item')
    if (!item) return
    e.stopPropagation()
    dispatch({ type: 'SET_SELECTED_ANNOTATION', id: item.dataset.id })
    const pageEl = item.closest('.preview-page')
    const idx = pageEl ? Number(pageEl.dataset.index) : -1
    if (idx >= 0 && idx !== appState.focusedPage) {
      dispatch({ type: 'SET_FOCUSED_PAGE', page: idx })
    }
  })

  let prevAnnots = null
  let prevSelected = null
  subscribe(() => {
    if (!appState.filePath && tool) setTool(null)
    if (appState.annotations !== prevAnnots || appState.selectedAnnotation !== prevSelected) {
      prevAnnots = appState.annotations
      prevSelected = appState.selectedAnnotation
      paintAll()
    }
  })
  window.addEventListener('resize', paintAll)
}

// ─────────── Tool selection ───────────

export function setTool(name) {
  closeEditor(true)
  cancelDrag()
  tool = tool === name ? null : name
  if (tool && isPlacing()) exitPlacementMode()
  document.body.classList.toggle('markup-tool-active', !!tool)
  for (const btn of document.querySelectorAll('#markup-ribbon [data-tool]')) {
    const on = btn.dataset.tool === tool
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-pressed', on ? 'true' : 'false')
  }
}

export function markupHighlight() {
  if (!applyHighlightFromSelection()) showToast('Select some text first, then click Highlight.', 2500)
}

export function markupRedact() {
  if (!applyRedactFromSelection()) showToast('Select some text first, then click Redact.', 2500)
}

function currentStyle() {
  const color = document.getElementById('markup-color')?.value || '#e03131'
  const width = Number(document.getElementById('markup-width')?.value) || 2
  return { color, strokeWidth: width }
}

// ─────────── Pointer interaction ───────────

function viewFromEvent(e) {
  const el = e.target.closest?.('.preview-page')
  if (!el) return null
  return getPageViewByIndex(Number(el.dataset.index))
}

function toPagePoint(view, e) {
  const r = view.el.getBoundingClientRect()
  const scale = view.scale || 1
  const x = Math.min(Math.max((e.clientX - r.left) / scale, 0), view.pdfWidth)
  const y = Math.min(Math.max((e.clientY - r.top) / scale, 0), view.pdfHeight)
  return { x, y }
}

function onPointerDown(e) {
  if (!tool || e.button !== 0 || isPlacing() || appState.loading) return
  if (e.target.closest('.markup-text-editor')) return
  closeEditor(true)
  const view = viewFromEvent(e)
  if (!view) return
  e.preventDefault()
  const p = toPagePoint(view, e)
  if (tool === 'text') {
    startTextEditor(view, p)
    return
  }
  drag = { view, start: p, points: [p], tool, style: currentStyle() }
}

function onPointerMove(e) {
  if (!drag) return
  const p = toPagePoint(drag.view, e)
  if (drag.tool === 'draw') {
    const last = drag.points[drag.points.length - 1]
    if (Math.hypot(p.x - last.x, p.y - last.y) < 0.75) return
    drag.points.push(p)
  } else {
    drag.end = p
  }
  paintDraft()
}

function onPointerUp(e) {
  if (!drag) return
  onPointerMove(e)
  const annot = buildAnnotation(drag)
  const view = drag.view
  clearDraft(view)
  drag = null
  if (annot) {
    dispatch({ type: 'ADD_ANNOTATION', annotation: annot })
  }
}

function cancelDrag() {
  if (!drag) return
  clearDraft(drag.view)
  drag = null
}

function buildAnnotation(d) {
  const base = {
    id: crypto.randomUUID(),
    type: d.tool,
    pageIndex: d.view.index,
    color: d.style.color,
    strokeWidth: d.style.strokeWidth,
  }
  if (d.tool === 'draw') {
    if (d.points.length < 2) return null
    return { ...base, points: d.points }
  }
  const s = d.start
  const t = d.end
  if (!t) return null
  if (d.tool === 'line') {
    if (Math.hypot(t.x - s.x, t.y - s.y) < MIN_SIZE) return null
    return { ...base, x1: s.x, y1: s.y, x2: t.x, y2: t.y }
  }
  const x = Math.min(s.x, t.x)
  const y = Math.min(s.y, t.y)
  const width = Math.abs(t.x - s.x)
  const height = Math.abs(t.y - s.y)
  if (width < MIN_SIZE || height < MIN_SIZE) return null
  return { ...base, x, y, width, height }
}

// ─────────── Text entry ───────────

function startTextEditor(view, p) {
  const scale = view.scale || 1
  const { color } = currentStyle()
  const ta = document.createElement('textarea')
  ta.className = 'markup-text-editor'
  ta.wrap = 'off'
  ta.rows = 1
  ta.spellcheck = false
  ta.setAttribute('aria-label', 'Text annotation')
  Object.assign(ta.style, {
    left: p.x * scale + 'px',
    top: p.y * scale + 'px',
    fontSize: DEFAULT_FONT_SIZE * scale + 'px',
    lineHeight: String(TEXT_LINE_HEIGHT),
    color,
  })
  const fit = () => {
    ta.style.width = '0px'
    ta.style.height = '0px'
    ta.style.width = Math.max(60 * scale, ta.scrollWidth + 6) + 'px'
    ta.style.height = ta.scrollHeight + 'px'
  }
  ta.addEventListener('input', fit)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeEditor(false)
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      closeEditor(true)
    }
  })
  ta.addEventListener('blur', () => closeEditor(true))
  view.el.appendChild(ta)
  editor = { ta, view, p, color }
  fit()
  setTimeout(() => ta.focus(), 0)
}

function closeEditor(commit) {
  if (!editor) return
  const { ta, view, p, color } = editor
  editor = null
  const text = ta.value.replace(/\s+$/, '')
  const scale = view.scale || 1
  const width = ta.offsetWidth / scale
  const height = ta.offsetHeight / scale
  ta.remove()
  if (!commit || !text.trim()) return
  dispatch({
    type: 'ADD_ANNOTATION',
    annotation: {
      id: crypto.randomUUID(),
      type: 'text',
      pageIndex: view.index,
      x: p.x,
      y: p.y,
      width,
      height,
      text,
      fontSize: DEFAULT_FONT_SIZE,
      color,
    },
  })
}

// ─────────── SVG painting ───────────

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

function layerFor(view) {
  let svg = view.el.querySelector(':scope > .markup-layer')
  if (!svg) {
    svg = svgEl('svg', { class: 'markup-layer', preserveAspectRatio: 'none' })
    const before = view.el.querySelector(':scope > .signature-overlay-layer')
    view.el.insertBefore(svg, before)
  }
  svg.setAttribute('viewBox', `0 0 ${view.pdfWidth} ${view.pdfHeight}`)
  return svg
}

function strokeAttrs(a, extra = {}) {
  return {
    fill: 'none',
    stroke: a.color,
    'stroke-width': a.strokeWidth,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    ...extra,
  }
}

function shapeElement(a, extra) {
  switch (a.type) {
    case 'rect':
      return svgEl('rect', { x: a.x, y: a.y, width: a.width, height: a.height, ...strokeAttrs(a, extra) })
    case 'ellipse':
      return svgEl('ellipse', {
        cx: a.x + a.width / 2,
        cy: a.y + a.height / 2,
        rx: a.width / 2,
        ry: a.height / 2,
        ...strokeAttrs(a, extra),
      })
    case 'line':
      return svgEl('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, ...strokeAttrs(a, extra) })
    case 'draw': {
      const d = a.points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')
      return svgEl('path', { d, ...strokeAttrs(a, extra) })
    }
    default:
      return null
  }
}

function buildNode(a, interactive) {
  const g = svgEl('g')
  if (a.type === 'text') {
    const lines = a.text.split(/\r?\n/)
    lines.forEach((line, i) => {
      const t = svgEl('text', {
        x: a.x,
        y: a.y + a.fontSize * (TEXT_BASELINE + TEXT_LINE_HEIGHT * i),
        'font-size': a.fontSize,
        'font-family': 'Helvetica, Arial, sans-serif',
        fill: a.color,
        style: 'white-space: pre',
      })
      t.textContent = line
      g.appendChild(t)
    })
    if (interactive) {
      g.appendChild(svgEl('rect', {
        x: a.x, y: a.y, width: a.width, height: a.height,
        fill: 'transparent', stroke: 'none', 'pointer-events': 'all',
      }))
    }
  } else {
    const shape = shapeElement(a)
    if (shape) g.appendChild(shape)
    if (interactive) {
      // Wider invisible stroke so thin lines are easy to click.
      const hit = shapeElement(a, {
        stroke: 'transparent',
        'stroke-width': Math.max(a.strokeWidth, 10),
        'pointer-events': 'stroke',
      })
      if (hit) g.appendChild(hit)
    }
  }
  if (interactive) {
    g.setAttribute('class', 'markup-item')
    g.dataset.id = a.id
    if (a.id === appState.selectedAnnotation) g.classList.add('markup-selected')
  }
  return g
}

function paintAll() {
  const host = document.getElementById('preview-pages')
  if (!host) return
  const byPage = new Map()
  for (const a of appState.annotations) {
    if (!MARKUP_TYPES.has(a.type)) continue
    if (!byPage.has(a.pageIndex)) byPage.set(a.pageIndex, [])
    byPage.get(a.pageIndex).push(a)
  }
  for (const el of host.querySelectorAll(':scope > .preview-page')) {
    const view = getPageViewByIndex(Number(el.dataset.index))
    if (!view) continue
    const svg = layerFor(view)
    svg.replaceChildren()
    for (const a of byPage.get(view.index) || []) svg.appendChild(buildNode(a, true))
  }
}

function paintDraft() {
  if (!drag) return
  const svg = layerFor(drag.view)
  svg.querySelector('.markup-draft')?.remove()
  const a = buildAnnotation({ ...drag, end: drag.end ?? drag.start, points: drag.points.length < 2 ? [drag.start, drag.start] : drag.points })
  // Draft bypasses minimum-size checks so feedback shows from the first pixel.
  const draft = a ?? draftFallback(drag)
  if (!draft) return
  const node = buildNode(draft, false)
  node.setAttribute('class', 'markup-draft')
  svg.appendChild(node)
}

function draftFallback(d) {
  const s = d.start
  const t = d.end ?? s
  const base = { id: 'draft', type: d.tool, color: d.style.color, strokeWidth: d.style.strokeWidth }
  if (d.tool === 'line') return { ...base, x1: s.x, y1: s.y, x2: t.x, y2: t.y }
  if (d.tool === 'draw') return { ...base, points: d.points.length ? d.points : [s, s] }
  return { ...base, x: Math.min(s.x, t.x), y: Math.min(s.y, t.y), width: Math.abs(t.x - s.x), height: Math.abs(t.y - s.y) }
}

function clearDraft(view) {
  view?.el.querySelector(':scope > .markup-layer .markup-draft')?.remove()
}
