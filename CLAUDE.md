# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Branch workflow

All new work (features, fixes, docs, tests) goes on the `dev` branch. Never commit to `master` directly, and never create other long-lived branches. Merge `dev` into `master` only when the user explicitly says to. If `dev` does not exist, create it from `master`; if you are on `master`, switch to `dev` before editing.

## Commands

```bash
npm start          # launch the app with `tauri dev` (alias: npm run dev)
npm run build      # `tauri build`: NSIS installer → src-tauri/target/release/bundle/nsis/
npm run audit      # npm audit --audit-level=high
```

Building needs Rust (stable, `x86_64-pc-windows-msvc`) and the Visual Studio C++ Build Tools with a Windows SDK. The Tauri CLI is a dev dependency. See `src-tauri/README.md`.

There is no linter configured. Tests:

```bash
npm test             # renderer regression suite in test/ (node:test, Node 26+)
npm run test:rust    # signing code: cargo test --lib in src-tauri
```

`.github/workflows/test.yml` runs both on push and pull request; `.github/workflows/security.yml` runs `npm audit --audit-level=high` on push, pull request, and weekly (Monday 08:00 UTC). See the Tests section below and `test/README.md`.

### App name and version

The visible name is **Basic PDF** (`productName` in `package.json` and `src-tauri/tauri.conf.json`). That is what the window, installer, and Start menu shortcut use.

`package.json` `"name"` must stay a valid npm package id (`basic-pdf`: lowercase, no spaces). Do not change `"name"` to the display name.

The version (currently 3.1.0) is repeated in four places that must be bumped together: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the fallback in `src/about.js`. The About dialog shows the version the shell reports (`get_app_info`, from `tauri.conf.json`); the `src/about.js` value is used only if that call fails. The installer file name carries it too (`Basic PDF_3.1.0_x64-setup.exe`).

## Architecture

This is a Tauri desktop app (Rust shell, system WebView2) with a vanilla-JS renderer: no bundler and no frontend framework. All browser-side code uses native ES modules that import pdf.js and pdf-lib from `../node_modules/` paths.

### Shell boundary

**Shell** (`src-tauri/src/lib.rs`) owns all native OS access: file open/save dialogs, filesystem reads/writes, right-click context menus, persistent settings, OS-level "open this PDF", display theme, About-dialog app info, the frameless window's minimize / maximize / close / drag commands, and the unsaved-changes prompt when closing the window. It exposes Tauri commands (`pick_open_file`, `pick_save_path`, `read_file_bytes`, `save_file`, `show_context_menu`, `store_get`, `store_set`, `set_dirty`, `get_theme`, `set_theme`, `get_app_info`, `take_pending_open_path`, `reveal_in_folder`, `open_url`, `prompt_unsaved`, `confirm_action`, the signing commands `list_identities` / `import_identity` / `generate_self_signed_identity` / `remove_identity` / `sign_pdf` (in `src-tauri/src/signing.rs`), and five `window_*` commands) and emits a `theme-updated` event to the renderer. PDF bytes cross the boundary as raw binary, not JSON: `read_file_bytes` returns a raw response, and `save_file` takes a raw body with the destination path in the `x-path` header. Theme preference is `'system'` (default, follows the OS), `'light'`, or `'dark'`. Settings are a JSON file, `basic-pdf.json`, in the app config folder (`%APPDATA%/com.barrven.basic-pdf`). Open / Save As dialogs use `lastDir` from that file (the folder of the last file the app opened or saved); if that folder is gone, the dialog uses the OS default.

Windows Default Apps launches a new process with the PDF as an argument. The shell keeps that path until the renderer registers `onOpenPath`, which pulls it with `take_pending_open_path`. There is no single-instance lock — each launch gets its own window.

Hardening: the renderer has no Node or filesystem access, only the commands above; the capability file (`src-tauri/capabilities/default.json`) grants only `core:event:default`; `on_navigation` keeps the window on the app's own origin (`tauri.localhost`, plus the dev server's address under `tauri dev`). `index.html` ships a strict CSP (`default-src 'none'`, `script-src 'self' 'wasm-unsafe-eval'` for pdf.js WASM, `worker-src 'self' blob:` for the pdf.js worker). The only network access it allows is Google Fonts (`fonts.googleapis.com` / `fonts.gstatic.com`), which `index.html` loads for DM Sans and DM Mono; without a connection the UI falls back to system fonts.

