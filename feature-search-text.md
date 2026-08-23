# Feature: text search (Ctrl+F)

Assessment of adding find-in-page to the current Basic PDF preview.

**Verdict:** feasible, and about the same size of work as text select — roughly a couple of days for a Ctrl+F bar with next/prev and on-page highlights. It is not a rewrite. Pair it with the text layer in `feature-select-text.md`; search without that overlay can still jump to a page, but cannot show the match.

Performance is fine if search stays incremental, caches extracted strings, and only highlights pages that already have a text layer. It gets expensive only if a text layer is painted on every page at once.

---

## Current state

There is no find UI, no `getTextContent()` usage, and no text layer. Preview pages are canvases plus a signature overlay (`src/preview.js`). Keyboard shortcuts live in `src/shortcuts.js`; `Ctrl/Cmd+F` is unused. `todos.txt` already lists “add search feature with ctrl + f”.

The page model is a composed list, not a single PDF:

- primary file (`PRIMARY_SOURCE_ID`)
- pages inserted from other files (`sourceId`)
- blank pages (`originalIndex === -1`)
- reordered / rotated pages

`appState.pages` is the source of truth for display order. Search must walk that array, not the original file’s page numbers.

pdf.js 4.10 ships `PDFFindController` and `TextHighlighter` in the viewer components. They are built for **one** `PDFDocumentProxy`. Dropping them in against the primary document would miss inserted sources, include pages that were deleted from the composition, and use the wrong order after a reorder. A small custom walker over `appState.pages` is the right fit.

The data API is already in the installed library: `page.getTextContent()` returns `{ items, styles, lang }` where each text item is `{ str, dir, transform, width, height, fontName, hasEOL }`.

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

A search-only v1 that jumps to a page with no highlight is possible but a worse first version. Ship (or at least land) the text layer first, then Ctrl+F on the same overlay and cache.

---

## Proposed v1

Scope: case-insensitive substring search, match count, next/prev, highlight current + other matches on the visible page. No regex, whole-word, or diacritics folding yet.

### UI

- Find bar in the preview chrome (or a compact bar above `#preview-pane`).
- `Ctrl/Cmd+F` opens it and focuses the input.
- Escape closes it when it is open (takes priority over placement-cancel / stamp-deselect).
- Enter / buttons for next and previous; wrap at the ends.
- Live status: `3 of 12` while extraction is still running (`3 of …` is fine until the last page finishes).

### Find (custom walker)

On a debounced query change:

1. Walk `appState.pages` in display order.
2. Skip blanks (`originalIndex === -1`).
3. `getPage(sourceId, originalIndex)` then `getTextContent()`.
4. Concatenate `item.str` (respect `hasEOL` as a break if useful for display snippets; matching can be on the joined string).
5. Record hits as `{ pageId, pageIndex, itemIndex, offset, length }` — include page `id` so reorder can remap.
6. Do **not** wait for the whole document before showing the first hits. Search page 1, paint results, continue, update the count.

Cache extracted payloads keyed by `sourceId` + `originalIndex`:

- Reorder / rotate / selection changes do **not** invalidate the cache (the glyphs did not change).
- Close file / replace primary / insert a new PDF source **does**.
- Share this cache with the text layer so visible-page paint and search do not extract twice.

### Show (text layer)

- Next/prev: `SET_FOCUSED_PAGE` to the hit’s `pageIndex`, `scrollPreviewToFocused({ force: true })`, wait until that page’s lazy canvas + text layer have painted, then highlight.
- Highlight only on pages that already have a text layer (visible / near-viewport). Off-screen hits wait until `IntersectionObserver` paints them — same as today’s canvases.
- Current match vs other matches: two CSS classes on the existing spans (or split a span when a hit is a substring of one text item). Do not rebuild the layer on every next-match.
- Thumbnails stay paint-only. No text layer, no highlights in the sidebar.

### Invalidation

Drop or remap the match list when pages change:

- Reorder / insert / delete: remap `pageIndex` by page `id` (same pattern as signatures), or just re-run the query. Re-run is simpler for v1.
- Rotate: strings are unchanged; highlights must wait for the text layer to rebuild at the new viewport.
- Zoom: preview stack is already torn down; re-apply highlights after the focused page paints.

---

## Interaction with existing shortcuts

