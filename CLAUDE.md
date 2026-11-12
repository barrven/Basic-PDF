# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # launch the app with `tauri dev` (alias: npm run dev)
npm run build      # `tauri build`: NSIS installer → src-tauri/target/release/bundle/nsis/
npm run audit      # npm audit --audit-level=high
```

Building needs Rust (stable, `x86_64-pc-windows-msvc`) and the Visual Studio C++ Build Tools with a Windows SDK. The Tauri CLI is a dev dependency. See `src-tauri/README.md`.

There is no test suite and no linter configured. `.github/workflows/security.yml` runs `npm audit --audit-level=high` on push, pull request, and weekly (Monday 08:00 UTC).

### App name

The visible name is **Basic PDF** (`productName` in `package.json` and `src-tauri/tauri.conf.json`). That is what the window, installer, and Start menu shortcut use.

`package.json` `"name"` must stay a valid npm package id (`basic-pdf`: lowercase, no spaces). Do not change `"name"` to the display name.

## Architecture

This is a Tauri desktop app (Rust shell, system WebView2) with a vanilla-JS renderer: no bundler and no frontend framework. All browser-side code uses native ES modules that import pdf.js and pdf-lib from `../node_modules/` paths.

### Shell boundary

**Shell** (`src-tauri/src/lib.rs`) owns all native OS access: file open/save dialogs, filesystem reads/writes, right-click context menus, persistent settings, OS-level "open this PDF", display theme, About-dialog app info, the frameless window's minimize / maximize / close / drag commands, and the unsaved-changes prompt when closing the window. It exposes Tauri commands (`pick_open_file`, `pick_save_path`, `read_file_bytes`, `save_file`, `show_context_menu`, `store_get`, `store_set`, `set_dirty`, `get_theme`, `set_theme`, `get_app_info`, `take_pending_open_path`, and five `window_*` commands) and emits a `theme-updated` event to the renderer. PDF bytes cross the boundary as raw binary, not JSON: `read_file_bytes` returns a raw response, and `save_file` takes a raw body with the destination path in the `x-path` header. Theme preference is `'system'` (default, follows the OS), `'light'`, or `'dark'`. Settings are a JSON file, `basic-pdf.json`, in the app config folder (`%APPDATA%/com.barrven.basic-pdf`). Open / Save As dialogs use `lastDir` from that file (the folder of the last file the app opened or saved); if that folder is gone, the dialog uses the OS default.

Windows Default Apps launches a new process with the PDF as an argument. The shell keeps that path until the renderer registers `onOpenPath`, which pulls it with `take_pending_open_path`. There is no single-instance lock — each launch gets its own window.

Hardening: the renderer has no Node or filesystem access, only the commands above; the capability file (`src-tauri/capabilities/default.json`) grants only `core:event:default`; `on_navigation` keeps the window on the app's own origin (`tauri.localhost`, plus the dev server's address under `tauri dev`). `index.html` ships a strict CSP (`default-src 'none'`, `script-src 'self' 'wasm-unsafe-eval'` for pdf.js WASM, `worker-src 'self' blob:` for the pdf.js worker).

**Bridge** (`src-tauri/src/bridge.js`) is injected as an initialization script before any page script. It defines `window.nativeAPI` (`openFile`, `openFileBytes`, `saveFile`, `saveFileAs`, `showContextMenu`, `getStoreValue`, `setStoreValue`, `setDirty`, `getAppInfo`, `getTheme`, `setTheme`, `onThemeUpdated`, `onOpenPath`) on top of Tauri's `invoke`, which is the renderer's only route to the OS. It also builds the caption buttons inside `#window-controls-spacer` and handles title-bar drag and double-click-to-maximize, because the window is frameless.

**Frontend assembly** (`src-tauri/scripts/assemble-frontend.mjs`) runs before `tauri dev` and `tauri build`. It copies `index.html`, `icon.png`, `src/`, and only the needed pdf.js / pdf-lib files into `src-tauri/frontend-dist/` (git-ignored), rewrites `../node_modules/` to `../vendor/` in the copied JS, and widens the copied CSP's `connect-src` for Tauri IPC. The sources are never modified. Edits to `src/` or `index.html` only reach the app after the command is re-run. If the renderer imports a new library file, add it to `COPIES` in that script.