**Bridge** (`src-tauri/src/bridge.js`) is injected as an initialization script before any page script. It defines `window.nativeAPI` (`openFile`, `openFileBytes`, `saveFile`, `saveFileAs`, `showContextMenu`, `getStoreValue`, `setStoreValue`, `setDirty`, `getAppInfo`, `getTheme`, `setTheme`, `onThemeUpdated`, `onOpenPath`, `revealInFolder`, `openExternal`, `promptUnsaved`, `confirm`, `listIdentities`, `importIdentity`, `generateSelfSignedIdentity`, `removeIdentity`, `signPdf`) on top of Tauri's `invoke`, which is the renderer's only route to the OS. It also builds the caption buttons inside `#window-controls-spacer` and handles title-bar drag and double-click-to-maximize, because the window is frameless.

**Frontend assembly** (`src-tauri/scripts/assemble-frontend.mjs`) runs before `tauri dev` and `tauri build`. It copies `index.html`, `icon.png`, `src/`, and only the needed pdf.js / pdf-lib files into `src-tauri/frontend-dist/` (git-ignored), rewrites `../node_modules/` to `../vendor/` in the copied JS, and widens the copied CSP's `connect-src` for Tauri IPC. The sources are never modified. `tauri dev` serves that folder from a local dev server (normally `http://127.0.0.1:1430`), and a built app serves it from `tauri.localhost`. Edits to `src/` or `index.html` only reach the app after `npm start` is re-run; edits under `src-tauri/` rebuild and relaunch automatically while `npm start` is running. If the renderer imports a new library file, add it to `COPIES` in that script.

### Renderer architecture

`src/main.js` is the entry point. It boots all modules and subscribes a single `render()` function to the state store. The render function diffs the previous and current state to decide which sub-renders to call — it is the only place that drives UI updates.

- `pages` / `filePath` changes rebuild thumbnails and re-run an open find query (`onSearchDocumentChanged()`). Find also re-runs when the redaction set changes.
- `pages` / `zoom` / `filePath` changes rebuild the preview stack (`renderPreview()`).
- `focusedPage` alone scrolls the existing stack (`scrollPreviewToFocused()`); it does not re-rasterize canvases.
- `signatures` / `selectedSig` changes only refresh stamp overlay DOM.
- `annotations` / `selectedAnnotation` changes only refresh highlight/redact overlay DOM.

**State** (`src/state.js`) is a single `appState` object mutated only through `dispatch(action)`. Subscribers are notified after every dispatch. Undo/redo snapshots only `pages`, `signatures`, `annotations`, and `fieldValues` (not zoom, selection, loading, etc.), capped at 50 entries. `loading` is set while a PDF is opened or inserted; a workspace overlay spinner stays up until the preview stack has been laid out. The sidebar width is the one piece of UI state kept in `localStorage` (`sidebarWidth`) rather than in the shell's settings file.

**Two-library PDF model**: The app uses two separate PDF libraries with distinct roles:
- **pdf.js** (`src/renderer.js`) — renders pages to `<canvas>` for display, extracts `getTextContent()` (cached by `sourceId` + `originalIndex`), and supplies the viewport used by the text layer. Each loaded file is keyed by a `sourceId` in a module-level `Map`. Documents are opened with `cMapUrl` and `standardFontDataUrl` (`useWorkerFetch: false`, so they are fetched on the main thread).
- **pdf-lib** (`src/pdf-engine.js`) — assembles the output document at save time. `buildOutputDoc()` copies pages from every source (by `sourceId`) into a fresh `PDFDocument`, applies rotations (always, including 0), draws highlight rectangles (`BlendMode.Multiply`), embeds signature images, and flattens pages that have redactions to a PNG so the covered text is not extractable.

**Pages model**: `appState.pages` is an array of `{ id, sourceId, originalIndex, rotation }` entries created via `createPageEntry()`. `id` is a UUID used to remap signatures, selection, and focus when pages are reordered, inserted, duplicated, or deleted. Inserting a PDF creates a new `sourceId`; the primary file always uses `PRIMARY_SOURCE_ID = 'primary'`. A blank page is represented by `originalIndex === -1`. `rotation` is the absolute display/save angle (0/90/180/270), seeded from the source page's `/Rotate` on open or insert — not an additive delta.

The toolbar "Add page" button is commented out; blank pages are still available from the thumbnail context menu (`Insert blank page after`).

