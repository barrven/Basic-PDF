import { test, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'
import { appState, dispatch, subscribe, createPageEntry, normalizeRotation, PRIMARY_SOURCE_ID } from '../src/state.js'

function entries(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, sourceId: PRIMARY_SOURCE_ID, originalIndex: i, rotation: 0 }))
}

function open(n = 3) {
  dispatch({ type: 'CLOSE_FILE' })
  dispatch({ type: 'OPEN_FILE', path: 'C:\\x.pdf', bytes: new Uint8Array(1), pages: entries(n) })
}

const sig = (id, pageIndex) => ({ id, pageIndex, x: 1, y: 2, width: 30, height: 10, opacity: 1, dataUrl: 'data:' })
const note = (id, pageIndex) => ({ id, type: 'highlight', pageIndex, rects: [{ x: 0, y: 0, width: 1, height: 1 }], color: '#ffe566' })

beforeEach(() => open(3))

describe('normalizeRotation', () => {
  test('wraps into 0/90/180/270', () => {
    assert.equal(normalizeRotation(0), 0)
    assert.equal(normalizeRotation(90), 90)
    assert.equal(normalizeRotation(360), 0)
    assert.equal(normalizeRotation(450), 90)
    assert.equal(normalizeRotation(-90), 270)
    assert.equal(normalizeRotation(-450), 270)
  })
  test('snaps odd angles and tolerates junk', () => {
    assert.equal(normalizeRotation(89), 90)
    assert.equal(normalizeRotation(44), 0)
    assert.equal(normalizeRotation(undefined), 0)
    assert.equal(normalizeRotation('abc'), 0)
    assert.equal(normalizeRotation(null), 0)
  })
})

describe('createPageEntry', () => {
  test('gives each entry a unique id and a normalized rotation', () => {
    const a = createPageEntry({ sourceId: 's', originalIndex: 0, rotation: 450 })
    const b = createPageEntry({ sourceId: 's', originalIndex: 0 })
    assert.notEqual(a.id, b.id)
    assert.equal(a.rotation, 90)
    assert.equal(b.rotation, 0)
  })
  test('blank pages use originalIndex -1', () => {
    assert.equal(createPageEntry({ originalIndex: -1 }).originalIndex, -1)
  })
})

describe('open / close', () => {
  test('OPEN_FILE resets everything and selects page 0', () => {
    dispatch({ type: 'ADD_SIGNATURE', signature: sig('s1', 0) })
    dispatch({ type: 'OPEN_FILE', path: 'a', bytes: new Uint8Array(1), pages: entries(2), formFields: { 'primary:0': true } })
    assert.equal(appState.signatures.length, 0)
    assert.equal(appState.annotations.length, 0)
    assert.deepEqual([...appState.selectedPages], [0])
    assert.equal(appState.dirty, false)
    assert.equal(appState.zoom, null)
    assert.deepEqual(appState.formFields, { 'primary:0': true })
    assert.deepEqual(appState.fieldValues, {})
    assert.equal(appState.history.past.length, 0)
  })
  test('CLOSE_FILE clears the document', () => {
    dispatch({ type: 'ADD_SIGNATURE', signature: sig('s1', 0) })
    dispatch({ type: 'CLOSE_FILE' })
    assert.equal(appState.filePath, null)
    assert.equal(appState.pages.length, 0)
    assert.equal(appState.dirty, false)
    assert.equal(appState.selectedPages.size, 0)
    assert.deepEqual(appState.formFields, {})
  })
})

