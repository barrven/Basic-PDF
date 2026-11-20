import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installMocks, installNativeAPI } from './helpers/mocks.mjs'
import { ZOOM_STEPS, ZOOM_MIN, ZOOM_MAX, snapZoom } from '../src/zoom.js'

installMocks()
const { appState, dispatch } = await import('../src/state.js')
const { findHitsInItems } = await import('../src/search.js')
const { rectsOverlap, mergeLineRects, textItemVisualRect, filterHitsCoveredByRedactions } = await import('../src/annotate.js')
const { fieldKey, pageFormKey, pageHasForm, isActionableLink, findTextUrls } = await import('../src/forms.js')
const { isMarkup, pointToUnrotated } = await import('../src/markup-save.js')
const store = await import('../src/store.js')

describe('zoom', () => {
  test('steps stay sorted within the 50-200 range', () => {
    assert.deepEqual([...ZOOM_STEPS].sort((a, b) => a - b), ZOOM_STEPS)
    assert.equal(ZOOM_STEPS[0], ZOOM_MIN)
    assert.equal(ZOOM_STEPS.at(-1), ZOOM_MAX)
  })
  test('snapZoom steps to the next/previous entry', () => {
    assert.equal(snapZoom('in', 100), 125)
    assert.equal(snapZoom('out', 100), 90)
    assert.equal(snapZoom('in', 101), 125)
    assert.equal(snapZoom('out', 101), 100)
  })
  test('snapZoom clamps at both ends', () => {
    assert.equal(snapZoom('in', 200), 200)
    assert.equal(snapZoom('out', 50), 50)
    assert.equal(snapZoom('in', 500), 200)
    assert.equal(snapZoom('out', 1), 50)
  })
})

describe('findHitsInItems', () => {
  const page = { id: 'pg' }
  const items = [{ str: 'Hello ' }, { str: 'World' }, { str: ' hello again' }]
  test('is case-insensitive and reports item + offset', () => {
    const hits = findHitsInItems(items, 'HELLO', page, 4)
    assert.equal(hits.length, 2)
    assert.deepEqual(hits[0], { pageId: 'pg', pageIndex: 4, itemIndex: 0, offset: 0, length: 5 })
    assert.deepEqual(hits[1], { pageId: 'pg', pageIndex: 4, itemIndex: 2, offset: 1, length: 5 })
  })
  test('matches across item boundaries', () => {
    const hits = findHitsInItems(items, 'o wor', page, 0)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].itemIndex, 0)
    assert.equal(hits[0].offset, 4)
  })
  test('empty query and no match give nothing', () => {
    assert.deepEqual(findHitsInItems(items, '', page, 0), [])
    assert.deepEqual(findHitsInItems(items, 'zzz', page, 0), [])
  })
  test('matches do not overlap', () => {
    assert.equal(findHitsInItems([{ str: 'aaaa' }], 'aa', page, 0).length, 2)
  })
  test('items without text are tolerated', () => {
    assert.equal(findHitsInItems([{}, { str: 'x' }], 'x', page, 0).length, 1)
  })
})

describe('rect helpers', () => {
  const r = (x, y, width, height) => ({ x, y, width, height })
  test('rectsOverlap needs real area overlap', () => {
    assert.equal(rectsOverlap(r(0, 0, 10, 10), r(5, 5, 10, 10)), true)
    assert.equal(rectsOverlap(r(0, 0, 10, 10), r(10, 0, 10, 10)), false) // touching edges
    assert.equal(rectsOverlap(r(0, 0, 10, 10), r(20, 20, 5, 5)), false)
  })
  test('mergeLineRects joins neighbouring rects on one line', () => {
    const merged = mergeLineRects([r(0, 0, 10, 12), r(10, 0, 10, 12), r(20.5, 0, 5, 12)])
    assert.equal(merged.length, 1)
    assert.deepEqual(merged[0], r(0, 0, 25.5, 12))
  })
  test('mergeLineRects keeps separate lines and far gaps apart, and does not mutate input', () => {
    const input = [r(0, 0, 10, 12), r(0, 30, 10, 12), r(100, 0, 10, 12)]
    const copy = JSON.parse(JSON.stringify(input))
    assert.equal(mergeLineRects(input).length, 3)
    assert.deepEqual(input, copy)
  })
  test('mergeLineRects handles 0 and 1 rects', () => {
    assert.deepEqual(mergeLineRects([]), [])
    assert.deepEqual(mergeLineRects([r(1, 2, 3, 4)]), [r(1, 2, 3, 4)])
  })
})

describe('find vs redactions', () => {
  beforeEach(() => {
    dispatch({ type: 'CLOSE_FILE' })
    dispatch({ type: 'OPEN_FILE', path: 'x', bytes: new Uint8Array(1), pages: [{ id: 'a', sourceId: 'primary', originalIndex: 0, rotation: 0 }] })
  })
  const viewport = { transform: [1, 0, 0, -1, 0, 100] } // 100pt-tall page, y flipped
  const items = [{ str: 'secret', width: 60, transform: [10, 0, 0, 10, 0, 50] }, { str: 'public', width: 60, transform: [10, 0, 0, 10, 0, 20] }]
  const hits = [
    { pageId: 'a', pageIndex: 0, itemIndex: 0, offset: 0, length: 6 },
    { pageId: 'a', pageIndex: 0, itemIndex: 1, offset: 0, length: 6 },
  ]
  test('textItemVisualRect maps a text item into visual space', () => {
    const rect = textItemVisualRect(items[0], viewport)
    assert.deepEqual(rect, { x: 0, y: 40, width: 60, height: 10 })
  })
  test('textItemVisualRect tolerates missing data', () => {
    assert.deepEqual(textItemVisualRect({}, viewport), { x: 0, y: 0, width: 0, height: 0 })
  })
  test('without redactions every hit is kept', () => {
    assert.equal(filterHitsCoveredByRedactions(hits, items, viewport, 0).length, 2)
  })
  test('hits under a redaction are dropped, others kept', () => {
    dispatch({ type: 'ADD_ANNOTATION', annotation: { id: 'r', type: 'redact', pageIndex: 0, color: '#000', rects: [{ x: 0, y: 38, width: 60, height: 14 }] } })
    const kept = filterHitsCoveredByRedactions(hits, items, viewport, 0)
    assert.deepEqual(kept.map((h) => h.itemIndex), [1])
  })
  test('a redaction on another page does not affect this page', () => {
    dispatch({ type: 'ADD_ANNOTATION', annotation: { id: 'r', type: 'redact', pageIndex: 5, color: '#000', rects: [{ x: 0, y: 0, width: 999, height: 999 }] } })
    assert.equal(filterHitsCoveredByRedactions(hits, items, viewport, 0).length, 2)
  })
})

