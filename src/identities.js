import { showToast } from './main.js'

// Signing identities (certificate + key). The shell stores and protects them;
// this module only lists, creates, imports and removes, and remembers whether
// newly placed stamps should also carry a cryptographic signature.

const CHOICE_KEY = 'digitalSignatureChoice'

let cache = []
let choice = { enabled: false, identityId: null }

try {
  const saved = JSON.parse(localStorage.getItem(CHOICE_KEY) || 'null')
  if (saved && typeof saved === 'object') choice = { enabled: !!saved.enabled, identityId: saved.identityId || null }
} catch {}

function persistChoice() {
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(choice))
  } catch {}
}

export async function refreshIdentities() {
  try {
    cache = (await window.nativeAPI.listIdentities()) || []
  } catch (err) {
    console.error(err)
    cache = []
  }
  // Forget a choice that points at a removed identity.
  if (choice.identityId && !cache.some((i) => i.id === choice.identityId)) {
    choice = { enabled: false, identityId: null }
    persistChoice()
  }
  return cache
}

export function getIdentities() {
  return cache
}

// The identity new stamps should be signed with, or null for a plain stamp.
export function activeIdentity() {
  if (!choice.enabled || !choice.identityId) return null
  return cache.find((i) => i.id === choice.identityId) || null
}

export function isExpired(identity) {
  return identity.notAfter < Date.now()
}

function describe(identity) {
  const parts = [identity.subjectCn]
  parts.push(identity.selfSigned ? 'self-signed' : `issued by ${identity.issuerCn}`)
  const date = new Date(identity.notAfter).toLocaleDateString()
  parts.push(isExpired(identity) ? `expired ${date}` : `expires ${date}`)
  return parts.join(' · ')
}

// ─────────── "Also apply a cryptographic signature" row ───────────

export function renderChoiceRow(container) {
  container.replaceChildren()
  container.classList.add('digital-choice')

  const label = document.createElement('label')
  label.className = 'digital-choice-check'
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = choice.enabled && !!choice.identityId
  box.disabled = cache.length === 0
  label.append(box, document.createTextNode(' Also apply a cryptographic signature'))
  container.appendChild(label)

  if (cache.length === 0) {
    const hint = document.createElement('span')
    hint.className = 'digital-choice-hint'
    hint.textContent = 'No signing identity yet. Add one from the saved-signatures menu (▾).'
    container.appendChild(hint)
    return
  }

  const select = document.createElement('select')
  select.setAttribute('aria-label', 'Signing identity')
  for (const id of cache) {
    const o = document.createElement('option')
    o.value = id.id
    o.textContent = `${id.label}${id.selfSigned ? ' (self-signed)' : ''}${isExpired(id) ? ' (expired)' : ''}`
    select.appendChild(o)
  }
  select.value = choice.identityId && cache.some((i) => i.id === choice.identityId) ? choice.identityId : cache[0].id
  select.disabled = !box.checked
  container.appendChild(select)

  box.addEventListener('change', () => {
    choice = { enabled: box.checked, identityId: select.value }
    select.disabled = !box.checked
    persistChoice()
  })
  select.addEventListener('change', () => {
    choice = { enabled: box.checked, identityId: select.value }
    persistChoice()
  })
}

// ─────────── Management section (inside the signature popover) ───────────

