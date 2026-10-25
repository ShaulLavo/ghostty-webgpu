import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const installed = process.argv[2] === '--installed'
const directory = await mkdtemp(join(tmpdir(), 'ghostty-shaders-pack-'))
try {
  let root = join(import.meta.dirname, 'node_modules/ghostty-webgpu-shaders')
  if (!installed) {
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
        encoding: 'utf8',
      }),
    )[0]
    const unpacked = join(directory, 'unpacked')
    await mkdir(unpacked)
    execFileSync('tar', ['-xzf', join(directory, packed.filename), '-C', unpacked])
    root = join(unpacked, 'package')
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'ghostty-webgpu-shaders')
  assert.equal(manifest.private, undefined)
  assert.deepEqual(manifest.dependencies ?? {}, {})
  assert.deepEqual(Object.keys(manifest.peerDependencies), ['ghostty-webgpu'])
  const api = installed
    ? await import('ghostty-webgpu-shaders')
    : await import(pathToFileURL(resolve(root, 'dist/index.js')).href)
  assert.equal(api.createShaderAddon({ wgsl: 'compiled artifact' }).name, 'ghostty-webgpu-shaders')
  for (const name of await readdir(join(root, 'dist'))) {
    if (!name.endsWith('.js')) continue
    const source = await readFile(join(root, 'dist', name), 'utf8')
    assert.doesNotMatch(source, /ghostty-web-shaderc|naga-wasm|\.wasm|import\s*\(/u)
    const imports = Array.from(source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu), (match) => match[1])
    assert(imports.every((specifier) => specifier.startsWith('./')))
  }
  console.log('Packed addon exports and runtime dependency checks passed.')
} finally {
  await rm(directory, { recursive: true, force: true })
}
