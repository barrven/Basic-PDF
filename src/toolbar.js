import { appState, dispatch, createPageEntry, normalizeRotation } from './state.js'
import { withDocumentLoading } from './main.js'
import { addPdfSource } from './renderer.js'
import { showSignatureModal, toggleSigPopover } from './signature.js'
import { showErrorModal, showToast } from './main.js'
import { setTool, markupHighlight, markupRedact } from './markup.js'
import { detectForms } from './forms.js'
import { snapZoom, ZOOM_MIN, ZOOM_MAX } from './zoom.js'

const ICONS = {
  markup: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13l1-3 7-7 2 2-7 7z"/><path d="M9.5 4.5l2 2"/></svg>`,
  highlight: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3l4 4-5 5H5V9z"/><path d="M3 14h10"/></svg>`,
  redact: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="12" height="6" fill="currentColor"/></svg>`,
  text: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4V3h10v1M8 3v10M6 13h4"/></svg>`,
  rect: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="7" height="7"/><circle cx="10.5" cy="5.5" r="3.5"/></svg>`,
  ellipse: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="8" rx="6" ry="4.5"/></svg>`,
  line: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13L13 3"/></svg>`,
  draw: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11c2-5 4-6 5-3s2 2 3-1 2-2 4 0"/></svg>`,
  'add-signature': `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12c2-4 4-6 5-6s1 3 2 3 2-4 4-4"/><path d="M2 14h12"/></svg>`,
}

function makeButton(action, label, iconKey, opts = {}) {
  const btn = document.createElement('button')
  btn.className = 'toolbar-btn'
  btn.dataset.action = action
  btn.setAttribute('style', '-webkit-app-region: no-drag')
  if (opts.title) btn.title = opts.title
  const icon = document.createElement('span')
  icon.className = 'toolbar-icon'
  icon.innerHTML = ICONS[iconKey] ?? ''
  const labelEl = document.createElement('span')
  labelEl.className = 'toolbar-label'
  labelEl.textContent = label
  btn.appendChild(icon)
  btn.appendChild(labelEl)
  return btn
}

function makeSep() {
  const sep = document.createElement('div')
  sep.className = 'sep'
  return sep
}

// kind 'action' runs once on the current text selection; kind 'tool' arms a drawing tool.
const MARKUP_TOOLS = [
  { kind: 'action', action: 'markup-highlight', label: 'Highlight', icon: 'highlight', title: 'Highlight selected text (Ctrl/Cmd+H)' },
  { kind: 'action', action: 'markup-redact', label: 'Redact', icon: 'redact', title: 'Redact selected text' },
  { kind: 'tool', tool: 'text', label: 'Text', icon: 'text', title: 'Add text: click the page, type, then click away (Ctrl+Enter also finishes)' },
  { kind: 'tool', tool: 'rect', label: 'Rectangle', icon: 'rect', title: 'Draw a rectangle' },
  { kind: 'tool', tool: 'ellipse', label: 'Ellipse', icon: 'ellipse', title: 'Draw an ellipse' },
  { kind: 'tool', tool: 'line', label: 'Line', icon: 'line', title: 'Draw a line' },
  { kind: 'tool', tool: 'draw', label: 'Draw', icon: 'draw', title: 'Freehand drawing' },
]

export function initToolbar() {
  const bar = document.getElementById('toolbar')
  bar.innerHTML = ''

  const markupBtn = makeButton('toggle-markup', 'Markup', 'markup', { title: 'Show or hide the markup tools' })
  markupBtn.setAttribute('aria-expanded', 'false')
  markupBtn.setAttribute('aria-controls', 'markup-ribbon')
  bar.appendChild(markupBtn)

  initMarkupRibbon()

  const spacer = document.createElement('div')
  spacer.className = 'toolbar-spacer'
  bar.appendChild(spacer)

  const counter = document.createElement('span')
  counter.id = 'page-counter'
  counter.className = 'page-counter'
  counter.textContent = '— / —'
  bar.appendChild(counter)

  const zoomGroup = document.createElement('div')
  zoomGroup.className = 'zoom-group'
  zoomGroup.setAttribute('style', '-webkit-app-region: no-drag')
  const zoomOut = document.createElement('button')
  zoomOut.dataset.action = 'zoom-out'
  zoomOut.textContent = '−'
  zoomOut.title = 'Zoom out (Ctrl/Cmd+scroll)'
  const zoomLabel = document.createElement('button')
  zoomLabel.id = 'zoom-label'
  zoomLabel.dataset.action = 'zoom-reset'
  zoomLabel.textContent = 'Fit'
  zoomLabel.title = 'Reset zoom (fit to width)'
  const zoomIn = document.createElement('button')
  zoomIn.dataset.action = 'zoom-in'
  zoomIn.textContent = '+'
  zoomIn.title = 'Zoom in (Ctrl/Cmd+scroll)'
  zoomGroup.appendChild(zoomOut)
  zoomGroup.appendChild(zoomLabel)
  zoomGroup.appendChild(zoomIn)
  bar.appendChild(zoomGroup)


  bar.addEventListener('click', onToolbarClick)
  document.getElementById('markup-ribbon').addEventListener('click', onToolbarClick)
  updateToolbar()
}

