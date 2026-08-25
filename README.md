# Basic PDF

A lightweight desktop PDF editor built with Electron — no bundler, no frontend framework, just vanilla JS and native ES modules.

## Features

- Open, edit, save, and close PDF files
- Open a PDF by double-clicking it when Basic PDF is the default reader (each launch is its own window)
- Continuous-scroll preview of all pages (fit-to-width or stepped zoom 50–200%)
- Zoom the preview with the toolbar or Ctrl/Cmd+mouse wheel (around the cursor)
- Select and copy text from pages
- Highlight selected text (Ctrl/Cmd+H) or redact it; both are written on save
- Find in document (Ctrl/Cmd+F) with match count, next/previous, and on-page highlights
- Reorder pages by dragging thumbnails
- Rotate, insert, duplicate, and delete pages
- Insert blank pages (thumbnail context menu) or pages from other PDFs
- Source page rotation is preserved on open, insert, and save
- Draw or upload signatures (PNG, JPEG, or WebP) and place them on any page
- Drag and resize placed signatures (aspect ratio locked)
- Reusable signature library (up to 20 saved signatures; entries can be deleted)
- Light, dark, or system display mode (default follows the OS)
- About dialog from the app name in the title bar
- Undo/redo (up to 50 steps)
- Prompt before discarding unsaved changes, including when closing the window
- Keyboard shortcuts for common actions

## Getting started

```bash
npm install
npm start       # launch the app (alias: npm run dev)
```

## Building

```bash
npm run build   # package with electron-builder → dist/
npm run audit   # npm audit --audit-level=high
```

Build targets and the `.pdf` file association are configured in `.electron-builder.yml`: NSIS (Windows), DMG (macOS), and AppImage (Linux). The installed app and Start menu shortcut are named **Basic PDF**. `npm run build` passes `--config .electron-builder.yml` so that file is used instead of the empty `"build"` field in `package.json`.

CI runs `npm audit --audit-level=high` on push, pull request, and a weekly schedule (`.github/workflows/security.yml`).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd+O` | Open |
| `Ctrl/Cmd+S` | Save |
| `Ctrl/Cmd+Shift+S` | Save as |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Shift+Z` / `Ctrl/Cmd+Y` | Redo |
| `Ctrl/Cmd+F` | Find in document |
| `[` / `]` | Rotate page left / right |
| `Ctrl/Cmd+A` | Select all text on the current page if a text selection is active; otherwise select all pages |
| `Delete` / `Backspace` | Delete selected pages or signature (ignored while a text selection is active) |
| `ArrowUp` / `ArrowDown` | Previous / next page |
| `PageUp` / `PageDown` | Scroll the preview by about one viewport |
| `Ctrl/Cmd+mouse wheel` | Zoom the preview in / out |
| `Escape` | Close find bar, then popovers/modals; cancel signature placement; deselect |

In the find bar, Enter goes to the next match and Shift+Enter to the previous. Matches wrap at the ends.

Right-click a thumbnail for delete, rotate, duplicate, and insert blank page.

## Architecture

The app is split across Electron's process boundary:

- **Main process** (`electron/main.js`) owns native OS access — file dialogs, filesystem I/O, context menus, persistent settings (via `electron-store`), display theme, app info for the About dialog, and the PDF path the OS passes when the app is launched as the default reader. It also prompts on window close if the renderer has unsaved changes. Multiple instances are allowed.
- **Preload** (`electron/preload.js`) bridges those handlers into `window.electronAPI` via `contextBridge`, so the renderer never touches Node directly.
- **Renderer** (`src/`) uses two PDF libraries with distinct roles:
  - [pdf.js](https://mozilla.github.io/pdf.js/) renders pages to `<canvas>` for on-screen display and builds a text layer for select, copy, and find.
  - [pdf-lib](https://pdf-lib.js.org/) assembles the final output document at save time — copying pages, applying rotations, and embedding signatures.

State lives in a single store (`src/state.js`) mutated only through `dispatch(action)`, with a single `render()` function in `src/main.js` reacting to changes.

See `CLAUDE.md` for a full module-by-module breakdown. Text-layer and find details are in `feature-select-text.md` and `feature-search-text.md`.

## License

MIT © 2026 barrven
