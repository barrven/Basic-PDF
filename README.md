# Basic PDF

A lightweight desktop PDF editor built with Tauri (Rust + the system WebView) — no bundler, no frontend framework, just vanilla JS and native ES modules.

## Features

- Open, edit, save, and close PDF files
- Open a PDF by double-clicking it when Basic PDF is the default reader (each launch is its own window)
- Continuous-scroll preview of all pages (fit-to-width or stepped zoom 50–200%)
- Stays responsive on large PDFs: pages and thumbnails are rendered on demand, nearest the view first
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

Requires Rust (stable, MSVC target) and the Visual Studio C++ Build Tools; see `src-tauri/README.md`.

## Building

```bash
npm run build   # NSIS installer → src-tauri/target/release/bundle/nsis/
npm run audit   # npm audit --audit-level=high
```

The build target and the `.pdf` file association are configured in `src-tauri/tauri.conf.json`. Only the Windows NSIS installer is set up. The installed app and Start menu shortcut are named **Basic PDF**.

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
| `Ctrl/Cmd+H` | Highlight the selected text |
| `[` / `]` | Rotate page left / right |
| `Ctrl/Cmd+A` | Select all text on the current page if a text selection is active; otherwise select all pages |
| `Delete` / `Backspace` | Delete the selected redaction, signature, or pages (ignored while a text selection is active) |
| `ArrowUp` / `ArrowDown` | Previous / next page |
| `PageUp` / `PageDown` | Scroll the preview by about one viewport |
| `Ctrl/Cmd+mouse wheel` | Zoom the preview in / out |
| `Escape` | Close the find bar, then the highlight/redact popover, then other popovers and the About dialog; then cancel signature placement or deselect |

In the find bar, Enter goes to the next match and Shift+Enter to the previous. Matches wrap at the ends.

Right-click a thumbnail for delete, rotate, duplicate, and insert blank page.

Select text on a page to get the Highlight / Redact popover. A redacted page is saved as an image, so the covered text cannot be recovered from the file.

## Architecture

The app is split between a Rust shell and a web renderer:

- **Shell** (`src-tauri/src/lib.rs`) owns native OS access — file dialogs, filesystem I/O, context menus, persistent settings (a JSON file in the app config folder), display theme, app info for the About dialog, and the PDF path the OS passes when the app is launched as the default reader. It also prompts on window close if the renderer has unsaved changes. Multiple instances are allowed.
- **Bridge** (`src-tauri/src/bridge.js`) is injected before any page script and exposes those commands as `window.nativeAPI`, the renderer's only route to the OS. It also draws the window's minimize / maximize / close buttons.
- **Renderer** (`src/`) uses two PDF libraries with distinct roles:
  - [pdf.js](https://mozilla.github.io/pdf.js/) renders pages to `<canvas>` for on-screen display and builds a text layer for select, copy, and find.
  - [pdf-lib](https://pdf-lib.js.org/) assembles the final output document at save time — copying pages, applying rotations, drawing highlights, flattening redacted pages to images, and embedding signatures.

State lives in a single store (`src/state.js`) mutated only through `dispatch(action)`, with a single `render()` function in `src/main.js` reacting to changes.

The renderer has no bundler. Before each run or build, `src-tauri/scripts/assemble-frontend.mjs` copies it, with only the pdf.js and pdf-lib files it needs, into the folder Tauri serves.

See `CLAUDE.md` for a full module-by-module breakdown and `src-tauri/README.md` for the shell. `features/features.md` is the functional specification; text-layer, find, and highlight/redaction details are in `features/feature-select-text.md`, `features/feature-search-text.md`, and `features/feature-annotate.md`.

## License

MIT © 2026 barrven
