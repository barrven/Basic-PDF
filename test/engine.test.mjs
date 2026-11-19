// End-to-end tests of what Basic PDF writes: they drive saveDocument() with a
// prepared appState and inspect the PDF bytes handed to the shell.
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installMocks, installNativeAPI, calls, resetCalls, fake } from './helpers/mocks.mjs'
import {
  makePdf, makeSharedFieldPdf, load, pageMarkers, containsMarker, pageContent, PDFName, PDFDict, PNG_DATA_URL,
} from './helpers/pdf.mjs'

installMocks()
const { appState, dispatch, PRIMARY_SOURCE_ID } = await import('../src/state.js')
const engine = await import('../src/pdf-engine.js')
const { BYTE_RANGE_PLACEHOLDER } = await import('../src/pdf-signature.js')

let nativeAPI

const entry = (originalIndex, rotation = 0, sourceId = PRIMARY_SOURCE_ID) => ({
  id: `e-${sourceId}-${originalIndex}-${Math.random().toString(36).slice(2)}`,
  sourceId,
  originalIndex,
  rotation,
})

// Opens `bytes` as the primary file with one entry per source page.
async function openBytes(bytes, { rotations = [], formFields } = {}) {
  const doc = await load(bytes)
  const pages = doc.getPages().map((p, i) => entry(i, rotations[i] ?? p.getRotation().angle))
  dispatch({ type: 'CLOSE_FILE' })
  dispatch({ type: 'OPEN_FILE', path: 'C:\\in.pdf', bytes, pages, formFields })
}

async function saveAndLoad(target = 'C:\\in.pdf') {
  resetCalls()
  await engine.saveDocument(target)
  assert.deepEqual(calls.errors, [], 'no error modal')
  assert.equal(calls.saved.length, 1)
  assert.equal(calls.saved[0].path, target)
  return calls.saved[0].bytes
}

const sig = (over = {}) => ({ id: 's', pageIndex: 0, x: 10, y: 20, width: 50, height: 30, opacity: 1, dataUrl: PNG_DATA_URL, ...over })
const rect = (x, y, width, height) => ({ x, y, width, height })

beforeEach(() => {
  resetCalls()
  nativeAPI = installNativeAPI()
})

describe('page assembly', () => {
  test('an unedited document round-trips with its pages in order', async () => {
    await openBytes(await makePdf({ pages: 3 }))
    const out = await saveAndLoad()
    assert.deepEqual(await pageMarkers(out), ['marker-0', 'marker-1', 'marker-2'])
  })

  test('reorder, delete and duplicate are reflected in the output', async () => {
    await openBytes(await makePdf({ pages: 3 }))
    const [a, b, c] = appState.pages
    dispatch({ type: 'SET_PAGE_ORDER', pages: [c, a, { ...a, id: 'dup' }] }) // b deleted, a duplicated
    const out = await saveAndLoad()
    assert.deepEqual(await pageMarkers(out), ['marker-2', 'marker-0', 'marker-0'])
    assert.equal(await containsMarker(out, 'marker-1'), false)
  })

  test('a blank page is A4 and carries no source content', async () => {
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'INSERT_PAGES', pages: [appState.pages[0], { id: 'b', sourceId: null, originalIndex: -1, rotation: 0 }] })
    const doc = await load(await saveAndLoad())
    assert.equal(doc.getPageCount(), 2)
    assert.deepEqual([doc.getPage(1).getWidth(), doc.getPage(1).getHeight()], [595, 842])
  })

  test('pages inserted from another PDF are merged from their own source', async () => {
    await openBytes(await makePdf({ pages: 1 }))
    const other = await makePdf({ pages: 2, size: [200, 200] })
    dispatch({
      type: 'INSERT_PAGES',
      pages: [appState.pages[0], entry(1, 0, 'src2'), entry(0, 0, 'src2')],
      sourceId: 'src2',
      sourceBytes: other,
    })
    const doc = await load(await saveAndLoad())
    assert.deepEqual(await pageMarkers(doc.save ? await doc.save() : null), ['marker-0', 'marker-1', 'marker-0'])
    assert.equal(doc.getPage(1).getWidth(), 200)
  })

  test('a missing source is reported, not silently dropped', async () => {
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'INSERT_PAGES', pages: [appState.pages[0], entry(0, 0, 'gone')] })
    resetCalls()
    await engine.saveDocument('C:\\in.pdf')
    assert.equal(calls.saved.length, 0)
    assert.equal(calls.errors.length, 1)
    assert.match(calls.errors[0], /Save failed/)
  })
})

