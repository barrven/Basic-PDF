# Implementation guide: PDF form filling

**Status:** not implemented. This is a design/implementation plan, not as-built documentation (compare `feature-annotate.md`, which describes shipped behavior). It covers the `todos.md` item "add js form filling features."

Scope: **fill existing AcroForm fields** (text, checkbox, radio, dropdown, listbox) and save the values into the PDF. It does **not** cover authoring new form fields, XFA forms, PDF-embedded JavaScript (calculations/validation), or signature fields (a different concept from this app's existing image-stamp "Signatures" feature — naming collision to watch for in the UI).

No new dependencies are needed. Both libraries already in `package.json` support this:
- **pdf.js** (`pdfjs-dist` 4.10.38) exports `AnnotationLayer` from `build/pdf.mjs` and can report field data via `PDFDocumentProxy.getFieldObjects()`.
- **pdf-lib** (1.17.1) can read/write AcroForm values via `PDFDocument.getForm()`.

---

## 1. Detection on open

In `loadFromBytes()` (`src/pdf-engine.js`), after `setPrimarySource(bytes)`, call `pdfDoc.getFieldObjects()` (pdf.js). It resolves to `null` for a PDF with no AcroForm, or a map of field name → field metadata (type, page-relative rect, export values for radio/checkbox, current value) otherwise. Use this to populate initial state and to short-circuit all form UI when the document has none — most PDFs opened in this app will not have forms, so the fast path (`null`) must stay cheap.

Do the equivalent for any `INSERT_PAGES` source too, since an inserted PDF can carry its own form fields.

**XFA check:** `pdfDoc.isPureXfa` — if true, `getFieldObjects()` may be empty/unreliable and pdf-lib cannot write XFA fields at all. Detect this and disable form filling with a toast ("This PDF uses a form format that isn't supported"), same pattern as the existing error-modal/toast conventions in `src/main.js`.

---

## 2. Data model

Add to `appState` (`src/state.js`):

```js
formFields: [],      // static, derived from the loaded doc(s); see key scheme below
fieldValues: {},      // user edits: key -> value
```

**`formFields`** is *page-intrinsic content*, the same category as pdf.js text content — not a floating user-placed object like a signature stamp or annotation. Key it the same way `textContentCache` in `src/renderer.js` already does: by `` `${sourceId}:${originalIndex}` ``. At render/save time, look up which live `appState.pages` entries currently point at that `(sourceId, originalIndex)` pair. This sidesteps writing a whole new remap-on-reorder/insert/delete code path (the `remapPageIndexed` machinery `SET_PAGE_ORDER`/`INSERT_PAGES` use for signatures and annotations) — page reorder, insertion, and deletion all fall out for free because nothing here stores a raw `pageIndex`.

**`fieldValues`** holds only what the user has actually changed, keyed by `` `${sourceId}:${fieldName}` `` (fully-qualified AcroForm field name, namespaced by source — see §6 for why). This is intentionally *not* run through undo/redo's page/signature/annotation snapshot model at every keystroke; see §5.

Populate `formFields` once per source, right after detection in §1, via a new `dispatch({ type: 'SET_FORM_FIELDS', sourceId, fields })` that merges into the map rather than replacing it (so inserting a second PDF doesn't wipe the primary's fields).

---

## 3. Rendering

Add a sixth stack layer in `src/preview.js`'s per-page DOM (`renderPreviewInner()`), positioned above the redaction layer so widgets are clickable but redaction still visually and functionally wins where they'd overlap:

```
canvas → .annot-highlight-layer → .textLayer → .annot-redact-layer → .annot-form-layer → .signature-overlay-layer
```

Reuse pdf.js's own `AnnotationLayer` class (from `build/pdf.mjs`, the same module `TextLayer` already comes from) rather than hand-rolling `<input>` positioning:

```js
import { AnnotationLayer } from '../node_modules/pdfjs-dist/build/pdf.mjs'
```

Call it per visible page, alongside `renderPageTextLayer()` in `renderPageCanvas()`:

```js
const annotations = await page.getAnnotations({ intent: 'display' })
const layer = new AnnotationLayer({ div: formLayerEl, page, viewport, ... })
await layer.render({ annotations, renderForms: true, ... })
```

**CSS:** the app has no dependency on `web/pdf_viewer.css` (it hand-rolled `.textLayer` styling in `src/style.css` instead of using pdf.js's `web/pdf_viewer` bundle). Do the same here: copy just the `.annotationLayer` / `.textWidgetAnnotation` / `.buttonWidgetAnnotation` / `.choiceWidgetAnnotation` rules needed for text inputs, checkboxes, radios, and selects out of `node_modules/pdfjs-dist/web/pdf_viewer.css` into `src/style.css`, scoped under `.annot-form-layer`, and re-theme them to match this app's light/dark tokens (existing highlight/redact layers already do custom theming, e.g. `--render-error-bg`).

**Zoom/rotation:** the layer is rebuilt on every `renderPageCanvas()` call the same as the text layer, so it already tracks `view.scale` and `entry.rotation` correctly — no extra bookkeeping needed there.

**CSP:** no changes needed. `AnnotationLayer` renders DOM, not scripts; `script-src 'self' 'wasm-unsafe-eval'` already covers pdf.js's own code, and no field carries executable content this app will honor (see §7).

---

## 4. Wiring field edits back into state

pdf.js's `AnnotationLayer` writes user input into its own `AnnotationStorage` (`pdfDoc.annotationStorage`), not into `appState`. Two ways to bridge that — recommend the second:

1. Read `annotationStorage` at save time. Simple, but couples the save path to pdf.js's live in-memory instance for the *primary* file, which conflicts with this app's existing pattern of building the saved doc from pdf-lib alone (`buildOutputDoc()` never touches pdf.js state). It would also make `dirty` tracking (which currently only flips on `dispatch`) miss form edits entirely unless you also poll `annotationStorage`.
2. **Listen to `AnnotationLayer`'s field-change events** (it fires DOM `input`/`change` on the widget elements it creates) and `dispatch({ type: 'SET_FIELD_VALUE', key, value })` from a new `src/forms.js` module, mirroring how `src/annotate.js` owns the annotate popover and `src/signature.js` owns placement mode. This keeps `appState.fieldValues` as the single source of truth, matching every other feature in this codebase, and `dirty` flips through the normal dispatch path.

`main.js`'s render loop needs one more diff clause: `fieldValues` changes don't need a full `renderPreview()` (the widget's own DOM already reflects what the user typed) — but do need `dirty` set, matching how `signatures`/`annotations` changes are handled today.

---

## 5. Undo/redo

`pushHistory()` snapshots `pages`, `signatures`, `annotations` on every discrete edit (capped at 50). Form field edits are effectively free-text keystrokes — snapshotting on every character the way `PUSH_HISTORY_SNAPSHOT` does once per signature-drag-start is the right shape, not once per keystroke. Recommend: push a history snapshot on `blur`/`change` of a widget (first edit since focus), not on every `input` event, the same "push once before first mutation in a gesture" pattern `src/preview.js`'s drag handlers already use for signature move/resize. Extend `snapshot()`/`UNDO`/`REDO` in `src/state.js` to include `fieldValues` alongside `pages`/`signatures`/`annotations`.

---

## 6. Save

New logic in `buildOutputDoc()` (`src/pdf-engine.js`), after pages are copied/rasterized but before the function returns:

```js
const form = newDoc.getForm()
for (const [key, value] of Object.entries(appState.fieldValues)) {
  const name = key.split(':').slice(1).join(':') // strip sourceId prefix
  try {
    const field = form.getField(name)
    if (field instanceof PDFTextField) field.setText(String(value))
    else if (field instanceof PDFCheckBox) value ? field.check() : field.uncheck()
    else if (field instanceof PDFRadioGroup) field.select(value)
    else if (field instanceof PDFDropdown) field.select(value)
    // PDFOptionList similarly
  } catch (err) {
    console.error('form field set failed', name, err)
  }
}
```

**Why namespace `fieldValues` keys by `sourceId`:** if the user inserts a second PDF that also has an AcroForm, its field names live in a *different* pdf-lib `PDFDocument` until `buildOutputDoc()` merges everything into `newDoc`. Field names are only required to be unique *within* one AcroForm — two independently-authored source PDFs can easily share a field name like `"Name"`. Keying user edits by source keeps them from cross-applying to the wrong document's field.

**Appearance streams:** pdf-lib regenerates a field's visual appearance when you call `setText()`/`select()`, which requires an embedded font. `form.updateFieldAppearances()` (called implicitly by the setters) defaults to Helvetica; if the field's original appearance used an embedded/non-standard font, the regenerated glyph rendering may not match the source PDF exactly. This is a known pdf-lib limitation, not something to solve here — flag it to the user only if it becomes a real complaint (e.g. via a toast on fields where the DA/font isn't a standard 14 font), don't build speculative handling.

**Interaction with redaction:** redaction is *not* a rasterize-the-whole-page operation any more — `redactPageContent()` (`src/redact-content.js`) rewrites the page's content stream to drop only the glyphs whose boxes overlap a redaction rect, and the page stays vector/text otherwise. `buildOutputDoc()` only falls back to `rasterizeRedactedPage()` if that content-stream rewrite throws. Two consequences for forms, neither of which is the flattening concern an earlier draft of this section assumed:

- **Common case (content-stream rewrite succeeds).** Form field widgets are AcroForm annotations, not glyphs painted by the page's content stream, so `redactPageContent()` never touches them — a redaction elsewhere on the page has no effect on field values or rendering. But if a redaction rect *overlaps a field widget's own area*, the widget (and whatever the user typed into it) would sit visually on top of the opaque black box the redaction draws, defeating the redaction. This app already solves the equivalent problem for text (`applyRedactionTextLocks()` in `src/preview.js` disables `pointer-events`/`user-select` and hides selected-text spans under a redaction) — do the same for the form layer: when laying out `.annot-form-layer`, skip rendering (or force-hide) any widget whose rect overlaps a redaction annotation, the same overlap test `annotRectsOverlap()` already provides.
- **Rare fallback case (content-stream rewrite fails → rasterize).** `rasterizeRedactedPage()` paints from a live pdf.js render and does not currently know about form field values at all (it predates this feature). If forms ship before this fallback is form-aware, a page that hits the fallback *and* has fields would silently lose those field values in the rasterized output. Low priority given how rare the fallback is meant to be, but worth a `console.error`/toast if detected, so it's not a silent data loss.

**Flatten-on-save option:** many form-filling tools offer "flatten form" (bake values as static content, remove interactivity) as an explicit save option. `form.flatten()` in pdf-lib does this in one call. Worth a checkbox in the save flow eventually, but not required for a first version — leave fields live/editable by default, matching how other PDF viewers behave after filling.

---

## 7. Explicitly out of scope / risks to call out, not solve

- **XFA forms** — not supported by pdf-lib; detect and refuse (§1).
- **Field calculations/validation/JavaScript actions** (`/AA`, `/JS` dictionary entries) — this app will not execute PDF-embedded JS (consistent with the CSP's `script-src 'self'` and the general hardening posture in `electron/main.js`). Filled fields simply won't recalculate dependent fields the way Acrobat would.
- **Digital signature fields** (`/FT /Sig`) — distinct from this app's existing "Signatures" feature (image stamps via `src/signature.js`). Do not attempt to support cryptographic signing; render such fields as non-interactive or hide them, and pick UI copy carefully so users don't confuse the two.
- **Duplicated pages with form fields.** `pdf-engine.js` already notes duplicate-page copies are independent (`// Fresh copy each time so duplicated pages don't share a reference`). Two widgets of the *same* AcroForm field placed on two duplicated pages will, after `copyPages()` runs per-page, likely end up as two separate field objects with an identical name in the output — a genuine pdf-lib/PDF-spec gray area (name collisions in a merged AcroForm), not something this guide has a clean answer for. Test this combination explicitly before shipping; don't assume it "just works."
- **Read-only / hidden fields** — pdf.js's field metadata from `getFieldObjects()` includes flags for these; skip rendering an interactive widget for them (render the flattened appearance only, same as a page with no form).

---

## 8. New/changed modules

| File | Change |
|------|--------|
| `src/state.js` | `formFields`, `fieldValues` on `appState`; `SET_FORM_FIELDS`, `SET_FIELD_VALUE` actions; include `fieldValues` in `snapshot()`/`UNDO`/`REDO` |
| `src/renderer.js` | expose `getFieldObjects()` lookup per source (mirrors existing `getPageTextContent` cache) |
| `src/pdf-engine.js` | detect forms/XFA on `loadFromBytes()` and `INSERT_PAGES`; write field values in `buildOutputDoc()`; optionally make the `rasterizeRedactedPage()` fallback form-aware |
| `src/preview.js` | new `.annot-form-layer` per page, built from pdf.js `AnnotationLayer` in `renderPageCanvas()`; hide/disable widgets overlapping a redaction, mirroring `applyRedactionTextLocks()` |
| `src/forms.js` *(new)* | owns field-change listeners → `SET_FIELD_VALUE` dispatch, any "Reset form" action, mirrors `src/annotate.js` / `src/signature.js` shape |
| `src/main.js` | render-loop diff clause for `fieldValues` (dirty only, no restack) |
| `src/style.css` | trimmed/retheme copy of pdf.js's `.annotationLayer` widget CSS |
| `index.html` | no changes expected (CSP already permits what's needed; no new DOM chrome required unless a "Reset form" toolbar button is added) |

---

## 9. Suggested phasing

1. Text fields + checkboxes + radio groups (the common case), no flatten option, no redaction interplay handled yet (warn/skip that combo).
2. Dropdowns and listboxes.
3. Redaction + form-field interplay: hide/disable widgets whose rects overlap a redaction (§6).
4. Flatten-on-save checkbox.
5. Everything in §7 stays explicitly unsupported unless a real need shows up.

## 10. Manual test plan

No test suite exists in this repo (`CLAUDE.md`: "There is no test suite and no linter configured"), so verify by hand against a small set of sample PDFs covering: plain AcroForm with text/checkbox/radio/dropdown, a form with a non-embedded custom font (appearance regeneration check), an XFA form (should show the unsupported toast), a form PDF inserted into a primary document that also has forms with colliding field names, and a redacted page that also carries a field (§6 combo). Also re-verify existing find/highlight/redaction/signature flows still work on non-form PDFs, since `preview.js` and `pdf-engine.js` are both touched.
