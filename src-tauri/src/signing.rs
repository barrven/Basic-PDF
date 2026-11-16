//! Cryptographic (PAdES) signing.
//!
//! The renderer reserves a `/Sig` placeholder in the PDF it builds (fixed-width
//! `/ByteRange` and a zero-filled `/Contents`); `sign_pdf` here finds the
//! placeholder, hashes everything outside `/Contents`, builds a detached CMS
//! `SignedData` (ETSI.CAdES.detached) and writes it into the gap. Private keys
//! never leave this module: they are stored protected by the OS (DPAPI on
//! Windows) and only the display-safe subset of an identity reaches the renderer.

use std::path::PathBuf;
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use cms::cert::{CertificateChoices, IssuerAndSerialNumber};
use cms::content_info::{CmsVersion, ContentInfo};
use cms::signed_data::{
    CertificateSet, EncapsulatedContentInfo, SignedData, SignerIdentifier, SignerInfo, SignerInfos,
};
use der::asn1::{ObjectIdentifier, OctetString, SetOfVec, UtcTime};
use der::{Any, Decode, Encode};
use p256::ecdsa::{DerSignature, SigningKey as P256Key};
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey};
use rand_core::{OsRng, RngCore};
use rsa::RsaPrivateKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spki::{AlgorithmIdentifierOwned, SubjectPublicKeyInfoOwned};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};
use x509_cert::attr::Attribute;
use x509_cert::builder::{Builder, CertificateBuilder, Profile};
use x509_cert::name::Name;
use x509_cert::serial_number::SerialNumber;
use x509_cert::time::Validity;
use x509_cert::Certificate;

type CmdResult<T> = Result<T, String>;

const IDENTITIES_FILE: &str = "identities.json";

const OID_DATA: &str = "1.2.840.113549.1.7.1";
const OID_SIGNED_DATA: &str = "1.2.840.113549.1.7.2";
const OID_CONTENT_TYPE: &str = "1.2.840.113549.1.9.3";
const OID_MESSAGE_DIGEST: &str = "1.2.840.113549.1.9.4";
const OID_SIGNING_TIME: &str = "1.2.840.113549.1.9.5";
const OID_SIGNING_CERT_V2: &str = "1.2.840.113549.1.9.16.2.47";
const OID_SHA256: &str = "2.16.840.1.101.3.4.2.1";
const OID_ECDSA_SHA256: &str = "1.2.840.10045.4.3.2";
const OID_RSA_SHA256: &str = "1.2.840.113549.1.1.11";

/// Must match the placeholder the renderer writes (src/pdf-signature.js), including
/// the spacing pdf-lib uses when it serializes an array.
const BYTE_RANGE_PLACEHOLDER: &[u8] = b"/ByteRange [ 0 1234567890 1234567890 1234567890 ]";

fn oid(s: &str) -> ObjectIdentifier {
    ObjectIdentifier::new_unwrap(s)
}

fn msg<E: std::fmt::Display>(_context: &str, e: E) -> String {
    // Never include key material in errors; keep the underlying message short.
    format!("{_context}: {e}")
}

// ------------------------------------------------------------ OS protection --

#[cfg(windows)]
mod os_protect {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(&input, PCWSTR::null(), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
                .map_err(|e| format!("Could not protect the key: {e}"))?;
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(HLOCAL(out.pbData as *mut _));
            Ok(bytes)
        }
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
                .map_err(|e| format!("Could not unlock the stored identity: {e}"))?;
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(HLOCAL(out.pbData as *mut _));
            Ok(bytes)
        }
    }
}

#[cfg(not(windows))]
mod os_protect {
    pub fn protect(_data: &[u8]) -> Result<Vec<u8>, String> {
        Err("Protected key storage is only implemented on Windows.".into())
    }
    pub fn unprotect(_data: &[u8]) -> Result<Vec<u8>, String> {
        Err("Protected key storage is only implemented on Windows.".into())
    }
}

// ----------------------------------------------------------------- storage --

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StoredIdentity {
    id: String,
    label: String,
    subject_cn: String,
    issuer_cn: String,
    self_signed: bool,
    /// Milliseconds since the Unix epoch.
    not_after: i64,
    /// base64 of the OS-protected `KeyMaterial` JSON.
    protected: String,
}

