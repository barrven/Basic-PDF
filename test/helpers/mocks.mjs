// Test harness: the renderer's modules assume a browser and Tauri. Modules that
// are pure (state, zoom, markup-save, forms-save, pdf-signature, pdf-engine's
// save path) run unmodified under Node; the DOM-bound ones they import are
// replaced here with stubs. Run with --experimental-test-module-mocks (npm test).
import { mock } from 'node:test'

const src = (name) => new URL(`../../src/${name}`, import.meta.url).href

export const calls = { toasts: [], errors: [], notices: [], saved: [], signed: [] }

const noop = () => {}

// What the stubbed pdf.js reports for the open document (set per test).
export const fake = { pdfjs: null }

export function installMocks() {
  mock.module(src('main.js'), {
    exports: {
      showToast: (m) => calls.toasts.push(m),
      showNotice: (m) => calls.notices.push(m),
      hideNotice: noop,
      updateLoadingOverlay: noop,
      withDocumentLoading: async (work) => work(),
      showErrorModal: (m) => calls.errors.push(m),
      render: noop,
    },
  })
  mock.module(src('renderer.js'), {
    exports: {
      setPrimarySource: async () => fake.pdfjs,
      addPdfSource: noop,
      clearPdfSources: noop,
      getPdfDoc: () => null,
      getPdfDocFor: () => fake.pdfjs,
      getPdfDocBytes: () => null,
      getPage: async () => null,
      getPageTextContent: async () => ({ items: [] }),
      RENDER_PRIORITY: { PREVIEW: 0, THUMBNAIL: 1 },
      scheduleRender: noop,
      drawBlankPlaceholder: noop,
      PAGE_SIZE_A4: { width: 595, height: 842 },
      visualPageSize: (w, h) => ({ width: w, height: h }),
      // Redaction flattening needs a real canvas; Node has none, so saving a page
      // with a redaction exercises the opaque-box fallback.
      openIsolatedPdf: async () => {
        throw new Error('no pdf.js in tests')
      },
    },
  })
  const previewStubs = [
    'initPreview', 'whenPreviewIdle', 'addTextLayerPaintListener', 'waitForTextLayer', 'renderPreview',
    'textLayerFromSelection', 'getPageViewByIndex', 'textSelectionIsActive', 'textSelectionIsNonCollapsed',
    'selectAllTextInActiveLayer', 'applyFindHighlights', 'applyFindHighlightsForPage', 'setCurrentFindHighlight',
    'scrollCurrentFindMatchIntoView', 'clearFindHighlights', 'renderSignatureOverlays', 'renderAnnotationOverlays',
    'scrollPreviewToFocused', 'getCurrentScale', 'getCurrentPageDimensions', 'cancelPlacementOnEscape',
  ]
  mock.module(src('preview.js'), {
    exports: Object.fromEntries(previewStubs.map((n) => [n, noop])),
  })
  mock.module(src('signature.js'), {
    exports: {
      initSignature: noop, showSignatureModal: noop, hideSignatureModal: noop, enterPlacementMode: noop,
      exitPlacementMode: noop, isPlacing: () => false, handlePlacementMove: noop, handlePlacementClick: noop,
      toggleSigPopover: noop,
    },
  })
  // annotate.js only needs pdf.js' 2x3 matrix multiply.
  mock.module(new URL('../../node_modules/pdfjs-dist/build/pdf.mjs', import.meta.url).href, {
    exports: {
      Util: {
        transform: (m1, m2) => [
          m1[0] * m2[0] + m1[2] * m2[1],
          m1[1] * m2[0] + m1[3] * m2[1],
          m1[0] * m2[2] + m1[2] * m2[3],
          m1[1] * m2[2] + m1[3] * m2[3],
          m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
          m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
        ],
      },
    },
  })
}

export function resetCalls() {
  for (const k of Object.keys(calls)) calls[k] = []
}

// Stand-in for window.nativeAPI. Override members per test.
export function installNativeAPI(overrides = {}) {
  globalThis.window = {
    nativeAPI: {
      saveFile: async (path, bytes) => calls.saved.push({ path, bytes }),
      openFileBytes: async () => {
        throw new Error('openFileBytes not stubbed')
      },
      signPdf: async (bytes, identityId) => {
        calls.signed.push({ bytes, identityId })
        return bytes
      },
      promptUnsaved: async () => 'cancel',
      ...overrides,
    },
  }
  return globalThis.window.nativeAPI
}
