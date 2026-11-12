// Assembles the folder Tauri embeds as the frontend (src-tauri/frontend-dist).
//
// The renderer has no bundler: it imports pdf.js and pdf-lib straight from
// node_modules paths. Pointing Tauri at the repo root would embed all of
// node_modules (Electron included), so this copies only what the renderer
// loads. The Tauri CLI refuses a frontend folder that contains a directory
// named node_modules, so the libraries land in vendor/ and the copied src/*.js
// files have their '../node_modules/' specifiers rewritten to '../vendor/'.
// The originals in src/ are never modified.
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const out = path.resolve(here, '..', 'frontend-dist')

const COPIES = [
  'icon.png',
  'src',
  'node_modules/pdfjs-dist/build/pdf.mjs',
  'node_modules/pdfjs-dist/build/pdf.worker.mjs',
  'node_modules/pdfjs-dist/cmaps',
  'node_modules/pdfjs-dist/standard_fonts',
  'node_modules/pdf-lib/dist/pdf-lib.esm.js',
]

const VENDOR_DIR = 'vendor'
const LIB_SPECIFIER = '../node_modules/'

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

for (const rel of COPIES) {
  const dest = path.join(out, rel.replace(/^node_modules\//, VENDOR_DIR + '/'))
  await mkdir(path.dirname(dest), { recursive: true })
  await cp(path.join(root, rel), dest, { recursive: true })
}

let rewritten = 0
for (const name of await readdir(path.join(out, 'src'))) {
  if (!name.endsWith('.js')) continue
  const file = path.join(out, 'src', name)
  const text = await readFile(file, 'utf8')
  if (!text.includes(LIB_SPECIFIER)) continue
  await writeFile(file, text.replaceAll(LIB_SPECIFIER, '../' + VENDOR_DIR + '/'))
  rewritten++
}
if (rewritten === 0) {
  throw new Error('no src/*.js file imports from ' + LIB_SPECIFIER + '; update assemble-frontend.mjs')
}

// index.html ships a strict CSP with `connect-src 'self'`. Tauri's IPC on
// Windows is a fetch to http://ipc.localhost; without allowing it Tauri falls
// back to postMessage, which JSON-encodes PDF bytes. Only the copy is patched.
const html = await readFile(path.join(root, 'index.html'), 'utf8')
const needle = "connect-src 'self';"
if (!html.includes(needle)) {
  throw new Error('index.html CSP no longer contains "' + needle + '"; update assemble-frontend.mjs')
}
await writeFile(
  path.join(out, 'index.html'),
  html.replace(needle, "connect-src 'self' ipc: http://ipc.localhost;")
)

console.log('frontend assembled at ' + out)
