# Basic PDF 3.1.2: change notes

Covers the 11 commits on `dev` that are not yet in `master` (previous release: 3.1.0).

## New

- **Print (File > Print, Ctrl/Cmd+P).** Prints only the document, not the app UI. Pages are rendered into a print-only area, with a progress label and a Cancel button while a large document is being prepared.
- **Keyboard Shortcuts dialog (Help > Keyboard Shortcuts).** A reference table of every shortcut. Escape closes it, and it counts as an open modal for find and Ctrl+wheel zoom.
- **Clickable links in PDFs.** Link annotations and plain-text web addresses now work in the preview, on pages with or without form fields. External URLs ask for confirmation first.

## Improved

- **Redacted pages stay searchable.** A page with a redaction is still flattened to an image, but all text outside the redaction boxes is put back as invisible text. The rest of the page can be searched and selected after reopening. Text runs that are rotated and touch a box are dropped rather than risk leaking redacted text.
- **Outline.** Clicking an entry scrolls the heading itself to the top, using the bookmark destination or the detected text position. Heading detection now joins wrapped headings, ignores repeated headers and footers, and groups near-equal font sizes into one level.
- **Highlight and Redact buttons.** They now leave any drawing tool and switch to text-selection mode. If no text is selected, the action applies to the next selection. Esc or a second click cancels.

## Changed

- The highlight/redact popover no longer appears when text is selected. Use Ctrl/Cmd+H or the ribbon buttons.
- Right-clicking selected text shows a native menu with only **Copy**. The WebView2 default context menu is suppressed everywhere else. The thumbnail list keeps its own menu.

## Fixed

- F5, Ctrl/Cmd+R and Ctrl+Shift+R are blocked. WebView2 used them to reload the page, which dropped the open document.
- Print: single-page output and slow printing of large documents.
- Print: broken ellipsis in the progress label.

## Commits

| Commit | Summary |
|--------|---------|
| `9622390` | Make links in PDFs clickable, including plain-text web addresses |
| `21cddec` | Highlight and Redact buttons switch to text-selection mode |
| `0db17f2` | Outline: scroll to the heading, improve heading detection |
| `b57c362` | Keep unredacted text searchable on redacted pages |
| `130ce76` | Add File > Print that prints only the document |
| `2ebb215` | Test print wiring and print CSS |
| `43ec77d` | Stop showing the highlight/redact popover on text selection |
| `00a4171` | Add keyboard shortcuts modal; block reload keys and default context menu |
| `9cfbe38` | Print: fix single-page output and slow large documents |
| `dfcd8b9` | Fix broken ellipsis in print progress label |
| `7dba6fa` | Add Cancel button while preparing a document to print |
