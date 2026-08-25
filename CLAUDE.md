# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # launch the Electron app (alias: npm run dev)
npm run build      # package with electron-builder --config .electron-builder.yml → dist/
```

There is no test suite and no linter configured.

### App name

The visible name is **Basic PDF** (`productName` in `package.json` and `.electron-builder.yml`). That is what the window, installer, and Start menu shortcut use.

`package.json` `"name"` must stay a valid npm package id (`basic-pdf`: lowercase, no spaces). Putting `"Basic PDF"` there makes `electron-builder` fail. Do not change `"name"` to the display name.

## Architecture

This is a vanilla-JS Electron desktop app with no bundler and no frontend framework. All browser-side code uses native ES modules loaded directly from `node_modules` paths.

### Process boundary

**Main process** (`electron/main.js`) owns all native OS access: file open/save dialogs, filesystem reads/writes, right-click context menus, persistent settings via `electron-store`, OS-level "open this PDF", and the display theme (`nativeTheme.themeSource`). It exposes nine invoke handlers (`open-file`, `open-file-bytes`, `save-file`, `save-file-as`, `show-context-menu`, `store-get`, `store-set`, `get-theme`, `set-theme`) plus one-way `open-path` and `theme-updated` events to the renderer. Theme preference is `'system'` (default, follows the OS), `'light'`, or `'dark'`. Window `backgroundColor` and `titleBarOverlay` colors track the resolved appearance.

Windows Default Apps launches a new process with the PDF as an argv entry (`[exe, file.pdf]` packaged, `[electron, ., file.pdf]` in dev). macOS uses the `open-file` event, which can fire before `ready`. The path is queued until `did-finish-load`, then sent to the renderer. There is no single-instance lock — each launch gets its own window.

**Preload** (`electron/preload.js`) bridges the invoke handlers into `window.electronAPI` via `contextBridge` so the renderer can never touch Node, and buffers `open-path` until `onOpenPath` is registered.

### Renderer architecture

`src/main.js` is the entry point. It boots all modules and subscribes a single `render()` function to the state store. The render function diffs the previous and current state to decide which sub-renders to call — it is the only place that drives UI updates.

- `pages` / `zoom` / `filePath` changes rebuild the preview stack (`renderPreview()`).
- `focusedPage` alone scrolls the existing stack (`scrollPreviewToFocused()`); it does not re-rasterize canvases.
- `signatures` / `selectedSig` changes only refresh overlay DOM.

**State** (`src/state.js`) is a single `appState` object mutated only through `dispatch(action)`. Subscribers are notified after every dispatch. Undo/redo snapshots only `pages` and `signatures` (not zoom, selection, loading, etc.), capped at 50 entries. `loading` is set while a PDF is opened or inserted; a workspace overlay spinner stays up until the preview stack has been laid out.

**Two-library PDF model**: The app uses two separate PDF libraries with distinct roles:
- **pdf.js** (`src/renderer.js`) — renders pages to `<canvas>` for display only. Each loaded file is keyed by a `sourceId` in a module-level `Map`.
- **pdf-lib** (`src/pdf-engine.js`) — assembles the output document at save time. `buildOutputDoc()` copies pages from every source (by `sourceId`) into a fresh `PDFDocument`, applies rotations (always, including 0), and embeds signature images.

**Pages model**: `appState.pages` is an array of `{ id, sourceId, originalIndex, rotation }` entries created via `createPageEntry()`. `id` is a UUID used to remap signatures, selection, and focus when pages are reordered, inserted, duplicated, or deleted. Inserting a PDF creates a new `sourceId`; the primary file always uses `PRIMARY_SOURCE_ID = 'primary'`. A blank page is represented by `originalIndex === -1`. `rotation` is the absolute display/save angle (0/90/180/270), seeded from the source page's `/Rotate` on open or insert — not an additive delta.

**Signatures** are stored as `{ id, pageIndex, x, y, width, height, opacity, dataUrl }` in `appState.signatures`. Coordinates are in pdf.js visual top-left space for the page at its current rotation. `buildOutputDoc()` converts those into pdf-lib's unrotated media-box space (and rotates the image) when embedding. `SET_PAGE_ORDER` / `INSERT_PAGES` remap `pageIndex` by page `id` so stamps follow the page they were placed on. The saved library (persisted via `electron-store`) is capped at 20 entries in `src/store.js`. WebP uploads are rasterized to PNG before save.

### Preview

The preview pane (`#preview-pane`) is a continuous vertical stack of `.preview-page` nodes (canvas + per-page signature overlay), not a single-page canvas. Pages are measured, laid out, then rasterized lazily with `IntersectionObserver` (`src/preview.js`). Fit-to-width (`zoom === null`) scales each page to the pane width; numeric zoom uses a shared `%` scale from `src/zoom.js` (steps 50–200). Scrolling updates `focusedPage` (and single-page selection) from whichever page sits near the top of the viewport. Thumbnail clicks and arrow keys scroll that page into view.

