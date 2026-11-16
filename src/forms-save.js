import {
  PDFName,
  PDFDict,
  PDFRef,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
} from '../node_modules/pdf-lib/dist/pdf-lib.esm.js'

// Writes the user's form edits into a source document *before* its pages are
// copied into the output, because the source is the one that still has its
// AcroForm. Returns the number of fields that could not be set.
export function applyFieldValues(doc, sourceId, values) {
  const prefix = `${sourceId}:`
  const entries = Object.entries(values).filter(([k]) => k.startsWith(prefix))
  if (!entries.length) return 0
  let form
  try {
    form = doc.getForm()
  } catch (err) {
    console.error('could not read form', err)
    return entries.length
  }
  let failed = 0
  for (const [key, value] of entries) {
    const name = key.slice(prefix.length)
    try {
      const field = form.getField(name)
      if (field instanceof PDFTextField) {
        field.setText(String(value ?? ''))
      } else if (field instanceof PDFCheckBox) {
        if (value) field.check()
        else field.uncheck()
      } else if (field instanceof PDFRadioGroup) {
        if (value === '' || value == null) {
          field.clear()
        } else {
          // pdf.js reports the widget's on-state name ("0", "1", ...). pdf-lib
          // selects by option label, which differs when the field has /Opt.
          const options = field.getOptions()
          const v = String(value)
          const label = options.includes(v) ? v : /^\d+$/.test(v) ? options[Number(v)] : undefined
          if (label === undefined) throw new Error(`unknown radio option ${v}`)
          field.select(label)
        }
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        const raw = Array.isArray(value) ? value.map(String) : value === '' || value == null ? [] : [String(value)]
        // Options may carry separate export and display values; pdf-lib selects by display.
        const table = new Map(field.acroField.getOptions().map((o) => [o.value, o.display]))
        const picked = raw.map((v) => table.get(v) ?? v)
        if (picked.length === 0) field.clear()
        else field.select(picked.length === 1 ? picked[0] : picked)
      }
    } catch (err) {
      failed++
      console.error('form field set failed', name, err)
    }
  }
  try {
    form.updateFieldAppearances()
  } catch (err) {
    console.error('form appearance update failed', err)
  }
  return failed
}

// A widget's optional /P points back at its page. copyPages() follows it, so a
// widget from a page the user deleted (reachable through a shared field's /Kids)
// would drag that whole page's content into the output. Drop the back-pointers
// from the source before copying.
export function stripWidgetPageRefs(doc) {
  for (const page of doc.getPages()) {
    const annots = page.node.Annots()
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookupMaybe(i, PDFDict)
      if (dict && dict.get(PDFName.of('Subtype')) === PDFName.of('Widget')) {
        dict.delete(PDFName.of('P'))
      }
    }
  }
}

// copyPages() brings widget annotations across but not the document's AcroForm,
// so without this the saved fields would be dead (visible, not editable). Rebuild
// /AcroForm from the widgets that actually landed on output pages.
export function rebuildAcroForm(newDoc) {
  const roots = []
  const seen = new Set()
  for (const page of newDoc.getPages()) {
    const annots = page.node.Annots()
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookupMaybe(i, PDFDict)
      if (!dict || dict.get(PDFName.of('Subtype')) !== PDFName.of('Widget')) continue
      let ref = annots.get(i)
      let cur = dict
      for (let depth = 0; depth < 32; depth++) {
        const parent = cur.get(PDFName.of('Parent'))
        if (!(parent instanceof PDFRef)) break
        ref = parent
        cur = newDoc.context.lookup(parent, PDFDict)
        if (!cur) break
      }
      if (!(ref instanceof PDFRef)) continue
      const id = ref.toString()
      if (seen.has(id)) continue
      seen.add(id)
      roots.push(ref)
    }
  }
  if (!roots.length) return 0
  const acro = newDoc.context.obj({
    Fields: roots,
    DA: '/Helv 0 Tf 0 g',
  })
  newDoc.catalog.set(PDFName.of('AcroForm'), newDoc.context.register(acro))
  return roots.length
}
