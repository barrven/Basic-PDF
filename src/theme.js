const PREFERENCES = ['system', 'light', 'dark']

const ICONS = {
  system: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3" width="11" height="8" rx="1"/><path d="M6 13h4M8 11v2"/></svg>`,
  light: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="2.75"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06"/></svg>`,
  dark: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12.75 10.2A5.25 5.25 0 1 1 5.8 3.25 4.25 4.25 0 0 0 12.75 10.2z"/></svg>`,
}

const LABELS = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

const TITLES = {
  system: 'Theme: System (follows OS)',
  light: 'Theme: Light',
  dark: 'Theme: Dark',
}

let currentPreference = 'system'
let popoverOpen = false

function normalizePreference(value) {
  return PREFERENCES.includes(value) ? value : 'system'
}

function applyThemeInfo(info) {
  currentPreference = normalizePreference(info?.preference)
  const resolved = info?.dark ? 'dark' : 'light'
  document.documentElement.dataset.theme = resolved
  updateThemeButton()
  renderThemePopover()
}

export async function initTheme() {
  updateThemeButton()
  try {
    const info = await window.electronAPI.getTheme()
    applyThemeInfo(info)
  } catch (err) {
    console.error(err)
    applyThemeInfo({
      preference: 'system',
      dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    })
  }

  window.electronAPI.onThemeUpdated(applyThemeInfo)
  updateThemeButton()

  const pop = document.getElementById('theme-popover')
  if (pop) {
    pop.addEventListener('click', onPopoverClick)
  }
}

function ensureThemeButton() {
  const host = document.getElementById('titlebar-actions')
  if (!host) return null
  let btn = document.getElementById('theme-btn')
  if (btn) return btn
  btn = document.createElement('button')
  btn.id = 'theme-btn'
  btn.type = 'button'
  btn.className = 'titlebar-btn'
  btn.dataset.action = 'theme'
  btn.setAttribute('aria-haspopup', 'menu')
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    toggleThemePopover(btn)
  })
  host.appendChild(btn)
  return btn
}

export function updateThemeButton() {
  const btn = ensureThemeButton()
  if (!btn) return
  btn.innerHTML = ICONS[currentPreference]
  btn.title = TITLES[currentPreference]
  btn.setAttribute('aria-label', TITLES[currentPreference])
  btn.setAttribute('aria-expanded', popoverOpen ? 'true' : 'false')
}

export function toggleThemePopover(anchorBtn) {
  if (popoverOpen) {
    closeThemePopover()
    return
  }
  renderThemePopover()
  const pop = document.getElementById('theme-popover')
  if (!pop || !anchorBtn) return
  const rect = anchorBtn.getBoundingClientRect()
  pop.hidden = false
  const width = pop.offsetWidth || 180
  pop.style.top = rect.bottom + 4 + 'px'
  pop.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + 'px'
  popoverOpen = true
  updateThemeButton()
  setTimeout(() => {
    document.addEventListener('mousedown', onDocMouseDown, { once: true })
  }, 0)
}

export function closeThemePopover() {
  const pop = document.getElementById('theme-popover')
  if (pop) pop.hidden = true
  popoverOpen = false
  updateThemeButton()
}

export function isThemePopoverOpen() {
  return popoverOpen
}

function onDocMouseDown(e) {
  const pop = document.getElementById('theme-popover')
  if (pop && (pop.contains(e.target) || e.target.closest('#theme-btn'))) {
    document.addEventListener('mousedown', onDocMouseDown, { once: true })
    return
  }
  closeThemePopover()
}

function onPopoverClick(e) {
  const option = e.target.closest('[data-theme-pref]')
  if (!option) return
  const preference = normalizePreference(option.dataset.themePref)
  setPreference(preference)
  closeThemePopover()
}

async function setPreference(preference) {
  try {
    const info = await window.electronAPI.setTheme(preference)
    applyThemeInfo(info)
  } catch (err) {
    console.error(err)
  }
}

function renderThemePopover() {
  const pop = document.getElementById('theme-popover')
  if (!pop) return
  pop.innerHTML = ''
  pop.setAttribute('role', 'menu')
  pop.setAttribute('aria-label', 'Display mode')
  for (const preference of PREFERENCES) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'theme-option'
    btn.dataset.themePref = preference
    btn.setAttribute('role', 'menuitemradio')
    btn.setAttribute('aria-checked', preference === currentPreference ? 'true' : 'false')
    const selected = preference === currentPreference
    btn.innerHTML = `<span class="theme-option-icon">${ICONS[preference]}</span><span class="theme-option-label">${LABELS[preference]}</span><span class="theme-option-check" aria-hidden="true">${selected ? '✓' : ''}</span>`
    if (preference === 'system') {
      btn.title = 'Follow the operating system light or dark setting'
    }
    pop.appendChild(btn)
  }
}