/// What the renderer is allowed to see.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityInfo {
    id: String,
    label: String,
    subject_cn: String,
    issuer_cn: String,
    self_signed: bool,
    not_after: i64,
}

impl From<&StoredIdentity> for IdentityInfo {
    fn from(s: &StoredIdentity) -> Self {
        IdentityInfo {
            id: s.id.clone(),
            label: s.label.clone(),
            subject_cn: s.subject_cn.clone(),
            issuer_cn: s.issuer_cn.clone(),
            self_signed: s.self_signed,
            not_after: s.not_after,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct KeyMaterial {
    /// "p256" or "rsa"
    alg: String,
    /// base64 PKCS#8 DER
    key: String,
    /// base64 DER certificates, signer's certificate first
    chain: Vec<String>,
}

enum Key {
    P256(P256Key),
    Rsa(Box<RsaPrivateKey>),
}

fn identities_path(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app.path().app_config_dir().map_err(|e| msg("config folder", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| msg("config folder", e))?;
    Ok(dir.join(IDENTITIES_FILE))
}

fn load_identities(app: &AppHandle) -> CmdResult<Vec<StoredIdentity>> {
    let path = identities_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| msg("identities file", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(msg("identities file", e)),
    }
}

fn save_identities(app: &AppHandle, list: &[StoredIdentity]) -> CmdResult<()> {
    let path = identities_path(app)?;
    let text = serde_json::to_string_pretty(list).map_err(|e| msg("identities file", e))?;
    std::fs::write(path, text).map_err(|e| msg("identities file", e))
}

fn random_id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ------------------------------------------------------------ certificates --

fn common_name(name: &Name) -> String {
    let text = name.to_string();
    for part in text.split(',') {
        if let Some(cn) = part.trim().strip_prefix("CN=") {
            return cn.to_string();
        }
    }
    text
}

fn cert_not_after_millis(cert: &Certificate) -> i64 {
    cert.tbs_certificate.validity.not_after.to_unix_duration().as_millis() as i64
}

fn load_key(alg: &str, pkcs8: &[u8]) -> CmdResult<Key> {
    match alg {
        "p256" => P256Key::from_pkcs8_der(pkcs8).map(Key::P256).map_err(|e| msg("key", e)),
        "rsa" => RsaPrivateKey::from_pkcs8_der(pkcs8).map(|k| Key::Rsa(Box::new(k))).map_err(|e| msg("key", e)),
        other => Err(format!("Unsupported key type: {other}")),
    }
}

fn public_spki_der(key: &Key) -> CmdResult<Vec<u8>> {
    let doc = match key {
        Key::P256(k) => k.verifying_key().to_public_key_der(),
        Key::Rsa(k) => rsa::RsaPublicKey::from(k.as_ref()).to_public_key_der(),
    };
    doc.map(|d| d.as_bytes().to_vec()).map_err(|e| msg("public key", e))
}

/// Sort the chain so the certificate matching the private key comes first.
fn order_chain(key: &Key, certs: Vec<Certificate>) -> CmdResult<Vec<Certificate>> {
    let want = public_spki_der(key)?;
    let mut leaf = None;
    let mut rest = Vec::new();
    for c in certs {
        let spki = c.tbs_certificate.subject_public_key_info.to_der().map_err(|e| msg("certificate", e))?;
        if leaf.is_none() && spki == want {
            leaf = Some(c);
        } else {
            rest.push(c);
        }
    }
    let leaf = leaf.ok_or("The certificate in this file does not match its private key.")?;
    let mut out = vec![leaf];
    out.extend(rest);
    Ok(out)
}

fn store_identity(
    app: &AppHandle,
    label: String,
    alg: &str,
    pkcs8: &[u8],
    chain: &[Certificate],
) -> CmdResult<IdentityInfo> {
    let leaf = chain.first().ok_or("No certificate found.")?;
    let subject = common_name(&leaf.tbs_certificate.subject);
    let issuer = common_name(&leaf.tbs_certificate.issuer);
    let self_signed = leaf.tbs_certificate.subject == leaf.tbs_certificate.issuer;
    let chain_b64 = chain
        .iter()
        .map(|c| c.to_der().map(|d| B64.encode(d)).map_err(|e| msg("certificate", e)))
        .collect::<CmdResult<Vec<_>>>()?;
    let material = KeyMaterial { alg: alg.to_string(), key: B64.encode(pkcs8), chain: chain_b64 };
    let json = serde_json::to_vec(&material).map_err(|e| msg("identity", e))?;
    let protected = B64.encode(os_protect::protect(&json)?);
    let record = StoredIdentity {
        id: random_id(),
        label: if label.trim().is_empty() { subject.clone() } else { label.trim().to_string() },
        subject_cn: subject,
        issuer_cn: issuer,
        self_signed,
        not_after: cert_not_after_millis(leaf),
        protected,
    };
    let info = IdentityInfo::from(&record);
    let mut list = load_identities(app)?;
    list.push(record);
    save_identities(app, &list)?;
    Ok(info)
}

fn make_self_signed(common_name: &str) -> CmdResult<(P256Key, Certificate)> {
    // Strip characters that would change the meaning of the RFC 4514 name string.
    let cn: String = common_name
        .chars()
        .map(|c| if ",+\"\\<>;=#".contains(c) || c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string();
    if cn.is_empty() {
        return Err("Enter a name for the certificate.".into());
    }
    let key = P256Key::random(&mut OsRng);
    let spki = SubjectPublicKeyInfoOwned::from_key(*key.verifying_key()).map_err(|e| msg("public key", e))?;
    let subject = Name::from_str(&format!("CN={cn}")).map_err(|e| msg("name", e))?;
    let validity = Validity::from_now(Duration::from_secs(5 * 365 * 24 * 3600)).map_err(|e| msg("validity", e))?;
    let mut serial_bytes = [0u8; 8];
    OsRng.fill_bytes(&mut serial_bytes);
    serial_bytes[0] &= 0x7f;
    serial_bytes[0] |= 0x01; // non-zero, positive
    let serial = SerialNumber::new(&serial_bytes).map_err(|e| msg("serial", e))?;
    let builder = CertificateBuilder::new(Profile::Root, serial, validity, subject, spki, &key)
        .map_err(|e| msg("certificate", e))?;
    let cert = builder.build::<DerSignature>().map_err(|e| msg("certificate", e))?;
    Ok((key, cert))
}

// -------------------------------------------------------------------- CMS --

fn attribute(attr_oid: &str, value: Any) -> CmdResult<Attribute> {
    Ok(Attribute {
        oid: oid(attr_oid),
        values: SetOfVec::try_from(vec![value]).map_err(|e| msg("attribute", e))?,
    })
}

fn build_cms(key: &Key, chain: &[Certificate], content_digest: &[u8]) -> CmdResult<Vec<u8>> {
    let leaf = chain.first().ok_or("No certificate found.")?;
    let leaf_der = leaf.to_der().map_err(|e| msg("certificate", e))?;

    // signing-certificate-v2 (RFC 5035): SEQUENCE { SEQUENCE OF ESSCertIDv2 { certHash } }.
    // The hash algorithm defaults to SHA-256, so it is omitted.
    let mut sc2 = vec![0x30, 0x26, 0x30, 0x24, 0x30, 0x22, 0x04, 0x20];
    sc2.extend_from_slice(&Sha256::digest(&leaf_der));

    let signing_time = UtcTime::from_unix_duration(
        SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| msg("clock", e))?,
    )
    .map_err(|e| msg("clock", e))?;

    let attrs = vec![
        attribute(OID_CONTENT_TYPE, Any::encode_from(&oid(OID_DATA)).map_err(|e| msg("attr", e))?)?,
        attribute(
            OID_MESSAGE_DIGEST,
            Any::encode_from(&OctetString::new(content_digest).map_err(|e| msg("attr", e))?).map_err(|e| msg("attr", e))?,
        )?,
        attribute(OID_SIGNING_TIME, Any::encode_from(&signing_time).map_err(|e| msg("attr", e))?)?,
        attribute(OID_SIGNING_CERT_V2, Any::from_der(&sc2).map_err(|e| msg("attr", e))?)?,
    ];
    let signed_attrs: SetOfVec<Attribute> = SetOfVec::try_from(attrs).map_err(|e| msg("attributes", e))?;

    // The signature covers the DER of the attributes encoded as a SET.
    let to_sign = signed_attrs.to_der().map_err(|e| msg("attributes", e))?;
    let (sig_bytes, sig_alg) = match key {
        Key::P256(k) => {
            use p256::ecdsa::signature::Signer;
            let sig: DerSignature = k.sign(&to_sign);
            (sig.to_bytes().to_vec(), AlgorithmIdentifierOwned { oid: oid(OID_ECDSA_SHA256), parameters: None })
        }
        Key::Rsa(k) => {
            use rsa::signature::{SignatureEncoding, Signer};
            let signer = rsa::pkcs1v15::SigningKey::<Sha256>::new((**k).clone());
            let sig = signer.sign(&to_sign);
            (sig.to_vec(), AlgorithmIdentifierOwned { oid: oid(OID_RSA_SHA256), parameters: Some(Any::null()) })
        }
    };

    let sha256 = AlgorithmIdentifierOwned { oid: oid(OID_SHA256), parameters: None };
    let signer_info = SignerInfo {
        version: CmsVersion::V1,
        sid: SignerIdentifier::IssuerAndSerialNumber(IssuerAndSerialNumber {
            issuer: leaf.tbs_certificate.issuer.clone(),
            serial_number: leaf.tbs_certificate.serial_number.clone(),
        }),
        digest_alg: sha256.clone(),
        signed_attrs: Some(signed_attrs),
        signature_algorithm: sig_alg,
        signature: OctetString::new(sig_bytes).map_err(|e| msg("signature", e))?,
        unsigned_attrs: None,
    };

    let certs = chain
        .iter()
        .cloned()
        .map(CertificateChoices::Certificate)
        .collect::<Vec<_>>();
    let signed_data = SignedData {
        version: CmsVersion::V1,
        digest_algorithms: SetOfVec::try_from(vec![sha256]).map_err(|e| msg("digest algorithms", e))?,
        encap_content_info: EncapsulatedContentInfo { econtent_type: oid(OID_DATA), econtent: None },
        certificates: Some(CertificateSet(SetOfVec::try_from(certs).map_err(|e| msg("certificates", e))?)),
        crls: None,
        signer_infos: SignerInfos(SetOfVec::try_from(vec![signer_info]).map_err(|e| msg("signer info", e))?),
    };
    let info = ContentInfo {
        content_type: oid(OID_SIGNED_DATA),
        content: Any::encode_from(&signed_data).map_err(|e| msg("signed data", e))?,
    };
    info.to_der().map_err(|e| msg("signed data", e))
}

// -------------------------------------------------------------- PDF bytes --

fn find_all(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    let mut out = Vec::new();
    if needle.is_empty() || haystack.len() < needle.len() {
        return out;
    }
    let mut i = 0;
    while i + needle.len() <= haystack.len() {
        if &haystack[i..i + needle.len()] == needle {
            out.push(i);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

/// Sign `pdf` (which carries the renderer's placeholder). Returns the signed bytes.
fn sign_pdf_bytes(pdf: &[u8], key: &Key, chain: &[Certificate]) -> CmdResult<Vec<u8>> {
    let br = find_all(pdf, BYTE_RANGE_PLACEHOLDER);
    if br.len() != 1 {
        return Err("The document has no signature placeholder to sign.".into());
    }
    let br_pos = br[0];

    // The placeholder /Contents is a long run of zeros inside <...>.
    let mut contents = None;
    for pos in find_all(pdf, b"/Contents <") {
        let start = pos + b"/Contents ".len(); // index of '<'
        let body = &pdf[start + 1..];
        let zeros = body.iter().take_while(|&&b| b == b'0').count();
        if zeros >= 64 && body.get(zeros) == Some(&b'>') {
            contents = Some((start, start + 1 + zeros + 1));
            break;
        }
    }
    let (c_start, c_end) = contents.ok_or("The document has no signature placeholder to sign.")?;
    if c_start < br_pos && c_end > br_pos {
        return Err("Malformed signature placeholder.".into());
    }

    let mut out = pdf.to_vec();
    let range = format!(
        "/ByteRange [ 0 {:010} {:010} {:010} ]",
        c_start,
        c_end,
        pdf.len() - c_end
    );
    debug_assert_eq!(range.len(), BYTE_RANGE_PLACEHOLDER.len());
    out[br_pos..br_pos + range.len()].copy_from_slice(range.as_bytes());

    let mut hasher = Sha256::new();
    hasher.update(&out[..c_start]);
    hasher.update(&out[c_end..]);
    let digest = hasher.finalize();

    let cms = build_cms(key, chain, &digest)?;
    let hex: String = cms.iter().map(|b| format!("{b:02X}")).collect();
    let capacity = c_end - c_start - 2;
    if hex.len() > capacity {
        return Err("The signature does not fit in the space reserved for it.".into());
    }
    let mut padded = hex.into_bytes();
    padded.resize(capacity, b'0');
    out[c_start + 1..c_end - 1].copy_from_slice(&padded);
    Ok(out)
}

// --------------------------------------------------------------- commands --

#[tauri::command]
pub fn list_identities(app: AppHandle) -> CmdResult<Vec<IdentityInfo>> {
    Ok(load_identities(&app)?.iter().map(IdentityInfo::from).collect())
}

#[tauri::command]
pub fn remove_identity(app: AppHandle, id: String) -> CmdResult<()> {
    let mut list = load_identities(&app)?;
    list.retain(|r| r.id != id);
    save_identities(&app, &list)
}

#[tauri::command(async)]
pub fn generate_self_signed_identity(
    app: AppHandle,
    common_name: String,
    label: String,
) -> CmdResult<IdentityInfo> {
    let (key, cert) = make_self_signed(&common_name)?;
    let pkcs8 = key.to_pkcs8_der().map_err(|e| msg("key", e))?;
    store_identity(&app, label, "p256", pkcs8.as_bytes(), &[cert])
}

/// Open a PKCS#12 bundle: (algorithm, PKCS#8 key, certificate chain with the
/// signer's certificate first).
fn parse_pfx(pfx: &[u8], password: &str) -> CmdResult<(&'static str, Vec<u8>, Vec<Certificate>)> {
    use p12_keystore::{KeyStore, Pkcs12ImportPolicy};
    let store = KeyStore::from_pkcs12(pfx, password, Pkcs12ImportPolicy::Strict).map_err(|_| {
        "Could not open that file. Check the password and that it is a valid .p12 or .pfx file.".to_string()
    })?;
    let (_, keychain) = store
        .private_key_chain()
        .ok_or("That file does not contain a private key and certificate.")?;
    let pkcs8 = keychain.key().as_der().to_vec();
    let (key, alg) = match load_key("p256", &pkcs8) {
        Ok(k) => (k, "p256"),
        Err(_) => (
            load_key("rsa", &pkcs8).map_err(|_| "Unsupported key type. Use an RSA or P-256 certificate.".to_string())?,
            "rsa",
        ),
    };
    let certs = keychain
        .certs()
        .iter()
        .map(|c| Certificate::from_der(c.as_der()).map_err(|e| msg("certificate", e)))
        .collect::<CmdResult<Vec<_>>>()?;
    let chain = order_chain(&key, certs)?;
    Ok((alg, pkcs8, chain))
}

#[tauri::command(async)]
pub fn import_identity(
    app: AppHandle,
    pfx_bytes: Vec<u8>,
    password: String,
    label: String,
) -> CmdResult<IdentityInfo> {
    let (alg, pkcs8, chain) = parse_pfx(&pfx_bytes, &password)?;
    store_identity(&app, label, alg, &pkcs8, &chain)
}

/// Body: the PDF with its signature placeholder. Header `x-identity`: percent-encoded id.
#[tauri::command(async)]
pub fn sign_pdf(app: AppHandle, request: Request<'_>) -> CmdResult<Response> {
    let encoded = request
        .headers()
        .get("x-identity")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-identity header")?;
    let id = percent_encoding::percent_decode_str(encoded).decode_utf8().map_err(|e| msg("identity", e))?.into_owned();
    let InvokeBody::Raw(pdf) = request.body() else {
        return Err("sign_pdf expects a raw byte body".into());
    };
    let record = load_identities(&app)?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or("The signing identity was not found.")?;
    if record.not_after < now_millis() {
        return Err("The signing certificate has expired.".into());
    }
    let protected = B64.decode(&record.protected).map_err(|e| msg("identity", e))?;
    let json = os_protect::unprotect(&protected)?;
    let material: KeyMaterial = serde_json::from_slice(&json).map_err(|e| msg("identity", e))?;
    let key = load_key(&material.alg, &B64.decode(&material.key).map_err(|e| msg("key", e))?)?;
    let chain = material
        .chain
        .iter()
        .map(|c| {
            let der = B64.decode(c).map_err(|e| msg("certificate", e))?;
            Certificate::from_der(&der).map_err(|e| msg("certificate", e))
        })
        .collect::<CmdResult<Vec<_>>>()?;
    let signed = sign_pdf_bytes(pdf, &key, &chain)?;
    Ok(Response::new(signed))
}

// ------------------------------------------------------------------ tests --

#[cfg(test)]
mod tests {
    use super::*;

    fn placeholder_pdf() -> Vec<u8> {
        let mut pdf = b"%PDF-1.7\n1 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached ".to_vec();
        pdf.extend_from_slice(BYTE_RANGE_PLACEHOLDER);
        pdf.extend_from_slice(b" /Contents <");
        pdf.extend(std::iter::repeat(b'0').take(16384));
        pdf.extend_from_slice(b"> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
        pdf
    }

    #[test]
    fn signs_placeholder_with_p256() {
        let (key, cert) = make_self_signed("Test Signer").unwrap();
        let pdf = placeholder_pdf();
        let signed = sign_pdf_bytes(&pdf, &Key::P256(key), &[cert]).unwrap();
        assert_eq!(signed.len(), pdf.len());
        let text = String::from_utf8_lossy(&signed);
        assert!(!text.contains("1234567890"));
        if let Ok(path) = std::env::var("SIGN_TEST_OUT") {
            std::fs::write(path, &signed).unwrap();
        }
    }

    // Set SIGN_TEST_PFX / SIGN_TEST_PFX_PASSWORD / SIGN_TEST_OUT to exercise PFX import and RSA signing.
    #[test]
    fn signs_with_imported_pfx() {
        let (Ok(path), Ok(password), Ok(out)) = (
            std::env::var("SIGN_TEST_PFX"),
            std::env::var("SIGN_TEST_PFX_PASSWORD"),
            std::env::var("SIGN_TEST_PFX_OUT"),
        ) else {
            return;
        };
        let bytes = std::fs::read(path).unwrap();
        assert!(parse_pfx(&bytes, "wrong password").is_err());
        let (alg, pkcs8, chain) = parse_pfx(&bytes, &password).unwrap();
        let key = load_key(alg, &pkcs8).unwrap();
        let signed = sign_pdf_bytes(&placeholder_pdf(), &key, &chain).unwrap();
        std::fs::write(out, signed).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn os_protection_round_trips() {
        let secret = b"not a real key".to_vec();
        let sealed = os_protect::protect(&secret).unwrap();
        assert_ne!(sealed, secret);
        assert_eq!(os_protect::unprotect(&sealed).unwrap(), secret);
    }

    // Set SIGN_TEST_PDF / SIGN_TEST_PDF_OUT to sign a PDF produced by the renderer.
    #[test]
    fn signs_renderer_output() {
        let (Ok(input), Ok(out)) = (std::env::var("SIGN_TEST_PDF"), std::env::var("SIGN_TEST_PDF_OUT")) else {
            return;
        };
        let (key, cert) = make_self_signed("Renderer Test").unwrap();
        let pdf = std::fs::read(input).unwrap();
        let signed = sign_pdf_bytes(&pdf, &Key::P256(key), &[cert]).unwrap();
        std::fs::write(out, signed).unwrap();
    }

    #[test]
    fn rejects_missing_placeholder() {
        let (key, cert) = make_self_signed("Test Signer").unwrap();
        assert!(sign_pdf_bytes(b"%PDF-1.7\n%%EOF\n", &Key::P256(key), &[cert]).is_err());
    }

    #[test]
    fn self_signed_name_is_sanitised() {
        let (_, cert) = make_self_signed("Evil, O=Corp").unwrap();
        assert_eq!(common_name(&cert.tbs_certificate.subject), "Evil  O Corp");
    }
}