**Signatures** are stored as `{ id, pageIndex, x, y, width, height, opacity, dataUrl }` in `appState.signatures`, plus `digital: true, identityId, signerLabel` when the stamp should also carry a cryptographic signature (at most one per document; `buildOutputBytes()` in `src/pdf-engine.js` reserves the placeholder and calls `signPdf` last). Coordinates are in pdf.js visual top-left space for the page at its current rotation. `buildOutputDoc()` converts those into pdf-lib's unrotated media-box space (and rotates the image) when embedding. `SET_PAGE_ORDER` / `INSERT_PAGES` remap `pageIndex` by page `id` so stamps follow the page they were placed on. Placed stamps can be dragged and resized with eight handles (aspect ratio locked, min 20pt). `opacity` is always 1: preview and save honor the field, but there is no control that changes it. The saved library (persisted in the shell's settings file) is capped at 20 entries in `src/store.js`; entries can be removed from the library popover. WebP uploads are rasterized to PNG before save.

**Annotations** (`appState.annotations`) are `{ id, type, pageIndex, rects, color }` with `type` `'highlight'` or `'redact'`. Drawn markup (`src/markup.js`) uses the same array with `type` `'text' | 'rect' | 'ellipse' | 'line' | 'draw'` and its own geometry fields (`x/y/width/height`, `x1..y2`, `points`, `text`, `color`, `strokeWidth`) instead of `rects`; never assume `rects` exists. Rects use the same visual top-left space as stamps. Select text to show `#annotate-popover` (`src/annotate.js`); `Ctrl/Cmd+H` highlights. Highlights sit under the text layer; redactions sit above it and block select/copy. On save, highlights are multiply-blend rectangles; a page with any redaction is rasterized (isolated pdf.js document at 2×, long edge capped at 3000px) so the covered glyphs are not in the output. The text that is not under a box is put back as invisible text (render mode 3, Helvetica, positioned from pdf.js `getTextContent()`, items trimmed per character around the boxes), so the rest of the page stays searchable and selectable after reopening. `SET_PAGE_ORDER` / `INSERT_PAGES` remap annotation `pageIndex` by page `id`.

### Preview

The preview pane (`#preview-pane`) is a continuous vertical stack of `.preview-page` nodes (canvas + highlight overlay + pdf.js `TextLayer` + redaction overlay + signature overlay), not a single-page canvas. Stack order is canvas, then `.annot-highlight-layer`, then `.textLayer`, then `.annot-redact-layer`, then `.annot-form-layer` (fillable form widgets, push buttons, and clickable Link annotations, which are scanned on every non-blank page, form or not), then `.markup-layer` (drawn markup SVG), then `.signature-overlay-layer`. Pages are measured, laid out, then rasterized lazily with `IntersectionObserver` (`src/preview.js`). A page canvas gets its backing store only when it is rasterized, and pages far from the viewport are freed again (canvas and text layer; at most 12 rendered pages are kept outside the observer margin) and re-render when scrolled back to. Fit-to-width (`zoom === null`) scales each page to the pane width; numeric zoom uses a shared `%` scale from `src/zoom.js` (steps 50–200). Scrolling updates `focusedPage` (and single-page selection) from whichever page sits near the top of the viewport. Thumbnail clicks and arrow keys scroll that page into view.

The text layer is built only for visible (or near-viewport) non-blank pages after the canvas paints, using the cached `getTextContent()` payload. It enables drag-select, copy, and find highlights. Pointer events on `.textLayer` are disabled during signature placement. Click-after-drag does not deselect a stamp. `Ctrl/Cmd+A` selects all text in the active layer when a text selection is already there; otherwise it selects all pages. Cross-page selection is not supported.

`Ctrl/Cmd+mouse wheel` over the preview steps zoom in/out using the same list as the toolbar buttons. After the stack rebuilds, a scroll anchor keeps the point under the cursor in place. Wheel zoom is ignored during signature placement and while a modal is open. Ctrl/Cmd+wheel is `preventDefault`ed in `src/shortcuts.js`, so the shortcut never scales the whole UI.

**Render queue**: all page rasterization (preview and thumbnails) goes through `scheduleRender()` in `src/renderer.js`. Preview pages run before thumbnails, nearest to `focusedPage` first, two at a time, and a request whose page has scrolled away before its turn is dropped. Thumbnails (`src/sidebar.js`) are rendered only when they scroll near the sidebar viewport; until then each is a blank placeholder with a typical page shape.

### Find

