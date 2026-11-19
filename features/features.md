# Basic PDF — Feature List

Functional specification of a desktop PDF editor, extracted from the current implementation (Tauri + vanilla JS + pdf.js + pdf-lib). Written to describe *what the app does*, independent of the current tech stack, for use as input when evaluating alternative languages, frameworks, or libraries.

## 1. File & document management

- Open a PDF via the file dialog or the OS "open with" association (double-click). Dragging a PDF onto the window does not open it.
- Each file opens in its own top-level window; no single-instance restriction — multiple windows/files can be open at once.
- Save in place, or Save As to a new path.
- File menu actions beyond open/save: insert pages from another PDF, "Open Parent Folder" (reveals the file in the OS file manager), and "Copy File Path" (to the clipboard).
- Opening a PDF that already carries a digital signature shows a dismissible notice that saving will remove it (saving rebuilds the file).
- Remembers the last-used folder across Open and Save As dialogs; falls back to the OS default if that folder no longer exists.
- Close file / close window prompts to save when there are unsaved changes.
- Tracks a "dirty" (unsaved changes) flag driven by document edits (page changes, signatures, annotations).
- Undo/redo history covering page layout, signature, annotation (highlight, redaction, markup) and form-field edits (bounded history depth, e.g. last 50 steps; typing in a form field coalesces into one step). Not covered by undo: zoom level, selection state, loading/UI state.

## 2. Page viewing

- Continuous vertical scroll preview of every page in the document (not a single-page-at-a-time viewer).
- Fit-to-width mode and stepped numeric zoom (e.g. 50%–200% in defined steps).
- Zoom via toolbar controls and via Ctrl/Cmd+mouse-wheel, zooming around the cursor position with a scroll anchor so the point under the cursor stays fixed.
- Lazy rendering: only visible/near-viewport pages are rasterized, nearest the current page first, and pages far from the viewport are released again, for speed and bounded memory on large documents.
- Thumbnails are rendered on demand as they scroll into the sidebar, after the pages in view.
- Thumbnail sidebar showing all pages; clicking a thumbnail scrolls the main preview to that page.
- Keyboard/page navigation: next/previous page, page-up/page-down scroll by roughly one viewport.
- Sidebar with two views: page thumbnails, and an outline. The outline uses the PDF's own bookmarks when present, otherwise headings detected from text size; clicking an entry jumps to its page, entries collapse, and the current section follows scrolling.
- A "focused page" concept — the page nearest the top of the viewport drives thumbnail highlighting and single-page context (e.g. rotate-current-page).

## 3. Page manipulation

- Reorder pages by dragging thumbnails.
- Rotate a page (or selection) left/right in 90° increments; rotation is stored as an absolute value (0/90/180/270), not a delta, and is preserved from the source file's existing rotation on open/insert.
- Insert blank pages (at a chosen position, via context menu).
- Insert pages from another PDF file (merges pages from a second source document into the current one).
- Duplicate pages.
- Delete pages (single or multi-select).
- Multi-page selection for bulk rotate/delete.
- Page identity is stable across reorder/insert/delete so that annotations and signatures placed on a page continue to track that same page (not a raw index) through subsequent edits.

## 4. Text: select, copy, find

- Selectable, copyable text layer over the rendered page image (invisible text positioned to match the rasterized glyphs), so text can be selected and copied to the system clipboard like a normal document viewer.
- Select-all: selects all text on the current page if a text selection is already active, otherwise selects all pages.
- Cross-page text selection is not required/supported (selection is scoped to a single page).
- Find/search in document: incremental, case-insensitive substring search across the entire (current, edited) page order — not the original file's page numbering.
- Find UI shows current match index and total (e.g. "3 of 12") with a distinct "still counting" state while a large document is still being scanned, next/previous navigation with wrap-around, and on-page highlighting of matches.
- Blank pages are skipped by search.
- Search results exclude any text that is covered by a redaction.

## 5. Highlighting & redaction

- Select text to bring up a contextual annotate action (popover/toolbar) offering highlight and redact.
- Highlight: marks selected text with a translucent color overlay (e.g. multiply blend so underlying text stays legible); has a keyboard shortcut.
- Redact: marks selected text/region as permanently hidden and non-copyable/non-selectable in the rendered preview.
- On save, redacted content must be **irreversibly removed** from the output file, not just visually covered — i.e. a page containing a redaction is flattened to a raster image in the saved PDF so the underlying text/glyphs are not extractable or recoverable by opening the file in another tool. This is a hard correctness requirement, not a cosmetic one.
- Highlights remain as real vector rectangles in the saved PDF (not rasterized) unless they coexist on a page with a redaction.
- Annotations (highlights/redactions) survive page reorder, insert, and delete, tracked by stable page identity.
- Selected annotation(s) can be deleted (e.g. via Delete/Backspace) when not actively editing a text selection.

## 6. Signatures / stamps

- Create a signature by freehand drawing (canvas/ink) or by uploading an image file (PNG, JPEG, WebP — WebP normalized to PNG on save).
- Place a signature image anywhere on any page as a resizable, draggable overlay.
- Drag to reposition; resize via corner/edge handles with aspect ratio locked; minimum size enforced.
- Reusable signature library: save signatures for reuse across documents, persisted between app sessions, capped at a maximum count (e.g. 20), with the ability to delete saved entries.
- Placed signatures are embedded into the output PDF as images at save time, correctly transformed into the page's rotation/coordinate space.
- Signature placements track page identity through reorder/insert/delete like other overlays.

### Cryptographic (digital) signatures

