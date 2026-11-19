import { appState, dispatch } from './state.js'
import { getPdfDocFor } from './renderer.js'
import { runButtonAction, runCalculations, extraActionsFor, fieldHiddenOverride, clearVisibility } from './form-actions.js'
import { showToast } from './main.js'

// Fill-in AcroForm fields (text, checkbox, radio, dropdown, list box).
//
// Field edits live in appState.fieldValues keyed by `${sourceId}:${fieldName}`
// (the fully-qualified AcroForm name), never by page index, so they survive page
// reorder / delete / duplicate. appState.formFields records which source pages
// carry fillable widgets (`${sourceId}:${originalIndex}` -> true).
//
// Widgets are plain DOM controls laid over the page canvas. pdf.js already paints
// each field's original appearance on the canvas; the controls are opaque so the
// old value never shows through.

const FILLABLE_SUBTYPE = 'Widget'

export function fieldKey(sourceId, fieldName) {
  return `${sourceId}:${fieldName}`
}

export function pageFormKey(sourceId, originalIndex) {
  return `${sourceId}:${originalIndex}`
}

export function pageHasForm(entry) {
  return !!entry && entry.originalIndex >= 0 && !!appState.formFields[pageFormKey(entry.sourceId, entry.originalIndex)]
}

function isFillable(obj) {
  if (!obj || obj.hidden || obj.editable === false) return false
  return ['text', 'checkbox', 'radiobutton', 'combobox', 'listbox'].includes(obj.type)
}

// Cheap on documents without a form: getFieldObjects() resolves to null.
export async function detectForms(sourceId) {
  clearVisibility(sourceId)
  const doc = getPdfDocFor(sourceId)
  if (!doc) return { fields: {}, xfa: false }
  let xfa = false
  try {
    xfa = !!doc.isPureXfa
  } catch {}
  if (xfa) return { fields: {}, xfa: true }
  let objects = null
  try {
    objects = await doc.getFieldObjects()
  } catch (err) {
    console.error('form detection failed', err)
  }
  const fields = {}
  if (objects) {
    for (const list of Object.values(objects)) {
      for (const obj of list) {
        // Push buttons need the form layer too (links, reset), even on pages with no input.
        if ((isFillable(obj) || obj.type === 'button') && Number.isInteger(obj.page)) fields[pageFormKey(sourceId, obj.page)] = true
      }
    }
  }
  return { fields, xfa: false }
}

// ─────────── Widgets ───────────

function rectOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function currentValue(key, fallback) {
  return Object.prototype.hasOwnProperty.call(appState.fieldValues, key) ? appState.fieldValues[key] : fallback
}

function asText(v) {
  if (Array.isArray(v)) return v.join(', ')
  return v == null ? '' : String(v)
}

function fontSizeFor(annot, heightPx, scale, multiline) {
  const pt = annot.defaultAppearanceData?.fontSize
  if (pt && pt > 0) return pt * scale
  return multiline ? 12 * scale : Math.max(8, Math.min(heightPx * 0.62, 18 * scale))
}

function makeControl(annot, key, heightPx, scale) {
  if (annot.checkBox) {
    const el = document.createElement('input')
    el.type = 'checkbox'
    const v = currentValue(key, annot.fieldValue)
    el.checked = v === true || (v != null && v !== false && v !== 'Off' && String(v) === String(annot.exportValue ?? 'Yes'))
    el.dataset.kind = 'checkbox'
    el.setAttribute('aria-label', annot.alternativeText || annot.fieldName)
    return el
  }
  if (annot.radioButton) {
    const el = document.createElement('input')
    el.type = 'radio'
    el.name = key
    el.value = String(annot.buttonValue ?? '')
    const v = currentValue(key, annot.fieldValue)
    el.checked = v != null && String(v) === String(annot.buttonValue)
    el.dataset.kind = 'radio'
    el.setAttribute('aria-label', annot.alternativeText || annot.fieldName)
    return el
  }
  if (annot.fieldType === 'Ch') {
    const el = document.createElement('select')
    el.dataset.kind = annot.combo ? 'combo' : 'list'
    if (annot.multiSelect) el.multiple = true
    if (!annot.combo) el.size = Math.max(2, Math.floor(heightPx / (14 * scale)) || 2)
    const v = currentValue(key, annot.fieldValue)
    const selected = new Set((Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String))
    // Without a stored value a combo would silently show its first entry.
    if (annot.combo && selected.size === 0) {
      const blank = document.createElement('option')
      blank.value = ''
      blank.selected = true
      el.appendChild(blank)
    }
    for (const opt of annot.options || []) {
      const o = document.createElement('option')
      o.value = String(opt.exportValue ?? opt.displayValue ?? '')
      o.textContent = String(opt.displayValue ?? opt.exportValue ?? '')
      o.selected = selected.has(o.value)
      el.appendChild(o)
    }
    el.style.fontSize = fontSizeFor(annot, heightPx, scale, false) + 'px'
    el.setAttribute('aria-label', annot.alternativeText || annot.fieldName)
    return el
  }
  // Text field.
  const multiline = !!annot.multiLine
  const el = document.createElement(multiline ? 'textarea' : 'input')
  if (!multiline) el.type = annot.password ? 'password' : 'text'
  el.value = asText(currentValue(key, annot.fieldValue))
  if (annot.maxLen) el.maxLength = annot.maxLen
  el.dataset.kind = 'text'
  el.spellcheck = false
  el.style.fontSize = fontSizeFor(annot, heightPx, scale, multiline) + 'px'
  const align = ['left', 'center', 'right'][annot.textAlignment] || 'left'
  el.style.textAlign = align
  el.setAttribute('aria-label', annot.alternativeText || annot.fieldName)
  return el
}