### Renderer architecture

`src/main.js` is the entry point. It boots all modules and subscribes a single `render()` function to the state store. The render function diffs the previous and current state to decide which sub-renders to call — it is the only place that drives UI updates.

- `pages` / `filePath` changes rebuild thumbnails and re-run an open find query (`onSearchDocumentChanged()`). Find also re-runs when the redaction set changes.
- `pages` / `zoom` / `filePath` changes rebuild the preview stack (`renderPreview()`).
- `focusedPage` alone scrolls the existing stack (`scrollPreviewToFocused()`); it does not re-rasterize canvases.
- `signatures` / `selectedSig` changes only refresh stamp overlay DOM.
- `annotations` / `selectedAnnotation` changes only refresh highlight/redact overlay DOM.

**State** (`src/state.js`) is a single `appState` object mutated only through `dispatch(action)`. Subscribers are notified after every dispatch. Undo/redo snapshots only `pages`, `signatures`, and `annotations` (not zoom, selection, loading, etc.), capped at 50 entries. `loading` is set while a PDF is opened or inserted; a workspace overlay spinner stays up until the preview stack has been laid out.

**Two-library PDF model**: The app uses two separate PDF libraries with distinct roles:
- **pdf.js** (`src/renderer.js`) — renders pages to `<canvas>` for display, extracts `getTextContent()` (cached by `sourceId` + `originalIndex`), and supplies the viewport used by the text layer. Each loaded file is keyed by a `sourceId` in a module-level `Map`. Documents are opened with `cMapUrl` and `standardFontDataUrl` (`useWorkerFetch: false`, so they are fetched on the main thread).
- **pdf-lib** (`src/pdf-engine.js`) — assembles the output document at save time. `buildOutputDoc()` copies pages from every source (by `sourceId`) into a fresh `PDFDocument`, applies rotations (always, including 0), draws highlight rectangles (`BlendMode.Multiply`), embeds signature images, and flattens pages that have redactions to a PNG so the covered text is not extractable.

**Pages model**: `appState.pages` is an array of `{ id, sourceId, originalIndex, rotation }` entries created via `createPageEntry()`. `id` is a UUID used to remap signatures, selection, and focus when pages are reordered, inserted, duplicated, or deleted. Inserting a PDF creates a new `sourceId`; the primary file always uses `PRIMARY_SOURCE_ID = 'primary'`. A blank page is represented by `originalIndex === -1`. `rotation` is the absolute display/save angle (0/90/180/270), seeded from the source page's `/Rotate` on open or insert — not an additive delta.

The toolbar "Add page" button is commented out; blank pages are still available from the thumbnail context menu (`Insert blank page after`).

**Signatures** are stored as `{ id, pageIndex, x, y, width, height, opacity, dataUrl }` in `appState.signatures`. Coordinates are in pdf.js visual top-left space for the page at its current rotation. `buildOutputDoc()` converts those into pdf-lib's unrotated media-box space (and rotates the image) when embedding. `SET_PAGE_ORDER` / `INSERT_PAGES` remap `pageIndex` by page `id` so stamps follow the page they were placed on. Placed stamps can be dragged and resized with eight handles (aspect ratio locked, min 20pt). The saved library (persisted in the shell's settings file) is capped at 20 entries in `src/store.js`; entries can be removed from the library popover. WebP uploads are rasterized to PNG before save.

**Annotations** (`appState.annotations`) are `{ id, type, pageIndex, rects, color }` with `type` `'highlight'` or `'redact'`. Rects use the same visual top-left space as stamps. Select text to show `#annotate-popover` (`src/annotate.js`); `Ctrl/Cmd+H` highlights. Highlights sit under the text layer; redactions sit above it and block select/copy. On save, highlights are multiply-blend rectangles; a page with any redaction is rasterized (isolated pdf.js document at 2×, long edge capped at 3000px) so the covered glyphs are not in the output. `SET_PAGE_ORDER` / `INSERT_PAGES` remap annotation `pageIndex` by page `id`.

