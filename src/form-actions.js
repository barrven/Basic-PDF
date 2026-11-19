import { appState, dispatch } from './state.js'
import { getPdfDocFor } from './renderer.js'
import { showToast } from './main.js'
import { readButtonActions, rectKey } from './form-hide.js'

// Behaviour behind form buttons and calculated fields.
//
// There is no PDF JavaScript engine here. pdf.js exposes the *data* of a few
// well-known actions (GoTo, URI, Named, ResetForm) and the raw script text of
// the rest. We act on the data, and recognise one script shape: Acrobat's
// AFSimple_Calculate("SUM", new Array("a", "b")). Anything else is ignored, so
// a PDF can never run code in the app.

// ─────────── Pure helpers ───────────

const CALC_OPS = { SUM: 'sum', PRD: 'product', AVG: 'average', MIN: 'min', MAX: 'max' }

// AFSimple_Calculate("SUM", new Array ("a", "b"));  ->  { op: 'sum', fields: ['a','b'] }
export function parseCalculation(script) {
  if (typeof script !== 'string') return null
  const m = /AFSimple_Calculate\s*\(\s*"(SUM|PRD|AVG|MIN|MAX)"\s*,\s*(?:new\s+Array\s*)?\(?\s*\[?\s*((?:"(?:[^"\\]|\\.)*"\s*,?\s*)+)\]?\s*\)?\s*\)/.exec(script)
  if (!m) return null
  const fields = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1].replace(/\\(.)/g, '$1'))
  return fields.length ? { op: CALC_OPS[m[1]], fields } : null
}

// AFNumber_Format(2, 0, 0, 0, "", true)  ->  2 decimals
export function parseNumberFormat(script) {
  if (typeof script !== 'string') return null
  const m = /AFNumber_Format\s*\(\s*(\d+)/.exec(script)
  return m ? Math.min(Number(m[1]), 10) : null
}

export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const n = parseFloat(v.replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : null
}

// Empty and non-numeric inputs are skipped, as Acrobat does.
export function computeCalculation(op, values) {
  const nums = values.map(toNumber).filter((n) => n !== null)
  if (nums.length === 0) return 0
  switch (op) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0)
    case 'product':
      return nums.reduce((a, b) => a * b, 1)
    case 'average':
      return nums.reduce((a, b) => a + b, 0) / nums.length
    case 'min':
      return Math.min(...nums)
    case 'max':
      return Math.max(...nums)
    default:
      return 0
  }
}

export function formatCalculated(n, decimals) {
  if (decimals != null) return n.toFixed(decimals)
  return String(Number(n.toFixed(10)))
}

// pdf.js ResetForm: `include` false means the listed fields are the ones to leave
// alone; an empty list means every field.
export function fieldsToReset(allNames, reset) {
  const listed = new Set(reset?.fields || [])
  if (listed.size === 0) return [...allNames]
  return allNames.filter((n) => (reset.include ? listed.has(n) : !listed.has(n)))
}

export function namedPageTarget(action, current, count) {
  switch (action) {
    case 'NextPage':
      return Math.min(current + 1, count - 1)
    case 'PrevPage':
      return Math.max(current - 1, 0)
    case 'FirstPage':
      return 0
    case 'LastPage':
      return count - 1
    default:
      return null
  }
}

export function isSafeLink(url) {
  return typeof url === 'string' && /^(https?:\/\/|mailto:)/i.test(url) && url.length <= 2048
}

// ─────────── Field scan (cached per pdf.js document) ───────────

const scans = new WeakMap()

function scanDocument(doc) {
  if (!scans.has(doc)) {
    scans.set(
      doc,
      (async () => {
        const out = { calcs: [], fields: new Map() }
        let objects = null
        try {
          objects = await doc.getFieldObjects()
        } catch {}
        if (!objects) return out
        let order = null
        try {
          order = await doc.getCalculationOrderIds()
        } catch {}
        for (const [name, list] of Object.entries(objects)) {
          // Fields with several widgets list a typeless parent entry first.
          const first = list.find((o) => o.type) || list[0]
          if (!first || !first.type || first.type === 'button') continue
          out.fields.set(name, { type: first.type, value: first.value, defaultValue: first.defaultValue })
          const calc = parseCalculation(first.actions?.Calculate?.[0])
          if (calc) {
            const decimals = parseNumberFormat(first.actions?.Format?.[0])
            out.calcs.push({ name, id: first.id, decimals, ...calc })
          }
        }
        if (Array.isArray(order) && order.length) {
          const rank = (c) => {
            const i = order.indexOf(c.id)
            return i < 0 ? order.length : i
          }
          out.calcs.sort((a, b) => rank(a) - rank(b))
        }
        return out
      })(),
    )
  }
  return scans.get(doc)
}

function valueOf(sourceId, name, scan) {
  const key = `${sourceId}:${name}`
  if (Object.prototype.hasOwnProperty.call(appState.fieldValues, key)) return appState.fieldValues[key]
  return scan.fields.get(name)?.value
}

// ─────────── Calculations ───────────

