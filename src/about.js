const FALLBACK_INFO = {
  name: 'Basic PDF',
  version: '3.1.0',
  description: 'A lightweight desktop PDF editor',
  author: 'barrven',
  license: 'MIT',
  copyright: '© 2026 barrven',
}

let appInfo = { ...FALLBACK_INFO }

export function initAbout() {
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
  if (!window.nativeAPI?.getAppInfo) return
  try {
    const info = await window.nativeAPI.getAppInfo()
    if (info && typeof info === 'object') {
      appInfo = { ...FALLBACK_INFO, ...info }
    }
  } catch (err) {
    console.error(err)
  }
}

export function isAboutModalOpen() {
  const el = document.getElementById('about-modal-backdrop')
  return !!(el && !el.hidden)
}

export function closeAboutModal() {
  const el = document.getElementById('about-modal-backdrop')
  if (el) el.hidden = true
}

export function openAboutModal() {
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
