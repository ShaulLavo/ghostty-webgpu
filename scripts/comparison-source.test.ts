import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { comparisonSourceHash } from './comparison-source'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ghostty-comparison-source-'))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a.ts'), 'export const a = 1\n')
  execFileSync('git', ['add', 'src/a.ts'], { cwd: root })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('staging unchanged source files preserves comparison provenance', async () => {
  await writeFile(join(root, 'src/z.ts'), 'export const z = 2\n')
  const before = await comparisonSourceHash(root)
  execFileSync('git', ['add', 'src/z.ts'], { cwd: root })
  expect(await comparisonSourceHash(root)).toBe(before)
})

test('path and content boundaries distinguish inventories with equal unframed bytes', async () => {
  await writeFile(join(root, 'src/a.ts'), 'x;\n')
  const before = await comparisonSourceHash(root)
  await rm(join(root, 'src/a.ts'))
  await writeFile(join(root, 'src/a.tsx'), ';\n')
  execFileSync('git', ['add', '--all', 'src'], { cwd: root })
  expect(await comparisonSourceHash(root)).not.toBe(before)
})

test('an archived runtime omits checkout provenance when tracked source is absent', async () => {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: root },
  )
  await rm(join(root, 'src/a.ts'))
  execFileSync('git', ['cat-file', '-e', 'HEAD:src/a.ts'], { cwd: root })
  expect(await comparisonSourceHash(root, 'HEAD')).toBeUndefined()
})

test('source contents and paths affect provenance while unrelated files do not', async () => {
  const before = await comparisonSourceHash(root)
  await writeFile(join(root, 'notes.txt'), 'outside the measured sources\n')
  expect(await comparisonSourceHash(root)).toBe(before)
  await writeFile(join(root, 'src/a.ts'), 'export const a = 2\n')
  const changed = await comparisonSourceHash(root)
  expect(changed).not.toBe(before)
  await writeFile(join(root, 'src/z.ts'), 'export const a = 2\n')
  expect(await comparisonSourceHash(root)).not.toBe(changed)
})
