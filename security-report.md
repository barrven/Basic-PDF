# Security Report — Basic PDF

Date: 2026-08-25 (re-audit after remediation)
Scope: full repository audit (`npm audit`, Electron hardening review, source scan for dangerous patterns, build/packaging config).

## Update — 2026-08-25 re-audit: all findings resolved

All four items from the original report have been fixed and verified:

| # | Finding | Status |
|---|---|---|
| 1 | Electron outdated (30.5.1 vs latest 44.0.0) | **Fixed** — now on `electron@44.0.0` |
| 2 | `fast-uri` transitive prod vuln | **Fixed** — `npm audit` now reports **0 vulnerabilities** |
| 3 | `electron-builder` toolchain vulns (14 high, 1 critical) | **Fixed** — `electron-builder` upgraded to `26.15.3`; full `npm audit` (including devDependencies) is clean |
| 4 | No CSP, no external-navigation guard | **Fixed** — see below |

Verification performed:
- `npm audit` (full, including devDependencies): **found 0 vulnerabilities**.
- `npm ls electron electron-builder pdfjs-dist pdf-lib electron-store`: confirms `electron@44.0.0`, `electron-builder@26.15.3`.
- Reviewed the diff to `electron/main.js`: adds
  ```js
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => { event.preventDefault() })
  ```
  right after window creation — closes the external-navigation gap from finding 4.
- Reviewed the diff to `index.html`: adds a `Content-Security-Policy` meta tag —
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none';`
  This is appropriately strict (default-deny, no `'unsafe-inline'`/`'unsafe-eval'` for scripts) and accounts for the app's actual needs: `worker-src blob:`/`'self'` for the pdf.js worker (`src/renderer.js` sets `GlobalWorkerOptions.workerSrc` via `new URL(...)`, same-origin), `wasm-unsafe-eval` for pdf.js's WASM use, and the Google Fonts origins already `preconnect`ed in the same file. `style-src 'unsafe-inline'` remains (commonly required for inline-styled UI) — low residual risk on a local desktop app with no untrusted HTML injection points.
- Confirmed `contextIsolation: true` / `nodeIntegration: false` are unchanged (still correct).
- Diff also adds an unrelated "About" modal/menu (`src/about.js`, new `get-app-info` IPC handler exposed via preload). Reviewed it: only reads static fields from `package.json` (name/version/author/license) in the main process and renders them via `textContent` in the renderer — no `innerHTML` with dynamic content, no new attack surface.
- Did a smoke-launch (`npm start`); no CSP-violation errors surfaced in the console during startup. Recommend the user manually confirm PDF opening/rendering and font rendering still look correct in normal use, since a full interactive UI pass wasn't performed here.

No new issues were introduced by the fixes. **No outstanding action items from the original report remain.**

---

## Original report (2026-08-25, pre-remediation)

No evidence of malicious code, secrets, or actively-exploited vulnerabilities. The main things a corporate security review would flag before broad rollout are:

1. **Electron runtime is significantly out of date** (highest-impact finding).
2. One high-severity **transitive production dependency** vulnerability (`fast-uri`, low real-world exploitability here).
3. Several high/critical vulnerabilities in **build-time-only tooling** (`electron-builder` chain) — not shipped to end users, but relevant to build-machine/CI hygiene.
4. A couple of low-cost **Electron hardening gaps** (no CSP, no explicit external-navigation/window-open policy) worth closing given the app opens untrusted, attacker-controllable input (PDF files).

Nothing here should block internal use of the current build, but items 1 and 4 are worth fixing before wider corporate distribution, and item 2/3 should be resolved via `npm audit fix`.

---

## 1. Electron runtime is outdated (Medium–High risk)

- Installed: **Electron 30.5.1** (`package.json` pins `^30.0.0`)
- Latest available: **Electron 44.0.0**

Electron bundles its own Chromium and Node.js. Being ~14 major versions behind means the app ships with a Chromium build that has received no security patches in a long time — including any renderer/V8 sandbox-escape CVEs fixed upstream since Electron 30. Since this app's core function is opening PDF files (an attacker-controlled input format) and rendering them via pdf.js inside that Chromium renderer, an out-of-date Chromium is the most relevant attack surface in this codebase.

There is no auto-update mechanism configured (`.electron-builder.yml` has no `publish`/`electron-updater` section), so patching requires a manual rebuild/reinstall — worth knowing when planning a corporate rollout.

**Recommendation:** Upgrade to a current Electron major (or at minimum the latest 30.x patch, then plan a major-version bump) as part of routine maintenance, and re-evaluate on a regular cadence (e.g. quarterly).

## 2. Production dependency vulnerability: `fast-uri` (High severity, low practical risk)

`npm audit --omit=dev` reports:

- **fast-uri** `3.0.0–3.1.4` — host-confusion vulnerabilities via backslash authority delimiters / failed IDN canonicalization ([GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx) and related).
- Pulled in transitively: `electron-store@8.2.0 → conf@10.2.0 → ajv@8.20.0 → fast-uri@3.1.2`.
- Used only for local JSON-schema validation of the app's own settings store (`electron-store`), not for parsing any network- or PDF-derived URLs. Practical exploitability in this app is low, but it's a free fix.

