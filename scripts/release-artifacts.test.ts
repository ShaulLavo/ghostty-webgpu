import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { sourceCommit, validateReleaseArtifacts, writeReleaseManifest } from './release-artifacts'

let root: string
let artifacts: string
let commit: string
let tag: string
const names = ['ghostty-webgpu', 'ghostty-webgpu-line-editor', 'ghostty-webgpu-shaders']

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

async function packFixture(index: number, version = '0.0.1'): Promise<void> {
  const packageRoot = join(root, 'fixture/package')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: names[index], version }),
  )
  execFileSync('tar', [
    '-czf',
    join(artifacts, `${names[index]}.tgz`),
    '-C',
    join(root, 'fixture'),
    'package',
  ])
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ghostty-release-test-'))
  artifacts = join(root, '.artifacts')
  await mkdir(artifacts)
  const directories = ['.', 'packages/line-editor', 'packages/shaders']
  for (const [index, directory] of directories.entries()) {
    await mkdir(join(root, directory), { recursive: true })
    await writeFile(
      join(root, directory, 'package.json'),
      JSON.stringify({ name: names[index], version: '0.0.1' }),
    )
    await packFixture(index)
  }
  git('init', '-q')
  git('add', 'package.json', 'packages')
  git(
    '-c',
    'user.name=Release test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'fixture',
  )
  commit = sourceCommit(root)
  tag = `v0.0.1-${commit.slice(0, 12)}`
  git(
    '-c',
    'user.name=Release test',
    '-c',
    'user.email=test@example.invalid',
    'tag',
    '-a',
    tag,
    '-m',
    'release',
  )
  await writeReleaseManifest(root, artifacts)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('accepts the same package set, checksums, versions, and annotated or lightweight tag target', async () => {
  await validateReleaseArtifacts({ root, artifacts, commit, tag })
  git('tag', '-d', tag)
  git('tag', tag)
  await validateReleaseArtifacts({ root, artifacts, commit, tag })
})

test.each([0, 1, 2])('rejects a changed checksum for package %i', async (index) => {
  await writeFile(join(root, 'fixture/package/extra'), 'changed payload')
  await packFixture(index)
  await expect(validateReleaseArtifacts({ root, artifacts, commit, tag })).rejects.toThrow(
    'checksum differs',
  )
})

test('rejects a packed version that differs from source', async () => {
  await packFixture(1, '0.0.2')
  await expect(validateReleaseArtifacts({ root, artifacts, commit, tag })).rejects.toThrow(
    'Packed identity differs',
  )
})

test('rejects a missing or extra tarball', async () => {
  await rm(join(artifacts, `${names[1]}.tgz`))
  await expect(validateReleaseArtifacts({ root, artifacts, commit, tag })).rejects.toThrow(
    'tarball set differs',
  )
  await packFixture(1)
  await writeFile(join(artifacts, 'unexpected.tgz'), '')
  await expect(validateReleaseArtifacts({ root, artifacts, commit, tag })).rejects.toThrow(
    'tarball set differs',
  )
})

test('rejects a mismatched manifest commit or package identity', async () => {
  await writeFile(
    join(artifacts, 'release.json'),
    JSON.stringify({ commit: '0'.repeat(40), packages: [] }),
  )
  await expect(validateReleaseArtifacts({ root, artifacts, commit, tag })).rejects.toThrow(
    'manifest commit',
  )
  await writeReleaseManifest(root, artifacts)
  const manifest = await readFile(join(artifacts, 'release.json'), 'utf8')
  await writeFile(
    join(artifacts, 'release.json'),
    manifest.replace('ghostty-webgpu-line-editor', 'wrong-name'),
  )
  await expect(validateReleaseArtifacts({ root, artifacts, commit, tag })).rejects.toThrow(
    'identity or checksum',
  )
})

test.each(['v0.0.2-SHA', 'v0.0.1-deadbee', 'v0.0.1-SHA/extra', 'v0.0.1-abc', 'v0.0.1-'])(
  'rejects a wrong tag version or commit prefix: %s',
  async (pattern) => {
    await expect(
      validateReleaseArtifacts({
        root,
        artifacts,
        commit,
        tag: pattern.replace('SHA', commit.slice(0, 12)),
      }),
    ).rejects.toThrow('tag must match')
  },
)

test.each(['lightweight', 'annotated'])(
  'rejects a %s tag retargeted away from the tested commit',
  async (kind) => {
    git(
      '-c',
      'user.name=Release test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'other',
    )
    const other = sourceCommit(root)
    git('tag', '-d', tag)
    const arguments_ = ['tag', tag, other]
    if (kind === 'annotated') arguments_.push('-a', '-m', 'wrong target')
    git('-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid', ...arguments_)
    git('checkout', '--detach', commit)
    await expect(validateReleaseArtifacts({ root, artifacts, commit, tag })).rejects.toThrow(
      'tag points to a different commit',
    )
  },
)

test('rejects a workflow commit that differs from the checkout', async () => {
  await expect(
    validateReleaseArtifacts({ root, artifacts, commit: '0'.repeat(40), tag }),
  ).rejects.toThrow('commit differs from the checkout')
})