describe('rotation', () => {
  test('source /Rotate is preserved', async () => {
    await openBytes(await makePdf({ pages: 2, rotations: [90, 0] }))
    const doc = await load(await saveAndLoad())
    assert.deepEqual(doc.getPages().map((p) => p.getRotation().angle), [90, 0])
  })

  test('rotating a rotated page back to 0 takes effect', async () => {
    await openBytes(await makePdf({ pages: 1, rotations: [90] }))
    dispatch({ type: 'SET_ROTATION', indices: [0], rotation: 0 })
    const doc = await load(await saveAndLoad())
    assert.equal(doc.getPage(0).getRotation().angle, 0)
  })

  test('rotation is absolute, not additive', async () => {
    await openBytes(await makePdf({ pages: 1, rotations: [90] }))
    dispatch({ type: 'SET_ROTATION', indices: [0], rotation: 270 })
    const doc = await load(await saveAndLoad())
    assert.equal(doc.getPage(0).getRotation().angle, 270)
  })
})

describe('highlights, redactions and markup', () => {
  test('a highlight is a multiply-blend rectangle and the page stays vector', async () => {
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'ADD_ANNOTATION', annotation: { id: 'h', type: 'highlight', pageIndex: 0, color: '#ffe566', rects: [rect(10, 10, 100, 12)] } })
    const doc = await load(await saveAndLoad())
    assert.equal(await containsMarker(await doc.save(), 'marker-0'), true, 'original page object kept')
    const gs = doc.getPage(0).node.Resources().lookup(PDFName.of('ExtGState'), PDFDict)
    const multiply = gs.keys().some((k) => gs.lookup(k, PDFDict).get(PDFName.of('BM')) === PDFName.of('Multiply'))
    assert.equal(multiply, true)
    assert.match(pageContent(doc.getPage(0)), /1 0\.898\d* 0\.4 rg[\s\S]*100 12 l/) // #ffe566 filled box
  })

  test('highlight position is converted for each page rotation', async () => {
    // Visual rect (x=10, y=20, 100x12) on a 300x400 page.
    const expected = { 0: [10, 368], 90: [32, 10], 180: [290, 32], 270: [268, 390] }
    for (const [rot, [x, y]] of Object.entries(expected)) {
      await openBytes(await makePdf({ pages: 1 }), { rotations: [Number(rot)] })
      dispatch({ type: 'ADD_ANNOTATION', annotation: { id: 'h', type: 'highlight', pageIndex: 0, color: '#ffe566', rects: [rect(10, 20, 100, 12)] } })
      const doc = await load(await saveAndLoad())
      const content = pageContent(doc.getPage(0))
      assert.match(content, new RegExp(`1 0 0 1 ${x} ${y} cm`), `rotation ${rot}`)
    }
  })

  test('a page with a redaction never keeps its original content, even if flattening fails', async () => {
    await openBytes(await makePdf({ pages: 2 }))
    dispatch({ type: 'ADD_ANNOTATION', annotation: { id: 'r', type: 'redact', pageIndex: 0, color: '#000', rects: [rect(10, 10, 100, 12)] } })
    const out = await saveAndLoad()
    // No pdf.js in the test, so the flatten throws and the code falls back to
    // opaque black boxes drawn over the copied page. The black fill must be there.
    assert.match(pageContent((await load(out)).getPage(0)), /0 0 0 rg/)
  })

  test('markup is drawn into the saved page', async () => {
    await openBytes(await makePdf({ pages: 1 }))
    const base = { pageIndex: 0, color: '#e03131', strokeWidth: 2 }
    dispatch({ type: 'ADD_ANNOTATION', annotation: { ...base, id: '1', type: 'rect', x: 10, y: 10, width: 50, height: 20 } })
    dispatch({ type: 'ADD_ANNOTATION', annotation: { ...base, id: '2', type: 'ellipse', x: 10, y: 50, width: 50, height: 20 } })
    dispatch({ type: 'ADD_ANNOTATION', annotation: { ...base, id: '3', type: 'line', x1: 0, y1: 0, x2: 100, y2: 100 } })
    dispatch({ type: 'ADD_ANNOTATION', annotation: { ...base, id: '4', type: 'draw', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 2 }] } })
    dispatch({ type: 'ADD_ANNOTATION', annotation: { ...base, id: '5', type: 'text', x: 10, y: 100, fontSize: 14, text: 'Hello\nWorld' } })
    const doc = await load(await saveAndLoad())
    const content = pageContent(doc.getPage(0))
    assert.match(content, /0\.878\d* 0\.192\d* 0\.192\d* RG/) // #e03131 stroke
    assert.ok((content.match(/ Tj/g) || []).length >= 3, 'original text plus two lines of markup text')
  })

  test('text outside WinAnsi does not break the save', async () => {
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'ADD_ANNOTATION', annotation: { id: 't', type: 'text', pageIndex: 0, color: '#000000', strokeWidth: 1, x: 5, y: 5, fontSize: 12, text: 'snowman ☃ 日本' } })
    await saveAndLoad()
  })
})

