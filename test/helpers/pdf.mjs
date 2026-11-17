import {
  PDFDocument, StandardFonts, rgb, PDFName, PDFString, PDFDict, PDFRawStream, decodePDFRawStream,
} from '../../node_modules/pdf-lib/dist/pdf-lib.esm.js'

export { PDFDocument, PDFName, PDFDict }

// 1x1 PNG as a data URL (a stand-in signature image).
export const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// Builds a PDF and returns its bytes. Each page carries a unique /Marker string
// so tests can tell source pages apart after they have been copied around.
export async function makePdf({ pages = 1, size = [300, 400], rotations = [], form = false } = {}) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const made = []
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage(size)
    page.drawText(`Page ${i + 1}`, { x: 20, y: 350, size: 12, font, color: rgb(0.2, 0.2, 0.2) })
    page.node.set(PDFName.of('Marker'), PDFString.of(`marker-${i}`))
    if (rotations[i]) page.setRotation({ type: 'degrees', angle: rotations[i] })
    made.push(page)
  }
  if (form) {
    const f = doc.getForm()
    f.createTextField('name').addToPage(made[0], { x: 20, y: 300, width: 150, height: 20 })
    f.createCheckBox('agree').addToPage(made[0], { x: 20, y: 270, width: 15, height: 15 })
    const color = f.createRadioGroup('color')
    color.addOptionToPage('red', made[0], { x: 20, y: 240, width: 15, height: 15 })
    color.addOptionToPage('blue', made[0], { x: 60, y: 240, width: 15, height: 15 })
    const pick = f.createDropdown('pick')
    pick.addOptions(['one', 'two', 'three'])
    pick.addToPage(made[0], { x: 20, y: 200, width: 100, height: 20 })
  }
  return doc.save()
}

// Two pages and one text field whose widgets sit on both pages.
export async function makeSharedFieldPdf() {
  const doc = await PDFDocument.create()
  const p1 = doc.addPage([300, 400])
  const p2 = doc.addPage([300, 400])
  p1.node.set(PDFName.of('Marker'), PDFString.of('marker-0'))
  p2.node.set(PDFName.of('Marker'), PDFString.of('marker-1'))
  const field = doc.getForm().createTextField('shared')
  field.addToPage(p1, { x: 10, y: 10, width: 100, height: 20 })
  field.addToPage(p2, { x: 10, y: 10, width: 100, height: 20 })
  return doc.save()
}

export async function load(bytes) {
  return PDFDocument.load(bytes, { ignoreEncryption: true })
}

// The /Marker of each page, in order: which source page each output page is.
export async function pageMarkers(bytes) {
  const doc = await load(bytes)
  return doc.getPages().map((p) => {
    const m = p.node.get(PDFName.of('Marker'))
    return m instanceof PDFString ? m.decodeText() : null
  })
}

// True when any object in the document carries a /Marker equal to `marker`.
export async function containsMarker(bytes, marker) {
  const doc = await load(bytes)
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict) {
      const m = obj.get(PDFName.of('Marker'))
      if (m instanceof PDFString && m.decodeText() === marker) return true
    }
  }
  return false
}

// A page's decoded content stream(s) as text.
export function pageContent(page) {
  const ctx = page.doc.context
  const parts = []
  const take = (obj) => {
    const s = ctx.lookup(obj)
    if (s instanceof PDFRawStream) parts.push(new TextDecoder('latin1').decode(decodePDFRawStream(s).decode()))
  }
  const contents = page.node.get(PDFName.of('Contents'))
  const resolved = contents && ctx.lookup(contents)
  if (resolved && typeof resolved.size === 'function' && typeof resolved.get === 'function') {
    for (let i = 0; i < resolved.size(); i++) take(resolved.get(i))
  } else if (contents) {
    take(contents)
  }
  return parts.join('\n')
}
