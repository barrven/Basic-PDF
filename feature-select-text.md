# Feature: select text with the cursor

**Status:** implemented. Drag-select and copy work on visible preview pages via a pdf.js `TextLayer`. This document describes the as-built behavior and the remaining follow-ons.

Editing the PDF text itself is a different, much harder project and is not in scope.

---

## What shipped

The preview (`src/preview.js`) is a continuous vertical stack of `.preview-page` nodes. Each page is:

1. A `<canvas>` rasterized by pdf.js
2. A `.textLayer` div (pdf.js `TextLayer`) between the canvas and the stamps
3. A `.signature-overlay-layer` on top for stamps

`src/renderer.js` loads documents with `cMapUrl` / `cMapPacked` and `standardFontDataUrl` (`useWorkerFetch: false`). `getPageTextContent(sourceId, originalIndex)` caches `page.getTextContent()` so the text layer and find share one extract.

Blank pages (`originalIndex === -1`) and image-only scans have no text items, so selection does nothing — which is correct.

The app depends on `pdfjs-dist` **4.10.38**, which exports `TextLayer` from the same `pdf.mjs` already imported for rendering.

---

## How pdf.js text selection works

pdf.js does not make the canvas selectable. It paints an invisible HTML text overlay on top of the canvas, with spans positioned to match the glyphs. The browser then handles drag-select and Ctrl/Cmd+C.

Two APIs ship with the package:

| API | Where | Role |
|---|---|---|
| `TextLayer` | `pdfjs-dist/build/pdf.mjs` (used) | Core: takes `textContentSource` + `container` + `viewport`, renders spans |
| `TextLayerBuilder` | `pdfjs-dist/web/` viewer components | Same overlay, plus a global listener so selection can cross page boundaries |

v1 uses `TextLayer` only. Cross-page selection is not supported.

`.textLayer` rules (transparent text, `user-select: text`, rotation via `data-main-rotation`, `::selection` styling) live in `src/style.css`. The full pdf.js viewer stylesheet is not imported.

---

## Implementation

Work is concentrated in `src/preview.js` plus CSS in `src/style.css` and the extract cache in `src/renderer.js`.

1. Each `.preview-page` gets a `.textLayer` div **between** the canvas and the signature overlay.
2. After a page canvas paints in `renderPageCanvas()`, `renderPageTextLayer()` runs:

   ```js
   const textContent = await getPageTextContent(entry.sourceId, entry.originalIndex)
   const layer = new TextLayer({
     textContentSource: textContent,
     container: view.textLayerEl,
     viewport,
   })
   await layer.render()
   ```

3. In-flight `TextLayer` work is cancelled when `lastRenderToken` changes (same token pattern as canvas rasterization).
4. Blank pages skip the layer and are marked painted immediately.
5. `#preview-pane.is-placing .textLayer { pointer-events: none }` so stamps still land on the page.
6. Signatures stay above the text layer. The overlay already uses `pointer-events: none` except on `.sig-overlay`, so stamps still win over text.
7. Click-after-drag (or a non-collapsed text selection) does not deselect a stamp.
8. `Ctrl/Cmd+A`: if the selection is inside a text layer, `selectAllTextInActiveLayer()` selects that page’s text; otherwise all pages are selected (`src/shortcuts.js`).
9. `Delete` / `Backspace` do **not** remove selected text from the PDF. While a non-collapsed text selection is active, the shortcut does not delete pages.

Zoom already rebuilds the whole preview stack, so the text layer rebuilds with the canvases. Native selection is lost on zoom — same as most PDF viewers.

---

## Interaction conflicts (as handled)

| Existing behavior | Handling |
|---|---|
| Click on the page deselects a signature | Ignore click-after-drag; ignore click while a text selection is non-collapsed. |
| Signature placement mode | `pointer-events: none` on `.textLayer` while placing. |
| `Ctrl/Cmd+A` selects every page | If the selection is inside a text layer, select all text on that page. Otherwise keep page-select. |
| `Delete` / `Backspace` deletes pages or a stamp | Skip page delete while a text selection is non-collapsed. Never delete glyphs from the PDF. |
| Zoom rebuilds the preview DOM | Native selection dies on zoom. Accepted. |
| Lazy `IntersectionObserver` render | Off-screen pages have no text layer yet. Cannot select across them until they paint. |
| Selecting across two pages | Not implemented. `TextLayerBuilder` has a global listener if this is needed later. |

---

## Encoding / CJK

`getDocument()` sets `cMapUrl`, `cMapPacked: true`, and `standardFontDataUrl`. Worker-side fetch of those `file://` assets is disabled (`useWorkerFetch: false`) because it is unreliable in Electron.

---

## What this is not

- **Not OCR.** A scanned page with no real text stream has nothing to select.
- **Not in-place text editing.** Overlay + copy is a display feature; mutating the PDF is a document-model feature.
- Saved highlight / redact annotations are implemented — see `feature-annotate.md`. Find highlights remain session-only (see `feature-search-text.md`).
- **Not cross-page selection.**

---

## Follow-ons (not implemented)

1. Cross-page selection via `TextLayerBuilder`.
2. OCR for image-only scans.

Find-in-page (`Ctrl/Cmd+F`) is implemented on top of this layer — see `feature-search-text.md`.

---

## See also

- `feature-search-text.md` — find bar, extract cache, on-page highlights
- `feature-annotate.md` — saved highlight and redaction on this same text layer
- `todos.md` — remaining product ideas (annotations, settings, form filling)