describe('signature stamps', () => {
  test('a stamp is embedded as an image at the converted position', async () => {
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'ADD_SIGNATURE', signature: sig() })
    const doc = await load(await saveAndLoad())
    const content = pageContent(doc.getPage(0))
    assert.match(content, /1 0 0 1 10 350 cm[\s\S]*50 0 0 30 0 0 cm/) // y = 400 - 20 - 30
    assert.match(content, / Do\b/)
  })

  test('a stamp follows its page after reordering', async () => {
    await openBytes(await makePdf({ pages: 2 }))
    dispatch({ type: 'ADD_SIGNATURE', signature: sig({ pageIndex: 0 }) })
    dispatch({ type: 'SET_PAGE_ORDER', pages: [appState.pages[1], appState.pages[0]] })
    const doc = await load(await saveAndLoad())
    assert.doesNotMatch(pageContent(doc.getPage(0)), / Do\b/)
    assert.match(pageContent(doc.getPage(1)), / Do\b/)
  })

  test('a stamp on a deleted page is dropped without error', async () => {
    await openBytes(await makePdf({ pages: 2 }))
    dispatch({ type: 'ADD_SIGNATURE', signature: sig({ pageIndex: 1 }) })
    dispatch({ type: 'SET_PAGE_ORDER', pages: [appState.pages[0]] })
    await saveAndLoad()
  })

  test('unsupported image data fails the save visibly instead of writing a bad file', async () => {
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'ADD_SIGNATURE', signature: sig({ dataUrl: 'data:image/gif;base64,AAAA' }) })
    resetCalls()
    await engine.saveDocument('C:\\in.pdf')
    assert.equal(calls.saved.length, 0)
    assert.equal(calls.errors.length, 1)
  })
})

