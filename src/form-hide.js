import {
  PDFDict,
  PDFArray,
  PDFName,
  PDFString,
  PDFHexString,
  PDFBool,
  PDFDocument,
} from '../node_modules/pdf-lib/dist/pdf-lib.esm.js'

// pdf.js drops Hide and SubmitForm actions when it parses a push button, so read
// them from the file itself with pdf-lib. Only the structure is read; nothing in
// the PDF is executed.
//
// Returns Map<rectKey, action[]> where rectKey is `${pageIndex}:${x1},${y1},${x2},${y2}`
// (rounded, normalised) and each action is
//   { type: 'hide', targets: string[], hide: boolean } | { type: 'submit', url: string | null }

export function rectKey(pageIndex, rect) {
  const [a, b, c, d] = rect.map((n) => Math.round(n))
  return `${pageIndex}:${Math.min(a, c)},${Math.min(b, d)},${Math.max(a, c)},${Math.max(b, d)}`
}

function fullName(dict) {
  const parts = []
  let d = dict
  for (let i = 0; d && i < 32; i++) {
    const t = d.lookupMaybe(PDFName.of('T'), PDFString, PDFHexString)
    if (t) parts.unshift(t.decodeText())
    d = d.lookupMaybe(PDFName.of('Parent'), PDFDict)
  }
  return parts.join('.')
}

function targetNames(dict) {
  const ctx = dict.context
  const out = []
  const add = (obj) => {
    const v = ctx.lookup(obj)
    if (v instanceof PDFString || v instanceof PDFHexString) out.push(v.decodeText())
    else if (v instanceof PDFDict) out.push(fullName(v))
  }
  const t = dict.get(PDFName.of('T'))
  if (!t) return out
  const resolved = ctx.lookup(t)
  if (resolved instanceof PDFArray) for (let i = 0; i < resolved.size(); i++) add(resolved.get(i))
  else add(t)
  return out.filter(Boolean)
}

function actionsFrom(action, out, depth = 0) {
  if (!(action instanceof PDFDict) || depth > 8) return
  const s = action.lookupMaybe(PDFName.of('S'), PDFName)
  if (s?.decodeText() === 'Hide') {
    const h = action.lookupMaybe(PDFName.of('H'), PDFBool)
    out.push({ type: 'hide', targets: targetNames(action), hide: h ? h.asBoolean() : true })
  } else if (s?.decodeText() === 'SubmitForm') {
    let url = null
    const f = action.lookupMaybe(PDFName.of('F'), PDFDict)
    const u = f?.lookupMaybe(PDFName.of('F'), PDFString, PDFHexString)
    if (u) url = u.decodeText()
    out.push({ type: 'submit', url })
  }
  const next = action.get(PDFName.of('Next'))
  if (!next) return
  const resolved = action.context.lookup(next)
  if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i++) actionsFrom(action.context.lookup(resolved.get(i)), out, depth + 1)
  } else actionsFrom(resolved, out, depth + 1)
}

export async function readButtonActions(bytes) {
  const result = new Map()
  let doc
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false })
  } catch {
    return result
  }
  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.Annots()
    if (!annots) return
    for (let i = 0; i < annots.size(); i++) {
      const widget = annots.lookupMaybe(i, PDFDict)
      if (!widget || widget.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() !== 'Widget') continue
      const list = []
      actionsFrom(widget.lookupMaybe(PDFName.of('A'), PDFDict), list)
      const aa = widget.lookupMaybe(PDFName.of('AA'), PDFDict)
      actionsFrom(aa?.lookupMaybe(PDFName.of('U'), PDFDict), list)
      if (!list.length) continue
      const rect = widget.lookupMaybe(PDFName.of('Rect'), PDFArray)
      if (!rect || rect.size() < 4) continue
      const nums = [0, 1, 2, 3].map((n) => rect.lookup(n).asNumber())
      result.set(rectKey(pageIndex, nums), list)
    }
  })
  return result
}
