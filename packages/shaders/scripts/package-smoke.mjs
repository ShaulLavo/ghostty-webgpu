import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const directory = await mkdtemp(join(tmpdir(), 'ghostty-shaders-pack-'))
try {
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
      encoding: 'utf8',
    }),
  )[0]
  const unpacked = join(directory, 'unpacked')
  await mkdir(unpacked)
  execFileSync('tar', ['-xzf', join(directory, packed.filename), '-C', unpacked])
  const root = join(unpacked, 'package')
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'ghostty-webgpu-shaders')
  assert.equal(manifest.private, undefined)
  assert.deepEqual(manifest.dependencies ?? {}, {})
  assert.deepEqual(Object.keys(manifest.peerDependencies), ['ghostty-webgpu'])
  const api = await import(pathToFileURL(resolve(root, 'dist/index.js')).href)
  assert.equal(api.createShaderAddon({ wgsl: 'compiled artifact' }).name, 'ghostty-webgpu-shaders')
  for (const name of await readdir(join(root, 'dist'))) {
    if (!name.endsWith('.js')) continue
    const source = await readFile(join(root, 'dist', name), 'utf8')
    assert.doesNotMatch(source, /ghostty-web-shaderc|naga-wasm|\.wasm|import\s*\(/u)
    const imports = Array.from(source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu), (match) => match[1])
    assert(imports.every((specifier) => specifier.startsWith('./')))
  }
  console.log(
    'Packed addon imports without a compiler, WASM, terminal runtime, or installed peers.',
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
