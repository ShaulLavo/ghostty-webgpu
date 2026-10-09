import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { expect, it } from 'vitest'
import { GHOSTTY_SOURCE_REPOSITORY, GHOSTTY_SOURCE_REVISION } from '../src/core/version.js'
import { sha256, WASM_BUILD_INPUTS } from './wasm-provenance.js'

it('binds the checked-in WASMs to the official pin and reproducible build inputs', async () => {
  const root = join(import.meta.dirname, '..')
  const receipt = JSON.parse(await readFile(join(root, 'ghostty-vt.provenance.json'), 'utf8'))
  expect(receipt.schema).toBe(1)
  expect(receipt.source).toMatchObject({
    repository: GHOSTTY_SOURCE_REPOSITORY,
    revision: GHOSTTY_SOURCE_REVISION,
    patched: false,
    officialArchive: {
      url: `https://codeload.github.com/ghostty-org/ghostty/tar.gz/${GHOSTTY_SOURCE_REVISION}`,
    },
  })
  expect(receipt.source.tree).toMatch(/^[a-f0-9]{40}$/)
  expect(receipt.source.gitArchiveSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(receipt.source.officialArchive.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(receipt.source.officialArchive.bytes).toBeGreaterThan(0)
  expect(receipt.compiler.version).toBe('0.16.0')
  expect(receipt.compiler.executableSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(Object.keys(receipt.recipe.inputs).sort()).toEqual(WASM_BUILD_INPUTS.toSorted())
  for (const path of WASM_BUILD_INPUTS) {
    expect(receipt.recipe.inputs[path], path).toBe(sha256(await readFile(join(root, path))))
  }
  expect(Object.keys(receipt.artifacts).sort()).toEqual(['bridge.wasm', 'ghostty-vt.wasm'])
  for (const [path, artifact] of Object.entries(receipt.artifacts) as [
    string,
    { bytes: number; sha256: string; nameSectionSha256: string[] },
  ][]) {
    const bytes = await readFile(join(root, path))
    expect(artifact.bytes, path).toBe(bytes.length)
    expect(artifact.sha256, path).toBe(sha256(bytes))
    const module = await WebAssembly.compile(bytes)
    expect(artifact.nameSectionSha256).toEqual(
      WebAssembly.Module.customSections(module, 'name').map((section) =>
        sha256(new Uint8Array(section)),
      ),
    )
  }
})

it('records every local bridge module as a reproducible build input', async () => {
  const root = join(import.meta.dirname, '..')
  for (const path of WASM_BUILD_INPUTS) {
    if (!path.endsWith('.zig')) continue
    const source = await readFile(join(root, path), 'utf8')
    for (const match of source.matchAll(/@import\("([^"]+\.zig)"\)/gu)) {
      const dependency = posix.join(posix.dirname(path), match[1]!)
      expect(WASM_BUILD_INPUTS, dependency).toContain(dependency)
    }
  }
})
