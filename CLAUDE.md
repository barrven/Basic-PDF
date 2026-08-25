# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # launch the Electron app (alias: npm run dev)
npm run build      # package with electron-builder --config .electron-builder.yml → dist/
npm run audit      # npm audit --audit-level=high
```

There is no test suite and no linter configured. `.github/workflows/security.yml` runs `npm audit --audit-level=high` on push, pull request, and weekly (Monday 08:00 UTC).

### App name

The visible name is **Basic PDF** (`productName` in `package.json` and `.electron-builder.yml`). That is what the window, installer, and Start menu shortcut use.

`package.json` `"name"` must stay a valid npm package id (`basic-pdf`: lowercase, no spaces). Putting `"Basic PDF"` there makes `electron-builder` fail. Do not change `"name"` to the display name.

## Architecture

This is a vanilla-JS Electron desktop app with no bundler and no frontend framework. All browser-side code uses native ES modules loaded directly from `node_modules` paths.

### Process boundary

**Main process** (`electron/main.js`) owns all native OS access: file open/save dialogs, filesystem reads/writes, right-click context menus, persistent settings via `electron-store`, OS-level "open this PDF", display theme (`nativeTheme.themeSource`), About-dialog app info, and the unsaved-changes prompt when closing the window. It exposes ten invoke handlers (`open-file`, `open-file-bytes`, `save-file`, `save-file-as`, `show-context-menu`, `store-get`, `store-set`, `get-theme`, `set-theme`, `get-app-info`), one-way `set-dirty` from the renderer, and one-way `open-path` / `theme-updated` events to the renderer. Theme preference is `'system'` (default, follows the OS), `'light'`, or `'dark'`. Window `backgroundColor` and `titleBarOverlay` colors track the resolved appearance. Open / Save As dialogs use `lastDir` from electron-store (the folder of the last file the app opened or saved); if that folder is gone, the dialog uses the OS default.

Windows Default Apps launches a new process with the PDF as an argv entry (`[exe, file.pdf]` packaged, `[electron, ., file.pdf]` in dev). macOS uses the `open-file` event, which can fire before `ready`. The path is queued until `did-finish-load`, then sent to the renderer. There is no single-instance lock — each launch gets its own window.

Hardening: `contextIsolation: true`, `nodeIntegration: false`, Chromium visual zoom locked at 100%, `setWindowOpenHandler` denies all window opens, and `will-navigate` is always prevented. `index.html` ships a strict CSP (`default-src 'none'`, `script-src 'self' 'wasm-unsafe-eval'` for pdf.js WASM, `worker-src 'self' blob:` for the pdf.js worker).

**Preload** (`electron/preload.js`) bridges the invoke handlers into `window.electronAPI` via `contextBridge` so the renderer can never touch Node, and buffers `open-path` until `onOpenPath` is registered.

### Renderer architecture

`src/main.js` is the entry point. It boots all modules and subscribes a single `render()` function to the state store. The render function diffs the previous and current state to decide which sub-renders to call — it is the only place that drives UI updates.

- `pages` / `filePath` changes rebuild thumbnails and re-run an open find query (`onSearchDocumentChanged()`). Find also re-runs when the redaction set changes.
- `pages` / `zoom` / `filePath` changes rebuild the preview stack (`renderPreview()`).
- `focusedPage` alone scrolls the existing stack (`scrollPreviewToFocused()`); it does not re-rasterize canvases.
- `signatures` / `selectedSig` changes only refresh stamp overlay DOM.
- `annotations` / `selectedAnnotation` changes only refresh highlight/redact overlay DOM.

**State** (`src/state.js`) is a single `appState` object mutated only through `dispatch(action)`. Subscribers are notified after every dispatch. Undo/redo snapshots only `pages`, `signatures`, and `annotations` (not zoom, selection, loading, etc.), capped at 50 entries. `loading` is set while a PDF is opened or inserted; a workspace overlay spinner stays up until the preview stack has been laid out.

**Two-library PDF model**: The app uses two separate PDF libraries with distinct roles:
- **pdf.js** (`src/renderer.js`) — renders pages to `<canvas>` for display, extracts `getTextContent()` (cached by `sourceId` + `originalIndex`), and supplies the viewport used by the text layer. Each loaded file is keyed by a `sourceId` in a module-level `Map`. Documents are opened with `cMapUrl` and `standardFontDataUrl` (`useWorkerFetch: false`, because worker-side `file://` fetches are unreliable in Electron).
- **pdf-lib** (`src/pdf-engine.js`) — assembles the output document at save time. `buildOutputDoc()` copies pages from every source (by `sourceId`) into a fresh `PDFDocument`, applies rotations (always, including 0), draws highlight rectangles (`BlendMode.Multiply`), embeds signature images, and flattens pages that have redactions to a PNG so the covered text is not extractable.

