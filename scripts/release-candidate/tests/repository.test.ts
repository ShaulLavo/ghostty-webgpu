import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { canonicalObjectBytes } from '../../config-resolver-native/canonical'
import { NATIVE_TARGETS } from '../../config-resolver-native/constants'
import { requireGeneratedOnlyPackageDiff } from '../repository'
import { createReleaseFixture } from './fixtures'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test.each(['.', 'ghostty-webgpu'])('checks generated-only release changes inside %s', (prefix) => {
  const checkout = mkdtempSync(join(tmpdir(), 'ghostty-release-diff-'))
  roots.push(checkout)
  const family = join(checkout, prefix)
  const native = join(family, 'native/config-resolver')
  mkdirSync(native, { recursive: true })
  writeFileSync(join(native, 'bootstrap.json'), '{}\n')
  git(checkout, ['init', '-q'])
  commit(checkout)
  const nativeBuildSourceHead = git(checkout, ['rev-parse', 'HEAD'])
  const manifest = { ...createReleaseFixture().manifest, nativeBuildSourceHead }
  rmSync(join(native, 'bootstrap.json'))
  writeFileSync(join(native, 'manifest.json'), canonicalObjectBytes(manifest))
  for (const target of NATIVE_TARGETS) {
    for (const file of manifest.targets[target].files) {
      const path = join(native, target, file.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'generated fixture\n')
    }
  }
  if (prefix !== '.') writeFileSync(join(checkout, 'app.txt'), 'independent app change\n')
  commit(checkout)
  const assembledHead = git(checkout, ['rev-parse', 'HEAD'])
  expect(() => requireGeneratedOnlyPackageDiff(family, assembledHead, manifest)).not.toThrow()

  writeFileSync(join(family, 'source.ts'), 'export const changed = true\n')
  commit(checkout)
  const changedHead = git(checkout, ['rev-parse', 'HEAD'])
  expect(() => requireGeneratedOnlyPackageDiff(family, changedHead, manifest)).toThrow(
    'package source contains a non-generated native diff',
  )
})

function commit(root: string) {
  git(root, ['add', '-A'])
  git(root, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'Fixture',
  ])
}

function git(root: string, args: readonly string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}