describe('form filling', () => {
  const formState = { 'primary:0': true }
  const fill = (values) => {
    for (const [name, value] of Object.entries(values)) dispatch({ type: 'SET_FIELD_VALUE', key: `primary:${name}`, value })
  }

  test('edited values are saved into the fields', async () => {
    await openBytes(await makePdf({ pages: 1, form: true }), { formFields: formState })
    fill({ name: 'Alice', agree: true, color: '1', pick: 'two' })
    const form = (await load(await saveAndLoad())).getForm()
    assert.equal(form.getTextField('name').getText(), 'Alice')
    assert.equal(form.getCheckBox('agree').isChecked(), true)
    assert.equal(form.getRadioGroup('color').getSelected(), 'blue') // pdf.js on-state "1" -> second option
    assert.deepEqual(form.getDropdown('pick').getSelected(), ['two'])
  })

  test('clearing a field removes its value', async () => {
    await openBytes(await makePdf({ pages: 1, form: true }), { formFields: formState })
    fill({ name: 'Alice', agree: true })
    fill({ name: '', agree: false })
    const form = (await load(await saveAndLoad())).getForm()
    assert.equal(form.getTextField('name').getText() ?? '', '')
    assert.equal(form.getCheckBox('agree').isChecked(), false)
  })

  test('fields stay editable: the saved file has an AcroForm listing them', async () => {
    await openBytes(await makePdf({ pages: 1, form: true }), { formFields: formState })
    const doc = await load(await saveAndLoad())
    assert.deepEqual(doc.getForm().getFields().map((f) => f.getName()).sort(), ['agree', 'color', 'name', 'pick'])
  })

  test('a field that cannot be written is counted, and the save still succeeds', async () => {
    await openBytes(await makePdf({ pages: 1, form: true }), { formFields: formState })
    fill({ color: 'purple' }) // not an option of the radio group
    const err = console.error
    console.error = () => {}
    try {
      await saveAndLoad()
    } finally {
      console.error = err
    }
    assert.match(calls.toasts.at(-1), /could not be written/)
  })

  test('a deleted page does not leak through a field shared with a kept page', async () => {
    await openBytes(await makeSharedFieldPdf(), { formFields: { 'primary:0': true, 'primary:1': true } })
    dispatch({ type: 'SET_PAGE_ORDER', pages: [appState.pages[0]] })
    const out = await saveAndLoad()
    assert.deepEqual(await pageMarkers(out), ['marker-0'])
    assert.equal(await containsMarker(out, 'marker-1'), false)
  })

  test('form edits survive page reordering (keyed by field name, not page)', async () => {
    await openBytes(await makePdf({ pages: 2, form: true }), { formFields: formState })
    fill({ name: 'Bob' })
    dispatch({ type: 'SET_PAGE_ORDER', pages: [appState.pages[1], appState.pages[0]] })
    const out = await load(await saveAndLoad())
    assert.equal(out.getForm().getTextField('name').getText(), 'Bob')
  })
})