// Transparent click target over a push button. pdf.js already painted the
// button's own appearance on the canvas.
function makeButtonOverlay(annot, viewport, entry, extras) {
  const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annot.rect)
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'form-button'
  el.style.left = Math.min(x1, x2) + 'px'
  el.style.top = Math.min(y1, y2) + 'px'
  el.style.width = Math.abs(x2 - x1) + 'px'
  el.style.height = Math.abs(y2 - y1) + 'px'
  el.setAttribute('aria-label', annot.alternativeText || annot.fieldName || 'Button')
  el.addEventListener('click', async () => {
    const handled = await runButtonAction(entry, annot, (key, value) => syncSiblings(null, key, value), extras, applyVisibility)
    if (!handled) showToast("This button's action isn't supported in Basic PDF")
  })
  return el
}

// Builds the widgets for one page. Returns the number of controls created.
export async function renderFormLayer(view, page, viewport, entry) {
  const layer = view.formLayer
  if (!layer) return 0
  layer.replaceChildren()
  if (!pageHasForm(entry)) return 0
  let annots
  try {
    annots = await page.getAnnotations({ intent: 'display' })
  } catch (err) {
    console.error('could not read form widgets', err)
    return 0
  }
  const scale = viewport.scale
  const frag = document.createDocumentFragment()
  let count = 0
  for (const annot of annots) {
    if (annot.subtype !== FILLABLE_SUBTYPE || !annot.fieldName) continue
    if (annot.pushButton) {
      if (!annot.isTooltipOnly && !annot.hidden) {
        const extras = await extraActionsFor(entry.sourceId, entry.originalIndex, annot)
        frag.appendChild(makeButtonOverlay(annot, viewport, entry, extras))
        count++
      }
      continue
    }
    // A read-only field is still shown if a script fills it in (calculated totals).
    if ((annot.readOnly && !annot.actions?.Calculate) || annot.fieldType === 'Sig') continue
    if (!['Tx', 'Btn', 'Ch'].includes(annot.fieldType)) continue
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annot.rect)
    const left = Math.min(x1, x2)
    const top = Math.min(y1, y2)
    const width = Math.abs(x2 - x1)
    const height = Math.abs(y2 - y1)
    if (width < 2 || height < 2) continue
    const key = fieldKey(entry.sourceId, annot.fieldName)
    const wrap = document.createElement('div')
    wrap.className = 'form-widget'
    wrap.style.left = left + 'px'
    wrap.style.top = top + 'px'
    wrap.style.width = width + 'px'
    wrap.style.height = height + 'px'
    wrap.dataset.key = key
    wrap.dataset.origHidden = annot.hidden ? '1' : ''
    wrap.dataset.vx = String(left / scale)
    wrap.dataset.vy = String(top / scale)
    wrap.dataset.vw = String(width / scale)
    wrap.dataset.vh = String(height / scale)
    const control = makeControl(annot, key, height, scale)
    if (annot.readOnly) control.readOnly = true
    control.dataset.key = key
    setWidgetVisibility(wrap)
    wrap.appendChild(control)
    frag.appendChild(wrap)
    count++
  }
  layer.appendChild(frag)
  applyFormRedactionLocks(view)
  return count
}

