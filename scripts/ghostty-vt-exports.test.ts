import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { GHOSTTY_VT_EXPORTS } from './ghostty-vt-exports.js'
import { trimWasmExports } from './wasm-exports.js'

const root = join(import.meta.dirname, '..')

async function sourceReferences(): Promise<Set<string>> {
  const entries = await readdir(join(root, 'src'), { recursive: true, withFileTypes: true })
  const names = new Set<string>()
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const text = await readFile(join(entry.parentPath, entry.name), 'utf8')
    // Names ending in `_` are URL prefixes and regex fragments, not exports.
    for (const match of text.matchAll(/\bghostty_[a-z0-9_]*[a-z0-9]\b/gu)) names.add(match[0])
  }
  return names
}

async function wasmModule(path: string): Promise<WebAssembly.Module> {
  return WebAssembly.compile(await readFile(join(root, path)))
}

it('keeps exactly the libghostty-vt exports the bindings and bridge call', async () => {
  const bridge = WebAssembly.Module.imports(await wasmModule('bridge.wasm'))
  const expected = await sourceReferences()
  for (const item of bridge) {
    if (item.name.startsWith('ghostty_')) expected.add(item.name)
  }
  expected.add('memory')
  expected.add('__indirect_function_table')
  expect(GHOSTTY_VT_EXPORTS.toSorted()).toEqual(Array.from(expected).sort())
})

it('ships a libghostty-vt module with exactly the kept exports', async () => {
  const exports = WebAssembly.Module.exports(await wasmModule('ghostty-vt.wasm'))
  expect(exports.map((item) => item.name).sort()).toEqual(GHOSTTY_VT_EXPORTS.toSorted())
})

it('drops unlisted exports and rejects a module missing a kept one', async () => {
  const bytes = new Uint8Array(await readFile(join(root, 'ghostty-vt.wasm')))
  const trimmed = trimWasmExports(bytes, new Set(['memory', 'ghostty_terminal_new']))
  const exports = WebAssembly.Module.exports(await WebAssembly.compile(trimmed))
  expect(exports.map((item) => item.name).sort()).toEqual(['ghostty_terminal_new', 'memory'])
  expect(() => trimWasmExports(bytes, new Set(['ghostty_not_exported']))).toThrow(
    /missing exports: ghostty_not_exported/,
  )
})