function initMarkupRibbon() {
  const ribbon = document.getElementById('markup-ribbon')
  ribbon.innerHTML = ''
  // Keep the page's text selection alive when a ribbon button is clicked.
  ribbon.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) e.preventDefault()
  })
  for (const t of MARKUP_TOOLS) {
    const btn = makeButton(t.kind === 'tool' ? 'markup-tool' : t.action, t.label, t.icon, { title: t.title })
    if (t.kind === 'tool') {
      btn.dataset.tool = t.tool
      btn.setAttribute('aria-pressed', 'false')
    }
    ribbon.appendChild(btn)
  }

  const style = document.createElement('div')
  style.className = 'markup-style'
  style.innerHTML = '<input type="color" id="markup-color" value="#e03131" title="Color for text, shapes and lines" aria-label="Markup color">' +
    '<select id="markup-width" title="Line thickness" aria-label="Line thickness">' +
    '<option value="1">Thin</option><option value="2" selected>Medium</option><option value="4">Thick</option><option value="6">Heavy</option></select>'
  ribbon.appendChild(style)
  ribbon.appendChild(makeSep())

  // Signature button with embedded dropdown arrow
  const sigBtn = document.createElement('button')
  sigBtn.className = 'toolbar-btn signature-btn'
  sigBtn.dataset.action = 'add-signature'
  sigBtn.setAttribute('style', '-webkit-app-region: no-drag')
  sigBtn.title = 'Add a signature'
  const sigInner = document.createElement('span')
  sigInner.className = 'label-wrap'
  sigInner.innerHTML = `<span class="toolbar-icon">${ICONS['add-signature']}</span><span class="toolbar-label">Signature</span>`
  sigBtn.appendChild(sigInner)
  const sigArrow = document.createElement('button')
  sigArrow.className = 'sig-dropdown-arrow'
  sigArrow.dataset.action = 'sig-library'
  sigArrow.setAttribute('style', '-webkit-app-region: no-drag')
  sigArrow.title = 'Saved signatures'
  sigArrow.textContent = '▾'
  sigBtn.appendChild(sigArrow)
  ribbon.appendChild(sigBtn)
}

function toggleMarkupRibbon() {
  const ribbon = document.getElementById('markup-ribbon')
  const btn = document.querySelector('#toolbar [data-action="toggle-markup"]')
  ribbon.hidden = !ribbon.hidden
  if (btn) {
    btn.setAttribute('aria-expanded', ribbon.hidden ? 'false' : 'true')
    btn.classList.toggle('active', !ribbon.hidden)
  }
}

function stepZoom(direction) {
  return snapZoom(direction, appState.zoom ?? 100)
}

async function onToolbarClick(e) {
  const target = e.target.closest('[data-action]')
  if (!target) return
  const action = target.dataset.action
  if (target.disabled) return
  switch (action) {
    case 'markup-highlight':
      markupHighlight()
      break
    case 'markup-redact':
      markupRedact()
      break
    case 'markup-tool':
      setTool(target.dataset.tool)
      break
    case 'toggle-markup':
      toggleMarkupRibbon()
      break
    case 'add-signature':
      e.stopPropagation()
      showSignatureModal()
      break
    case 'sig-library':
      e.stopPropagation()
      toggleSigPopover(target)
      break
    case 'zoom-out':
      dispatch({ type: 'SET_ZOOM', zoom: stepZoom('out') })
      break
    case 'zoom-in':
      dispatch({ type: 'SET_ZOOM', zoom: stepZoom('in') })
      break
    case 'zoom-reset':
      dispatch({ type: 'SET_ZOOM', zoom: null })
      break
  }
}

export async function insertPdfFile() {
  if (appState.loading) return
  const result = await window.nativeAPI.openFile()
  if (!result) return
  try {
    await withDocumentLoading(() => insertPdfFromOpenResult(result))
  } catch (err) {
    console.error(err)
    showErrorModal('Could not insert this PDF. It may be corrupt or not a valid PDF.')
  }
}

