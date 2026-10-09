import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { comparisonBuildArguments, runtimeSource, sha256 } from './comparison-build.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

test('runtime build arguments preserve positional output and require one explicit Git ref', () => {
  const output = resolve('bundle')
  assert.deepEqual(comparisonBuildArguments([], output), { output, ref: undefined })
  assert.deepEqual(comparisonBuildArguments(['bundle'], output), { output, ref: undefined })
  for (const args of [
    ['bundle', '--runtime-ref', 'HEAD'],
    ['--runtime-ref', 'HEAD', 'bundle'],
  ])
    assert.deepEqual(comparisonBuildArguments(args, output), { output, ref: 'HEAD' })
  assert.deepEqual(comparisonBuildArguments(['--runtime-ref', 'HEAD'], output), {
    output,
    ref: 'HEAD',
  })
  for (const args of [
    ['--runtime-ref'],
    ['--runtime-ref', '--bad'],
    ['--bad'],
    ['one', 'two'],
    ['--runtime-ref', 'HEAD', '--runtime-ref', 'HEAD'],
  ])
    assert.throws(() => comparisonBuildArguments(args, output))
})

test('changing Canvas composer bytes or declarations changes the checkout inventory', async (context) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' })
  } catch {
    context.skip('Runtime inventories require a Git checkout and Git executable')
    return
  }
  const repository = await mkdtemp(join(tmpdir(), 'ghostty-composer-inventory-'))
  const runtimeRoot = join(repository, 'runtime')
  const git = (args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
  try {
    await mkdir(join(runtimeRoot, 'src/core'), { recursive: true })
    const declarations = join(runtimeRoot, 'src/core/assets.ts')
    const manifest = await readFile(join(root, 'src/core/assets.ts'), 'utf8')
    await writeFile(declarations, manifest)
    await writeFile(join(runtimeRoot, 'src/runtime.ts'), 'export const value = 1\n')
    await writeFile(join(runtimeRoot, 'package.json'), '{"version":"0.1.1"}\n')
    for (const path of ['ghostty-vt.wasm', 'bridge.wasm', 'canvas-compose.wasm'])
      await copyFile(join(root, path), join(runtimeRoot, path))
    git(['init', '--quiet'])
    git(['add', '.'])
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'runtime',
    ])
    const baseline = await runtimeSource(runtimeRoot)
    await writeFile(join(runtimeRoot, 'canvas-compose.wasm'), 'changed-composer\0')
    const changed = await runtimeSource(runtimeRoot)
    assert.notEqual(changed.inventory.sha256, baseline.inventory.sha256)
    assert.equal(changed.inventory.files['canvas-compose.wasm'], sha256('changed-composer\0'))
    assert.match(changed.dirty, /canvas-compose\.wasm/)
    const path = 'wasm/compose-current.wasm'
    await mkdir(join(runtimeRoot, 'wasm'))
    await writeFile(join(runtimeRoot, path), 'relocated-composer\0')
    await writeFile(declarations, manifest.replace('../../canvas-compose.wasm', `../../${path}`))
    const relocated = await runtimeSource(runtimeRoot)
    assert.equal(relocated.assets[path], join(runtimeRoot, path))
    assert.equal(relocated.assets['canvas-compose.wasm'], undefined)
    assert.equal(relocated.inventory.files[path], sha256('relocated-composer\0'))
    assert.equal(relocated.inventory.files['canvas-compose.wasm'], undefined)
    assert.notEqual(relocated.inventory.sha256, changed.inventory.sha256)
  } finally {
    await rm(repository, { recursive: true, force: true })
  }
})

test('explicit Git ref extracts and hashes the actual runtime while redirecting only runtime imports', async (context) => {
  try {
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: 'pipe' })
  } catch {
    context.skip('Runtime-ref builds require a Git checkout and Git executable')
    return
  }
  const runtime = await runtimeSource(root, 'HEAD')
  let redirected
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    const prefix = execFileSync('git', ['rev-parse', '--show-prefix'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    const expected = execFileSync('git', ['show', `${commit}:${prefix}src/core/runtime.ts`], {
      cwd: root,
    })
    assert.equal(runtime.commit, commit)
    assert.equal(runtime.mode, 'git-ref')
    assert.equal(runtime.dirty, '')
    assert.equal(runtime.inventory.files['src/core/runtime.ts'], sha256(expected))
    let resolveImport
    runtime.plugins[0].setup({
      onResolve: (_options, callback) => {
        resolveImport = callback
      },
    })
    redirected = resolveImport({
      path: '../src/core/runtime.js',
      importer: resolve(root, 'bench/comparison-entry.ts'),
    })
    assert.deepEqual(await readFile(redirected.path), expected)
    assert.equal(
      resolveImport({
        path: './comparison-fixtures.js',
        importer: resolve(root, 'bench/comparison-entry.ts'),
      }),
      undefined,
    )
    assert.equal(
      resolveImport({ path: '@xterm/xterm', importer: resolve(root, 'bench/comparison-entry.ts') }),
      undefined,
    )
  } finally {
    await runtime.dispose()
  }
  await assert.rejects(readFile(redirected.path), { code: 'ENOENT' })
})