**Pages model**: `appState.pages` is an array of `{ id, sourceId, originalIndex, rotation }` entries created via `createPageEntry()`. `id` is a UUID used to remap signatures, selection, and focus when pages are reordered, inserted, duplicated, or deleted. Inserting a PDF creates a new `sourceId`; the primary file always uses `PRIMARY_SOURCE_ID = 'primary'`. A blank page is represented by `originalIndex === -1`. `rotation` is the absolute display/save angle (0/90/180/270), seeded from the source page's `/Rotate` on open or insert — not an additive delta.

The toolbar "Add page" button is commented out; blank pages are still available from the thumbnail context menu (`Insert blank page after`).

**Signatures** are stored as `{ id, pageIndex, x, y, width, height, opacity, dataUrl }` in `appState.signatures`. Coordinates are in pdf.js visual top-left space for the page at its current rotation. `buildOutputDoc()` converts those into pdf-lib's unrotated media-box space (and rotates the image) when embedding. `SET_PAGE_ORDER` / `INSERT_PAGES` remap `pageIndex` by page `id` so stamps follow the page they were placed on. Placed stamps can be dragged and resized with eight handles (aspect ratio locked, min 20pt). The saved library (persisted via `electron-store`) is capped at 20 entries in `src/store.js`; entries can be removed from the library popover. WebP uploads are rasterized to PNG before save.

**Annotations** (`appState.annotations`) are `{ id, type, pageIndex, rects, color }` with `type` `'highlight'` or `'redact'`. Rects use the same visual top-left space as stamps. Select text to show `#annotate-popover` (`src/annotate.js`); `Ctrl/Cmd+H` highlights. Highlights sit under the text layer; redactions sit above it and block select/copy. On save, highlights are multiply-blend rectangles; a page with any redaction is rasterized (isolated pdf.js document at 2×, long edge capped at 3000px) so the covered glyphs are not in the output. `SET_PAGE_ORDER` / `INSERT_PAGES` remap annotation `pageIndex` by page `id`.

### Preview

The preview pane (`#preview-pane`) is a continuous vertical stack of `.preview-page` nodes (canvas + highlight overlay + pdf.js `TextLayer` + redaction overlay + signature overlay), not a single-page canvas. Stack order is canvas, then `.annot-highlight-layer`, then `.textLayer`, then `.annot-redact-layer`, then `.signature-overlay-layer`. Pages are measured, laid out, then rasterized lazily with `IntersectionObserver` (`src/preview.js`). Fit-to-width (`zoom === null`) scales each page to the pane width; numeric zoom uses a shared `%` scale from `src/zoom.js` (steps 50–200). Scrolling updates `focusedPage` (and single-page selection) from whichever page sits near the top of the viewport. Thumbnail clicks and arrow keys scroll that page into view.

The text layer is built only for visible (or near-viewport) non-blank pages after the canvas paints, using the cached `getTextContent()` payload. It enables drag-select, copy, and find highlights. Pointer events on `.textLayer` are disabled during signature placement. Click-after-drag does not deselect a stamp. `Ctrl/Cmd+A` selects all text in the active layer when a text selection is already there; otherwise it selects all pages. Cross-page selection is not supported.

`Ctrl/Cmd+mouse wheel` over the preview steps zoom in/out using the same list as the toolbar buttons. After the stack rebuilds, a scroll anchor keeps the point under the cursor in place. Wheel zoom is ignored during signature placement and while a modal is open. Chromium visual zoom is locked at 100% (`webContents.setVisualZoomLevelLimits(1, 1)` in `electron/main.js`) and Ctrl/Cmd+wheel is `preventDefault`ed in `src/shortcuts.js`, so the shortcut never scales the whole UI.

### Find