// 'off': hidden in the PDF itself, nothing painted underneath. 'cover': hidden by
// a Hide action, so the field's painted appearance must be covered.
function setWidgetVisibility(wrap) {
  const override = fieldHiddenOverride(wrap.dataset.key)
  const hidden = override === undefined ? wrap.dataset.origHidden === '1' : override
  if (!hidden) delete wrap.dataset.vis
  else wrap.dataset.vis = wrap.dataset.origHidden === '1' ? 'off' : 'cover'
}

function applyVisibility(key) {
  for (const wrap of document.querySelectorAll('#preview-pages .form-widget')) {
    if (wrap.dataset.key === key) setWidgetVisibility(wrap)
  }
}

// A redaction over a widget hides it in the preview (the page is flattened to an
// image on save, so the field would not survive there anyway).
export function applyFormRedactionLocks(view) {
  const layer = view?.formLayer
  if (!layer || !layer.firstChild) return
  const redacts = appState.annotations.filter((a) => a.type === 'redact' && a.pageIndex === view.index)
  for (const wrap of layer.querySelectorAll('.form-widget')) {
    const box = {
      x: Number(wrap.dataset.vx),
      y: Number(wrap.dataset.vy),
      width: Number(wrap.dataset.vw),
      height: Number(wrap.dataset.vh),
    }
    const covered = redacts.some((a) => a.rects.some((r) => rectOverlap(r, box)))
    wrap.classList.toggle('form-widget-redacted', covered)
  }
}

// ─────────── Edits ───────────

let freshGesture = true

function readValue(el) {
  switch (el.dataset.kind) {
    case 'checkbox':
      return el.checked
    case 'radio':
      return el.value
    case 'list':
    case 'combo':
      return el.multiple ? [...el.selectedOptions].map((o) => o.value) : el.value
    default:
      return el.value
  }
}

function syncSiblings(source, key, value) {
  for (const el of document.querySelectorAll('#preview-pages .form-widget [data-key]')) {
    if (el === source || el.dataset.key !== key) continue
    const kind = el.dataset.kind
    if (kind === 'text') el.value = asText(value)
    else if (kind === 'checkbox') el.checked = value === true
    else if (kind === 'radio') el.checked = String(value) === el.value
    else if (kind === 'combo' || kind === 'list') {
      const sel = new Set((Array.isArray(value) ? value : [value]).map(String))
      for (const o of el.options) o.selected = sel.has(o.value)
    }
  }
}

function onEdit(e) {
  const el = e.target.closest?.('.form-widget [data-key]')
  if (!el) return
  const kind = el.dataset.kind
  // Typing coalesces into one undo step per focus; discrete controls push one each.
  const history = kind === 'text' ? freshGesture : true
  if (kind === 'text') freshGesture = false
  const key = el.dataset.key
  const value = readValue(el)
  dispatch({ type: 'SET_FIELD_VALUE', key, value, history })
  syncSiblings(el, key, value)
  runCalculations((k, v) => syncSiblings(null, k, v)).catch((err) => console.error('calculation failed', err))
}

export function initForms() {
  const host = document.getElementById('preview-pages')
  if (!host) return
  host.addEventListener('focusin', () => {
    freshGesture = true
  })
  host.addEventListener('input', (e) => {
    if (e.target.dataset?.kind === 'text') onEdit(e)
  })
  host.addEventListener('change', (e) => {
    if (e.target.dataset?.kind !== 'text') onEdit(e)
  })
}

// ─────────── Redaction flatten support ───────────

// pages flattened to an image are drawn by pdf.js itself, so hand it the user's
// edits through annotationStorage before rendering (annotationMode ENABLE_STORAGE).
export async function applyFormValuesToStorage(pdfJsDoc, sourceId, originalIndex) {
  let objects = null
  try {
    objects = await pdfJsDoc.getFieldObjects()
  } catch {
    return
  }
  if (!objects) return
  const storage = pdfJsDoc.annotationStorage
  for (const [name, list] of Object.entries(objects)) {
    const key = fieldKey(sourceId, name)
    if (!Object.prototype.hasOwnProperty.call(appState.fieldValues, key)) continue
    const value = appState.fieldValues[key]
    for (const obj of list) {
      if (obj.page !== originalIndex || !obj.id) continue
      if (obj.type === 'checkbox') storage.setValue(obj.id, { value: value === true })
      else if (obj.type === 'radiobutton') {
        const mine = obj.exportValues ?? obj.buttonValue
        storage.setValue(obj.id, { value: String(value) === String(mine) })
      } else storage.setValue(obj.id, { value })
    }
  }
}
