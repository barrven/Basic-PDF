# Stack evaluation for a Windows rewrite / re-platform

Written against `features.md`, the stack-agnostic functional spec extracted from the current Electron implementation. Goal: evaluate whether to stay on Electron, move to Tauri, or go fully native for Windows.

## Recommendation

Don't do a from-scratch native rewrite. The hard part of this app isn't UI chrome — it's the PDF engine: a working text layer for select/copy/find, highlight-as-vector-rects, and (critically) redaction that *irreversibly* removes content by rasterizing affected pages. That's already solved correctly with pdf.js + pdf-lib. Reimplementing it on PDFium/C# or Qt/Poppler means re-deriving a security-relevant feature (unrecoverable redaction) from scratch in a new language — high risk for a spec whose section 10 explicitly flags that as a correctness/security requirement, not cosmetic.

**Preferred path: Tauri**, not a switch to a fully native GUI toolkit. Keep essentially all of `src/*` (pdf.js rendering, pdf-lib assembly, the state store, preview/search/annotate logic) unchanged — it's plain ES modules with no Electron-specific API baked into the rendering/engine layers, only `main.js`/`preload.js` touch Electron. Swap the shell: Rust + Tauri's WebView2-based window instead of bundling Chromium.

You keep:
- Native file dialogs, context menus, drag-drop, dark/light/system theme, About dialog — all available via Tauri APIs, comparable effort to the current `electron-store`/native-menu code in `main.js`.
- File-association launch (`.pdf` double-click) and window-close dirty-prompt — same pattern, different IPC surface.

You gain:
- ~10–20MB installer vs Electron's ~150–200MB.
- Lower idle RAM (no bundled Chromium process).
- Faster cold start.

Tradeoff: relies on WebView2 being present (bundled on Win11, auto-installed redistributable on Win10) rather than shipping its own browser engine — the one real regression vs. Electron.

## Alternative: fully native (WinUI 3 / C#)

Better OS-native feel, smallest footprint, best performance. The catch is the PDF engine: you'd need a commercial SDK (Apryse/PDFTron, PSPDFKit, Syncfusion) to get redaction-safe flattening, text extraction, and annotation APIs at the current app's quality bar without reinventing them yourself on raw PDFium. That's a licensing cost and a genuine rewrite, and it drops the cross-platform story the app currently has for free via Electron/`electron-builder` (NSIS/DMG/AppImage from one codebase).

## Other options considered, not recommended

- **Qt (C++/PyQt) + Poppler**: cross-platform native, mature, but Qt's PDF module is viewer-oriented, not editor-oriented — redaction/highlight persistence and text extraction would need Poppler or a commercial SDK layered on top. Heavier engineering lift, C++ complexity, no reuse of existing JS engine code.
- **Flutter (Dart)**: decent cross-platform UI, but the Windows PDF-editing ecosystem (redaction, highlight persistence into the saved file) is thinner than pdf.js/pdf-lib; would likely still end up shelling out to a native PDF library, losing the "one engine, one language" benefit.

## Decision rule

- Priority is smaller/faster/still-cross-platform with minimal risk to the PDF logic → **Tauri**.
- Priority is native Windows fidelity over dev cost, licensing, and keeping macOS/Linux builds → **WinUI 3 + a commercial PDF SDK**.

## Open follow-up

Not yet done: a file-by-file porting-effort estimate for `electron/main.js` → Tauri commands and `electron/preload.js` → Tauri's IPC surface, if the Tauri path is chosen.
