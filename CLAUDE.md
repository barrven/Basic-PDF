# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # launch the Electron app (alias: npm run dev)
npm run build      # package with electron-builder → dist/
```

There is no test suite and no linter configured.

## Architecture

This is a vanilla-JS Electron desktop app with no bundler and no frontend framework. All browser-side code uses native ES modules loaded directly from `node_modules` paths.

### Process boundary

**Main process** (`electron/main.js`) owns all native OS access: file open/save dialogs, filesystem reads/writes, right-click context menus, and persistent settings via `electron-store`. It exposes exactly seven IPC handlers.

**Preload** (`electron/preload.js`) bridges them into `window.electronAPI` via `contextBridge` so the renderer can never touch Node.

### Renderer architecture

`src/main.js` is the entry point. It boots all modules and subscribes a single `render()` function to the state store. The render function diffs the previous and current state to decide which sub-renders to call — it is the only place that drives UI updates.

**State** (`src/state.js`) is a single `appState` object mutated only through `dispatch(action)`. Subscribers are notified after every dispatch. Undo/redo snapshots only `pages` and `signatures` (not zoom, selection, etc.), capped at 50 entries.

**Two-library PDF model**: The app uses two separate PDF libraries with distinct roles:
- **pdf.js** (`src/renderer.js`) — renders pages to `<canvas>` for display only. Each loaded file is keyed by a `sourceId` in a module-level `Map`.
- **pdf-lib** (`src/pdf-engine.js`) — assembles the output document at save time. `buildOutputDoc()` copies pages from every source (by `sourceId`) into a fresh `PDFDocument`, applies rotations, and embeds signature images.

**Pages model**: `appState.pages` is an array of `{ sourceId, originalIndex, rotation }` entries. Inserting a PDF creates a new `sourceId`; the primary file always uses `PRIMARY_SOURCE_ID = 'primary'`. A blank page is represented by `originalIndex === -1`.

**Signatures** are stored as `{ id, pageIndex, x, y, width, height, opacity, dataUrl }` in `appState.signatures`. Coordinates are in pdf.js top-left space; `buildOutputDoc()` converts to pdf-lib bottom-left space when embedding. The saved library (persisted via `electron-store`) is capped at 20 entries in `src/store.js`.

### Module responsibilities

| File | Role |
|------|------|
| `src/state.js` | Central store, dispatch, pub/sub, undo/redo |
| `src/main.js` | Boot, render loop, toast, error modal |
| `src/renderer.js` | pdf.js wrapper — load sources, render pages to canvas |
| `src/pdf-engine.js` | pdf-lib wrapper — open, save, saveAs, close, `buildOutputDoc` |
| `src/toolbar.js` | Toolbar DOM, button wiring, zoom control |
| `src/sidebar.js` | Thumbnail list, drag-to-reorder, click selection, context menu |
| `src/preview.js` | Main canvas, signature overlay layer, drag/resize interactions |
| `src/signature.js` | Signature modal (draw/upload), placement mode, library popover |
| `src/store.js` | Signature library persistence (electron-store) |
| `src/shortcuts.js` | Global keyboard shortcuts |

### Keyboard shortcuts (implemented in `src/shortcuts.js`)

`Ctrl/Cmd+O` open, `Ctrl/Cmd+S` save, `Ctrl/Cmd+Shift+S` save as, `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` / `Ctrl/Cmd+Y` redo, `[` rotate left, `]` rotate right, `Ctrl/Cmd+A` select all, `Delete/Backspace` delete selected pages or signature, `Escape` cancel placement / deselect.

### Build output

`electron-builder` config is in `.electron-builder.yml`. Targets: NSIS (Windows), DMG (macOS), AppImage (Linux). Built app lands in `dist/`.