describe('dirty flag', () => {
  test('is set by document edits', () => {
    for (const action of [
      { type: 'SET_ROTATION', indices: [0], rotation: 90 },
      { type: 'ADD_SIGNATURE', signature: sig('s', 0) },
      { type: 'ADD_ANNOTATION', annotation: note('a', 0) },
      { type: 'SET_PAGE_ORDER', pages: entries(3).reverse() },
      { type: 'SET_FIELD_VALUE', key: 'primary:f', value: 'x' },
    ]) {
      open(3)
      assert.equal(appState.dirty, false)
      dispatch(action)
      assert.equal(appState.dirty, true, action.type)
    }
  })
  test('is not set by view changes', () => {
    dispatch({ type: 'SET_ZOOM', zoom: 125 })
    dispatch({ type: 'SET_FOCUSED_PAGE', page: 2 })
    dispatch({ type: 'SET_SELECTED_PAGES', pages: new Set([1]) })
    dispatch({ type: 'SET_LOADING', loading: true })
    assert.equal(appState.dirty, false)
    assert.equal(appState.zoom, 125)
    assert.equal(appState.loading, true)
  })
})

describe('page identity tracking', () => {
  test('SET_PAGE_ORDER moves stamps and annotations with their page', () => {
    dispatch({ type: 'ADD_SIGNATURE', signature: sig('s0', 0) })
    dispatch({ type: 'ADD_ANNOTATION', annotation: note('a2', 2) })
    dispatch({ type: 'SET_PAGE_ORDER', pages: [appState.pages[2], appState.pages[0], appState.pages[1]] })
    assert.equal(appState.signatures[0].pageIndex, 1) // p0 moved to index 1
    assert.equal(appState.annotations[0].pageIndex, 0) // p2 moved to index 0
  })
  test('SET_PAGE_ORDER drops items whose page was removed', () => {
    dispatch({ type: 'ADD_SIGNATURE', signature: sig('s1', 1) })
    dispatch({ type: 'ADD_ANNOTATION', annotation: note('a1', 1) })
    dispatch({ type: 'SET_SELECTED_SIG', id: 's1' })
    dispatch({ type: 'SET_PAGE_ORDER', pages: [appState.pages[0], appState.pages[2]] })
    assert.equal(appState.signatures.length, 0)
    assert.equal(appState.annotations.length, 0)
    assert.equal(appState.selectedSig, null)
  })
  test('selection and focus follow the page, not the index', () => {
    dispatch({ type: 'SET_SELECTED_PAGES', pages: new Set([2]) })
    dispatch({ type: 'SET_FOCUSED_PAGE', page: 2 })
    dispatch({ type: 'SET_PAGE_ORDER', pages: [appState.pages[2], appState.pages[0], appState.pages[1]] })
    assert.deepEqual([...appState.selectedPages], [0])
    assert.equal(appState.focusedPage, 0)
  })
  test('focus is clamped when its page is deleted', () => {
    dispatch({ type: 'SET_FOCUSED_PAGE', page: 2 })
    dispatch({ type: 'SET_PAGE_ORDER', pages: [appState.pages[0], appState.pages[1]] })
    assert.equal(appState.focusedPage, 1)
  })
  test('INSERT_PAGES shifts later stamps and records the new source', () => {
    dispatch({ type: 'ADD_SIGNATURE', signature: sig('s1', 1) })
    const inserted = { id: 'new', sourceId: 'src2', originalIndex: 0, rotation: 0 }
    dispatch({
      type: 'INSERT_PAGES',
      pages: [appState.pages[0], inserted, appState.pages[1], appState.pages[2]],
      sourceId: 'src2',
      sourceBytes: new Uint8Array(2),
      formFields: { 'src2:0': true },
    })
    assert.equal(appState.pages.length, 4)
    assert.equal(appState.signatures[0].pageIndex, 2)
    assert.ok(appState.sources.src2)
    assert.equal(appState.formFields['src2:0'], true)
  })
  test('INSERT_PAGES honours an explicit focusedPage', () => {
    dispatch({ type: 'INSERT_PAGES', pages: [...appState.pages, { id: 'n', sourceId: null, originalIndex: -1, rotation: 0 }], focusedPage: 3 })
    assert.equal(appState.focusedPage, 3)
  })
  test('SHIFT_SIGNATURES_AFTER moves stamps and annotations at or after an index', () => {
    dispatch({ type: 'ADD_SIGNATURE', signature: sig('a', 0) })
    dispatch({ type: 'ADD_SIGNATURE', signature: sig('b', 1) })
    dispatch({ type: 'ADD_ANNOTATION', annotation: note('n', 2) })
    dispatch({ type: 'SHIFT_SIGNATURES_AFTER', fromIndex: 1, delta: 1 })
    assert.deepEqual(appState.signatures.map((s) => s.pageIndex), [0, 2])
    assert.equal(appState.annotations[0].pageIndex, 3)
  })
})

