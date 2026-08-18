# PDF Editor

A lightweight desktop PDF editor built with Electron — no bundler, no frontend framework, just vanilla JS and native ES modules.

## Features

- Open, edit, and save PDF files
- Reorder, rotate, insert, and delete pages
- Insert blank pages or pages from other PDFs
- Draw or upload signatures and place them on pages, with a reusable signature library
- Undo/redo (up to 50 steps)
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

Build targets are configured in `.electron-builder.yml`: NSIS (Windows), DMG (macOS), and AppImage (Linux).

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
| `Escape` | Cancel placement / deselect |

## Architecture

The app is split across Electron's process boundary:

- **Main process** (`electron/main.js`) owns native OS access — file dialogs, filesystem I/O, context menus, and persistent settings (via `electron-store`) — exposed through a small set of IPC handlers.
- **Preload** (`electron/preload.js`) bridges those handlers into `window.electronAPI` via `contextBridge`, so the renderer never touches Node directly.
- **Renderer** (`src/`) uses two PDF libraries with distinct roles:
  - [pdf.js](https://mozilla.github.io/pdf.js/) renders pages to `<canvas>` for on-screen display.
  - [pdf-lib](https://pdf-lib.js.org/) assembles the final output document at save time — copying pages, applying rotations, and embedding signatures.

State lives in a single store (`src/state.js`) mutated only through `dispatch(action)`, with a single `render()` function in `src/main.js` reacting to changes.

See `CLAUDE.md` for a full module-by-module breakdown.

## License

No license specified.