`Ctrl/Cmd+mouse wheel` over the preview steps zoom in/out using the same list as the toolbar buttons. After the stack rebuilds, a scroll anchor keeps the point under the cursor in place. Wheel zoom is ignored during signature placement and while a modal is open. Chromium visual zoom is locked at 100% (`webContents.setVisualZoomLevelLimits(1, 1)` in `electron/main.js`) and Ctrl/Cmd+wheel is `preventDefault`ed in `src/shortcuts.js`, so the shortcut never scales the whole UI.

### Dirty state

`dirty` is set on page/signature edits. Opening another file, closing the current file, or closing the window prompts when unsaved changes exist.

### Module responsibilities

| File | Role |
|------|------|
| `src/state.js` | Central store, dispatch, pub/sub, undo/redo, page ids, signature remapping |
| `src/main.js` | Boot, render loop, toast, error modal, document-loading overlay, unsaved `beforeunload`, OS file-open hookup |
| `src/renderer.js` | pdf.js wrapper — load/clear sources, page fetch, blank-page helper |
| `src/pdf-engine.js` | pdf-lib wrapper — open, save, saveAs, close, OS `openPath`, `buildOutputDoc` |
| `src/toolbar.js` | Toolbar DOM, button wiring, zoom, add/insert/delete/rotate |
| `src/zoom.js` | Shared zoom step list (50–200%) and `snapZoom()` used by toolbar and wheel zoom |
| `src/sidebar.js` | Thumbnail list, drag-to-reorder, click selection, context menu |
| `src/preview.js` | Continuous-scroll page stack, lazy canvas render, signature overlays, Ctrl/Cmd+wheel zoom |
| `src/signature.js` | Signature modal (draw/upload), placement mode, library popover |
| `src/store.js` | Signature library persistence (electron-store) |
| `src/theme.js` | Display mode (system / light / dark), title-bar popover, `data-theme` on `<html>` |
| `src/shortcuts.js` | Global keyboard shortcuts |

### Keyboard shortcuts (implemented in `src/shortcuts.js`; Ctrl/Cmd+wheel zoom is in `src/preview.js`)

`Ctrl/Cmd+O` open, `Ctrl/Cmd+S` save, `Ctrl/Cmd+Shift+S` save as, `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` / `Ctrl/Cmd+Y` redo, `[` rotate left, `]` rotate right, `Ctrl/Cmd+A` select all, `Delete/Backspace` delete selected pages or signature, `ArrowUp` / `ArrowDown` previous/next page, `PageUp` / `PageDown` scroll the preview by about one viewport, `Ctrl/Cmd+mouse wheel` zoom the preview in / out, `Escape` cancel placement / deselect.

### Planned features

Design notes (not implemented):

- `feature-select-text.md` — select-and-copy via a pdf.js text layer over each preview canvas
- `feature-search-text.md` — Ctrl/Cmd+F find-in-page on that same text layer

### Build output

`electron-builder` config is in `.electron-builder.yml` (file list, icons, NSIS names, and a `.pdf` `fileAssociations` entry). `npm run build` must pass `--config .electron-builder.yml` because `package.json` has an empty `"build": {}` that electron-builder would otherwise treat as the whole config. Targets: NSIS (Windows), DMG (macOS), AppImage (Linux). Built app lands in `dist/`.
