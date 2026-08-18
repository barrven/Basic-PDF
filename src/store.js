export async function getLibrary() {
  return (await window.electronAPI.getStoreValue('signatureLibrary')) ?? []
}

export async function addToLibrary(sig) {
  let lib = await getLibrary()
  lib.push(sig)
  if (lib.length > 20) lib = lib.slice(lib.length - 20)
  await window.electronAPI.setStoreValue('signatureLibrary', lib)
}
