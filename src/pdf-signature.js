import {
  PDFName,
  PDFNumber,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFString,
} from '../node_modules/pdf-lib/dist/pdf-lib.esm.js'
import { pointToUnrotated } from './markup-save.js'

// Reserves a cryptographic signature in a pdf-lib document: a /Sig dictionary
// with a fixed-width /ByteRange and a zero-filled /Contents, plus an AcroForm
// signature field whose widget sits over the placed stamp. The Rust shell
// (signing.rs, sign_pdf) later fills both in. BYTE_RANGE_PLACEHOLDER must match
// the string it searches for.

// pdf-lib serializes arrays as "[ a b c ]"; the shell searches for this exact text.
export const BYTE_RANGE_PLACEHOLDER = '/ByteRange [ 0 1234567890 1234567890 1234567890 ]'
// Room for the CMS blob (signature + certificate chain), in bytes.
const CONTENTS_BYTES = 12288

// The save has to be a plain serialization: object streams would hide the
// placeholder from the byte-level patching.
export const SIGNED_SAVE_OPTIONS = { useObjectStreams: false }

export function addSignaturePlaceholder(doc, pdfPage, stamp, meta = {}) {
  const ctx = doc.context

  const info = {
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'ETSI.CAdES.detached',
    ByteRange: [0, 1234567890, 1234567890, 1234567890],
    Contents: PDFHexString.of('0'.repeat(CONTENTS_BYTES * 2)),
    M: PDFString.fromDate(new Date()),
  }
  if (meta.name) info.Name = PDFHexString.fromText(meta.name)
  if (meta.reason) info.Reason = PDFHexString.fromText(meta.reason)
  if (meta.location) info.Location = PDFHexString.fromText(meta.location)
  const sigRef = ctx.register(ctx.obj(info))

  // The stamp's visual rectangle, as an axis-aligned box in unrotated page space.
  const corners = [
    pointToUnrotated(pdfPage, stamp.x, stamp.y),
    pointToUnrotated(pdfPage, stamp.x + stamp.width, stamp.y),
    pointToUnrotated(pdfPage, stamp.x, stamp.y + stamp.height),
    pointToUnrotated(pdfPage, stamp.x + stamp.width, stamp.y + stamp.height),
  ]
  const xs = corners.map((c) => c.x)
  const ys = corners.map((c) => c.y)
  const widgetRef = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      V: sigRef,
      T: PDFHexString.fromText('Signature1'),
      F: 132, // print + locked
      P: pdfPage.ref,
    }),
  )
  pdfPage.node.addAnnot(widgetRef)

  let acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)
  if (!acro) {
    acro = ctx.obj({ Fields: [] })
    doc.catalog.set(PDFName.of('AcroForm'), ctx.register(acro))
  }
  let fields = acro.lookupMaybe(PDFName.of('Fields'), PDFArray)
  if (!fields) {
    fields = ctx.obj([])
    acro.set(PDFName.of('Fields'), fields)
  }
  fields.push(widgetRef)
  acro.set(PDFName.of('SigFlags'), PDFNumber.of(3)) // signatures exist + append-only
}

// True when a loaded document already carries a signed /Sig dictionary. Saving
// rebuilds the document, which discards it.
export function documentHasSignature(doc) {
  const byteRange = PDFName.of('ByteRange')
  const contents = PDFName.of('Contents')
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.has(byteRange) && obj.has(contents)) return true
  }
  return false
}