### Preview

The preview pane (`#preview-pane`) is a continuous vertical stack of `.preview-page` nodes (canvas + highlight overlay + pdf.js `TextLayer` + redaction overlay + signature overlay), not a single-page canvas. Stack order is canvas, then `.annot-highlight-layer`, then `.textLayer`, then `.annot-redact-layer`, then `.signature-overlay-layer`. Pages are measured, laid out, then rasterized lazily with `IntersectionObserver` (`src/preview.js`). A page canvas gets its backing store only when it is rasterized, and pages far from the viewport are freed again (canvas and text layer; at most 12 rendered pages are kept outside the observer margin) and re-render when scrolled back to. Fit-to-width (`zoom === null`) scales each page to the pane width; numeric zoom uses a shared `%` scale from `src/zoom.js` (steps 50–200). Scrolling updates `focusedPage` (and single-page selection) from whichever page sits near the top of the viewport. Thumbnail clicks and arrow keys scroll that page into view.

The text layer is built only for visible (or near-viewport) non-blank pages after the canvas paints, using the cached `getTextContent()` payload. It enables drag-select, copy, and find highlights. Pointer events on `.textLayer` are disabled during signature placement. Click-after-drag does not deselect a stamp. `Ctrl/Cmd+A` selects all text in the active layer when a text selection is already there; otherwise it selects all pages. Cross-page selection is not supported.

`Ctrl/Cmd+mouse wheel` over the preview steps zoom in/out using the same list as the toolbar buttons. After the stack rebuilds, a scroll anchor keeps the point under the cursor in place. Wheel zoom is ignored during signature placement and while a modal is open. Ctrl/Cmd+wheel is `preventDefault`ed in `src/shortcuts.js`, so the shortcut never scales the whole UI.

**Render queue**: all page rasterization (preview and thumbnails) goes through `scheduleRender()` in `src/renderer.js`. Preview pages run before thumbnails, nearest to `focusedPage` first, two at a time, and a request whose page has scrolled away before its turn is dropped. Thumbnails (`src/sidebar.js`) are rendered only when they scroll near the sidebar viewport; until then each is a blank placeholder with a typical page shape.

### Find

`src/search.js` implements case-insensitive substring search over the composed `appState.pages` list (not the original file’s page numbers). `Ctrl/Cmd+F` opens `#find-bar` above the preview; Escape closes it first (before placement-cancel / deselect). Enter / Shift+Enter and the ↑/↓ buttons move next/prev and wrap. Extraction is incremental and debounced (200ms); status shows `3 of …` until every page has been walked, then `3 of 12` or `No matches`. Blank pages are skipped. Hits are remapped by re-running the query when `pages` / `filePath` change, and when the redaction set changes. Hits that overlap a redaction are omitted. Highlights (`find-match` / `find-match-current`) are applied only on pages that already have a text layer; jumping to an off-screen hit waits for lazy paint. This is a find-session overlay — it is not written to the PDF on save.

### Dirty state

`dirty` is set on page/signature/annotation edits. Opening another file or closing the current file prompts in the renderer (`window.confirm`). Closing the window prompts in the shell: the renderer calls `setDirty` on every dirty change, and the `CloseRequested` window event shows a native dialog when the dirty flag is set.

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
| `src/store.js` | Signature library persistence (through `window.nativeAPI` store calls) |
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

Design notes (not implemented):

- `feature-forms-plan.md` — implementation plan for AcroForm field filling (the `todos.md` "add js form filling features" item)

Open product ideas (not designed, not implemented) live in `todos.md`: annotation-style drawing/text entry, a settings gear.

### Build output

Tauri config is in `src-tauri/tauri.conf.json` (product name, identifier, icons, NSIS target, and a `.pdf` `fileAssociations` entry). Only the Windows NSIS installer is configured; macOS and Linux bundles are not set up. The installer lands in `src-tauri/target/release/bundle/nsis/`. `src-tauri/target/` and `src-tauri/frontend-dist/` are build output and git-ignored.