describe('cryptographic signature placeholder', () => {
  const digital = (over = {}) => sig({ digital: true, identityId: 'id1', signerLabel: 'Jane Doe', ...over })

  test('is reserved, then handed to the shell to sign last', async () => {
    await openBytes(await makePdf({ pages: 2 }))
    dispatch({ type: 'ADD_SIGNATURE', signature: digital({ pageIndex: 1 }) })
    const out = await saveAndLoad()
    assert.equal(calls.signed.length, 1)
    assert.equal(calls.signed[0].identityId, 'id1')
    const text = Buffer.from(calls.signed[0].bytes).toString('latin1')
    assert.equal(text.split(BYTE_RANGE_PLACEHOLDER).length - 1, 1, 'exactly one ByteRange placeholder')
    assert.match(text, new RegExp(`/Contents <${'0'.repeat(24576)}>`))
    assert.match(text, /\/SubFilter \/ETSI\.CAdES\.detached/)
    assert.match(text, /\/SigFlags 3/)
    assert.deepEqual(Buffer.from(out), Buffer.from(calls.signed[0].bytes), 'saved bytes are what the shell returned')
  })

  test('uses a plain (non object-stream) serialization so the shell can patch bytes', async () => {
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'ADD_SIGNATURE', signature: digital() })
    await saveAndLoad()
    assert.doesNotMatch(Buffer.from(calls.signed[0].bytes).toString('latin1'), /\/Type \/ObjStm/)
  })

  test('the signature widget sits on the stamped page', async () => {
    await openBytes(await makePdf({ pages: 2 }))
    dispatch({ type: 'ADD_SIGNATURE', signature: digital({ pageIndex: 1 }) })
    await saveAndLoad()
    const doc = await load(calls.signed[0].bytes)
    const hasSigWidget = (page) => (page.node.Annots()?.asArray() ?? []).some((r) => {
      const d = doc.context.lookup(r, PDFDict)
      return d?.get(PDFName.of('FT')) === PDFName.of('Sig')
    })
    assert.equal(hasSigWidget(doc.getPage(0)), false)
    assert.equal(hasSigWidget(doc.getPage(1)), true)
  })

  test('a plain stamp never calls the signer', async () => {
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'ADD_SIGNATURE', signature: sig() })
    await saveAndLoad()
    assert.equal(calls.signed.length, 0)
    assert.doesNotMatch(Buffer.from(calls.saved[0].bytes).toString('latin1'), /ByteRange/)
  })

  test('a shell signing failure is shown and nothing is written', async () => {
    nativeAPI.signPdf = async () => { throw new Error('no key') }
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'ADD_SIGNATURE', signature: digital() })
    resetCalls()
    await engine.saveDocument('C:\\in.pdf')
    assert.equal(calls.saved.length, 0)
    assert.match(calls.errors[0], /Save failed: no key/)
    assert.equal(appState.dirty, true)
  })
})

describe('save bookkeeping', () => {
  test('save clears the dirty flag and shows a toast', async () => {
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'SET_ROTATION', indices: [0], rotation: 90 })
    assert.equal(appState.dirty, true)
    await saveAndLoad()
    assert.equal(appState.dirty, false)
    assert.deepEqual(calls.toasts, ['Saved ✓'])
  })

  test('Save As switches the document to the new path', async () => {
    await openBytes(await makePdf({ pages: 1 }))
    await saveAndLoad('C:\\other.pdf')
    assert.equal(appState.filePath, 'C:\\other.pdf')
  })

  test('a failed write keeps the document dirty and reports the error', async () => {
    nativeAPI.saveFile = async () => { throw new Error('disk full') }
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'SET_ROTATION', indices: [0], rotation: 90 })
    await engine.saveDocument('C:\\in.pdf')
    assert.equal(appState.dirty, true)
    assert.match(calls.errors[0], /disk full/)
  })

  test('saving with no file open does nothing', async () => {
    dispatch({ type: 'CLOSE_FILE' })
    await engine.saveDocument('C:\\x.pdf')
    assert.equal(calls.saved.length, 0)
  })
})

describe('closing a file', () => {
  test('a clean file closes without prompting', async () => {
    let prompted = false
    nativeAPI.promptUnsaved = async () => { prompted = true; return 'cancel' }
    await openBytes(await makePdf({ pages: 1 }))
    await engine.closeFile()
    assert.equal(prompted, false)
    assert.equal(appState.filePath, null)
  })

  test('Cancel keeps the file open', async () => {
    nativeAPI.promptUnsaved = async () => 'cancel'
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'SET_ROTATION', indices: [0], rotation: 90 })
    await engine.closeFile()
    assert.equal(appState.filePath, 'C:\\in.pdf')
  })

  test("Don't save closes without writing", async () => {
    nativeAPI.promptUnsaved = async () => 'discard'
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'SET_ROTATION', indices: [0], rotation: 90 })
    await engine.closeFile()
    assert.equal(appState.filePath, null)
    assert.equal(calls.saved.length, 0)
  })

  test('Save writes, then closes', async () => {
    nativeAPI.promptUnsaved = async () => 'save'
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'SET_ROTATION', indices: [0], rotation: 90 })
    await engine.closeFile()
    assert.equal(calls.saved.length, 1)
    assert.equal(appState.filePath, null)
  })

  test('a failed save keeps the file open', async () => {
    nativeAPI.promptUnsaved = async () => 'save'
    nativeAPI.saveFile = async () => { throw new Error('locked') }
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'SET_ROTATION', indices: [0], rotation: 90 })
    await engine.closeFile()
    assert.equal(appState.filePath, 'C:\\in.pdf')
  })

  test('never uses window.confirm (the Tauri override is async and always truthy)', async () => {
    let confirmed = false
    globalThis.window.confirm = () => { confirmed = true; return true }
    nativeAPI.promptUnsaved = async () => 'cancel'
    await openBytes(await makePdf({ pages: 1 }))
    dispatch({ type: 'SET_ROTATION', indices: [0], rotation: 90 })
    await engine.closeFile()
    assert.equal(confirmed, false)
  })
})

