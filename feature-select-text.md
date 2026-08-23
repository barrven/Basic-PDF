# Feature: select text with the cursor

Assessment of adding pointer-based text selection (and copy) to the current Basic PDF preview.

**Verdict:** select-and-copy is a moderate, well-supported add — roughly a day or two for a solid first version. The PDF library already in the project does this. Editing the PDF text itself would be a different, much harder project.

---

## Current state

The preview (`src/preview.js`) is a continuous vertical stack of `.preview-page` nodes. Each page is:

1. A `<canvas>` rasterized by pdf.js
2. A `.signature-overlay-layer` on top for stamps

A canvas is pixels. There is no DOM text, so the cursor has nothing to select. `src/renderer.js` only uses pdf.js to load documents and paint pages. There is no `getTextContent`, `TextLayer`, or text-layer CSS today.

The app already depends on `pdfjs-dist` **4.10.38**, which exports `TextLayer` from the same `pdf.mjs` loaded in `src/renderer.js`. Each page already fetched can also provide `page.getTextContent()`. The viewport used to paint the canvas already includes scale and rotation:

```js
const viewport = page.getViewport({ scale: view.scale, rotation: entry.rotation })
await page.render({ canvasContext: ctx, viewport }).promise
```

That same `viewport` is what `TextLayer` needs.

Blank pages (`originalIndex === -1`) and image-only scans have no text items, so selection would do nothing — which is correct.

---

## How pdf.js text selection works

pdf.js does not make the canvas selectable. It paints an invisible HTML text overlay on top of the canvas, with spans positioned to match the glyphs. The browser then handles drag-select and Ctrl/Cmd+C.

Two APIs ship with the installed package:

| API | Where | Role |
|---|---|---|
| `TextLayer` | `pdfjs-dist/build/pdf.mjs` (already imported) | Core: takes `textContentSource` + `container` + `viewport`, renders spans |
| `TextLayerBuilder` | `pdfjs-dist/web/` viewer components | Same overlay, plus a global listener so selection can cross page boundaries |

For one-page-at-a-time select+copy, the core `TextLayer` class is enough. The full pdf.js viewer is not required.

Standard styles live in `pdfjs-dist/web/pdf_viewer.css` under `.textLayer` (transparent text, `user-select: text`, absolute positioning). Those rules can be copied/adapted into `src/style.css` rather than importing the entire viewer stylesheet.

---

## Proposed v1 (copy-only)

Work is concentrated in `src/preview.js` plus some CSS. Scope: drag to select text on a visible page and copy it. Do not edit, delete, or search yet.

1. Add a `.textLayer` div on each `.preview-page`, **between** the canvas and the signature overlay.
2. After a page canvas paints in `renderPageCanvas()`, run:

   ```js
   const textContentSource = await page.getTextContent()
   const layer = new TextLayer({
     textContentSource,
     container: view.textLayerEl,
     viewport,
   })
   await layer.render()
   ```

3. Copy/adapt the `.textLayer` rules from `pdfjs-dist/web/pdf_viewer.css`.
4. Disable pointer events on the text layer while placing a signature, so stamps still land on the page.
5. Keep signatures above the text layer. The overlay already uses `pointer-events: none` except on `.sig-overlay`, so stamps still win over text.
6. Skip the text layer for blank pages (`originalIndex === -1`).
7. Cancel an in-flight `TextLayer` when `lastRenderToken` changes (same token pattern as canvas rasterization).

Zoom already rebuilds the whole preview stack, so the text layer rebuilds with the canvases. Native selection is lost on zoom — same as most PDF viewers, acceptable for v1.

---

## Interaction conflicts

The rendering is the easy part. The mouse and keyboard already mean other things:

| Existing behavior | Conflict | v1 handling |
|---|---|---|
| Click on the page deselects a signature | A text drag ends in a `click`. That would wipe the selection and/or deselect stamps. | Ignore click-after-drag (or only deselect if the selection is collapsed). |
| Signature placement mode | The text layer would steal the click. | `pointer-events: none` on `.textLayer` while placing. |
| `Ctrl/Cmd+A` selects every page (`src/shortcuts.js`) | Users will expect it to select all text once they have a text selection. | If the selection is inside a text layer, let the browser select text (or select all text on the focused page). Otherwise keep current page-select behavior. |
| `Delete` / `Backspace` deletes pages or a stamp | Fine if selection is copy-only. | Do **not** wire delete to “remove the selected text from the PDF.” |
| Zoom rebuilds the preview DOM | Native selection dies on zoom. | Acceptable. |
| Lazy `IntersectionObserver` render | Off-screen pages have no text layer yet. | Cannot select across them until they paint. Fine for v1. |
| Selecting across two pages | Browser selection does not join two separate overlay trees. | Skip for v1. `TextLayerBuilder` has a global listener if this is needed later. |

---

## Encoding / CJK caveat

CJK and some other encodings may need `cMapUrl` pointed at `pdfjs-dist/cmaps`. `src/renderer.js` does not set that today (`getDocument({ data: copy })` only). Rendering can still look fine while `getTextContent()` returns garbage for those files. Worth wiring `cMapUrl` (and `standardFontDataUrl`) when the text layer lands, even if it is not strictly required for Latin documents.

---

## What this is not

- **Not OCR.** A scanned page with no real text stream has nothing to select. That would be a separate pipeline.
- **Not in-place text editing.** Replacing glyphs in the original content stream is not something pdf-lib does cleanly, and it does not belong in this overlay. Overlay + copy is a display feature; mutating the PDF is a document-model feature.
- **Not highlight / redact as a saved annotation.** Possible later (text items expose quad points), but out of v1.

---

## Follow-on: search

`todos.txt` already lists “add search feature with ctrl + f”. Find-in-page uses the same text layer: `getTextContent()` for the query, then highlight matching spans. If the text layer ships first, Ctrl+F becomes much cheaper. Full write-up: `feature-search-text.md`.

---

## Suggested implementation order

1. Add `.textLayer` DOM + CSS; render it next to the canvas for visible pages.
2. Verify select + copy on a text PDF at 0° rotation, then at 90/180/270.
3. Confirm image-only and blank pages are a no-op.
4. Disable the layer during signature placement; keep stamp drag/resize working.
5. Fix click-after-drag vs signature deselect.
6. Decide `Ctrl/Cmd+A` when a text selection exists.
7. (Optional) `cMapUrl` / `standardFontDataUrl` for non-Latin text.
8. (Later) cross-page selection via `TextLayerBuilder`.
9. (Later) Ctrl+F on top of the same spans.
