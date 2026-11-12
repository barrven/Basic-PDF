export async function getLibrary() {
  return (await window.nativeAPI.getStoreValue('signatureLibrary')) ?? []
}

export async function addToLibrary(sig) {
  let lib = await getLibrary()
  lib.push(sig)
  if (lib.length > 20) lib = lib.slice(lib.length - 20)
  await window.nativeAPI.setStoreValue('signatureLibrary', lib)
}

export async function removeFromLibrary(id) {
  const lib = await getLibrary()
  const next = lib.filter((s) => s.id !== id)
  await window.nativeAPI.setStoreValue('signatureLibrary', next)
  return next
}
