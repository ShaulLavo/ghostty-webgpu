import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'
import {
  frameworkBaseRelease,
  frameworkProgramsRelease,
  frameworkRelayRelease,
  frameworkRelease,
} from './ios-browser-dependency.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)

test('the complete host tuple is dev-only, locked, and shares one runtime', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const lock = await readFile(join(root, 'bun.lock'), 'utf8')
  const runtime = realpathSync(require.resolve('waffle/testing/page-runner/framework'))
  const packages = [
    ['waffle', frameworkRelease],
    ['waffle-relay', frameworkRelayRelease],
    ['waffle-base', frameworkBaseRelease],
  ] as const
  for (const [name, release] of packages) {
    assert.equal(manifest.devDependencies[name], release.url)
    assert.equal(manifest.dependencies[name], undefined)
    const row = lock.split('\n').find((line) => line.startsWith(`    "${name}": ["${name}@`))
    assert(row?.includes(`${name}@${release.url}`), `${name} public URL`)
    assert(row.includes(`"${release.integrity}"`), `${name} archive integrity`)
    const packagePath = join(root, 'node_modules', name, 'package.json')
    const installed = JSON.parse(await readFile(packagePath, 'utf8'))
    assert.equal(installed.name, name)
    assert.equal(installed.version, release.version)
    assert.equal(installed.waffleHostInterface, release.hostInterface)
    const consumer = createRequire(packagePath)
    assert.equal(realpathSync(consumer.resolve('waffle/testing/page-runner/framework')), runtime)
  }
  assert.equal(lock.match(/"waffle": \["waffle@/g)?.length, 1)
  assert.equal(frameworkRelayRelease.source, frameworkRelease.source)
  assert.equal(frameworkProgramsRelease.toolSource, frameworkRelease.source)
  assert.equal(frameworkProgramsRelease.source, '3050f69d810fe7c851e487135517698b5dfd93e5')
})

test('base resolves its complete program family at the supported host interface', async () => {
  const basePath = realpathSync(join(root, 'node_modules/waffle-base/package.json'))
  const baseRequire = createRequire(basePath)
  const base = JSON.parse(await readFile(basePath, 'utf8'))
  const families = ['coreutils', 'findutils', 'grep', 'ripgrep', 'sed']
  assert.deepEqual(
    Object.keys(base.dependencies).sort(),
    families.map((name) => `waffle-${name}`),
  )
  const runtime = realpathSync(require.resolve('waffle/testing/page-runner/framework'))
  for (const family of families) {
    const name = `waffle-${family}`
    assert.equal(
      base.dependencies[name],
      `https://github.com/ShaulLavo/waffle/releases/download/${frameworkProgramsRelease.tag}/${name}-${frameworkProgramsRelease.version}.tgz`,
    )
    const packagePath = join(dirname(baseRequire.resolve(name)), '../package.json')
    const installed = JSON.parse(await readFile(packagePath, 'utf8'))
    assert.equal(installed.name, name)
    assert.equal(installed.version, frameworkProgramsRelease.version)
    assert.equal(installed.waffleHostInterface, frameworkProgramsRelease.hostInterface)
    const consumer = createRequire(packagePath)
    assert.equal(realpathSync(consumer.resolve('waffle/testing/page-runner/framework')), runtime)
  }
})