describe('forms helpers', () => {
  test('keys', () => {
    assert.equal(fieldKey('primary', 'a.b'), 'primary:a.b')
    assert.equal(pageFormKey('src2', 3), 'src2:3')
  })
  test('pageHasForm looks up the source page', () => {
    dispatch({ type: 'CLOSE_FILE' })
    dispatch({ type: 'OPEN_FILE', path: 'x', bytes: new Uint8Array(1), pages: [], formFields: { 'primary:0': true } })
    assert.equal(pageHasForm({ sourceId: 'primary', originalIndex: 0 }), true)
    assert.equal(pageHasForm({ sourceId: 'primary', originalIndex: 1 }), false)
    assert.equal(pageHasForm({ sourceId: null, originalIndex: -1 }), false)
    assert.equal(pageHasForm(null), false)
  })
  test('findTextUrls finds plain-text addresses and trims punctuation', () => {
    const item = (str) => ({ str, transform: [12, 0, 0, 12, 72, 700], width: 100, height: 12 })
    const hits = findTextUrls([item('https://music.youtube.com/watch?v=1&list=2'), item('see www.example.com.'), item('no link here')])
    assert.equal(hits.length, 2)
    assert.equal(hits[0].url, 'https://music.youtube.com/watch?v=1&list=2')
    assert.deepEqual([hits[0].rect[0], hits[0].rect[2]], [72, 172])
    assert.equal(hits[1].url, 'https://www.example.com')
    assert.ok(hits[1].rect[0] > 72 && hits[1].rect[2] < 172)
  })
  test('isActionableLink accepts Link annotations with a target (even on pages with no form)', () => {
    const rect = [0, 0, 10, 10]
    assert.equal(isActionableLink({ subtype: 'Link', url: 'https://example.com/', rect }), true)
    assert.equal(isActionableLink({ subtype: 'Link', dest: 'chapter1', rect }), true)
    assert.equal(isActionableLink({ subtype: 'Link', rect }), false)
    assert.equal(isActionableLink({ subtype: 'Widget', url: 'https://example.com/', rect }), false)
    assert.equal(isActionableLink(null), false)
  })
})

describe('markup helpers', () => {
  test('isMarkup recognizes the drawn types only', () => {
    for (const type of ['text', 'rect', 'ellipse', 'line', 'draw']) assert.equal(isMarkup({ type }), true, type)
    for (const type of ['highlight', 'redact']) assert.equal(isMarkup({ type }), false, type)
  })
  const fakePage = (angle, w = 300, h = 400) => ({ getRotation: () => ({ angle }), getSize: () => ({ width: w, height: h }) })
  test('pointToUnrotated maps visual top-left space for each rotation', () => {
    assert.deepEqual(pointToUnrotated(fakePage(0), 10, 20), { x: 10, y: 380 })
    assert.deepEqual(pointToUnrotated(fakePage(90), 10, 20), { x: 20, y: 10 })
    assert.deepEqual(pointToUnrotated(fakePage(180), 10, 20), { x: 290, y: 20 })
    assert.deepEqual(pointToUnrotated(fakePage(270), 10, 20), { x: 280, y: 390 })
  })
  test('pointToUnrotated normalizes odd rotation values', () => {
    assert.deepEqual(pointToUnrotated(fakePage(-90), 10, 20), pointToUnrotated(fakePage(270), 10, 20))
    assert.deepEqual(pointToUnrotated(fakePage(360), 10, 20), pointToUnrotated(fakePage(0), 10, 20))
  })
})

describe('signature library store', () => {
  let data
  before(() => {
    installNativeAPI({
      getStoreValue: async (k) => data[k],
      setStoreValue: async (k, v) => { data[k] = v },
    })
  })
  beforeEach(() => { data = {} })
  test('starts empty', async () => assert.deepEqual(await store.getLibrary(), []))
  test('adds and removes entries', async () => {
    await store.addToLibrary({ id: 'a' })
    await store.addToLibrary({ id: 'b' })
    assert.deepEqual((await store.getLibrary()).map((s) => s.id), ['a', 'b'])
    assert.deepEqual((await store.removeFromLibrary('a')).map((s) => s.id), ['b'])
    assert.deepEqual((await store.getLibrary()).map((s) => s.id), ['b'])
  })
  test('keeps only the newest 20', async () => {
    for (let i = 0; i < 25; i++) await store.addToLibrary({ id: String(i) })
    const lib = await store.getLibrary()
    assert.equal(lib.length, 20)
    assert.equal(lib[0].id, '5')
    assert.equal(lib.at(-1).id, '24')
  })
})