describe('rotation', () => {
  test('SET_ROTATION sets an absolute angle on the chosen pages only', () => {
    dispatch({ type: 'SET_ROTATION', indices: [0, 2], rotation: 270 })
    assert.deepEqual(appState.pages.map((p) => p.rotation), [270, 0, 270])
  })
})

describe('signatures', () => {
  test('move and resize update the stamp', () => {
    dispatch({ type: 'ADD_SIGNATURE', signature: sig('s', 0) })
    dispatch({ type: 'MOVE_SIGNATURE', id: 's', x: 50, y: 60 })
    assert.deepEqual([appState.signatures[0].x, appState.signatures[0].y], [50, 60])
    dispatch({ type: 'RESIZE_SIGNATURE', id: 's', x: 5, y: 6, width: 70, height: 20 })
    const s = appState.signatures[0]
    assert.deepEqual([s.x, s.y, s.width, s.height], [5, 6, 70, 20])
  })
  test('delete clears selection of that stamp', () => {
    dispatch({ type: 'ADD_SIGNATURE', signature: sig('s', 0) })
    dispatch({ type: 'SET_SELECTED_SIG', id: 's' })
    dispatch({ type: 'DELETE_SIGNATURE', id: 's' })
    assert.equal(appState.signatures.length, 0)
    assert.equal(appState.selectedSig, null)
  })
  test('selecting a stamp deselects an annotation and vice versa', () => {
    dispatch({ type: 'ADD_ANNOTATION', annotation: note('a', 0) })
    dispatch({ type: 'ADD_SIGNATURE', signature: sig('s', 0) })
    dispatch({ type: 'SET_SELECTED_ANNOTATION', id: 'a' })
    dispatch({ type: 'SET_SELECTED_SIG', id: 's' })
    assert.equal(appState.selectedAnnotation, null)
    dispatch({ type: 'SET_SELECTED_ANNOTATION', id: 'a' })
    assert.equal(appState.selectedSig, null)
  })
})

describe('annotations', () => {
  test('delete one and delete many', () => {
    dispatch({ type: 'ADD_ANNOTATION', annotation: note('a', 0) })
    dispatch({ type: 'ADD_ANNOTATION', annotation: note('b', 0) })
    dispatch({ type: 'ADD_ANNOTATION', annotation: note('c', 1) })
    dispatch({ type: 'DELETE_ANNOTATION', id: 'a' })
    assert.deepEqual(appState.annotations.map((a) => a.id), ['b', 'c'])
    dispatch({ type: 'SET_SELECTED_ANNOTATION', id: 'b' })
    dispatch({ type: 'DELETE_ANNOTATIONS', ids: ['b', 'c'] })
    assert.equal(appState.annotations.length, 0)
    assert.equal(appState.selectedAnnotation, null)
  })
})