export async function renderIdentitySection(container, onChange) {
  await refreshIdentities()
  const section = document.createElement('div')
  section.className = 'identity-section'

  const heading = document.createElement('div')
  heading.className = 'identity-heading'
  heading.textContent = 'Signing identities'
  section.appendChild(heading)

  if (cache.length === 0) {
    const p = document.createElement('p')
    p.className = 'identity-empty'
    p.textContent = 'None yet. A signing identity lets you add a cryptographic signature that shows if the file is changed afterwards.'
    section.appendChild(p)
  }
  for (const id of cache) {
    const row = document.createElement('div')
    row.className = 'identity-row'
    const text = document.createElement('div')
    text.className = 'identity-text'
    const name = document.createElement('div')
    name.className = 'identity-name'
    name.textContent = id.label
    const detail = document.createElement('div')
    detail.className = 'identity-detail'
    detail.textContent = describe(id)
    if (isExpired(id)) detail.classList.add('identity-expired')
    text.append(name, detail)
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'sig-library-delete'
    del.title = 'Remove this identity'
    del.setAttribute('aria-label', 'Remove ' + id.label)
    del.textContent = '×'
    del.addEventListener('click', async (e) => {
      e.stopPropagation()
      const ok = await window.nativeAPI.confirm(
        `Remove the signing identity "${id.label}"? Its key is deleted from this computer and cannot be recovered.`,
        'Remove',
        'Remove identity',
      )
      if (!ok) return
      try {
        await window.nativeAPI.removeIdentity(id.id)
      } catch (err) {
        console.error(err)
        showToast('Could not remove that identity.')
      }
      await onChange()
    })
    row.append(text, del)
    section.appendChild(row)
  }

  const actions = document.createElement('div')
  actions.className = 'identity-actions'
  const imp = document.createElement('button')
  imp.type = 'button'
  imp.className = 'btn-secondary'
  imp.textContent = 'Import…'
  imp.title = 'Import a .p12 or .pfx certificate'
  imp.addEventListener('click', () => openIdentityModal('import', onChange))
  const gen = document.createElement('button')
  gen.type = 'button'
  gen.className = 'btn-secondary'
  gen.textContent = 'Create self-signed…'
  gen.title = 'Create a certificate on this computer'
  gen.addEventListener('click', () => openIdentityModal('self', onChange))
  actions.append(imp, gen)
  section.appendChild(actions)

  const choiceRow = document.createElement('div')
  renderChoiceRow(choiceRow)
  section.appendChild(choiceRow)

  container.appendChild(section)
}

// ─────────── Create / import dialog ───────────

let modalOnDone = null

export function initIdentities() {
  const backdrop = document.getElementById('identity-modal-backdrop')
  if (!backdrop) return
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-action="close-identity-modal"]')) closeIdentityModal()
  })
  document.getElementById('identity-modal')?.addEventListener('submit', onIdentitySubmit)
  refreshIdentities()
}

function field(id) {
  return document.getElementById(id)
}

function openIdentityModal(mode, onDone) {
  modalOnDone = onDone
  const backdrop = field('identity-modal-backdrop')
  backdrop.dataset.mode = mode
  field('identity-modal-title').textContent = mode === 'self' ? 'Create self-signed identity' : 'Import signing identity'
  field('identity-submit').textContent = mode === 'self' ? 'Create' : 'Import'
  field('identity-note').textContent =
    mode === 'self'
      ? 'Self-signed identities are not trusted by other people’s PDF readers. They will show the signature as valid but the signer as unverified.'
      : 'Pick a .p12 or .pfx file and enter its password. The key is stored encrypted for this Windows account.'
  field('identity-name').value = ''
  field('identity-label').value = ''
  field('identity-password').value = ''
  field('identity-file').value = ''
  field('identity-error').hidden = true
  backdrop.hidden = false
  ;(mode === 'self' ? field('identity-name') : field('identity-file')).focus()
}

function closeIdentityModal() {
  const backdrop = field('identity-modal-backdrop')
  if (backdrop) backdrop.hidden = true
  field('identity-password').value = ''
  modalOnDone = null
}

function showIdentityError(message) {
  const el = field('identity-error')
  el.textContent = message
  el.hidden = false
}

async function onIdentitySubmit(e) {
  e.preventDefault()
  const backdrop = field('identity-modal-backdrop')
  const mode = backdrop.dataset.mode
  const submit = field('identity-submit')
  submit.disabled = true
  field('identity-error').hidden = true
  try {
    if (mode === 'self') {
      const name = field('identity-name').value.trim()
      if (!name) {
        showIdentityError('Enter a name for the certificate.')
        return
      }
      await window.nativeAPI.generateSelfSignedIdentity(name, field('identity-label').value.trim())
    } else {
      const file = field('identity-file').files?.[0]
      if (!file) {
        showIdentityError('Choose a .p12 or .pfx file.')
        return
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      await window.nativeAPI.importIdentity(bytes, field('identity-password').value, field('identity-label').value.trim())
    }
    const done = modalOnDone
    closeIdentityModal()
    showToast('Signing identity added')
    if (done) await done()
  } catch (err) {
    console.error(err)
    showIdentityError(typeof err === 'string' ? err : err?.message || 'Could not add the identity.')
  } finally {
    submit.disabled = false
    field('identity-password').value = ''
  }
}