// Re-evaluates every calculated field after an edit. `sync(key, value)` updates
// the widgets on screen.
export async function runCalculations(sync) {
  const sources = [...new Set(appState.pages.map((p) => p.sourceId))]
  for (const sourceId of sources) {
    const doc = getPdfDocFor(sourceId)
    if (!doc) continue
    const scan = await scanDocument(doc)
    for (const calc of scan.calcs) {
      const result = formatCalculated(
        computeCalculation(calc.op, calc.fields.map((f) => valueOf(sourceId, f, scan))),
        calc.decimals,
      )
      const key = `${sourceId}:${calc.name}`
      if (String(valueOf(sourceId, calc.name, scan) ?? '') === result) continue
      dispatch({ type: 'SET_FIELD_VALUE', key, value: result, history: false })
      sync(key, result)
    }
  }
}

// ─────────── Hide / Show and Submit (read from the file; pdf.js drops them) ───────────

const buttonScans = new WeakMap()

// Actions pdf.js does not report for the push button `annot`, or [].
export async function extraActionsFor(sourceId, pageIndex, annot) {
  const doc = getPdfDocFor(sourceId)
  if (!doc || typeof doc.getData !== 'function') return []
  if (!buttonScans.has(doc)) {
    buttonScans.set(
      doc,
      doc.getData().then((bytes) => readButtonActions(bytes)).catch(() => new Map()),
    )
  }
  const map = await buttonScans.get(doc)
  return map.get(rectKey(pageIndex, annot.rect)) || []
}

// Visibility set by Hide actions, keyed like field values. Display only: it is
// not written to the saved PDF.
const visibility = new Map()

export function fieldHiddenOverride(key) {
  return visibility.get(key)
}

export function clearVisibility(sourceId) {
  for (const k of [...visibility.keys()]) if (k.startsWith(`${sourceId}:`)) visibility.delete(k)
}

// ─────────── Buttons ───────────

async function resolveDestPage(doc, dest) {
  let explicit = dest
  if (typeof dest === 'string') explicit = await doc.getDestination(dest)
  if (!Array.isArray(explicit) || explicit.length === 0) return null
  const target = explicit[0]
  if (Number.isInteger(target)) return target
  return doc.getPageIndex(target)
}

function goToPage(index) {
  if (index == null || index < 0 || index >= appState.pages.length) return
  dispatch({ type: 'SET_FOCUSED_PAGE', page: index })
}

async function resetFields(sourceId, reset, sync) {
  const doc = getPdfDocFor(sourceId)
  if (!doc) return
  const scan = await scanDocument(doc)
  const names = fieldsToReset([...scan.fields.keys()], reset)
  let first = true
  for (const name of names) {
    const f = scan.fields.get(name)
    let value
    if (f.type === 'checkbox') value = !!f.defaultValue && f.defaultValue !== 'Off'
    else if (f.type === 'radiobutton') value = f.defaultValue && f.defaultValue !== 'Off' ? f.defaultValue : ''
    else value = f.defaultValue ?? ''
    const key = `${sourceId}:${name}`
    dispatch({ type: 'SET_FIELD_VALUE', key, value, history: first })
    first = false
    sync(key, value)
  }
  await runCalculations(sync)
}

// annot: a pdf.js annotation (Link or push-button widget). Returns true if it
// had an action we know how to run.
export async function runButtonAction(entry, annot, sync, extras = [], setHidden = () => {}) {
  const doc = getPdfDocFor(entry.sourceId)
  try {
    const hide = extras.filter((a) => a.type === 'hide')
    if (hide.length) {
      for (const a of hide) {
        for (const name of a.targets) {
          const key = `${entry.sourceId}:${name}`
          visibility.set(key, a.hide)
          setHidden(key)
        }
      }
      return true
    }
    if (extras.some((a) => a.type === 'submit')) {
      showToast("Basic PDF can't submit forms. Save the PDF and send it instead.", 4000)
      return true
    }
    if (annot.resetForm) {
      await resetFields(entry.sourceId, annot.resetForm, sync)
      showToast('Form reset')
      return true
    }
    if (annot.dest && doc) {
      const original = await resolveDestPage(doc, annot.dest)
      const idx = appState.pages.findIndex((p) => p.sourceId === entry.sourceId && p.originalIndex === original)
      if (idx < 0) showToast('That page is no longer in the document')
      else goToPage(idx)
      return true
    }
    if (annot.action) {
      const current = appState.pages.findIndex((p) => p.id === entry.id)
      const target = namedPageTarget(annot.action, current, appState.pages.length)
      if (target === null) return false
      goToPage(target)
      return true
    }
    if (annot.url) {
      if (!isSafeLink(annot.url)) {
        showToast("That kind of link can't be opened")
        return true
      }
      const ok = await window.nativeAPI.confirm(`This PDF wants to open:\n\n${annot.url}`, 'Open link', 'Open link')
      if (ok) await window.nativeAPI.openExternal(annot.url)
      return true
    }
  } catch (err) {
    console.error('form button failed', err)
    showToast("Couldn't run that button")
    return true
  }
  return false
}
