# Basic PDF

A lightweight desktop PDF editor built with Electron — no bundler, no frontend framework, just vanilla JS and native ES modules.

## Features

- Open, edit, save, and close PDF files
- Open a PDF by double-clicking it when Basic PDF is the default reader (each launch is its own window)
- Continuous-scroll preview of all pages (fit-to-width or stepped zoom)
- Zoom the preview with the toolbar or Ctrl/Cmd+mouse wheel (around the cursor)
- Reorder pages by dragging thumbnails
- Rotate, insert, duplicate, and delete pages
- Insert blank pages or pages from other PDFs
- Source page rotation is preserved on open, insert, and save
- Draw or upload signatures (PNG, JPEG, or WebP) and place them on any page
- Reusable signature library (up to 20 saved signatures)
- Undo/redo (up to 50 steps)
- Prompt before discarding unsaved changes
- Keyboard shortcuts for common actions

## Getting started

```bash
npm install
npm start       # launch the app (alias: npm run dev)
```

## Building

```bash
npm run build   # package with electron-builder → dist/
```

Build targets and the `.pdf` file association are configured in `.electron-builder.yml`: NSIS (Windows), DMG (macOS), and AppImage (Linux). The installed app and Start menu shortcut are named **Basic PDF**. `npm run build` passes `--config .electron-builder.yml` so that file is used instead of the empty `"build"` field in `package.json`.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+O` | Open |
| `Ctrl/Cmd+S` | Save |
| `Ctrl/Cmd+Shift+S` | Save as |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Shift+Z` / `Ctrl/Cmd+Y` | Redo |
| `[` / `]` | Rotate page left / right |
| `Ctrl/Cmd+A` | Select all pages |
| `Delete` / `Backspace` | Delete selected pages or signature |
| `ArrowUp` / `ArrowDown` | Previous / next page |
| `PageUp` / `PageDown` | Scroll the preview by about one viewport |
| `Ctrl/Cmd+mouse wheel` | Zoom the preview in / out |
| `Escape` | Cancel placement / deselect |

Right-click a thumbnail for delete, rotate, duplicate, and insert blank page.

## Architecture

The app is split across Electron's process boundary:

- **Main process** (`electron/main.js`) owns native OS access — file dialogs, filesystem I/O, context menus, persistent settings (via `electron-store`), and the PDF path the OS passes when the app is launched as the default reader — exposed through a small set of IPC handlers plus an `open-path` event. Multiple instances are allowed.
- **Preload** (`electron/preload.js`) bridges those handlers into `window.electronAPI` via `contextBridge`, so the renderer never touches Node directly.
- **Renderer** (`src/`) uses two PDF libraries with distinct roles:
  - [pdf.js](https://mozilla.github.io/pdf.js/) renders pages to `<canvas>` for on-screen display.
  - [pdf-lib](https://pdf-lib.js.org/) assembles the final output document at save time — copying pages, applying rotations, and embedding signatures.

State lives in a single store (`src/state.js`) mutated only through `dispatch(action)`, with a single `render()` function in `src/main.js` reacting to changes.

See `CLAUDE.md` for a full module-by-module breakdown.

## License

No license specified.
