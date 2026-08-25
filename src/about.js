import { closeThemePopover } from './theme.js'

const FALLBACK_INFO = {
  name: 'Basic PDF',
  version: '1.0.0',
  description: 'A lightweight desktop PDF editor',
  author: 'barrven',
  license: 'MIT',
  copyright: '© 2026 barrven',
}

let popoverOpen = false
let appInfo = { ...FALLBACK_INFO }

export function initAbout() {
  const nameBtn = document.getElementById('app-name')
  if (nameBtn) {
    nameBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleAboutMenu(nameBtn)
    })
  }

  const pop = document.getElementById('about-popover')
  if (pop) pop.addEventListener('click', onMenuClick)

  const backdrop = document.getElementById('about-modal-backdrop')
  if (backdrop) {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.closest('[data-action="close-about-modal"]')) {
        closeAboutModal()
      }
    })
  }

  loadAppInfo()
}

async function loadAppInfo() {
  if (!window.electronAPI?.getAppInfo) return
  try {
    const info = await window.electronAPI.getAppInfo()
    if (info && typeof info === 'object') {
      appInfo = { ...FALLBACK_INFO, ...info }
    }
  } catch (err) {
    console.error(err)
  }
}

export function toggleAboutMenu(anchorBtn) {
  if (popoverOpen) {
    closeAboutMenu()
    return
  }
  closeThemePopover()
  renderAboutMenu()
  const pop = document.getElementById('about-popover')
  if (!pop || !anchorBtn) return
  const rect = anchorBtn.getBoundingClientRect()
  pop.hidden = false
  pop.style.top = rect.bottom + 4 + 'px'
  pop.style.left = Math.max(8, rect.left) + 'px'
  popoverOpen = true
  syncNameButton()
  setTimeout(() => {
    document.addEventListener('mousedown', onDocMouseDown, { once: true })
  }, 0)
}

export function closeAboutMenu() {
  const pop = document.getElementById('about-popover')
  if (pop) pop.hidden = true
  popoverOpen = false
  syncNameButton()
}

export function isAboutMenuOpen() {
  return popoverOpen
}

export function isAboutModalOpen() {
  const el = document.getElementById('about-modal-backdrop')
  return !!(el && !el.hidden)
}

export function closeAboutModal() {
  const el = document.getElementById('about-modal-backdrop')
  if (el) el.hidden = true
}

function syncNameButton() {
  const btn = document.getElementById('app-name')
  if (!btn) return
  btn.setAttribute('aria-expanded', popoverOpen ? 'true' : 'false')
}

function onDocMouseDown(e) {
  const pop = document.getElementById('about-popover')
  if (pop && (pop.contains(e.target) || e.target.closest('#app-name'))) {
    document.addEventListener('mousedown', onDocMouseDown, { once: true })
    return
  }
  closeAboutMenu()
}

function onMenuClick(e) {
  const item = e.target.closest('[data-action="open-about"]')
  if (!item) return
  openAboutModal()
}

function renderAboutMenu() {
  const pop = document.getElementById('about-popover')
  if (!pop) return
  pop.innerHTML = ''
  pop.setAttribute('role', 'menu')
  pop.setAttribute('aria-label', 'Basic PDF')
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'about-menu-item'
  btn.dataset.action = 'open-about'
  btn.setAttribute('role', 'menuitem')
  btn.textContent = `About ${appInfo.name}`
  pop.appendChild(btn)
}

function openAboutModal() {
  closeAboutMenu()
  const name = document.getElementById('about-name')
  const version = document.getElementById('about-version')
  const description = document.getElementById('about-description')
  const copyright = document.getElementById('about-copyright')
  if (name) name.textContent = appInfo.name
  if (version) version.textContent = `Version ${appInfo.version}`
  if (description) description.textContent = appInfo.description
  if (copyright) {
    const license = appInfo.license ? `${appInfo.license} License` : ''
    copyright.textContent = [license, appInfo.copyright].filter(Boolean).join(' · ')
  }
  const backdrop = document.getElementById('about-modal-backdrop')
  if (backdrop) backdrop.hidden = false
}
