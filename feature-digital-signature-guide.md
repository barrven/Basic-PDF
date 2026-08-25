# Implementation guide: cryptographic (digital) signatures

**Status:** design/implementation guide only — nothing here is built. Written against `dev` as of "Keep highlighted text readable in the preview." (`3cce064`). Cross-check line numbers against current source before coding; they will drift, and the redaction implementation in particular is under active revision.

This describes how to add a real cryptographic signature (PAdES/PKCS#7, the kind Adobe Reader shows a blue ribbon for) on top of the existing signature *stamp* feature. It is a substantially bigger feature than it looks, because it touches process boundaries, save semantics, and PDF's byte-level signing format — not just UI. Read the whole thing before starting; the "gotchas" section exists because each one was a redesign, not a bug fix, when skipped.

---

## 1. What exists today vs. what this adds

The current "signature" feature (`src/signature.js`, `appState.signatures`, `buildOutputDoc()` in `src/pdf-engine.js`) is a **visual stamp**: a drawn/uploaded/typed image dropped onto a page and burned in as a raster image at save time via `pdfPage.drawImage()`. It proves nothing — anyone can flatten the same PNG onto any PDF. There's no key, no certificate, no tamper-evidence.

A **digital signature** in the PDF sense (ISO 32000 §12.8, PAdES/CAdES) is a `/Sig` dictionary containing a detached PKCS#7 `SignedData` (CMS) blob, computed over a `/ByteRange` of the file's raw bytes, referenced from a widget annotation on an `AcroForm` `/Sig` field. Any byte changed after signing breaks the hash, and Acrobat/Reader will say so. This is what "add a digital component" means here.

These are two different things that happen to look similar in the UI (a rectangle on a page). Recommendation: keep the visual stamp as the *appearance* of a digital signature field, but treat "digitally sign" as an explicit opt-in per stamp, not a property that piggybacks silently on every stamp.

---

## 2. Architectural facts that drive every decision below

1. **pdf-lib cannot produce PDF signatures.** It has no `/ByteRange`, no CMS/PKCS#7, no incremental-update writer for this purpose. You need a second library purely for the signing step.
2. **Signing needs Node crypto (or a big browser crypto polyfill).** The renderer runs with `contextIsolation: true`, `nodeIntegration: false` (`electron/main.js:181-185`) and a CSP that blocks arbitrary script/module loading (`index.html`). Private-key handling belongs in the **main process** regardless — you don't want a private key or PFX passphrase anywhere near a Chromium renderer that loads pdf.js-parsed PDF content. This means a new IPC surface, mirroring how `open-file`/`save-file` already cross that boundary.
3. **`buildOutputDoc()` is a full rebuild, not an incremental update.** Every save constructs `PDFDocument.create()` from scratch and copies pages in (`src/pdf-engine.js:226-318`). It does not carry over the source file's `AcroForm`, `/Sig` dictionaries, or any prior incremental-update history. Consequence: **opening an already-signed PDF in this app and saving it will silently drop the existing signature**, with no warning today. That has to be fixed as part of this feature (§8), not left as a surprise.
4. **Signing is necessarily the last step before bytes hit disk.** The signed hash covers the exact byte range of the saved file. It must run after `buildOutputDoc()` → `newDoc.save()`, not before, and nothing may touch the returned bytes afterward except splicing the signature into the pre-sized placeholder (which is exactly what the signing library does).
5. **The signature's byte range must be reserved before the hash is computed**, and its size can't change afterward without invalidating offsets. This is the part hand-rolling would get wrong — use a library that already does it (§3).

---

## 3. Recommended dependencies

```
npm install @signpdf/signpdf @signpdf/placeholder-pdf-lib @signpdf/signer-p12 node-forge
```

- **`@signpdf/signpdf`** — core: finds the `/ByteRange` placeholder in a PDF buffer, computes the digest, hands it to a signer, splices the result back in.
- **`@signpdf/placeholder-pdf-lib`** — sibling package built specifically for pdf-lib interop (this app already depends on pdf-lib, so this is the natural fit over `@signpdf/placeholder-plain`, which works against raw already-serialized PDF bytes instead). Exposes `pdflibAddPlaceholder({ pdfDoc, ... })`, called on the in-memory `PDFDocument` *before* `.save()`. It adds the `AcroForm`, the `/Sig` field + widget annotation, and a placeholder `/Contents` hex string of reserved length.
- **`@signpdf/signer-p12`** — wraps `node-forge` to build a detached CMS `SignedData` from a PKCS#12 (`.p12`/`.pfx`) bundle. Use this for both CA-issued and self-signed identities (a self-signed cert can still be packaged as PKCS#12).
- **`node-forge`** — also used directly (not just via `signer-p12`) for: parsing a PFX to read the certificate's subject/expiry for display, and generating a self-signed cert + keypair when the user doesn't have one.

Confirm exact option names against the installed versions' TypeScript types before wiring this up — `pdflibAddPlaceholder`'s option set (reason/location/contactInfo/name/signatureLength/subFilter/widget rect) is what you need, but pin down the current signature from `node_modules/@signpdf/placeholder-pdf-lib` once it's installed rather than trusting any example verbatim, including this one. For PAdES-compliant output (recommended over the plain Adobe subfilter) pass the ETSI CAdES-detached subfilter option — the package exports a constant for it.

Everything in this list runs in the **main process**. Do not add these to any renderer-loaded module path (the CSP's `script-src 'self'` plus no bundler means they wouldn't load in the renderer anyway without a lot of extra plumbing — which is one more reason to keep this server-side in Electron terms).

---

## 4. Identity (certificate) management

Users need an X.509 certificate + private key to sign with. Two paths:

- **Import an existing PFX/P12** (their org's CA-issued identity, e-signature provider export, etc.) — password-protected file.
- **Generate a self-signed identity** in-app for people who don't have one. Must be clearly labeled as such: Acrobat/Reader will show "signature valid, signer identity unknown/untrusted" unless that cert is manually trusted or chains to a CA the verifier trusts.

### Storage

Do **not** put the PFX bytes or password in `electron-store` (`src/store.js`) as-is — it's plaintext JSON on disk (see `src/store.js`'s existing use for the signature image library, which is fine for images but not for key material). Use Electron's `safeStorage` module (`safeStorage.encryptString` / `decryptString`), which is backed by DPAPI on Windows, Keychain on macOS, and libsecret on Linux. Store the encrypted blob's bytes in `electron-store` (or a dedicated file under `app.getPath('userData')`); decrypt only inside the main process, only at the moment of signing, and never send the decrypted bytes over IPC.

Suggested shape for a stored identity record (main-process side only):

```js
{
  id: 'uuid',
  label: 'Jane Doe (Acme Corp)',   // shown in UI, user-editable
  subjectCN: 'Jane Doe',            // parsed from cert at import time, for display
  issuerCN: 'Acme Corp CA',         // or 'Self-signed' 
  notAfter: 1782000000000,          // expiry, to warn/block signing with an expired cert
  encryptedPfx: <Buffer>,           // safeStorage.encryptString(base64 pfx) result
  encryptedPassword: <Buffer>,      // safeStorage.encryptString(password) result
}
```

Never expose `encryptedPfx`/`encryptedPassword` (or their decrypted form) to the renderer. The renderer only ever sees `{ id, label, subjectCN, issuerCN, notAfter }`.

### New main-process IPC handlers (`electron/main.js`)

Mirrors the existing pattern (`ipcMain.handle('open-file', ...)` etc.):

- `import-identity` — opens a native file dialog filtered to `.p12`/`.pfx`, reads it, prompts for... actually the password can't come from a native dialog (Electron has none); have the renderer collect the password in a modal and pass it in, e.g. `importIdentity(pfxBytes, password, label)`. Main process parses with `node-forge` to validate the password and extract subject/issuer/expiry, encrypts with `safeStorage`, stores the record, and returns the display-safe subset.
- `list-identities` — returns the display-safe array.
- `remove-identity` — deletes a stored record.
- `generate-self-signed-identity` — takes `{ commonName, label }`, generates an RSA keypair + self-signed X.509 cert with `node-forge`, packages as PKCS#12 (no password, or a random one that stays server-side), stores it the same way as an import, returns the display-safe record.
- `sign-pdf` — see §6.

### Preload additions (`electron/preload.js`)

Same shape as the existing bridge:

```js
importIdentity:  (pfxBytes, password, label) => ipcRenderer.invoke('import-identity', pfxBytes, password, label),
listIdentities:  ()                          => ipcRenderer.invoke('list-identities'),
removeIdentity:  (id)                        => ipcRenderer.invoke('remove-identity', id),
generateSelfSignedIdentity: (commonName, label) => ipcRenderer.invoke('generate-self-signed-identity', commonName, label),
signPdf:         (pdfBytes, identityId, opts) => ipcRenderer.invoke('sign-pdf', pdfBytes, identityId, opts),
```

---

## 5. Data model changes (renderer)

Extend a signature entry (`appState.signatures`, currently `{ id, pageIndex, x, y, width, height, opacity, dataUrl }`, `src/state.js`) with two optional fields:

```js
{ ..., digital: false, identityId: null }
```

- `digital: true` marks this stamp as also being the appearance for a cryptographic signature.
- `identityId` references a stored identity (from `list-identities`), resolved to a display label in the UI.

Keep it to **at most one digital signature per save** for v1 — reject placing a second `digital: true` stamp while one is already pending, with a toast explaining why (multi-signature PDFs need sequential incremental updates and per-field byte ranges; that's real added complexity, see §9). `ADD_SIGNATURE` / `DELETE_SIGNATURE` in `src/state.js` don't need structural changes, just carry the new fields through.

No new undo/redo handling needed — `digital`/`identityId` ride along inside the existing signature object that `snapshot()`/`UNDO`/`REDO` already deep-clone.

---

## 6. Save-flow integration (`src/pdf-engine.js`)

Current `buildOutputDoc()` returns a pdf-lib `PDFDocument` (§2.3); `saveDocument()`/`saveAs()` then call `.save()` on it. Insert the signing step between those two, only when a digital signature is pending:

```js
function pendingDigitalSignature() {
  return appState.signatures.find((s) => s.digital && s.identityId) || null
}

async function buildOutputBytes() {
  const newDoc = await buildOutputDoc()
  const digitalSig = pendingDigitalSignature()
  if (!digitalSig) return newDoc.save()

  // Reserve the /Sig placeholder + AcroForm/widget on the pdf-lib doc BEFORE
  // serializing — this must happen before newDoc.save(), not after.
  const pdfPage = newDoc.getPage(digitalSig.pageIndex)
  const widgetRect = visualRectToUnrotated(pdfPage, digitalSig.x, digitalSig.y, digitalSig.width, digitalSig.height)
  await pdflibAddPlaceholder({
    pdfDoc: newDoc,
    reason: digitalSig.reason || '',
    contactInfo: digitalSig.contactInfo || '',
    name: digitalSig.signerLabel || '',
    location: digitalSig.location || '',
    // widget placement on digitalSig.pageIndex using widgetRect
    // subFilter: SUBFILTER_ETSI_CADES_DETACHED, // for PAdES
  })
  const unsignedBytes = await newDoc.save()

  // Main process holds the private key; renderer never sees it.
  return await window.electronAPI.signPdf(unsignedBytes, digitalSig.identityId, {
    reason: digitalSig.reason,
    location: digitalSig.location,
  })
}
```

Then `saveDocument()` and `saveAs()` (`src/pdf-engine.js:320-380`) both call `buildOutputBytes()` instead of `newDoc.save()` directly. Both already route through `withDocumentLoading()` when `hasRedactions()` — extend that same "show the overlay" condition to `Boolean(pendingDigitalSignature())`, since signing (main-process crypto + IPC round-trip) is not instant and the UI should not look frozen.

### Main-process `sign-pdf` handler

```js
ipcMain.handle('sign-pdf', async (_event, pdfBytes, identityId, opts) => {
  const record = getIdentityRecord(identityId)          // from wherever identities are stored
  if (!record) throw new Error('Signing identity not found')
  if (record.notAfter < Date.now()) throw new Error('Signing certificate has expired')
  const pfxBase64 = safeStorage.decryptString(record.encryptedPfx)
  const password = safeStorage.decryptString(record.encryptedPassword)
  const signer = new P12Signer(Buffer.from(pfxBase64, 'base64'), { passphrase: password })
  const signed = await signpdf.sign(Buffer.from(pdfBytes), signer)
  return new Uint8Array(signed)
})
```

Decrypted key material (`pfxBase64`, `password`, and everything `P12Signer` derives from them) should go out of scope as soon as `sign()` returns — don't cache it, don't log it, don't let it end up in a main-process error report.

---

## 7. UI changes

### Signature modal (`src/signature.js`, `#signature-modal`)

Add a third tab or a post-draw/upload step: after the user confirms a drawn/uploaded signature (`onSignatureConfirmed()`, `src/signature.js:310-320`), if any identities exist (`window.electronAPI.listIdentities()`), show a checkbox: **"Also apply a cryptographic signature"**, with a dropdown of stored identities (label + subject CN) and optional reason/location text fields. If no identity exists yet, offer **"Add a signing identity"** inline (opens the import/self-signed flow) rather than dead-ending the user.

Placement (`enterPlacementMode()`, `handlePlacementClick()`, `src/signature.js:346-420`) doesn't need new mechanics — the digital-signature choice is metadata carried on the same `ADD_SIGNATURE` dispatch, just with `digital`/`identityId` set from the modal's new controls.

### Identity management

Fold into the existing signature library popover (`toggleSigPopover()`/`renderSigPopover()`, `src/signature.js:426-514`) as a second section — "Signing identities" below "Saved signatures" — rather than inventing a new top-level surface. Each row: label, subject CN, expiry (flag if expired/expiring soon), remove button. An "Import…" / "Create self-signed…" row at the top, same interaction pattern as the existing delete (`×`) buttons.

### Placed-stamp indicator

A stamp with `digital: true` should look visibly different in the preview overlay (`src/preview.js` signature overlay rendering) — e.g. a small badge/lock icon in the corner — so it's clear at a glance which stamp will produce a cryptographic signature at save time, distinct from a purely decorative one.

---

## 8. Handling already-signed PDFs (do not skip this)

Because `buildOutputDoc()` rebuilds the document from scratch, **any edit-and-save cycle on a PDF that already has a digital signature destroys that signature** without telling the user — the rebuilt output has no `AcroForm`/`/Sig` at all unless this feature explicitly re-adds one. Before shipping this feature, add a check at open time (`loadFromBytes()`, `src/pdf-engine.js:63-89`):

- Inspect the loaded `PDFDocument` for an existing `AcroForm` with `/Sig` fields (`pdfDoc.catalog.lookup('AcroForm')` → walk `/Fields` for `/FT /Sig`).
- If found, set a flag (e.g. `appState.hasExistingSignature`) and surface a persistent, dismissible notice: "This PDF already has a digital signature. Saving changes here will remove it." This is a warning, not a hard block, for v1 — but it must not be silent.
- Stretch goal (§9): preserve existing signatures by writing an incremental update instead of a full rebuild when the source already has one and no page/content edits touch it. That's a materially different save pipeline and should be scoped separately.

---

## 9. Explicitly out of scope for a first cut (call these out, don't attempt silently)

- **Multiple digital signatures in one document.** Real multi-signer workflows need sequential incremental updates (each signer's byte range must include all prior signatures unmodified). v1: one digital signature per save, and disable adding a second while one is pending.
- **RFC 3161 timestamping (TSA).** Without it, a signature's long-term validity depends on the signing cert still being valid/unexpired at verification time. `@signpdf`'s signer interface can be extended for this, but it's a separate integration (a TSA client + embedding the timestamp token in the CMS) — track as a follow-up, not v1.
- **OCSP/CRL revocation checking.** Verification-side concern, not signing-side; out of scope.
- **DocMDP ("certifying") signatures and lock-after-signing (form fill only / no changes allowed) transform params.** Meaningful once §8's rebuild-destroys-signature problem is actually solved with incremental updates; not worth doing on top of a full-rebuild save pipeline.
- **PKCS#11 / hardware token signing (smart cards, YubiKey, etc.).** Different signer implementation entirely; note as a future identity-source option alongside PFX import.

---

## 10. Security checklist

- Private key material (PFX bytes, passphrase, anything `node-forge`/`P12Signer` derive from them) never crosses into the renderer process. Only display-safe identity metadata does.
- PFX/passphrase at rest: `safeStorage.encryptString`, not plaintext `electron-store`.
- Validate the PFX password at import time (catch node-forge's decryption error) and surface a clear "wrong password" error rather than storing something that will fail silently at sign time.
- Check certificate expiry both at import (warn) and at sign time (`sign-pdf` handler, hard error if expired — a signature is worth less than nothing if it's plainly out of date).
- Self-signed identities: label them as such everywhere they appear in the UI (dropdown, popover, placed-stamp badge) so users don't mistake them for a trusted CA-issued signature.
- Treat imported `.pfx`/`.p12` files like any other user-selected file path — no special validation beyond what `node-forge`'s own PKCS#12 parser already enforces; don't shell out, don't eval anything from the file.
- Don't log signed/unsigned PDF bytes, PFX bytes, or passwords, even at debug level, in either process.

---

## 11. Verification / testing plan

There's no test suite in this repo (per `CLAUDE.md`), so verification here is manual:

1. Sign a document with a self-signed identity, open the output in Adobe Acrobat Reader (or `qpdf --check` / `pdfsig` from poppler-utils) — confirm it reports "signed" with a valid hash and an untrusted-signer warning (expected for self-signed).
2. Sign, then modify a single byte of the saved file (e.g. append a space) and re-check with `pdfsig` — confirm it now reports the signature as invalid. This is the actual proof the byte-range/hash plumbing is correct, not just "a `/Sig` dict exists."
3. Open a signed PDF from this app, make an unrelated edit (e.g. rotate a page), save, and confirm the §8 warning appeared and that the resulting file no longer validates as signed (expected until incremental-update preservation is built).
4. Round-trip through the existing redaction/highlight/stamp code paths with a digital signature pending, to confirm `buildOutputDoc()` + the placeholder step don't interact badly (e.g. a redacted page that gets flattened to PNG, `rasterizeRedactedPage()`, still ends up as page N in `newDoc` before `pdflibAddPlaceholder()` looks up `newDoc.getPage(digitalSig.pageIndex)` — page indices must be assigned before the placeholder step runs, which the flow in §6 already respects since it comes after the full `buildOutputDoc()` loop).
5. Expired-certificate path: import a deliberately expired test cert, confirm `sign-pdf` rejects it with a clear error instead of producing an unverifiable/garbage signature.

---

## 12. Suggested phased rollout

1. **Plumbing only, no UI:** `sign-pdf`/`list-identities`/`import-identity` IPC handlers, `safeStorage`-backed storage, a throwaway dev script that signs a fixed test PDF with a hardcoded self-signed identity. Verify with `pdfsig`/Acrobat before touching any renderer UI.
2. **Self-signed identity generation + import**, surfaced in the signature popover, with expiry/label display. No signing wired to save yet.
3. **Save-flow integration** (§6): one digital signature per save, placed via the existing stamp-placement flow with the new modal checkbox.
4. **§8's already-signed-PDF warning** — should land before or alongside step 3, not after, since step 3 is exactly what makes the silent-destruction problem live.
5. Everything in §9 as separate, independently-scoped follow-ups.

---

## See also

- `feature-annotate.md` — the closest existing analog for "this changes what `buildOutputDoc()` produces, and has a raster-fallback path to reason about."
- `todos.md` — open product ideas list; this guide's summary line lives there.
