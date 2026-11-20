const GROUPS = [
  {
    title: 'File',
    items: [
      ['Open', 'Ctrl+O'],
      ['Save', 'Ctrl+S'],
      ['Save As', 'Ctrl+Shift+S'],
      ['Print', 'Ctrl+P'],
    ],
  },
  {
    title: 'Edit',
    items: [
      ['Undo', 'Ctrl+Z'],
      ['Redo', 'Ctrl+Shift+Z / Ctrl+Y'],
      ['Find', 'Ctrl+F'],
      ['Highlight selected text', 'Ctrl+H'],
      ['Select all text, or all pages', 'Ctrl+A'],
      ['Delete selection or pages', 'Delete / Backspace'],
    ],
  },
  {
    title: 'Pages and view',
    items: [
      ['Rotate page left / right', '[ / ]'],
      ['Previous / next page', 'Up / Down'],
      ['Scroll one screen', 'Page Up / Page Down'],
      ['Zoom in / out', 'Ctrl+Mouse wheel'],
      ['Close find, popovers, cancel placement', 'Esc'],
    ],
  },
]

function build(body) {
  const list = document.createElement('div')
  list.id = 'shortcuts-list'
  for (const group of GROUPS) {
    const h = document.createElement('h3')
    h.textContent = group.title
    list.appendChild(h)
    for (const [label, keys] of group.items) {
      const row = document.createElement('div')
      row.className = 'shortcuts-row'
      const name = document.createElement('span')
      name.textContent = label
      const kbd = document.createElement('kbd')
      kbd.textContent = keys
      row.append(name, kbd)
      list.appendChild(row)
    }
  }
  body.prepend(list)
}

export function initShortcutsHelp() {
  const backdrop = document.getElementById('shortcuts-modal-backdrop')
  if (!backdrop) return
  build(backdrop.querySelector('.modal-body'))
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-action="close-shortcuts-modal"]')) {
      closeShortcutsModal()
    }
  })
}

export function isShortcutsModalOpen() {
  const el = document.getElementById('shortcuts-modal-backdrop')
  return !!(el && !el.hidden)
}

export function closeShortcutsModal() {
  const el = document.getElementById('shortcuts-modal-backdrop')
  if (el) el.hidden = true
}

export function openShortcutsModal() {
  const el = document.getElementById('shortcuts-modal-backdrop')
  if (el) el.hidden = false
}
