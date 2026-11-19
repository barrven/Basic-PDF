import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument, PDFName, PDFString } from '../node_modules/pdf-lib/dist/pdf-lib.esm.js'
import { readButtonActions, rectKey } from '../src/form-hide.js'

async function pdfWithButtons() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([600, 800])
  const ctx = doc.context
  const widget = (rect, action) =>
    ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Btn', Ff: 65536, T: PDFString.of('b'), Rect: rect, A: ctx.obj(action) }))
  const hide = widget([10, 20, 110, 60], { S: 'Hide', T: PDFString.of('field-specific'), H: true })
  const show = widget([120, 20, 220, 60], { S: 'Hide', T: PDFString.of('field-specific'), H: false })
  const submit = widget([230, 20, 330, 60], { S: 'SubmitForm', F: { Type: 'Filespec', FS: 'URL', F: PDFString.of('https://example.test/') } })
  page.node.set(PDFName.of('Annots'), ctx.obj([hide, show, submit]))
  return doc.save()
}

test('reads Hide / Show / SubmitForm that pdf.js drops', async () => {
  const map = await readButtonActions(await pdfWithButtons())
  assert.deepEqual(map.get(rectKey(0, [10, 20, 110, 60])), [{ type: 'hide', targets: ['field-specific'], hide: true }])
  assert.deepEqual(map.get(rectKey(0, [120, 20, 220, 60])), [{ type: 'hide', targets: ['field-specific'], hide: false }])
  assert.deepEqual(map.get(rectKey(0, [230, 20, 330, 60])), [{ type: 'submit', url: 'https://example.test/' }])
})

test('rectKey normalises corner order', () => {
  assert.equal(rectKey(1, [10.4, 20, 5, 30.2]), rectKey(1, [5, 30, 10, 20]))
})

test('garbage bytes give an empty map', async () => {
  assert.equal((await readButtonActions(new Uint8Array([1, 2, 3]))).size, 0)
})
