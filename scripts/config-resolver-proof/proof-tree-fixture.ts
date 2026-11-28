import { spawnSync } from 'node:child_process'
import { chmodSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashExternalTree, type ExternalTreeIdentity } from './proof-contract'
import {
  assertProofRejection,
  createFixtureDirectory,
  fail,
  sha256,
  stableJson,
} from './proof-self-test-support'
import { computeGitTreeSha256, type UpstreamAudit } from './upstream-audit'

type TreeTestResult<T> = {
  readonly baseline: T
  readonly mutationSha256: string
  readonly mutations: number
}

const GITLINK_ONE = '1'.repeat(40)
const GITLINK_TWO = '2'.repeat(40)

function runGit(directory: string, argv: readonly string[]): string {
  const result = spawnSync('/usr/bin/git', argv, {
    cwd: directory,
    encoding: 'utf8',
    env: {
      GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
      GIT_AUTHOR_EMAIL: 'proof@example.invalid',
      GIT_AUTHOR_NAME: 'proof-self-test',
      GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
      GIT_COMMITTER_EMAIL: 'proof@example.invalid',
      GIT_COMMITTER_NAME: 'proof-self-test',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0 || result.stderr.length !== 0) {
    fail(`Git fixture command failed: ${argv[0] ?? 'unknown'}`)
  }
  return result.stdout.trim()
}

function writeFixtureFile(path: string, content: string, mode: number): void {
  writeFileSync(path, content)
  chmodSync(path, mode)
}

function createFixtureSymlink(target: string, path: string): void {
  // Symlink mode is hashed, and macOS derives it from the creation umask.
  const previousUmask = process.umask()
  try {
    process.umask(0)
    symlinkSync(target, path)
  } finally {
    process.umask(previousUmask)
  }
}

function createGitFixture(root: string, mutation: string): string {
  createFixtureDirectory(root)
  runGit(root, ['init', '--quiet'])
  createFixtureDirectory(join(root, 'bin'))
  createFixtureDirectory(join(root, 'links'))

  const plainName = mutation === 'path' ? 'plain-renamed.txt' : 'plain.txt'
  const plainContent = mutation === 'blob' ? 'bravo\n' : 'alpha\n'
  const plainMode = mutation === 'mode' ? 0o755 : 0o644
  const symlinkTarget = mutation === 'symlink' ? '../bin/run.sh' : '../plain.txt'
  const gitlink = mutation === 'gitlink' ? GITLINK_TWO : GITLINK_ONE

  writeFixtureFile(join(root, plainName), plainContent, plainMode)
  writeFixtureFile(join(root, 'bin', 'run.sh'), '#!/bin/sh\nexit 0\n', 0o755)
  createFixtureSymlink(symlinkTarget, join(root, 'links', 'current'))
  runGit(root, ['add', '--all'])
  runGit(root, ['update-index', '--add', '--cacheinfo', '160000', gitlink, 'vendor/submodule'])
  runGit(root, ['commit', '--quiet', '--message', 'fixture'])
  return runGit(root, ['rev-parse', 'HEAD'])
}

function addCheckoutNoise(root: string, marker: string, modifiedTime: number): void {
  createFixtureDirectory(join(root, '.proof-cache'), 0o700)
  writeFileSync(join(root, '.proof-cache', 'untracked-cache'), marker)
  writeFileSync(join(root, '.git', 'self-test-metadata'), marker)
  runGit(root, ['config', 'proof.marker', marker])
  utimesSync(join(root, 'plain.txt'), modifiedTime, modifiedTime)
  utimesSync(join(root, 'bin', 'run.sh'), modifiedTime, modifiedTime)
}

function assertAuditEqual(left: UpstreamAudit, right: UpstreamAudit, label: string): void {
  if (stableJson(left) !== stableJson(right)) fail(`${label} changed tree identity`)
}

function assertAuditChanged(left: UpstreamAudit, right: UpstreamAudit, label: string): void {
  if (left.sha256 === right.sha256) fail(`${label} did not change tree identity`)
}

export function testGitTree(root: string): TreeTestResult<UpstreamAudit> {
  const checkoutOne = join(root, 'checkout-one')
  const checkoutTwo = join(root, 'checkout-two')
  const revisionOne = createGitFixture(checkoutOne, 'none')
  const revisionTwo = createGitFixture(checkoutTwo, 'none')
  addCheckoutNoise(checkoutOne, 'one', 946_684_800)
  addCheckoutNoise(checkoutTwo, 'two', 1_262_304_000)

  const baseline = computeGitTreeSha256(checkoutOne, revisionOne)
  const metadataVariant = computeGitTreeSha256(checkoutTwo, revisionTwo)
  assertAuditEqual(baseline, metadataVariant, 'Git metadata/mtime/untracked-cache variant')

  const transcript: string[] = []
  for (const mutation of ['path', 'mode', 'blob', 'symlink', 'gitlink']) {
    const fixture = join(root, `mutation-${mutation}`)
    const revision = createGitFixture(fixture, mutation)
    const identity = computeGitTreeSha256(fixture, revision)
    assertAuditChanged(baseline, identity, `Git ${mutation} mutation`)
    transcript.push(`${mutation}:${stableJson(identity)}`)
  }

  return {
    baseline,
    mutationSha256: sha256(`${transcript.join('\n')}\n`),
    mutations: transcript.length,
  }
}

function createExternalTree(root: string, variant: string): void {
  createFixtureDirectory(root)
  const directoryOrder = variant === 'order' ? ['links', 'empty', 'bin'] : ['bin', 'empty', 'links']
  for (const name of directoryOrder) createFixtureDirectory(join(root, name))

  const fileOrder = variant === 'order' ? ['other.txt', 'data.txt'] : ['data.txt', 'other.txt']
  for (const name of fileOrder) {
    const content = name === 'data.txt' ? 'data\n' : 'other\n'
    writeFixtureFile(join(root, name), content, 0o644)
  }
  writeFixtureFile(join(root, 'bin', 'tool'), 'tool\n', 0o755)
  createFixtureSymlink('../data.txt', join(root, 'links', 'data'))

  if (variant === 'file') writeFixtureFile(join(root, 'data.txt'), 'changed\n', 0o644)
  if (variant === 'symlink') {
    rmSync(join(root, 'links', 'data'))
    createFixtureSymlink('../other.txt', join(root, 'links', 'data'))
  }
  if (variant === 'empty-dir') {
    rmSync(join(root, 'empty'), { recursive: true })
    createFixtureDirectory(join(root, 'vacant'))
  }
  if (variant === 'mode') chmodSync(join(root, 'data.txt'), 0o600)

  const modifiedTime = variant === 'order' ? 1_262_304_000 : 946_684_800
  for (const path of ['bin', 'empty', 'links', 'data.txt', 'other.txt', 'bin/tool']) {
    const absolute = join(root, path)
    if (variant === 'empty-dir' && path === 'empty') continue
    utimesSync(absolute, modifiedTime, modifiedTime)
  }
  if (variant === 'empty-dir') utimesSync(join(root, 'vacant'), modifiedTime, modifiedTime)
}

function assertExternalEqual(
  left: ExternalTreeIdentity,
  right: ExternalTreeIdentity,
  label: string,
): void {
  if (stableJson(left) !== stableJson(right)) fail(`${label} changed external-tree identity`)
}

function assertExternalChanged(
  left: ExternalTreeIdentity,
  right: ExternalTreeIdentity,
  label: string,
): void {
  if (left.sha256 === right.sha256) fail(`${label} did not change external-tree identity`)
}

function assertExternalEscapeRejected(root: string): void {
  const outside = join(root, 'outside.txt')
  const fixture = join(root, 'escape')
  writeFileSync(outside, 'outside\n')
  createExternalTree(fixture, 'none')
  createFixtureSymlink('../outside.txt', join(fixture, 'escape'))
  assertProofRejection(() => hashExternalTree(fixture), 'escaping external-tree symlink')
}

function assertSymlinkErrorRestoresUmask(root: string): void {
  const path = join(root, 'umask-restore-link')
  createFixtureSymlink('target', path)
  const expected = process.umask()
  try {
    createFixtureSymlink('target', path)
  } catch {
    if (process.umask() !== expected) fail('fixture symlink helper leaked umask after an error')
    return
  }
  fail('fixture symlink error case did not fail')
}

export function testExternalTree(root: string): TreeTestResult<ExternalTreeIdentity> {
  const baselinePath = join(root, 'baseline')
  const orderPath = join(root, 'order')
  createExternalTree(baselinePath, 'none')
  createExternalTree(orderPath, 'order')
  const baseline = hashExternalTree(baselinePath)
  const orderVariant = hashExternalTree(orderPath)
  assertExternalEqual(baseline, orderVariant, 'creation-order/mtime variant')

  const transcript: string[] = []
  for (const mutation of ['file', 'symlink', 'empty-dir', 'mode']) {
    const fixture = join(root, mutation)
    createExternalTree(fixture, mutation)
    const identity = hashExternalTree(fixture)
    assertExternalChanged(baseline, identity, `external-tree ${mutation} mutation`)
    transcript.push(`${mutation}:${stableJson(identity)}`)
  }
  assertExternalEscapeRejected(root)
  assertSymlinkErrorRestoresUmask(root)

  return {
    baseline,
    mutationSha256: sha256(`${transcript.join('\n')}\n`),
    mutations: transcript.length,
  }
}
