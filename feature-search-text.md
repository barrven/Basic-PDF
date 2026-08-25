# Feature: text search (Ctrl+F)

**Status:** implemented. Case-insensitive substring find with a Ctrl/Cmd+F bar, next/prev, live match count, and on-page highlights. This document describes the as-built behavior and the remaining follow-ons.

Search walks the composed `appState.pages` list. It does not use pdf.js `PDFFindController` (that API is built for a single `PDFDocumentProxy` and would miss inserted sources, include deleted pages, and use the wrong order after a reorder).

---

## What shipped

- Find bar (`#find-bar`) above `#preview-pane`.
- `Ctrl/Cmd+F` opens it and focuses the input (`src/shortcuts.js` → `src/search.js`).
- Escape closes it when it is open (takes priority over placement-cancel / stamp-deselect / other popovers).
- Enter / ↓ next match; Shift+Enter / ↑ previous; wrap at the ends.
- Live status: `…` then `3 of …` while extraction is still running, then `3 of 12` or `No matches`.
- Case-insensitive substring search. No regex, whole-word, or diacritics folding.
- Highlights on the existing text-layer spans (`find-match` / `find-match-current`). Current match is scrolled into view.
- First revealed hit prefers the focused page (or the next page that has a match).

There is a shared `getPageTextContent()` cache in `src/renderer.js` (keyed by `sourceId` + `originalIndex`). Preview paint and search do not extract twice.

---

## How search works here

Two separate jobs:

1. **Find** — extract strings from every page in the composed document, match the query, keep a list of hits.
2. **Show** — scroll the hit’s page into view and highlight the matching spans on the text layer.

Find does **not** need DOM. Show **does**. That is why this feature and text select share infrastructure:

| | Select | Search |
|---|---|---|
| Needs `getTextContent()` | Yes, visible pages | Yes, all pages (cached) |
| Needs text-layer DOM | Yes | Only to *show* hits |
| Same “no text” cases | Scans, blanks | Scans, blanks |

The page model is a composed list, not a single PDF:

- primary file (`PRIMARY_SOURCE_ID`)
- pages inserted from other files (`sourceId`)
- blank pages (`originalIndex === -1`)
- reordered / rotated pages

`appState.pages` is the source of truth for display order.

---

## Find (custom walker)

On a debounced (200ms) query change, `runSearch()`:

1. Walks `appState.pages` in display order.
2. Skips blanks (`originalIndex === -1`).
3. `getPageTextContent(sourceId, originalIndex)` then joins `item.str`.
4. Records hits as `{ pageId, pageIndex, itemIndex, offset, length }`.
5. Yields every four pages so the UI can update. The first match at or after the focused page is revealed immediately; the count keeps growing.

Cache invalidation:

- Reorder / rotate / selection changes do **not** drop the extract cache (the glyphs did not change).
- Close file / replace primary / insert a new PDF source **does** (`clearPdfSources` / `setPrimarySource` / `addPdfSource` paths).
- Page-list or file-path changes re-run the open query (`onSearchDocumentChanged()` from `src/main.js`). Re-run is simpler than remapping hits.

Matching is on the concatenated item strings (no extra whitespace inserted between items). A hit that spans two adjacent items is stored against the first item and painted by walking subsequent spans until `length` is consumed.

---

## Show (text layer)

- Next/prev: `SET_FOCUSED_PAGE` to the hit’s `pageIndex`, wait for preview idle, `scrollPreviewToFocused({ force: true })`, `waitForTextLayer`, then highlight and scroll the current match into view.
- Highlight only on pages that already have a text layer (visible / near-viewport). Off-screen hits wait until `IntersectionObserver` paints them — same as canvases. A paint listener re-applies highlights when a layer finishes.
- Current match vs other matches: CSS classes on existing spans; a span is split when a hit is a substring of one text item. The original string is kept in `data-find-text` so highlights can be restored without rebuilding the layer.
- Thumbnails stay paint-only. No text layer, no highlights in the sidebar.

---

## Interaction with existing shortcuts

| Existing behavior | Handling |
|---|---|
| `Ctrl/Cmd+F` | Open/focus the find bar (ignored while a modal is open). |
| Escape cancels placement / deselects stamps / closes modals | If the find bar is open, close it first. |
| `Ctrl/Cmd+A` selects all pages | Unchanged unless a text selection is active (see `feature-select-text.md`). |
| `Enter` in the find input | Next match. Shift+Enter previous. |
| Signature placement | Independent; highlighting sits under stamps. |

Do **not** bind Delete to “remove the matched text from the PDF.”

---

## What this is not

- **Not OCR.** Image-only scans and blank pages have nothing to find.
- **Not in-place text editing.** Hits are display overlays, same as select.
- **Not `PDFFindController` as-is.** Wrong document model (one file vs composed `appState.pages`).
- **Not saved highlight annotations.** Yellow is a find-session overlay, not written by pdf-lib on save.

CJK / unusual encodings use `cMapUrl` and `standardFontDataUrl` on `getDocument()` (see `feature-select-text.md`). Search quality tracks extract quality.

---

## Performance (as built)

Canvas rasterization remains the bottleneck. Text extract and text-layer DOM follow the same lazy rules as canvases.

- `getTextContent()` for visible pages runs with canvas paint; search fills the rest incrementally.
- Text layers exist only for near-viewport pages. Search never builds a layer for every page.
- Zoom rebuilds the preview stack; highlights are re-applied after the focused page paints.
- Re-extract is not done on zoom, scroll, or reorder.

---

## Follow-ons (not implemented)

1. Whole-word, case toggle, regex, diacritics (pdf.js `PDFFindController` helpers could be copied).
2. Match snippets / a hit list in the sidebar.
3. OCR for image-only scans.

---

## See also

- `feature-select-text.md` — text layer, copy, interaction with stamps and `Ctrl+A`
- `todos.md` — remaining product ideas (annotations, settings, form filling)