| Existing behavior | Conflict | v1 handling |
|---|---|---|
| No `Ctrl/Cmd+F` today | None | Open/focus the find bar. |
| Escape cancels placement / deselects stamps / closes modals | Find bar would steal it | If the find bar is open, close it first. |
| `Ctrl/Cmd+A` selects all pages | Only matters once a text layer exists | Unchanged unless a text selection is active (see `feature-select-text.md`). |
| `Enter` in the find input | Must not trigger other actions | Next match. Shift+Enter previous. |
| Signature placement | Find is independent | Leave placement alone; highlighting still sits under stamps. |

Do **not** bind Delete to “remove the matched text from the PDF.”

---

## What this is not

- **Not OCR.** Image-only scans and blank pages have nothing to find.
- **Not in-place text editing.** Hits are display overlays, same as select.
- **Not `PDFFindController` as-is.** Wrong document model (one file vs composed `appState.pages`). Its match/normalize helpers can be copied later for whole-word / diacritics if needed.
- **Not saved highlight annotations.** Yellow is a find-session overlay, not written by pdf-lib on save.

CJK / unusual encodings still want `cMapUrl` and `standardFontDataUrl` on `getDocument()` (see `feature-select-text.md`). Search quality tracks extract quality.

---

## Performance

Today the expensive work is **canvas rasterization** (`page.render`). Thumbnails also rasterize every page on open. Text extract and text-layer DOM are both cheaper than that, if they follow the same lazy rules.

### Text layer (needed to show hits; also used by select)

| What | Cost | Why it stays small |
|---|---|---|
| `getTextContent()` per visible page | Worker-side, typically a fraction of `page.render` | Same `IntersectionObserver` as canvases (`rootMargin: 800px`) |
| Invisible `<span>`s over the canvas | Extra DOM, not extra pixels | Only a handful of pages exist as painted views |
| Zoom | Rebuilds the preview stack anyway | Layer dies and is rebuilt with the canvases, still lazy |

A normal letter page is tens to a few hundred spans. The ugly case is a CAD/form export with thousands of one-character runs: that **page** can hitch, not the rest of the document.

Expect on the order of **+10–30% on a visible page’s first paint**, not 2×, and **no extra cost for pages that have not scrolled into view**. After paint, idle scrolling and signature drag should feel the same.

### Search extract (all pages, no extra DOM)

Search must read text from every page, including ones never shown.

| What | Cost | How to keep it cheap |
|---|---|---|
| First search over N pages | N × `getTextContent()` | Incremental + debounce. Live match count. |
| Later searches in the same file | Almost free | Cache by `sourceId` + `originalIndex`. |
| Highlighting | CSS classes on existing spans | Only on pages that already have a text layer |
| Jump to a match off-screen | One more lazy page paint | Same as clicking a thumbnail |

`getTextContent()` does **not** rasterize. A 20–50 page text PDF is usually sub-second for the first search. A 300–500 page file can take a few seconds if you wait for the whole thing — which is why the count should update live instead of blocking.

Memory for page strings is small (kilobytes to a couple of MB). Memory for a text layer on every page in a 400-page stack would **not** be small. Never build layers for off-screen pages just because they have hits.

Share one cache between select and search: the first visible-page paint fills extract for those pages; the first search fills the rest.

### What would actually hurt

1. Building a text layer for every page on open (DOM explosion).
2. Re-extracting on every keystroke with no debounce/cache.
3. Re-extracting on zoom/scroll (viewport changed; the strings did not).
4. Highlighting by wrapping/splitting thousands of spans on every next-match.
5. Running search work on the thumbnail path.

Avoid those and neither select nor search should change the feel of open, scroll, rotate, or stamp. Canvas paint remains the bottleneck.

---

## Suggested implementation order

1. Land the text layer from `feature-select-text.md` (or the extract + layer pieces of it).
2. Add a `sourceId`+`originalIndex` text cache in `src/renderer.js` (or a small `src/text-content.js`) used by both preview and search.
3. Find bar UI + `Ctrl/Cmd+F` / Escape / Enter.
4. Incremental walker over `appState.pages`; live match count.
5. Next/prev: focus, scroll, wait for lazy paint, highlight current match.
6. Re-run (or remap) on page-list changes; keep cache across reorder/rotate.
7. Confirm blanks and image-only PDFs report zero hits.
8. (Optional) `cMapUrl` / `standardFontDataUrl` if not already done for select.
9. (Later) whole-word, case toggle, regex, diacritics; copy helpers from `PDFFindController` if useful.
10. (Later) match snippets / a hit list in the sidebar.

---

## See also

- `feature-select-text.md` — text layer, copy, interaction with stamps and `Ctrl+A`
- `todos.txt` — “add search feature with ctrl + f”