**Recommendation:** `npm audit fix` (non-breaking) resolves this.

## 3. Build-tooling vulnerabilities (High/Critical severity, dev-only — not shipped to users)

`npm audit` (full, including devDependencies) reports 15 advisories (14 high, 1 critical), all rooted in the `electron-builder@24.13.3` toolchain used only to *package* the app, not part of the shipped runtime:

| Package | Severity | Issue |
|---|---|---|
| `tar` | Critical | Multiple hardlink/symlink path-traversal and DoS issues (arbitrary file write/overwrite) |
| `extract-zip` | High | Unvalidated symlink path traversal |
| `js-yaml` | High | Quadratic-complexity DoS via crafted YAML |
| `form-data` | High | CRLF injection via unescaped multipart field/filename |
| `fast-uri` (build-tool copy) | High | Same host-confusion class as above |
| `tmp` | High | Path traversal via unsanitized prefix/postfix |
| `app-builder-lib` | High | Uncontrolled search path in AppImage builds |

These only matter if a malicious/crafted **input reaches the build process itself** (e.g., untrusted archives extracted during packaging, or a compromised CI feeding crafted config) — they are not attack surface for end users running the shipped app. Still worth cleaning up for build-machine/CI hygiene and supply-chain hardening.

**Recommendation:** `npm audit fix` resolves the non-breaking ones; `npm audit fix --force` upgrades `electron-builder` to `26.15.3` for the rest, which `npm audit` flags as a semver-major bump — test the build after upgrading (config format / Node version requirements may change).

## 4. Electron hardening gaps

Current `BrowserWindow` config (`electron/main.js`) already does the important things right:

- `contextIsolation: true`, `nodeIntegration: false` ✔
- No `nodeIntegrationInWorker`, `webviewTag`, or `enableRemoteModule` enabled ✔
- Preload script uses `contextBridge` correctly, exposing a narrow, specific API (no generic `ipcRenderer` passthrough) ✔
- No `<webview>` tags, no `remote` module usage, no `child_process`/`eval`/`new Function` found anywhere in `src/` or `electron/` ✔

Two gaps worth closing, given the app's job is opening untrusted PDF files (which can contain clickable link annotations pointing anywhere):

- **No Content-Security-Policy.** `index.html` has no `<meta http-equiv="Content-Security-Policy">`, and no CSP header is set on the window. A CSP is defense-in-depth against any future XSS-style issue in the renderer (e.g. from a future feature that renders PDF-supplied text/metadata unsafely).
- **No explicit external-navigation/window-open policy.** There's no `webContents.setWindowOpenHandler` or `will-navigate` handler on `mainWindow`. Electron's modern defaults already block `window.open` unless handled, but there's nothing stopping in-page navigation (`will-navigate`) away from `index.html` if a link is ever clicked (e.g. a link annotation surfaced from a rendered PDF in a future feature). Currently no code appears to open PDF-supplied links, so this isn't exploitable today — but it costs little to close explicitly:

```js
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
win.webContents.on('will-navigate', (e) => e.preventDefault())
```

`webSecurity` is left at its default (`true`, i.e. enabled) — good, no `allowRunningInsecureContent` or disabled web security found anywhere.

## 5. Other checks performed (no findings)

- No hardcoded API keys, tokens, passwords, or private keys in the repo (pattern search across all files; the only "token" hits were an unrelated render-cancellation counter variable in `src/preview.js`).
- `innerHTML` usage in `src/` is limited to clearing nodes (`= ''`) or inserting static, hardcoded icon markup from an internal `ICONS` map — none of it interpolates PDF content, filenames, or other untrusted/external input.
- File-system IPC handlers (`open-file`, `save-file`, `save-file-as`, `open-file-bytes`) are invoked with paths chosen via native OS dialogs or the OS "open with" argv, not arbitrary renderer-supplied paths — the renderer cannot direct the main process to read/write arbitrary files of its own choosing beyond what the user picked in a dialog or launched via the OS.
- No auto-update / remote code-fetch mechanism, so no supply-chain risk from a compromised update server.
- `pdf-lib@1.17.1` (latest) and `pdfjs-dist@4.10.38` (current: 6.2.108, two majors behind) are not flagged by `npm audit`; no known advisories currently apply to the installed versions in the npm advisory database.

---

## Recommended action items, in priority order (original — see Update above for resolution)

1. ~~Run `npm audit fix` to clear the non-breaking production (`fast-uri`) and build-tool advisories.~~ Done.
2. ~~Plan an Electron major-version upgrade (currently 30 → latest 44) as routine maintenance; re-check periodically.~~ Done.
3. ~~Add a `setWindowOpenHandler` / `will-navigate` guard and a basic CSP meta tag to `index.html` as low-cost defense-in-depth.~~ Done.
4. Optionally schedule `npm audit` as part of CI so new advisories are caught automatically going forward. (Still open — not a vulnerability, just a process suggestion.)
