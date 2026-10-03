import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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
