# Feature: text highlight and redaction

**Status:** implemented. Select text on a preview page, then highlight it or redact it. Both are saved into the PDF. This document describes the as-built behavior.

This sits on top of the pdf.js text layer (`feature-select-text.md`). It is not in-place PDF text editing, and it is not OCR — image-only scans have nothing to select.

---

## What shipped

- Drag-select text on a visible preview page. A floating popover offers **Highlight** and **Redact**.
- `Ctrl/Cmd+H` highlights the current selection (same as the popover button).
- Highlights are yellow marker bars under the glyphs. Text stays selectable and copyable.
- Redactions are opaque black bars above the glyphs. Preview text under a redaction cannot be selected or copied. Find skips hits that overlap a redaction.
- Clicking a redaction selects it (accent outline). `Delete` / `Backspace` removes it. Highlights are removed by selecting overlapping text and choosing **Remove highlight**, or with undo.
- Selecting overlapping highlighted/redacted text toggles the popover to **Remove highlight** / **Remove redaction**.
- Undo/redo covers annotations with pages and stamps. Page reorder, insert, delete, and duplicate remap `pageIndex` by page `id` the same way stamps do.
- Escape closes the popover and clears the text selection (after the find bar, if it is open).

---

## Data model

`appState.annotations` is an array of:

```
{ id, type: 'highlight' | 'redact', pageIndex, rects: [{ x, y, width, height }], color }
```

Coordinates are pdf.js visual top-left space for the page at its current rotation — the same space as signature stamps. `rects` is one box per line of the selection (adjacent same-line boxes are merged).

They are session edits, not round-tripped PDF annotation objects. Opening a file starts with an empty list; existing highlight/redact markup already in the PDF is left as page content.

---

## Preview

Each `.preview-page` stack is:

1. `<canvas>`
2. `.annot-highlight-layer` (pointer-events none; rects use `mix-blend-mode: multiply` with no extra opacity so glyphs stay dark like the saved PDF)
3. `.textLayer`
4. `.annot-redact-layer` (pointer-events on the black rects)
5. `.signature-overlay-layer`

`src/annotate.js` turns `window.getSelection()` + `Range.getClientRects()` into PDF-point rects via the page view’s scale. `src/preview.js` paints the overlay DOM and, after the text layer paints, disables pointer events / select on spans that intersect a redaction.

The popover is `#annotate-popover` (`position: fixed`). `mousedown` is `preventDefault`ed so the selection is not collapsed when a button is clicked.

---

## Save

`buildOutputDoc()` in `src/pdf-engine.js`:

**Highlights only (no redaction on that page).** Copy the source page, set rotation, draw yellow rectangles with `BlendMode.Multiply` using the same visual→pdf-lib mapping as stamps.

**Any redaction on that page.** Rasterize a fresh pdf.js document (isolated from the preview’s live page, so the two renders cannot cancel each other) at 2×, cap the long edge at 3000px. Paint highlights (multiply), stamps, then black redaction rects onto the canvas. Replace the output page with that PNG at the visual page size, rotation 0. Underlying glyphs are not in the saved file.

If rasterization fails, the save still completes: vector copy + multiply highlights + opaque black rectangles (visual cover only). That fallback is logged.

Pages with redactions show the document-loading overlay (`Saving…`) during `buildOutputDoc()`.

---

## Find

`src/search.js` drops hits whose glyph boxes overlap a redaction. Highlight annotations do not affect find. Changing the redaction set while the find bar is open re-runs the query.

---

## What this is not

- **Not a highlighter tool you click first, then drag.** Select text, then apply.
- **Not colored highlight presets.** One yellow.
- **Not PDF `/Highlight` or `/Redact` annotation objects.** Other readers see burned-in appearance (and, for redacted pages, a flattened image).
- **Not partial-page vector redaction.** A redacted page is flattened so the words cannot be extracted. Non-redacted text on that page also becomes an image.
- **Not OCR.** Scanned pages with no text stream cannot be highlighted or redacted this way.

---

## See also

- `feature-select-text.md` — text layer, select-and-copy
- `feature-search-text.md` — find bar on that same extract cache