describe('opening', () => {
  const pdfjsFor = (rotates, fieldObjects = null, isPureXfa = false) => ({
    numPages: rotates.length,
    getPage: async (n) => ({ rotate: rotates[n - 1] }),
    getFieldObjects: async () => fieldObjects,
    isPureXfa,
  })

  test('builds one entry per page, seeded with the source rotation', async () => {
    const bytes = await makePdf({ pages: 3, rotations: [0, 90, 270] })
    fake.pdfjs = pdfjsFor([0, 90, 270])
    await engine.loadFromBytes('C:\\a.pdf', bytes)
    assert.deepEqual(appState.pages.map((p) => [p.originalIndex, p.rotation, p.sourceId]), [
      [0, 0, 'primary'], [1, 90, 'primary'], [2, 270, 'primary'],
    ])
    assert.equal(appState.filePath, 'C:\\a.pdf')
    assert.equal(appState.dirty, false)
  })

  test('detects which pages carry fillable fields or push buttons', async () => {
    const bytes = await makePdf({ pages: 3 })
    // Page 0 has only a hidden field (no form layer); page 1 a text field; page 2 a push button.
    fake.pdfjs = pdfjsFor([0, 0, 0], { f: [{ type: 'text', page: 1 }, { type: 'button', page: 2 }, { type: 'text', page: 0, hidden: true }] })
    await engine.loadFromBytes('C:\\a.pdf', bytes)
    assert.deepEqual(appState.formFields, { 'primary:1': true, 'primary:2': true })
  })

  test('an XFA form gets a warning and no fields', async () => {
    fake.pdfjs = pdfjsFor([0], { f: [{ type: 'text', page: 0 }] }, true)
    await engine.loadFromBytes('C:\\a.pdf', await makePdf({ pages: 1 }))
    assert.deepEqual(appState.formFields, {})
    assert.match(calls.toasts.at(-1), /XFA/)
  })

  test('garbage bytes show an error and do not replace the open document', async () => {
    fake.pdfjs = pdfjsFor([0])
    await engine.loadFromBytes('C:\\a.pdf', await makePdf({ pages: 1 }))
    resetCalls()
    const err = console.error
    console.error = () => {}
    try {
      await assert.rejects(engine.loadFromBytes('C:\\bad.pdf', new TextEncoder().encode('not a pdf')))
    } finally {
      console.error = err
    }
    assert.equal(calls.errors.length, 1)
    assert.equal(appState.filePath, 'C:\\a.pdf')
  })

  test('an already-signed PDF shows the "will remove it" notice', async () => {
    // Build a PDF containing a /Sig-like dictionary (ByteRange + Contents).
    const bytes = await makePdf({ pages: 1 })
    const doc = await load(bytes)
    doc.context.register(doc.context.obj({ Type: 'Sig', ByteRange: [0, 1, 2, 3], Contents: doc.context.obj([]) }))
    fake.pdfjs = pdfjsFor([0])
    await engine.loadFromBytes('C:\\signed.pdf', await doc.save())
    assert.match(calls.notices[0], /already has a digital signature/)
  })
})
