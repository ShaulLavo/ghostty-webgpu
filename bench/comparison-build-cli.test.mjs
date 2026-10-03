import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sha256 } from './comparison-build.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

async function fixture(context, run) {
  if (!process.versions.bun) {
    context.skip('Comparison bundle builds require Bun')
    return
  }
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' })
    execFileSync('tar', ['--version'], { stdio: 'pipe' })
  } catch {
    context.skip('Runtime-ref builds require Git and tar')
    return
  }
  const repository = await mkdtemp(join(tmpdir(), 'ghostty-comparison-build-'))
  const root = join(repository, 'ghostty-webgpu')
  const git = (args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
  try {
    await mkdir(join(root, 'scripts'), { recursive: true })
    await mkdir(join(root, 'bench/fixtures'), { recursive: true })
    await mkdir(join(root, 'src'))
    for (const name of await readdir(join(packageRoot, 'scripts'))) {
      if (name.startsWith('comparison') || name === 'build-comparison.ts')
        await cp(join(packageRoot, 'scripts', name), join(root, 'scripts', name))
    }
    for (const name of ['comparison-build.ts', 'comparison-fixtures.ts'])
      await cp(join(packageRoot, 'bench', name), join(root, 'bench', name))
    await cp(
      join(packageRoot, 'bench/fixtures/git-history.txt'),
      join(root, 'bench/fixtures/git-history.txt'),
    )
    await symlink(join(packageRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
    await writeFile(
      join(root, 'bench/comparison-entry.ts'),
      "import { value } from '../src/runtime.js'; console.log(value)\n",
    )
    const writeRuntime = async (value) => {
      await writeFile(join(root, 'src/runtime.ts'), `export const value = '${value}'\n`)
      await writeFile(join(root, 'bridge.wasm'), `${value}-bridge\0`)
      await writeFile(join(root, 'ghostty-vt.wasm'), `${value}-native\0`)
      await writeFile(join(root, 'package.json'), JSON.stringify({ version: value }))
    }
    git(['init', '--quiet'])
    git(['config', 'user.name', 'Fixture'])
    git(['config', 'user.email', 'fixture@example.invalid'])
    git(['config', 'commit.gpgsign', 'false'])
    await writeFile(join(repository, '.gitignore'), 'node_modules\n.artifacts\n')
    await writeRuntime('0.1.1')
    git(['add', '.'])
    git(['commit', '--quiet', '-m', 'baseline'])
    const baseline = git(['rev-parse', 'HEAD'])
    await writeRuntime('0.1.2')
    git(['add', '.'])
    git(['commit', '--quiet', '-m', 'treatment'])
    const build = (output, args = []) =>
      spawnSync(process.execPath, [join(root, 'scripts/build-comparison.ts'), output, ...args], {
        cwd: root,
        encoding: 'utf8',
      })
    await run({ repository, root, git, baseline, build })
  } finally {
    await rm(repository, { recursive: true, force: true })
  }
}

async function assertBundle(output, expectedVersion, expectedBytes) {
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
  assert.equal(manifest.versions['ghostty-webgpu'], expectedVersion)
  const bundle = await readFile(join(output, 'browser.js'))
  assert.ok(bundle.toString().includes(expectedVersion))
  assert.equal(manifest.runtime.version, expectedVersion)
  assert.equal(manifest.bundleSha256, sha256(bundle))
  for (const [name, bytes] of Object.entries(expectedBytes)) {
    assert.deepEqual(await readFile(join(output, name)), bytes)
    assert.equal(manifest.assets[name], sha256(bytes))
    const path = name === 'native.wasm' ? 'ghostty-vt.wasm' : name
    assert.equal(manifest.runtime.files[path], sha256(bytes))
  }
  return manifest
}

test('runtime-ref CLI bundles source, WASM and package version from one commit', async (context) => {
  await fixture(context, async ({ repository, baseline, build }) => {
    const output = join(repository, '.artifacts/baseline')
    const result = build(output, ['--runtime-ref', baseline])
    assert.equal(result.status, 0, result.stderr)
    const blob = (path) =>
      execFileSync('git', ['show', `${baseline}:ghostty-webgpu/${path}`], { cwd: repository })
    const manifest = await assertBundle(output, '0.1.1', {
      'native.wasm': blob('ghostty-vt.wasm'),
      'bridge.wasm': blob('bridge.wasm'),
    })
    assert.equal(manifest.runtime.commit, baseline)
    assert.equal(manifest.runtime.mode, 'git-ref')
    assert.equal(manifest.runtime.dirty, '')
    const inventory = Object.keys(manifest.runtime.files)
      .sort()
      .map((path) => {
        const bytes = blob(path)
        assert.equal(manifest.runtime.files[path], sha256(bytes))
        return Buffer.concat([Buffer.from(`${path}\0`), bytes, Buffer.from('\0')])
      })
    assert.equal(manifest.runtime.sourceSha256, sha256(Buffer.concat(inventory)))
    assert.doesNotMatch(await readFile(join(output, 'browser.js'), 'utf8'), /0\.1\.2/)
  })
})

test('checkout CLI bundles current dirty source, WASM and version', async (context) => {
  await fixture(context, async ({ repository, root, build }) => {
    await writeFile(join(root, 'bridge.wasm'), 'dirty-bridge\0')
    const output = join(repository, '.artifacts/checkout')
    const result = build(output)
    assert.equal(result.status, 0, result.stderr)
    const manifest = await assertBundle(output, '0.1.2', {
      'native.wasm': await readFile(join(root, 'ghostty-vt.wasm')),
      'bridge.wasm': await readFile(join(root, 'bridge.wasm')),
    })
    assert.equal(manifest.runtime.mode, 'checkout')
    assert.match(manifest.runtime.dirty, /bridge\.wasm/)
  })
})

test('missing ref, missing snapshot input and failed builds leave no staging directory', async (context) => {
  await fixture(context, async ({ repository, root, git, baseline, build }) => {
    assert.notEqual(
      build(join(repository, '.artifacts/missing-ref'), ['--runtime-ref', 'missing-ref']).status,
      0,
    )
    for (const path of ['bridge.wasm', 'ghostty-vt.wasm', 'package.json', 'src/runtime.ts']) {
      const bytes = await readFile(join(root, path))
      git(['rm', `ghostty-webgpu/${path}`])
      git(['commit', '--quiet', '-m', `remove ${path}`])
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(join(root, path), bytes)
      const output = join(repository, '.artifacts/missing-path')
      assert.notEqual(build(output, ['--runtime-ref', 'HEAD']).status, 0, path)
      await assert.rejects(readFile(join(output, 'manifest.json')), { code: 'ENOENT' })
      git(['add', `ghostty-webgpu/${path}`])
      git(['commit', '--quiet', '-m', `restore fixture ${path}`])
    }
    await writeFile(join(root, 'bench/comparison-entry.ts'), 'invalid syntax {')
    const output = join(repository, '.artifacts/build-failure')
    assert.notEqual(build(output, ['--runtime-ref', baseline]).status, 0)
    await assert.rejects(readFile(join(output, 'manifest.json')), { code: 'ENOENT' })
    const staging = await readdir(join(root, '.artifacts'))
    assert.deepEqual(
      staging.filter((name) => name.startsWith('comparison-runtime-')),
      [],
    )
  })
})
