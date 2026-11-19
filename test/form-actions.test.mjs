import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installMocks, installNativeAPI, calls, fake } from './helpers/mocks.mjs'

installMocks()
const { appState, dispatch } = await import('../src/state.js')
const fa = await import('../src/form-actions.js')

describe('parseCalculation', () => {
  test('reads the Acrobat SUM script from the sample form', () => {
    assert.deepEqual(fa.parseCalculation('AFSimple_Calculate("SUM", new Array ("calc1", "calc2"));'), {
      op: 'sum',
      fields: ['calc1', 'calc2'],
    })
  })
  test('reads other operations and ignores arbitrary scripts', () => {
    assert.equal(fa.parseCalculation('AFSimple_Calculate("AVG", new Array("a"))').op, 'average')
    assert.equal(fa.parseCalculation('app.alert("hi")'), null)
    assert.equal(fa.parseCalculation(undefined), null)
  })
  test('parseNumberFormat reads decimals', () => {
    assert.equal(fa.parseNumberFormat('AFNumber_Format(2, 0, 0, 0, "", true);'), 2)
    assert.equal(fa.parseNumberFormat('nothing'), null)
  })
})

describe('calculation maths', () => {
  test('skips empty and non-numeric inputs', () => {
    assert.equal(fa.computeCalculation('sum', ['2', '', 'x', '3.5']), 5.5)
    assert.equal(fa.computeCalculation('sum', ['', '']), 0)
    assert.equal(fa.computeCalculation('product', ['2', '4']), 8)
    assert.equal(fa.computeCalculation('average', ['2', '4']), 3)
    assert.equal(fa.computeCalculation('max', ['2', '4']), 4)
    assert.equal(fa.computeCalculation('min', ['2', '4']), 2)
  })
  test('formatCalculated avoids float noise', () => {
    assert.equal(fa.formatCalculated(0.1 + 0.2, null), '0.3')
    assert.equal(fa.formatCalculated(4, 2), '4.00')
  })
})

describe('reset / navigation helpers', () => {
  const all = ['a', 'b', 'c']
  test('fieldsToReset honours include / exclude / empty', () => {
    assert.deepEqual(fa.fieldsToReset(all, { fields: [], include: false }), all)
    assert.deepEqual(fa.fieldsToReset(all, { fields: ['a'], include: true }), ['a'])
    assert.deepEqual(fa.fieldsToReset(all, { fields: ['a'], include: false }), ['b', 'c'])
  })
  test('namedPageTarget clamps', () => {
    assert.equal(fa.namedPageTarget('NextPage', 2, 3), 2)
    assert.equal(fa.namedPageTarget('PrevPage', 0, 3), 0)
    assert.equal(fa.namedPageTarget('LastPage', 0, 3), 2)
    assert.equal(fa.namedPageTarget('Print', 0, 3), null)
  })
  test('isSafeLink allows only web and mailto', () => {
    assert.ok(fa.isSafeLink('https://www.google.com/'))
    assert.ok(fa.isSafeLink('mailto:a@b.co'))
    assert.ok(!fa.isSafeLink('file:///C:/x'))
    assert.ok(!fa.isSafeLink('javascript:alert(1)'))
  })
})

describe('runCalculations / runButtonAction', () => {
  const objects = {
    calc1: [{ id: '1R', type: 'text', value: '2', defaultValue: '', actions: { Format: ['AFNumber_Format(2, 0, 0, 0, "", true);'] } }],
    calc2: [{ id: '2R', type: 'text', value: '2', defaultValue: '' }],
    sum: [{ id: '3R', type: 'text', value: '0', defaultValue: '', actions: { Calculate: ['AFSimple_Calculate("SUM", new Array ("calc1", "calc2"));'] } }],
    reset: [{ id: '4R', type: 'button' }],
  }
  beforeEach(() => {
    fake.pdfjs = {
      getFieldObjects: async () => objects,
      getCalculationOrderIds: async () => ['3R'],
      getPageIndex: async (ref) => ref.num,
      getDestination: async () => null,
    }
    calls.toasts.length = 0
    appState.pages = [
      { id: 'p0', sourceId: 'primary', originalIndex: 0, rotation: 0 },
      { id: 'p1', sourceId: 'primary', originalIndex: 1, rotation: 0 },
    ]
    appState.fieldValues = {}
    appState.focusedPage = 0
  })

  test('updates the calculated field from its inputs', async () => {
    dispatch({ type: 'SET_FIELD_VALUE', key: 'primary:calc1', value: '5', history: false })
    const synced = []
    await fa.runCalculations((k, v) => synced.push([k, v]))
    assert.equal(appState.fieldValues['primary:sum'], '7')
    assert.deepEqual(synced, [['primary:sum', '7']])
  })

  test('reset clears fields to their defaults and recalculates', async () => {
    dispatch({ type: 'SET_FIELD_VALUE', key: 'primary:calc1', value: '5', history: false })
    await fa.runButtonAction(appState.pages[0], { resetForm: { fields: [], include: false } }, () => {})
    assert.equal(appState.fieldValues['primary:calc1'], '')
    assert.equal(appState.fieldValues['primary:sum'], '0')
  })

  test('a GoTo button focuses the page it points at', async () => {
    const handled = await fa.runButtonAction(appState.pages[0], { dest: [{ num: 1, gen: 0 }, { name: 'FitH' }, 0] }, () => {})
    assert.equal(handled, true)
    assert.equal(appState.focusedPage, 1)
  })

  test('a Named action moves relative to the page', async () => {
    await fa.runButtonAction(appState.pages[0], { action: 'NextPage' }, () => {})
    assert.equal(appState.focusedPage, 1)
  })

  test('URL buttons confirm, then open externally', async () => {
    const opened = []
    installNativeAPI({ confirm: async () => true, openExternal: async (u) => opened.push(u) })
    await fa.runButtonAction(appState.pages[0], { url: 'https://www.google.com/' }, () => {})
    assert.deepEqual(opened, ['https://www.google.com/'])
  })

  test('unsafe URLs are refused and unknown actions report false', async () => {
    const opened = []
    installNativeAPI({ confirm: async () => true, openExternal: async (u) => opened.push(u) })
    await fa.runButtonAction(appState.pages[0], { url: 'file:///C:/x' }, () => {})
    assert.deepEqual(opened, [])
    assert.equal(await fa.runButtonAction(appState.pages[0], {}, () => {}), false)
  })
})

describe('hide / show / submit buttons', () => {
  const entry = { id: 'p0', sourceId: 'primary', originalIndex: 0, rotation: 0 }
  test('Hide actions set and clear the field override', async () => {
    const seen = []
    await fa.runButtonAction(entry, {}, () => {}, [{ type: 'hide', targets: ['f'], hide: true }], (k) => seen.push(k))
    assert.equal(fa.fieldHiddenOverride('primary:f'), true)
    await fa.runButtonAction(entry, {}, () => {}, [{ type: 'hide', targets: ['f'], hide: false }], (k) => seen.push(k))
    assert.equal(fa.fieldHiddenOverride('primary:f'), false)
    assert.deepEqual(seen, ['primary:f', 'primary:f'])
    fa.clearVisibility('primary')
    assert.equal(fa.fieldHiddenOverride('primary:f'), undefined)
  })
  test('Submit explains instead of failing silently', async () => {
    calls.toasts.length = 0
    assert.equal(await fa.runButtonAction(entry, {}, () => {}, [{ type: 'submit', url: 'https://x.test' }]), true)
    assert.match(calls.toasts.at(-1), /submit/i)
  })
})
