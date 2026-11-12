# Implementation guide: cryptographic (digital) signatures

**Status:** design/implementation guide only — nothing here is built. The renderer-side sections were written against an earlier revision ("Keep highlighted text readable in the preview.", `3cce064`); the shell-side sections were revised for the Tauri shell and have not been prototyped. Cross-check `file:line` references against current source before coding; they will drift. Crate names in §3 are candidates to evaluate, not tested choices.

This describes how to add a real cryptographic signature (PAdES/PKCS#7, the kind Adobe Reader shows a blue ribbon for) on top of the existing signature *stamp* feature. It is a substantially bigger feature than it looks, because it touches the shell/renderer boundary, save semantics, and PDF's byte-level signing format — not just UI. Read the whole thing before starting; the "gotchas" section exists because each one was a redesign, not a bug fix, when skipped.

---

## 1. What exists today vs. what this adds

The current "signature" feature (`src/signature.js`, `appState.signatures`, `buildOutputDoc()` in `src/pdf-engine.js`) is a **visual stamp**: a drawn/uploaded/typed image dropped onto a page and burned in as a raster image at save time via `pdfPage.drawImage()`. It proves nothing — anyone can flatten the same PNG onto any PDF. There's no key, no certificate, no tamper-evidence.

A **digital signature** in the PDF sense (ISO 32000 §12.8, PAdES/CAdES) is a `/Sig` dictionary containing a detached PKCS#7 `SignedData` (CMS) blob, computed over a `/ByteRange` of the file's raw bytes, referenced from a widget annotation on an `AcroForm` `/Sig` field. Any byte changed after signing breaks the hash, and Acrobat/Reader will say so. This is what "add a digital component" means here.

These are two different things that happen to look similar in the UI (a rectangle on a page). Recommendation: keep the visual stamp as the *appearance* of a digital signature field, but treat "digitally sign" as an explicit opt-in per stamp, not a property that piggybacks silently on every stamp.

---

## 2. Architectural facts that drive every decision below

1. **pdf-lib cannot produce PDF signatures.** It has no `/ByteRange`, no CMS/PKCS#7, no incremental-update writer for this purpose. You need a second library purely for the signing step.
2. **Signing belongs in the shell, not the renderer.** The renderer is a WebView2 page with no filesystem or OS access beyond the commands the shell exposes (`src-tauri/src/lib.rs`, reached through `window.nativeAPI` in `src-tauri/src/bridge.js`), and a CSP that blocks arbitrary script loading (`index.html`). Private-key handling belongs in the **Rust shell** regardless — you don't want a private key or PFX passphrase held in a web page that also parses untrusted PDF content with pdf.js. This means new Tauri commands, mirroring how `read_file_bytes` / `save_file` already cross that boundary.
3. **`buildOutputDoc()` is a full rebuild, not an incremental update.** Every save constructs `PDFDocument.create()` from scratch and copies pages in (`src/pdf-engine.js:226-318`). It does not carry over the source file's `AcroForm`, `/Sig` dictionaries, or any prior incremental-update history. Consequence: **opening an already-signed PDF in this app and saving it will silently drop the existing signature**, with no warning today. That has to be fixed as part of this feature (§8), not left as a surprise.
4. **Signing is necessarily the last step before bytes hit disk.** The signed hash covers the exact byte range of the saved file. It must run after `buildOutputDoc()` → `newDoc.save()`, not before, and nothing may touch the returned bytes afterward except splicing the signature into the pre-sized placeholder (which is exactly what the signing library does).
5. **The signature's byte range must be reserved before the hash is computed**, and its size can't change afterward without invalidating offsets. This is the part hand-rolling would get wrong — use a library that already does it (§3).

---

## 3. Recommended dependencies

The work splits in two: the renderer reserves the signature placeholder with pdf-lib, and the shell computes the signature in Rust.

### Renderer: the placeholder

The `@signpdf` packages are the reference implementation for this in JavaScript, and `@signpdf/placeholder-pdf-lib` does exactly the placeholder step for pdf-lib. They are CommonJS packages written for Node, and this renderer has no bundler and loads only ES modules listed in `COPIES` in `src-tauri/scripts/assemble-frontend.mjs`, so they cannot be imported as-is. Two options:

- **Write a small local helper** (recommended), modelled on `@signpdf/placeholder-pdf-lib`. It adds, on the in-memory `PDFDocument` *before* `.save()`: the `AcroForm`, the `/Sig` field + widget annotation, a `/ByteRange` array with fixed-width placeholder values, and a `/Contents` hex string of reserved length. Read that package's source for the exact dictionary layout before writing it.
- **Vendor an ES-module build** of the package and add it to `COPIES`. More moving parts for about sixty lines of logic.

For PAdES-compliant output (recommended over the plain Adobe subfilter) use the `/SubFilter /ETSI.CAdES.detached` value.

### Shell: the signature (Rust)

Add to `src-tauri/Cargo.toml`. These are candidates from the RustCrypto family; confirm current versions, APIs and maintenance status before committing to them:

- **PKCS#12 parsing** (`p12` or `pkcs12`) — read a `.p12`/`.pfx` bundle, validate its password, extract the key and certificate chain.
- **X.509** (`x509-cert`) — read subject, issuer and expiry for display.
- **CMS** (`cms`) with `rsa` and `sha2` — build the detached `SignedData` over the two byte ranges. For PAdES the signed attributes must include `signing-certificate-v2`; check that the chosen crate lets you add it.
- **Self-signed generation** (`rcgen`) — keypair + certificate for users without an identity.
- **Key storage** — see §4.

The shell also has to do what `@signpdf/signpdf` does in JS: find the `/ByteRange` placeholder in the serialized bytes, write the real offsets into it without changing its length, hash everything outside `/Contents`, and write the hex-encoded CMS blob into `/Contents`, padded with zeros to the reserved length. This is plain byte manipulation, but the offsets must be exact; test it with §11 step 2.

None of this runs in the renderer.

---

## 4. Identity (certificate) management

Users need an X.509 certificate + private key to sign with. Two paths:

- **Import an existing PFX/P12** (their org's CA-issued identity, e-signature provider export, etc.) — password-protected file.
- **Generate a self-signed identity** in-app for people who don't have one. Must be clearly labeled as such: Acrobat/Reader will show "signature valid, signer identity unknown/untrusted" unless that cert is manually trusted or chains to a CA the verifier trusts.

### Storage

Do **not** put the PFX bytes or password in the settings file (`basic-pdf.json`, reached through `store_get` / `store_set` and used by `src/store.js`) as-is — it's plaintext JSON on disk, which is fine for the signature image library but not for key material. Protect it with the OS: on Windows that is DPAPI (`CryptProtectData`, available through the `windows` crate) or the Credential Manager (the `keyring` crate wraps it, and Keychain / Secret Service on other platforms). Keep the protected blob either in the OS store itself or in a dedicated file in the app config folder (`app.path().app_config_dir()`); decrypt only inside the shell, only at the moment of signing, and never return the decrypted bytes from a command.

Suggested shape for a stored identity record (shell side only):

```json
{
  "id": "uuid",
  "label": "Jane Doe (Acme Corp)",
  "subjectCN": "Jane Doe",
  "issuerCN": "Acme Corp CA",
  "notAfter": 1782000000000,
  "protectedPfx": "<base64 of the OS-protected PFX bytes>",
  "protectedPassword": "<base64 of the OS-protected password>"
}
```

`label` is shown in the UI and user-editable. `subjectCN`, `issuerCN` (or `Self-signed`) and `notAfter` are parsed from the certificate at import time, for display and to warn or block signing with an expired certificate.

Never expose `protectedPfx` / `protectedPassword` (or their decrypted form) to the renderer. The renderer only ever sees `{ id, label, subjectCN, issuerCN, notAfter }`.

### New shell commands (`src-tauri/src/lib.rs`)

Mirrors the existing pattern (`#[tauri::command]` functions registered in `generate_handler!`):

- `import_identity` — the renderer collects the password in a modal (there is no native password prompt) and calls `importIdentity(pfxBytes, password, label)`. The file itself can be picked with the existing dialog plugin, filtered to `.p12`/`.pfx`. The shell parses the bundle to validate the password and extract subject/issuer/expiry, protects it as above, stores the record, and returns the display-safe subset.
- `list_identities` — returns the display-safe array.
- `remove_identity` — deletes a stored record.
- `generate_self_signed_identity` — takes `{ commonName, label }`, generates an RSA keypair + self-signed X.509 certificate, stores it the same way as an import (no password, or a random one that never leaves the shell), returns the display-safe record.
- `sign_pdf` — see §6.

### Bridge additions (`src-tauri/src/bridge.js`)

Same shape as the existing `window.nativeAPI` entries. `sign_pdf` should carry the PDF as a raw body with its arguments in headers, the way `save_file` does, so the bytes are not JSON-encoded:

```js
importIdentity: (pfxBytes, password, label) =>
  invoke('import_identity', { pfxBytes: Array.from(pfxBytes), password, label }),
listIdentities: () => invoke('list_identities'),
removeIdentity: (id) => invoke('remove_identity', { id }),
generateSelfSignedIdentity: (commonName, label) =>
  invoke('generate_self_signed_identity', { commonName, label }),
signPdf: async (pdfBytes, identityId) =>
  new Uint8Array(
    await invoke('sign_pdf', toBytes(pdfBytes), { headers: { 'x-identity': header(identityId) } })
  ),
```

A PFX is a few kilobytes, so passing it as a JSON array is acceptable there.
---

## 5. Data model changes (renderer)

Extend a signature entry (`appState.signatures`, currently `{ id, pageIndex, x, y, width, height, opacity, dataUrl }`, `src/state.js`) with two optional fields:

```js
{ ..., digital: false, identityId: null }
```

- `digital: true` marks this stamp as also being the appearance for a cryptographic signature.
- `identityId` references a stored identity (from `listIdentities()`), resolved to a display label in the UI.

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
  await addSignaturePlaceholder({   // local helper, see §3
    pdfDoc: newDoc,
    reason: digitalSig.reason || '',
    contactInfo: digitalSig.contactInfo || '',
    name: digitalSig.signerLabel || '',
    location: digitalSig.location || '',
    // widget placement on digitalSig.pageIndex using widgetRect
    // subFilter: 'ETSI.CAdES.detached', // for PAdES
  })
  const unsignedBytes = await newDoc.save()

  // The shell holds the private key; the renderer never sees it.
  return await window.nativeAPI.signPdf(unsignedBytes, digitalSig.identityId)
}
```

Then `saveDocument()` and `saveAs()` (`src/pdf-engine.js:320-380`) both call `buildOutputBytes()` instead of `newDoc.save()` directly. Both already route through `withDocumentLoading()` when `hasRedactions()` — extend that same "show the overlay" condition to `Boolean(pendingDigitalSignature())`, since signing (a round-trip to the shell plus the crypto there) is not instant and the UI should not look frozen.

### Shell `sign_pdf` command

In outline (the crypto calls depend on the crates chosen in §3):

```rust
#[tauri::command]
fn sign_pdf(app: AppHandle, request: Request<'_>) -> CmdResult<Response> {
    let identity_id = header_value(&request, "x-identity")?;
    let InvokeBody::Raw(pdf) = request.body() else {
        return Err("sign_pdf expects a raw byte body".into());
    };
    let record = identity_record(&app, &identity_id).ok_or("Signing identity not found")?;
    if record.not_after < now_millis() {
        return Err("Signing certificate has expired".into());
    }
    let (pfx, password) = unprotect(&record)?;            // OS-protected -> plaintext, shell only
    let mut out = pdf.clone();
    let ranges = fix_byte_range(&mut out)?;               // write real offsets into /ByteRange
    let cms = detached_signed_data(&pfx, &password, &out, &ranges)?;
    write_contents(&mut out, &cms)?;                      // hex, zero-padded to the reserved length
    Ok(Response::new(out))
}
```

Decrypted key material (`pfx`, `password`, and everything derived from them) should go out of scope as soon as the signature is built — don't cache it, don't log it, and don't let it end up in an error string returned to the renderer.
---

## 7. UI changes

### Signature modal (`src/signature.js`, `#signature-modal`)

Add a third tab or a post-draw/upload step: after the user confirms a drawn/uploaded signature (`onSignatureConfirmed()`, `src/signature.js:310-320`), if any identities exist (`window.nativeAPI.listIdentities()`), show a checkbox: **"Also apply a cryptographic signature"**, with a dropdown of stored identities (label + subject CN) and optional reason/location text fields. If no identity exists yet, offer **"Add a signing identity"** inline (opens the import/self-signed flow) rather than dead-ending the user.

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
- **RFC 3161 timestamping (TSA).** Without it, a signature's long-term validity depends on the signing cert still being valid/unexpired at verification time. It can be added later, but it's a separate integration (a TSA client + embedding the timestamp token in the CMS) — track as a follow-up, not v1.
- **OCSP/CRL revocation checking.** Verification-side concern, not signing-side; out of scope.
- **DocMDP ("certifying") signatures and lock-after-signing (form fill only / no changes allowed) transform params.** Meaningful once §8's rebuild-destroys-signature problem is actually solved with incremental updates; not worth doing on top of a full-rebuild save pipeline.
- **PKCS#11 / hardware token signing (smart cards, YubiKey, etc.).** Different signer implementation entirely; note as a future identity-source option alongside PFX import.

---

## 10. Security checklist

- Private key material (decrypted PFX bytes, the stored passphrase, anything derived from them) never crosses back into the renderer. Only display-safe identity metadata does. The one exception is import, where the renderer hands the PFX and the password the user just typed to the shell; clear those from renderer memory as soon as the call returns.
- PFX/passphrase at rest: OS-protected (DPAPI or Credential Manager on Windows), not the plaintext settings file.
- Validate the PFX password at import time (catch the PKCS#12 decryption error) and surface a clear "wrong password" error rather than storing something that will fail silently at sign time.
- Check certificate expiry both at import (warn) and at sign time (`sign_pdf` command, hard error if expired — a signature is worth less than nothing if it's plainly out of date).
- Self-signed identities: label them as such everywhere they appear in the UI (dropdown, popover, placed-stamp badge) so users don't mistake them for a trusted CA-issued signature.
- Treat imported `.pfx`/`.p12` files like any other user-selected file path — no special validation beyond what the PKCS#12 parser already enforces; don't shell out, and don't interpret anything from the file.
- Don't log signed/unsigned PDF bytes, PFX bytes, or passwords, even at debug level, in the shell or the renderer.

---

## 11. Verification / testing plan

There's no test suite in this repo (per `../CLAUDE.md`), so verification here is manual:

1. Sign a document with a self-signed identity, open the output in Adobe Acrobat Reader (or `qpdf --check` / `pdfsig` from poppler-utils) — confirm it reports "signed" with a valid hash and an untrusted-signer warning (expected for self-signed).
2. Sign, then modify a single byte of the saved file (e.g. append a space) and re-check with `pdfsig` — confirm it now reports the signature as invalid. This is the actual proof the byte-range/hash plumbing is correct, not just "a `/Sig` dict exists."
3. Open a signed PDF from this app, make an unrelated edit (e.g. rotate a page), save, and confirm the §8 warning appeared and that the resulting file no longer validates as signed (expected until incremental-update preservation is built).
4. Round-trip through the existing redaction/highlight/stamp code paths with a digital signature pending, to confirm `buildOutputDoc()` + the placeholder step don't interact badly (e.g. a redacted page that gets flattened to PNG, `rasterizeRedactedPage()`, still ends up as page N in `newDoc` before `addSignaturePlaceholder()` looks up `newDoc.getPage(digitalSig.pageIndex)` — page indices must be assigned before the placeholder step runs, which the flow in §6 already respects since it comes after the full `buildOutputDoc()` loop).
5. Expired-certificate path: import a deliberately expired test cert, confirm `sign_pdf` rejects it with a clear error instead of producing an unverifiable/garbage signature.

---

## 12. Suggested phased rollout

1. **Plumbing only, no UI:** `sign_pdf` / `list_identities` / `import_identity` commands, OS-protected storage, and a throwaway dev test that signs a fixed test PDF with a hardcoded self-signed identity. Verify with `pdfsig`/Acrobat before touching any renderer UI.
2. **Self-signed identity generation + import**, surfaced in the signature popover, with expiry/label display. No signing wired to save yet.
3. **Save-flow integration** (§6): one digital signature per save, placed via the existing stamp-placement flow with the new modal checkbox.
4. **§8's already-signed-PDF warning** — should land before or alongside step 3, not after, since step 3 is exactly what makes the silent-destruction problem live.
5. Everything in §9 as separate, independently-scoped follow-ups.

---

## See also

- `feature-annotate.md` — the closest existing analog for "this changes what `buildOutputDoc()` produces, and has a raster-fallback path to reason about."
- `../todos.md` — open product ideas list; this guide's summary line lives there.
