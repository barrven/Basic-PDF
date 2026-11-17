# Tests

Regression tests for the renderer, plus a pointer to the Rust tests for the shell.

```bash
npm test             # renderer suite (Node's built-in test runner, no extra dependencies)
npm run test:rust    # signing code in src-tauri (cargo test --lib)
```

Node 22 or newer. `npm test` passes `--experimental-test-module-mocks` (used to stub browser-only modules) and silences two warnings that flag, respectively, the module-type notice for `package.json` and the experimental mocking API. CI (`.github/workflows/test.yml`) runs both suites on every push and pull request.

## What is covered

| File | Layer | What it protects |
|---|---|---|
| `state.test.mjs` | `src/state.js` | Every reducer action. Page-identity remapping of stamps / annotations / selection / focus on reorder, insert, delete. Undo/redo (what is and is not snapshotted, 50-step cap, redo cleared by a new edit). Dirty flag. Subscriber isolation. |
| `units.test.mjs` | Pure helpers | Zoom stepping, find (`findHitsInItems`), highlight rect merging and overlap, find-vs-redaction filtering, markup coordinate mapping for all four rotations, form keys, the 20-entry signature library. |
| `engine.test.mjs` | `src/pdf-engine.js` end to end | Drives `saveDocument()` / `closeFile()` / `loadFromBytes()` with a prepared state and inspects the PDF bytes handed to the shell. Page order, delete, duplicate, blank pages, inserted sources, rotation (including back to 0), highlight geometry per rotation, the redaction fallback (black boxes), markup, stamps, form filling (text, checkbox, radio, dropdown), AcroForm rebuild, the deleted-page leak through shared fields, the cryptographic-signature placeholder, dirty/close prompts, open-time detection. |
| `contracts.test.mjs` | Cross-file | Version identical in four places. Every `nativeAPI.*` call exists in the bridge; every bridge `invoke` is a registered Rust command; capability file is minimal; no `window.confirm`; the `/ByteRange` placeholder matches `signing.rs`; every library import is in `assemble-frontend.mjs` `COPIES`; every `getElementById` target exists; the CSP stays strict. |

The Rust signing tests (`src-tauri/src/signing.rs`) cover CMS construction for P-256 and RSA identities, PFX import, DPAPI round-trip, patching a renderer-built PDF, and a missing placeholder.

## How the harness works

The renderer is browser code, so `helpers/mocks.mjs` swaps the DOM-bound modules for stubs before the code under test is imported:

- `main.js` (toasts, error modal, loading overlay) records what the UI would have shown in `calls`.
- `renderer.js` (pdf.js) is stubbed. `fake.pdfjs` is what the "pdf.js document" reports (page count, rotation, field objects); set it per test.
- `preview.js`, `signature.js` and `pdfjs-dist` are stubs (`annotate.js` needs only `Util.transform`).
- `window.nativeAPI` comes from `installNativeAPI(overrides)`. `saveFile` and `signPdf` record into `calls.saved` / `calls.signed`.

`helpers/pdf.mjs` builds small PDFs with pdf-lib. Each page carries a unique `/Marker` string so a test can tell which source page ended up where after copying, and `containsMarker()` finds a page's objects anywhere in the file (this is how the deleted-page leak is detected).

Import order matters: call `installMocks()` first, then load app modules with a dynamic `await import(...)`.

### What it cannot see

There is no canvas, no layout and no real pdf.js in Node. So these are **not** covered and still need a manual pass in `npm start`:

- Preview rendering, text layer, overlays, drag/resize, scrolling and lazy rasterization.
- Redaction flattening to an image (only the fallback path runs). Check by saving a redacted page, opening it elsewhere and confirming the text cannot be selected.
- Native dialogs, the context menu, the title bar, file association, and the real signing commands over IPC.
- How Adobe Reader or other validators display a digital signature.

## Adding a test

1. Pure function or reducer: add to `state.test.mjs` or `units.test.mjs`. If it lives in a module that imports DOM code, import it dynamically after `installMocks()`.
2. Anything that changes what is written to a PDF: add a case to `engine.test.mjs`. Build input with `makePdf()`, set up state with `openBytes()` and `dispatch()`, call `saveAndLoad()`, then assert on the loaded output. Prefer asserting on structure (`getRotation()`, form fields, markers, content-stream operators) over byte counts.
3. A new native command: add it to `bridge.js` and `lib.rs`; `contracts.test.mjs` fails until both agree and it is registered. A new library file imported from `src/` must be added to `COPIES` in `assemble-frontend.mjs`.
4. A new module imported by the code under test that touches `document` or `window` at import time: add a stub to `installMocks()`. Stubs must export every name the importers use, or the import fails.
5. Fixing a bug: add the failing test first, then the fix. Several existing tests (rotation back to 0, the `/P` leak, the unsaved-changes prompt) came from real bugs.

A useful sanity check after writing a test is to break the code on purpose and confirm the test fails, for example by deleting the `stripWidgetPageRefs(doc)` call in `src/pdf-engine.js`.
