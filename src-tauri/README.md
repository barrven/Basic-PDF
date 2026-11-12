# Basic PDF: Tauri shell

A Rust / WebView2 shell for Basic PDF, following the recommendation in [`rewrite.md`](../rewrite.md). It runs the same renderer as the Electron app (`index.html` + `src/*`, unmodified) and replaces only `electron/main.js` and `electron/preload.js`.

The Electron app is still the shipping build. Both shells live side by side.

## Prerequisites

- Rust (stable, `x86_64-pc-windows-msvc`) with `cargo` on `PATH`
- Visual Studio 2022 Build Tools with the C++ workload and a Windows SDK
- WebView2 runtime (ships with Windows 11)
- `npm install` in the repo root (the renderer's libraries are copied from `node_modules`)

## Build and run

From the repo root:

```bash
npm run tauri:dev
```

```bash
npm run tauri:build
```

The Tauri CLI is a dev dependency (`@tauri-apps/cli`), so these need no separate install. `tauri:dev` holds the terminal while the app is open; Ctrl+C there closes the app.

`tauri:build` writes the NSIS installer to `src-tauri/target/release/bundle/nsis/` (about 3.4 MiB).

Both commands first run `scripts/assemble-frontend.mjs`. After editing anything in `src/` or `index.html`, re-run the command so the embedded copy is refreshed.

## Layout

| File | Role |
|---|---|
| `src/lib.rs` | The shell: file dialogs, file read/write, context menu, settings store, theme, About info, unsaved-changes close prompt, PDF path from argv, frameless-window commands |
| `src/bridge.js` | Injected before any page script. Defines `window.electronAPI` on top of Tauri's `invoke`, and draws the minimize / maximize / close buttons inside `#window-controls-spacer` |
| `scripts/assemble-frontend.mjs` | Builds `frontend-dist/`, the folder Tauri embeds |
| `tauri.conf.json`, `capabilities/default.json` | App config, NSIS target, `.pdf` file association |

`target/`, `frontend-dist/` and `gen/` are build output and are git-ignored.

## How the frontend is assembled

The renderer has no bundler and imports pdf.js and pdf-lib from `../node_modules/...`. The Tauri CLI refuses a frontend folder that contains a `node_modules` directory, so the assembly script:

1. copies `index.html`, `icon.png` and `src/` into `frontend-dist/`;
2. copies only the library files the renderer loads into `frontend-dist/vendor/`;
3. rewrites `../node_modules/` to `../vendor/` in the copied JS;
4. widens `connect-src` in the copied `index.html` CSP to allow Tauri's IPC (`ipc:` and `http://ipc.localhost`).

The originals are never modified. If the renderer starts importing another library file, add it to `COPIES` in the script.

## Electron to Tauri mapping

| Electron channel | Tauri command(s) |
|---|---|
| `open-file` | `pick_open_file` + `read_file_bytes` |
| `open-file-bytes` | `read_file_bytes` (raw binary response) |
| `save-file` | `save_file` (raw body, path in the `x-path` header) |
| `save-file-as` | `pick_save_path` + `save_file` |
| `show-context-menu` | `show_context_menu` (native popup) |
| `store-get` / `store-set` | `store_get` / `store_set` |
| `set-dirty` | `set_dirty` + the `CloseRequested` prompt |
| `get-theme` / `set-theme` / `theme-updated` | `get_theme` / `set_theme` / `theme-updated` event |
| `get-app-info` | `get_app_info` |
| `open-path` (pushed by main) | `take_pending_open_path` (pulled when `onOpenPath` is registered) |
| native caption buttons (`titleBarOverlay`) | `window_minimize`, `window_toggle_maximize`, `window_is_maximized`, `window_close`, `window_start_drag` |

## Differences from the Electron shell

- **Settings location.** Settings are stored in `%APPDATA%/com.barrven.basic-pdf/basic-pdf.json`. On first run, if that file does not exist, the Electron app's `%APPDATA%/Basic PDF/basic-pdf.json` is imported (signature library, theme, last folder). After that the two stores are independent.
- **Title bar.** The window is frameless and the caption buttons are HTML. Hovering the maximize button does not show the Windows 11 snap-layout flyout.
- **File drops.** Tauri's native file-drop handler is disabled because it breaks HTML5 drag-and-drop on Windows (thumbnail reordering, signature upload). Dragging a PDF onto the window is therefore not handled by the shell.

## Not yet verified

- Running the installer, and the `.pdf` association after install.
- Dragging the window by the title bar with a real mouse.
- Completing Save As through the native dialog (the dialog opens; the write path behind it is tested).
- `theme-updated` when the OS theme changes while the preference is "system".
- Signatures, drag-reorder, find, highlight and redaction clicked through in the Tauri window.
- Large PDFs.