`src/search.js` implements case-insensitive substring search over the composed `appState.pages` list (not the original file’s page numbers). `Ctrl/Cmd+F` opens `#find-bar` above the preview; Escape closes it first (before placement-cancel / deselect). Enter / Shift+Enter and the ↑/↓ buttons move next/prev and wrap. Extraction is incremental and debounced (200ms); status shows `3 of …` until every page has been walked, then `3 of 12` or `No matches`. Blank pages are skipped. Hits are remapped by re-running the query when `pages` / `filePath` change, and when the redaction set changes. Hits that overlap a redaction are omitted. Highlights (`find-match` / `find-match-current`) are applied only on pages that already have a text layer; jumping to an off-screen hit waits for lazy paint. This is a find-session overlay — it is not written to the PDF on save.

### Dirty state

`dirty` is set on page/signature/annotation edits. Opening another file or closing the current file prompts in the renderer (`window.confirm`). Closing the window prompts in the main process: the renderer sends `set-dirty` on every dirty change, and `BrowserWindow` `close` shows a native dialog when `rendererDirty` is true.

### Module responsibilities

| File | Role |
|------|------|
| `src/state.js` | Central store, dispatch, pub/sub, undo/redo, page ids, signature/annotation remapping |
| `src/main.js` | Boot, render loop, toast, error modal, document-loading overlay, dirty sync to main, OS file-open hookup |
| `src/renderer.js` | pdf.js wrapper — load/clear sources, page fetch, text-content cache, CMap/standard-font URLs, blank-page helper, isolated docs for redaction flatten |
| `src/pdf-engine.js` | pdf-lib wrapper — open, save, saveAs, close, OS `openPath`, `buildOutputDoc` (highlights, redaction flatten, stamps) |
| `src/toolbar.js` | Toolbar DOM, button wiring, zoom, insert/delete/rotate |
| `src/zoom.js` | Shared zoom step list (50–200%) and `snapZoom()` used by toolbar and wheel zoom |
| `src/sidebar.js` | Thumbnail list, drag-to-reorder, click selection, context menu |
| `src/preview.js` | Continuous-scroll page stack, lazy canvas + text-layer render, signature/annotation overlays, Ctrl/Cmd+wheel zoom, find highlights |
| `src/search.js` | Find bar, incremental walker over composed pages, next/prev, highlight coordination |
| `src/annotate.js` | Selection popover, highlight/redact create/remove, selection→rect conversion, find/redaction overlap |
| `src/signature.js` | Signature modal (draw/upload), placement mode, library popover (including delete) |
| `src/store.js` | Signature library persistence (electron-store) |
| `src/theme.js` | Display mode (system / light / dark), title-bar popover, `data-theme` on `<html>` |
| `src/about.js` | Title-bar app-name menu and About modal (`get-app-info`) |
| `src/shortcuts.js` | Global keyboard shortcuts |

### Keyboard shortcuts (implemented in `src/shortcuts.js`; Ctrl/Cmd+wheel zoom is in `src/preview.js`)

`Ctrl/Cmd+O` open, `Ctrl/Cmd+S` save, `Ctrl/Cmd+Shift+S` save as, `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` / `Ctrl/Cmd+Y` redo, `Ctrl/Cmd+F` find, `Ctrl/Cmd+H` highlight current text selection, `[` rotate left, `]` rotate right, `Ctrl/Cmd+A` select all text in the active layer if a text selection is active else select all pages, `Delete/Backspace` delete selected redaction, signature, or pages (skipped while a non-collapsed text selection is active), `ArrowUp` / `ArrowDown` previous/next page, `PageUp` / `PageDown` scroll the preview by about one viewport, `Ctrl/Cmd+mouse wheel` zoom the preview in / out, `Escape` close find bar, then the annotate popover (and collapse the selection), then theme/about popovers and the About modal, then cancel placement / deselect.

### Related feature notes

As-built notes (these features are implemented):

- `feature-select-text.md` — pdf.js text layer, select-and-copy, interaction with stamps and `Ctrl+A`
- `feature-search-text.md` — Ctrl/Cmd+F find bar on that same text layer and extract cache
- `feature-annotate.md` — saved highlight and redaction on that same text layer

Open product ideas (not designed, not implemented) live in `todos.md`: annotation-style drawing/text entry, a settings gear, form filling.

### Build output

`electron-builder` config is in `.electron-builder.yml` (file list, icons, NSIS names, and a `.pdf` `fileAssociations` entry). `npm run build` must pass `--config .electron-builder.yml` because `package.json` has an empty `"build": {}` that electron-builder would otherwise treat as the whole config. Targets: NSIS (Windows), DMG (macOS), AppImage (Linux). Built app lands in `dist/`.