describe('undo / redo', () => {
  test('undo restores pages, stamps, annotations and form values', () => {
    dispatch({ type: 'ADD_SIGNATURE', signature: sig('s', 0) })
    dispatch({ type: 'ADD_ANNOTATION', annotation: note('a', 0) })
    dispatch({ type: 'SET_FIELD_VALUE', key: 'primary:f', value: 'hi', history: true })
    dispatch({ type: 'SET_ROTATION', indices: [0], rotation: 90 })
    dispatch({ type: 'UNDO' })
    assert.equal(appState.pages[0].rotation, 0)
    dispatch({ type: 'UNDO' })
    assert.equal(appState.fieldValues['primary:f'], undefined)
    dispatch({ type: 'UNDO' })
    assert.equal(appState.annotations.length, 0)
    dispatch({ type: 'UNDO' })
    assert.equal(appState.signatures.length, 0)
    dispatch({ type: 'UNDO' }) // nothing left: no-op
    assert.equal(appState.signatures.length, 0)
  })
  test('redo replays undone steps and a new edit clears redo', () => {
    dispatch({ type: 'ADD_SIGNATURE', signature: sig('s', 0) })
    dispatch({ type: 'UNDO' })
    assert.equal(appState.signatures.length, 0)
    dispatch({ type: 'REDO' })
    assert.equal(appState.signatures.length, 1)
    dispatch({ type: 'UNDO' })
    dispatch({ type: 'ADD_ANNOTATION', annotation: note('a', 0) })
    dispatch({ type: 'REDO' })
    assert.equal(appState.signatures.length, 0)
  })
  test('undo and redo mark the document dirty and clear selection', () => {
    dispatch({ type: 'ADD_SIGNATURE', signature: sig('s', 0) })
    dispatch({ type: 'SET_DIRTY', dirty: false })
    dispatch({ type: 'SET_SELECTED_SIG', id: 's' })
    dispatch({ type: 'UNDO' })
    assert.equal(appState.dirty, true)
    assert.equal(appState.selectedSig, null)
    assert.equal(appState.selectedPages.size, 0)
  })
  test('INSERT_PAGES undo restores pre-insert pages and stamp positions together', () => {
    dispatch({ type: 'ADD_SIGNATURE', signature: sig('s', 1) })
    dispatch({
      type: 'INSERT_PAGES',
      pages: [appState.pages[0], { id: 'n', sourceId: null, originalIndex: -1, rotation: 0 }, appState.pages[1], appState.pages[2]],
    })
    assert.equal(appState.signatures[0].pageIndex, 2)
    dispatch({ type: 'UNDO' })
    assert.equal(appState.pages.length, 3)
    assert.equal(appState.signatures[0].pageIndex, 1)
  })
  test('history is capped at 50 steps', () => {
    for (let i = 0; i < 60; i++) dispatch({ type: 'SET_ROTATION', indices: [0], rotation: (i % 4) * 90 })
    assert.equal(appState.history.past.length, 50)
  })
  test('zoom and selection are not part of history', () => {
    dispatch({ type: 'SET_ZOOM', zoom: 150 })
    dispatch({ type: 'SET_SELECTED_PAGES', pages: new Set([1]) })
    assert.equal(appState.history.past.length, 0)
  })
  test('SET_FIELD_VALUE only snapshots when asked (typing coalescing)', () => {
    dispatch({ type: 'SET_FIELD_VALUE', key: 'primary:f', value: 'a' })
    dispatch({ type: 'SET_FIELD_VALUE', key: 'primary:f', value: 'ab' })
    assert.equal(appState.history.past.length, 0)
    dispatch({ type: 'SET_FIELD_VALUE', key: 'primary:g', value: true, history: true })
    assert.equal(appState.history.past.length, 1)
  })
})

describe('subscribe', () => {
  test('notifies after every dispatch and can unsubscribe', () => {
    let n = 0
    const off = subscribe(() => n++)
    dispatch({ type: 'SET_ZOOM', zoom: 100 })
    dispatch({ type: 'SET_ZOOM', zoom: 125 })
    assert.equal(n, 2)
    off()
    dispatch({ type: 'SET_ZOOM', zoom: 150 })
    assert.equal(n, 2)
  })
  test('a throwing listener does not stop the others', () => {
    let reached = false
    const err = console.error
    console.error = () => {}
    const a = subscribe(() => { throw new Error('boom') })
    const b = subscribe(() => { reached = true })
    dispatch({ type: 'SET_ZOOM', zoom: 100 })
    console.error = err
    a(); b()
    assert.equal(reached, true)
  })
})
