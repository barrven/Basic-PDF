// Cross-file consistency checks. These read source files as text and catch the
// kind of breakage no unit test sees: a renderer call to a bridge function that
// does not exist, a Rust command nobody registered, a version bumped in three
// of four places, a library file the packaged app would be missing.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(root, rel), 'utf8')
const srcFiles = readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js'))
const srcText = Object.fromEntries(srcFiles.map((f) => [f, read(`src/${f}`)]))
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('version', () => {
  const pkg = JSON.parse(read('package.json'))
  test('package.json, Cargo.toml, tauri.conf.json and about.js agree', () => {
    const cargo = /^version\s*=\s*"([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))[1]
    const tauri = JSON.parse(read('src-tauri/tauri.conf.json')).version
    const about = /['"](\d+\.\d+\.\d+)['"]/.exec(srcText['about.js'])[1]
    assert.deepEqual({ cargo, tauri, about }, { cargo: pkg.version, tauri: pkg.version, about: pkg.version })
  })
  test('package name stays a valid npm id while the product name is the display name', () => {
    assert.equal(pkg.name, 'basic-pdf')
    assert.equal(pkg.productName, 'Basic PDF')
    assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).productName, 'Basic PDF')
  })
})

describe('renderer <-> shell boundary', () => {
  const bridge = read('src-tauri/src/bridge.js')
  const lib = read('src-tauri/src/lib.rs')
  const bridgeApi = new Set([...bridge.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]))

  test('every window.nativeAPI.* call in src/ is defined by the bridge', () => {
    const used = new Set()
    for (const text of Object.values(srcText)) for (const m of text.matchAll(/nativeAPI\??\.(\w+)/g)) used.add(m[1])
    assert.ok(used.size > 10, 'found the calls')
    const missing = [...used].filter((n) => !bridgeApi.has(n))
    assert.deepEqual(missing, [])
  })

  test('every command the bridge invokes is registered in the Rust shell', () => {
    const invoked = new Set([...bridge.matchAll(/invoke\('(\w+)'/g)].map((m) => m[1]))
    const handler = /generate_handler!\[([\s\S]*?)\]/.exec(lib)[1]
    const registered = new Set([...handler.matchAll(/(?:\w+::)*(\w+)\s*,?/g)].map((m) => m[1]))
    const missing = [...invoked].filter((c) => !registered.has(c))
    assert.deepEqual(missing, [])
  })

  test('every registered command is a real function in the shell', () => {
    const handler = /generate_handler!\[([\s\S]*?)\]/.exec(lib)[1]
    const signing = read('src-tauri/src/signing.rs')
    for (const m of handler.matchAll(/((?:\w+::)+)?(\w+)\s*,/g)) {
      const src = m[1] ? signing : lib
      assert.match(src, new RegExp(`fn ${m[2]}\\b`), m[2])
    }
  })

  test('the capability file grants nothing beyond core events', () => {
    const cap = JSON.parse(read('src-tauri/capabilities/default.json'))
    assert.deepEqual(cap.permissions, ['core:event:default'])
  })

  test('the renderer never calls window.confirm / alert / prompt', () => {
    for (const [file, text] of Object.entries(srcText)) {
      const code = stripComments(text)
      assert.doesNotMatch(code, /(^|[^.\w])(window\.)?(confirm|alert|prompt)\s*\(/, file)
    }
  })

  test('the renderer has no Node access', () => {
    for (const [file, text] of Object.entries(srcText)) {
      assert.doesNotMatch(text, /\brequire\(|from ['"]node:|from ['"]fs['"]|process\.env/, file)
    }
  })
})

describe('signing contract between JS and Rust', () => {
  const rust = read('src-tauri/src/signing.rs')
  test('the /ByteRange placeholder text is identical on both sides', async () => {
    const { BYTE_RANGE_PLACEHOLDER } = await import('../src/pdf-signature.js')
    const m = /const BYTE_RANGE_PLACEHOLDER: &\[u8\] = b"([^"]+)"/.exec(rust)
    assert.ok(m, 'constant found in signing.rs')
    assert.equal(m[1], BYTE_RANGE_PLACEHOLDER)
  })
  test('the /Contents placeholder is the same size on both sides', () => {
    const js = Number(/CONTENTS_BYTES = (\d+)/.exec(srcText['pdf-signature.js'])[1])
    const rs = /const (?:CONTENTS_\w+|SIG_\w+):\s*usize\s*=\s*(\d+)/.exec(rust)
    if (rs) assert.equal(Number(rs[1]), js)
    assert.ok(js >= 8192, 'room for a certificate chain')
  })
})

describe('packaging', () => {
  const assemble = read('src-tauri/scripts/assemble-frontend.mjs')
  const copies = [...assemble.matchAll(/'(node_modules\/[^']+)'/g)].map((m) => m[1])

  test('every library file the renderer imports is copied into the app', () => {
    const imported = new Set()
    for (const text of Object.values(srcText)) {
      for (const m of text.matchAll(/from\s+'\.\.\/(node_modules\/[^']+)'/g)) imported.add(m[1])
    }
    assert.ok(imported.size >= 2)
    const missing = [...imported].filter((f) => !copies.some((c) => f === c || f.startsWith(c + '/')))
    assert.deepEqual(missing, [])
  })

  test('every file in COPIES exists', () => {
    for (const rel of copies) assert.ok(existsSync(path.join(root, rel)), rel)
  })

  test('relative imports between src modules resolve', () => {
    for (const [file, text] of Object.entries(srcText)) {
      for (const m of text.matchAll(/from\s+'(\.\/[^']+)'/g)) {
        assert.ok(existsSync(path.join(root, 'src', m[1])), `${file} imports ${m[1]}`)
      }
    }
  })
})

describe('index.html', () => {
  const html = read('index.html')
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))

  test('every literal getElementById in src/ points at an element that exists', () => {
    // Ids created by the renderer itself (el.id = '...' or id="..." in a string) count too.
    for (const text of Object.values(srcText)) {
      for (const m of text.matchAll(/\.id = '([^']+)'|\bid="([^"]+)"/g)) ids.add(m[1] || m[2])
    }
    const missing = []
    for (const [file, text] of Object.entries(srcText)) {
      for (const m of text.matchAll(/getElementById\('([^']+)'\)/g)) {
        if (!ids.has(m[1])) missing.push(`${file}: #${m[1]}`)
      }
    }
    assert.deepEqual(missing, [])
  })

  test('element ids are unique', () => {
    const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(all.filter((id, i) => all.indexOf(id) !== i), [])
  })

  test('the CSP stays strict', () => {
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)[1]
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/)
    assert.doesNotMatch(csp, /unsafe-inline'?\s*[;]?[^;]*script-src|script-src[^;]*unsafe-inline|unsafe-eval(?!')/)
    assert.match(csp, /connect-src 'self';/, 'assemble-frontend.mjs patches this exact text')
  })

  test('the module entry point exists', () => {
    const entry = /<script type="module" src="([^"]+)"/.exec(html)[1]
    assert.ok(existsSync(path.join(root, entry)))
  })
})

describe('keyboard shortcuts', () => {
  test('every shortcut the README documents has a handler', () => {
    const code = srcText['shortcuts.js']
    for (const needle of ["'o'", "'s'", "'z'", "'y'", "'f'", "'h'", "'a'", "'['", "']'", "'Delete'", "'Backspace'", "'ArrowUp'", "'ArrowDown'", "'PageUp'", "'PageDown'", "'Escape'"]) {
      assert.ok(code.toLowerCase().includes(needle.toLowerCase()), needle)
    }
  })
})