async function insertPdfFromOpenResult(result) {
  const { PDFDocument } = await import('../node_modules/pdf-lib/dist/pdf-lib.esm.js')

  // Validate the file is a real PDF and get its page count.
  const insertedDoc = await PDFDocument.load(result.buffer, { ignoreEncryption: true })
  const insertCount = insertedDoc.getPageCount()
  if (insertCount === 0) return

  // Keep the inserted PDF as its own source. buildOutputDoc() already merges
  // across sources at save time, so we avoid re-encoding the primary bytes
  // on every insert.
  const sourceId = `inserted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await addPdfSource(sourceId, result.buffer)

  const forms = await detectForms(sourceId)
  if (forms.xfa) showToast("The inserted PDF has an XFA form, which isn't supported. Its fields can't be filled.", 4500)

  const insertAt = appState.focusedPage + 1
  const insertedEntries = Array.from({ length: insertCount }, (_, i) => {
    const angle = insertedDoc.getPage(i).getRotation().angle
    return createPageEntry({
      sourceId,
      originalIndex: i,
      rotation: normalizeRotation(angle),
    })
  })
  const newPages = [
    ...appState.pages.slice(0, insertAt),
    ...insertedEntries,
    ...appState.pages.slice(insertAt),
  ]

  // One atomic dispatch — a single render with the final pages/focusedPage,
  // so the preview can't race against an intermediate state.
  dispatch({
    type: 'INSERT_PAGES',
    sourceId,
    sourceBytes: result.buffer,
    formFields: forms.fields,
    pages: newPages,
    focusedPage: insertAt,
    shiftFromIndex: insertAt,
    shiftDelta: insertCount,
  })
}

function targetPageIndices() {
  if (appState.selectedPages.size > 0) return [...appState.selectedPages]
  if (appState.pages.length === 0) return []
  return [appState.focusedPage]
}

export function deleteSelectedPages() {
  const sel = new Set(targetPageIndices())
  if (sel.size === 0) return
  if (appState.pages.length - sel.size < 1) return
  const newPages = appState.pages.filter((_, i) => !sel.has(i))
  dispatch({ type: 'SET_PAGE_ORDER', pages: newPages })
  dispatch({ type: 'SET_SELECTED_PAGES', pages: new Set([appState.focusedPage]) })
}

export function rotateSelected(delta) {
  const targetIndices = targetPageIndices()
  if (targetIndices.length === 0) return
  const newPages = appState.pages.map((p, i) =>
    targetIndices.includes(i)
      ? { ...p, rotation: normalizeRotation(p.rotation + delta) }
      : p
  )
  dispatch({ type: 'SET_PAGE_ORDER', pages: newPages })
}

export function updateToolbar() {
  const fileOpen = appState.filePath !== null
  const busy = appState.loading
  const map = {
    'add-signature': busy,
    'sig-library': busy,
  }
  for (const [action, disabled] of Object.entries(map)) {
    const btn = document.querySelector(`#toolbar [data-action="${action}"], #markup-ribbon [data-action="${action}"]`)
    if (btn) btn.disabled = disabled
  }
  for (const btn of document.querySelectorAll('#markup-ribbon [data-action^="markup-"]')) {
    btn.disabled = !fileOpen || busy
  }
  const currentZoom = appState.zoom ?? 100
  const zoomOutBtn = document.querySelector('#toolbar [data-action="zoom-out"]')
  const zoomInBtn = document.querySelector('#toolbar [data-action="zoom-in"]')
  if (zoomOutBtn) zoomOutBtn.disabled = !fileOpen || busy || currentZoom <= ZOOM_MIN
  if (zoomInBtn) zoomInBtn.disabled = !fileOpen || busy || currentZoom >= ZOOM_MAX
  const zoomLabelBtn = document.getElementById('zoom-label')
  if (zoomLabelBtn) zoomLabelBtn.disabled = !fileOpen || busy
}

export function updatePageCounter() {
  const counter = document.getElementById('page-counter')
  if (!counter) return
  if (!appState.filePath || appState.pages.length === 0) {
    counter.textContent = '— / —'
  } else {
    counter.textContent = `${appState.focusedPage + 1} / ${appState.pages.length}`
  }
}

export function updateZoomLabel() {
  const el = document.getElementById('zoom-label')
  if (!el) return
  el.textContent = appState.zoom === null ? 'Fit' : appState.zoom + '%'
}