`src/search.js` implements case-insensitive substring search over the composed `appState.pages` list (not the original file’s page numbers). `Ctrl/Cmd+F` opens `#find-bar` above the preview; Escape closes it first (before placement-cancel / deselect). Enter / Shift+Enter and the ↑/↓ buttons move next/prev and wrap. Extraction is incremental and debounced (200ms); status shows `3 of …` until every page has been walked, then `3 of 12` or `No matches`. Blank pages are skipped. Hits are remapped by re-running the query when `pages` / `filePath` change, and when the redaction set changes. Hits that overlap a redaction are omitted. Highlights (`find-match` / `find-match-current`) are applied only on pages that already have a text layer; jumping to an off-screen hit waits for lazy paint. This is a find-session overlay — it is not written to the PDF on save.

### Dirty state

The renderer must not use `window.confirm`: `tauri-plugin-dialog` replaces it with an async version that returns a Promise (always truthy) and needs a capability this app does not grant. Use `nativeAPI.promptUnsaved` (Save / Don't save / Cancel) or `nativeAPI.confirm` instead.

`dirty` is set on page/signature/annotation/form edits. Opening another file or closing the current file prompts through `resolveUnsavedChanges()` in `src/pdf-engine.js` (`nativeAPI.promptUnsaved`: save, discard or cancel; a cancelled or failed save keeps the file open). Closing the window prompts in the shell: the renderer calls `setDirty` on every dirty change, and the `CloseRequested` window event shows a native dialog when the dirty flag is set.

### Module responsibilities

| File | Role |
|------|------|
| `src/state.js` | Central store, dispatch, pub/sub, undo/redo, page ids, signature/annotation remapping |
| `src/main.js` | Boot, render loop, toast, error modal, document-loading overlay, dirty sync to the shell, OS file-open hookup |
| `src/renderer.js` | pdf.js wrapper — load/clear sources, page fetch, text-content cache, CMap/standard-font URLs, blank-page helper, isolated docs for redaction flatten, the shared render queue (`scheduleRender`) |
| `src/pdf-engine.js` | pdf-lib wrapper — open, save, saveAs, close, OS `openPath`, `buildOutputDoc` (highlights, redaction flatten, stamps) |
| `src/menubar.js` | Title-bar File / Edit / Help dropdown menus (open, save, undo/redo, find, page ops, About) |
| `src/toolbar.js` | Toolbar (Markup toggle, page counter, zoom), expandable markup ribbon (placeholder tools + Signature), insert/delete/rotate helpers |
| `src/markup.js` | Markup tools from the ribbon: text, rectangle, ellipse, line, freehand. Highlight / Redact buttons leave any drawing tool and arm text-selection mode (applies to the next selection; Esc or a second click cancels). Pointer drawing, text editor, SVG `.markup-layer` per page, click-to-select |
| `src/markup-save.js` | Draws markup annotations into the saved PDF (pdf-lib, rotation-aware) and onto redaction-flattened pages (canvas) |
| `src/forms.js` | Fillable AcroForm widgets (text, checkbox, radio, dropdown, list): detection, DOM controls, edits into `appState.fieldValues`, values for redaction-flattened pages |
| `src/form-actions.js` | Push-button actions (GoTo, Named, URI after a confirm, ResetForm) and `AFSimple_Calculate` recalculation. No PDF JavaScript engine: scripts are never run; Hide/Show/Submit buttons are unsupported and show a toast |
| `src/forms-save.js` | pdf-lib side of forms: write values into the source doc, strip widget `/P`, rebuild `/AcroForm` |
| `src/pdf-signature.js` | `/Sig` placeholder + signature field for the shell to fill; detects already-signed PDFs |
| `src/identities.js` | Signing identities UI (list, create self-signed, import PFX) and the per-stamp "also sign cryptographically" choice |
| `src/zoom.js` | Shared zoom step list (50–200%) and `snapZoom()` used by toolbar and wheel zoom |
| `src/outline.js` | Sidebar Pages / Outline switch. Outline uses the PDF's bookmarks, else headings detected from text size; click jumps to the page, current section follows scrolling |
| `src/sidebar.js` | Thumbnail list (rendered lazily through the render queue), drag-to-reorder, click selection, context menu, resizable width |
| `src/preview.js` | Continuous-scroll page stack, lazy canvas + text-layer render and freeing of distant pages, signature/annotation overlays, Ctrl/Cmd+wheel zoom, find highlights |
| `src/search.js` | Find bar, incremental walker over composed pages, next/prev, highlight coordination |
| `src/annotate.js` | Selection popover, highlight/redact create/remove, selection→rect conversion, find/redaction overlap |
| `src/signature.js` | Signature modal (draw/upload), placement mode, library popover (including delete) |
| `src/store.js` | Signature library persistence (through `window.nativeAPI` store calls) |
| `src/theme.js` | Display mode (system / light / dark), title-bar popover, `data-theme` on `<html>` |
| `src/about.js` | About modal, opened from Help → About (`nativeAPI.getAppInfo()`) |
| `src/shortcuts.js` | Global keyboard shortcuts |
| `src-tauri/src/lib.rs` | Rust shell: Tauri commands, settings file, context menu, theme, frameless-window commands, close prompt |
| `src-tauri/src/signing.rs` | Identities (DPAPI-protected), CMS/CAdES signing, `/ByteRange` + `/Contents` patching, unit tests (`cargo test --lib`) |
| `src-tauri/src/bridge.js` | `window.nativeAPI` on top of Tauri `invoke`; caption buttons and title-bar drag |
| `src-tauri/scripts/assemble-frontend.mjs` | Builds `src-tauri/frontend-dist/` before `tauri dev` / `tauri build` |

### Keyboard shortcuts (implemented in `src/shortcuts.js`; Ctrl/Cmd+wheel zoom is in `src/preview.js`)

`Ctrl/Cmd+O` open, `Ctrl/Cmd+S` save, `Ctrl/Cmd+Shift+S` save as, `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` / `Ctrl/Cmd+Y` redo, `Ctrl/Cmd+F` find, `Ctrl/Cmd+H` highlight current text selection, `[` rotate left, `]` rotate right, `Ctrl/Cmd+A` select all text in the active layer if a text selection is active else select all pages, `Delete/Backspace` delete selected redaction, signature, or pages (skipped while a non-collapsed text selection is active), `ArrowUp` / `ArrowDown` previous/next page, `PageUp` / `PageDown` scroll the preview by about one viewport, `Ctrl/Cmd+mouse wheel` zoom the preview in / out, `Escape` close find bar, then the annotate popover (and collapse the selection), then theme/about popovers and the About modal, then cancel placement / deselect.

### Related feature notes

All of these live in `features/`.

As-built notes (these features are implemented):

- `features/features.md` — functional specification of what the app does
- `features/feature-select-text.md` — pdf.js text layer, select-and-copy, interaction with stamps and `Ctrl+A`
- `features/feature-search-text.md` — Ctrl/Cmd+F find bar on that same text layer and extract cache
- `features/feature-annotate.md` — saved highlight and redaction on that same text layer
- `features/feature-forms-plan.md` — AcroForm field filling (implemented; "As built" section first, original plan after)
- `features/feature-digital-signature-guide.md` — cryptographic (CAdES) signatures signed in the Rust shell (implemented; "As built" section first, original guide after)

`todos.md` tracks the backlog; everything listed there is currently done.

### Tests

`test/` holds the renderer regression suite (`npm test`). It uses Node's built-in runner and stubs the browser-only modules (`main.js`, `renderer.js`, `preview.js`, `signature.js`, pdf.js) via `mock.module`, so state, the save pipeline and the pure helpers run unmodified. Add a test whenever behaviour changes; when fixing a bug, add the failing test first.

| File | Covers |
|------|--------|
| `test/state.test.mjs` | Every reducer action, page-identity remapping, undo/redo, dirty flag |
| `test/units.test.mjs` | Zoom, find hits, rect merging/overlap, find-vs-redaction, markup coordinate mapping, signature library |
| `test/engine.test.mjs` | `saveDocument` / `closeFile` / `loadFromBytes` end to end: page assembly, rotation, highlights, redaction fallback, markup, stamps, forms, signature placeholder, unsaved prompts |
| `test/contracts.test.mjs` | JS/Rust/HTML/build-script consistency: version in four places, `nativeAPI` vs bridge vs Rust commands, signing placeholder, `COPIES`, element ids, CSP |
| `test/helpers/` | `mocks.mjs` (module stubs, `fake.pdfjs`, `installNativeAPI`), `pdf.mjs` (PDF fixtures and inspection) |

Not covered (check by hand in `npm start`): preview rendering and overlays, drag/resize, redaction flattening to an image, native dialogs, real signing over IPC. A new source module that the tested code imports and that touches `document` at import time needs a stub in `installMocks()`; a new native command must be added to `bridge.js` and `lib.rs` together (the contract test fails otherwise).

### Build output

Tauri config is in `src-tauri/tauri.conf.json` (product name, identifier, icons, NSIS target, and a `.pdf` `fileAssociations` entry). Only the Windows NSIS installer is configured; macOS and Linux bundles are not set up. The installer lands in `src-tauri/target/release/bundle/nsis/`. `src-tauri/target/` and `src-tauri/frontend-dist/` are build output and git-ignored.