- A placed stamp can optionally also carry a cryptographic signature (ETSI CAdES detached, SHA-256). The saved file shows if it is modified afterwards.
- Signing identities: create a self-signed certificate (ECDSA P-256) or import a `.p12` / `.pfx` (RSA or P-256). Identities are listed with expiry and a self-signed tag, and can be removed. Private keys are stored encrypted for the OS user account (Windows DPAPI) and never reach the renderer; a PFX password is used once and not stored.
- At most one cryptographic signature per document; no timestamping, no revocation checks, no incremental updates. An expired certificate cannot be used.
- Signing is the last step of saving. The stamp shows a lock badge before saving.
- Self-signed signatures are intact but unverified in other readers.

## 6b. Markup tools

- A Markup ribbon, expanded from a toolbar button, holds: Highlight and Redact (act on selected text), Text, Rectangle, Ellipse, Line and Freehand draw (click/drag on a page), a color picker and a line-thickness picker, and the Signature button with its saved-signatures menu.
- Text: click the page, type, click away to finish (Ctrl+Enter also finishes). Shapes and lines are stroke-only. Items can be selected by clicking and deleted with Delete/Backspace.
- Markup is saved as real vector content in the PDF (text uses a standard Helvetica font, so characters outside Latin-1 are replaced with "?"). On a page that is flattened for redaction, markup is painted into the image.
- Escape leaves the active tool. Markup follows page identity like other overlays and is covered by undo/redo.

## 6c. Form filling

- Fillable AcroForm fields are shown as live controls over the page: text (single and multi-line), checkbox, radio group, dropdown, list box. Read-only and hidden fields are not offered. XFA forms are detected and reported as unsupported.
- Values are kept per field name (not per page) so they survive reorder, duplicate and delete, and are written into the saved PDF with refreshed appearances. The saved PDF's form stays editable.
- Pages inserted from another PDF bring their own fields.
- A page that is both filled in and redacted is flattened with the entered values visible; its fields are no longer live afterwards. A field covered by a redaction is hidden in the preview.
- Deleting a page never carries that page's content into the file through a field shared with a kept page.

## 7. Appearance / theming

- Light, dark, and "follow OS" display modes, switchable at runtime.
- Whole-app theme, including the title bar (which the app draws itself), updates immediately on change and on OS theme change when in "system" mode.

## 8. Application chrome & info

- Windows-style menu bar in the title bar: File (Open, Save, Save As, Insert PDF, Open Parent Folder, Copy File Path, Close File), Edit (Undo, Redo, Find, Rotate left/right, Delete page, Add signature) and Help (About). Items are enabled according to whether a file is open; hovering switches between open menus.
- Custom "About" dialog showing app name, version, description, author, license, and copyright.
- Custom title bar with the app name, the open file's name (with an unsaved-changes marker), the display-mode control, and minimize / maximize / close buttons; drag it to move the window, double-click to maximize.
- Right-click context menus for page/thumbnail actions (rotate, insert blank page, duplicate, delete, etc.).

## 9. Keyboard shortcuts

A full shortcut set for power-user workflows, at minimum:
Open, Save, Save As, Undo, Redo, Find, Highlight-selection, Rotate left/right, Select-all (context-sensitive), Delete selection, Previous/Next page, Page-up/Page-down scroll, Zoom in/out via modifier+wheel, Escape to back out of the current mode in a defined priority order (find bar → annotate popover/selection → theme/about popovers → active markup tool / placement / deselect).

## 10. Safety & data integrity

- Confirmation prompt (Save / Don't save / Cancel) before discarding unsaved changes, both when switching/closing documents within the app and when closing the application window itself. A cancelled or failed save keeps the document open. These prompts are native dialogs, not browser `confirm()`.
- Output PDF assembly must not silently corrupt or drop content: rotations, highlights, redaction-flattening, and embedded signature images all need to compose correctly regardless of edit order.
- Redaction must be a genuine security/privacy feature (content unrecoverable from the saved file), not merely a UI overlay — this should be treated as a security-relevant requirement in any reimplementation.

## 11. Explicitly out of scope today (candidate future features)

Not implemented in the current app; worth considering when exploring a new design, but not required for parity:
- Editing existing PDF text or images; OCR for scanned pages.
- Markup beyond the listed tools: arrows, sticky notes/comments, fonts and sizes other than the default, moving or resizing a shape after it is drawn, highlight color presets.
- Saving highlights/redactions as standard PDF annotation objects (they are burned into page content).
- Flatten-on-save for form fields; XFA forms.
- Multiple cryptographic signatures, timestamping, revocation checking, preserving an existing signature when saving.
- Drag-and-drop of a PDF onto the window.
- An in-app settings/preferences panel (currently no dedicated settings UI beyond theme).
- macOS and Linux builds.

## 12. Non-functional characteristics worth preserving

- Runs as a desktop application (not just a viewer) with real filesystem read/write access to arbitrary local paths.
- Works offline: opening, editing and saving need no network. The only network request is for the UI fonts (Google Fonts); without a connection the UI uses system fonts.
- Windows only today (NSIS installer, WebView2). No macOS or Linux build is configured.
- Should perform acceptably on large multi-hundred-page PDFs (motivates lazy/virtualized rendering and incremental search rather than eager whole-document processing).
- Two distinct concerns exist in the current design and probably should remain separable regardless of stack: (a) *rendering* pages to pixels for on-screen display + extracting text/positions for selection/search, and (b) *assembling/writing* the final output PDF (copying pages, applying rotation, drawing highlight boxes, flattening redacted pages to images, embedding signature images). A new implementation may unify these in one library/engine or keep them split — that tradeoff is one of the things worth evaluating.
- Must not leak "deleted"/redacted content into the saved file even when the rendering layer that displays it is only visual (canvas-based). This includes content reachable only through a form field shared with a page that was kept.
- Private signing keys stay in the native shell and are encrypted at rest; the renderer only ever sees identity metadata.
