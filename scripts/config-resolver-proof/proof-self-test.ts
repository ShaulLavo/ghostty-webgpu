import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  PROOF_SOURCE_DATE_EPOCH,
  PROOF_TARGETS,
  PROOF_UPSTREAM_REPOSITORY,
  PROOF_UPSTREAM_REVISION,
  PROOF_UPSTREAM_TREE_SHA256,
  PROOF_ZIG_VERSION,
  ProofContractError,
  hashExternalTree,
  loadProofRecipe,
  projectObservedLinkArgv,
  proofCanonicalBytes,
  type ExternalTreeIdentity,
  type ProofTarget,
} from './proof-contract'
import { computeGitTreeSha256, type UpstreamAudit } from './upstream-audit'

type JsonObject = { [key: string]: JsonValue }
type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string
type JsonPath = readonly (number | string)[]
type MutationOutcome = 'change' | 'reject'
type MutationCase = {
  readonly apply: (recipe: JsonObject) => void
  readonly covers: readonly string[]
  readonly label: string
  readonly outcome: MutationOutcome
}
type ProjectionMutationCase = {
  readonly apply: (argv: string[], target: ProofTarget) => void
  readonly label: string
  readonly outcome: 'equal' | 'reject'
  readonly requiresContractRejection?: boolean
}
type ProjectionTestResult = {
  readonly equal: number
  readonly rejected: number
  readonly transcript: readonly string[]
}
type SelfTestResult = {
  readonly externalTree: {
    readonly baseline: ExternalTreeIdentity
    readonly mutationSha256: string
    readonly mutations: number
  }
  readonly gitTree: {
    readonly baseline: UpstreamAudit
    readonly mutationSha256: string
    readonly mutations: number
  }
  readonly recipe: {
    readonly canonicalBytes: number
    readonly canonicalSha256: string
    readonly changed: number
    readonly mutationSha256: string
    readonly mutations: number
    readonly projectedEqual: number
    readonly projectedRejected: number
    readonly rejected: number
  }
}
type CheckedRecipeIdentity = {
  readonly bytes: number
  readonly sha256: string
}

class SelfTestFailure extends Error {}

const GITLINK_ONE = '1'.repeat(40)
const GITLINK_TWO = '2'.repeat(40)
const LINUX_TARGET = ['targets', 'linux-x64'] as const
const DARWIN_TARGET = ['targets', 'darwin-arm64'] as const
const OBSERVED_LINK_TARGET_COUNTS: Readonly<Record<ProofTarget, number>> = {
  'darwin-arm64': 18,
  'darwin-x64': 18,
  'linux-arm64': 17,
  'linux-x64': 17,
}
const OBSERVED_LINK_ARGV_LENGTHS: Readonly<Record<ProofTarget, number>> = {
  'darwin-arm64': 391,
  'darwin-x64': 391,
  'linux-arm64': 370,
  'linux-x64': 370,
}
const LINK_FILLER_PREFIX = '--proof-self-test-link-filler='
const LINK_CACHE_KEYS = {
  primary: '0123456789abcdef0123456789abcdef',
  secondary: 'fedcba9876543210fedcba9876543210',
  tertiary: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const
const DRIFTED_LINK_CACHE_KEYS = {
  primary: '13579bdf02468ace13579bdf02468ace',
  secondary: '2468ace013579bdf2468ace013579bdf',
  tertiary: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
} as const

const TARGET_FIXTURES: Readonly<
  Record<
    ProofTarget,
    {
      readonly root: string
      readonly triple: string
      readonly zigArchive: {
        readonly archiveBytes: number
        readonly archiveSha256: string
        readonly url: string
      }
    }
  >
> = {
  'darwin-arm64': {
    root: '/private/tmp/ghostty-config-resolver-proof-build-v1',
    triple: 'aarch64-macos.13.0',
    zigArchive: {
      archiveBytes: 52_238_004,
      archiveSha256: 'b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489',
      url: 'https://ziglang.org/download/0.16.0/zig-aarch64-macos-0.16.0.tar.xz',
    },
  },
  'darwin-x64': {
    root: '/private/tmp/ghostty-config-resolver-proof-build-v1',
    triple: 'x86_64-macos.13.0',
    zigArchive: {
      archiveBytes: 57_396_836,
      archiveSha256: '0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7',
      url: 'https://ziglang.org/download/0.16.0/zig-x86_64-macos-0.16.0.tar.xz',
    },
  },
  'linux-arm64': {
    root: '/tmp/ghostty-config-resolver-proof-build-v1',
    triple: 'aarch64-linux-musl',
    zigArchive: {
      archiveBytes: 51_211_944,
      archiveSha256: 'ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17',
      url: 'https://ziglang.org/download/0.16.0/zig-aarch64-linux-0.16.0.tar.xz',
    },
  },
  'linux-x64': {
    root: '/tmp/ghostty-config-resolver-proof-build-v1',
    triple: 'x86_64-linux-musl',
    zigArchive: {
      archiveBytes: 55_478_392,
      archiveSha256: '70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00',
      url: 'https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz',
    },
  },
}

const RECIPE_SCHEMA_FIELDS = [
  'recipe.schemaVersion',
  'recipe.sourceDateEpoch',
  'recipe.targets',
  'recipe.upstream',
  'recipe.zigVersion',
  'targets.darwin-arm64',
  'targets.darwin-x64',
  'targets.linux-arm64',
  'targets.linux-x64',
  'upstream.repository',
  'upstream.revision',
  'upstream.treeSha256',
  'target.buildArgv',
  'target.environment',
  'target.inputs',
  'target.linkPlan',
  'target.optimizationMode',
  'target.runner',
  'target.stripArgv',
  'target.targetTriple',
  'target.tools',
  'runner.arch',
  'runner.image',
  'runner.imageVersion',
  'runner.os',
  'environment.name',
  'environment.value',
  'tool.acquisition',
  'tool.bytes',
  'tool.generation',
  'tool.name',
  'tool.role',
  'tool.sha256',
  'tool.version',
  'input.acquisition',
  'input.bytes',
  'input.generation',
  'input.id',
  'input.role',
  'input.sha256',
  'generation.argv',
  'generation.sources',
  'official-download.archiveBytes',
  'official-download.archiveSha256',
  'official-download.kind',
  'official-download.url',
  'git.kind',
  'git.repository',
  'git.revision',
  'git.treeAlgorithm',
  'git.treeSha256',
  'runner-component.contentKind',
  'runner-component.kind',
  'runner-component.macosSdk',
  'runner-component.path',
  'runner-component.runnerImage',
  'runner-component.runnerImageVersion',
  'macosSdk.sdkBuild',
  'macosSdk.sdkSettingsSha256',
  'macosSdk.sdkVersion',
  'macosSdk.xcodeBuild',
  'macosSdk.xcodeVersion',
] as const

// These values intentionally freeze the format, not ambient tool or filesystem metadata.
const GOLDEN_RESULT: SelfTestResult = {
  externalTree: {
    baseline: {
      bytes: 27,
      entries: 7,
      sha256: 'a768d6377f40287740b4964d74d8b2876607db8d5193c0d47b695d28365f3872',
    },
    mutationSha256: '1b952e62c88711b372a0e7914bab82f9930b9656af2c0fb053cd33a5f405831f',
    mutations: 4,
  },
  gitTree: {
    baseline: {
      bytes: 55,
      entries: 4,
      gitlinks: 1,
      sha256: '4465646445232cd47796f779883436f88bfc25e78806ab1a5a5f573332791de1',
    },
    mutationSha256: 'f55ecbe524f45c9e24f2ccb11d9346c13f183b104e681040f8c0cd7e0e802de7',
    mutations: 5,
  },
  recipe: {
    canonicalBytes: 81_038,
    canonicalSha256: 'b33f427519c7902c23adc3ef680b6dcd047b06804806df1753cb5957691fa3f3',
    changed: 12,
    mutationSha256: '85cb96fc7ec9b39b72139de3b3a655fbe52e87c787ad9c9be5805220af163c6f',
    mutations: 255,
    projectedEqual: 4,
    projectedRejected: 76,
    rejected: 163,
  },
}

function fail(message: string): never {
  throw new SelfTestFailure(message)
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

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

function createFixtureDirectory(path: string, mode = 0o755): void {
  mkdirSync(path, { recursive: true, mode })
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

function testGitTree(root: string): SelfTestResult['gitTree'] {
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

function testExternalTree(root: string): SelfTestResult['externalTree'] {
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

function targetIdentity(target: ProofTarget): {
  readonly arch: 'arm64' | 'x64'
  readonly os: 'darwin' | 'linux'
} {
  const os = target.startsWith('darwin-') ? 'darwin' : 'linux'
  const arch = target.endsWith('arm64') ? 'arm64' : 'x64'
  return { arch, os }
}

function fixtureHash(label: string): string {
  return sha256(`proof-self-test:${label}`)
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function officialDownload(label: string): JsonObject {
  return {
    archiveBytes: 100 + label.length,
    archiveSha256: fixtureHash(`archive:${label}`),
    kind: 'official-download',
    url: `https://example.invalid/downloads/${label}.tar.xz`,
  }
}

function upstreamAcquisition(): JsonObject {
  return {
    kind: 'git',
    repository: PROOF_UPSTREAM_REPOSITORY,
    revision: PROOF_UPSTREAM_REVISION,
    treeAlgorithm: 'ghostty-upstream-tree-v1',
    treeSha256: PROOF_UPSTREAM_TREE_SHA256,
  }
}

function zigAcquisition(target: ProofTarget): JsonObject {
  const archive = TARGET_FIXTURES[target].zigArchive
  return {
    archiveBytes: archive.archiveBytes,
    archiveSha256: archive.archiveSha256,
    kind: 'official-download',
    url: archive.url,
  }
}

function runnerImage(target: ProofTarget): {
  readonly image: string
  readonly version: string
} {
  const identity = targetIdentity(target)
  return { image: `${identity.os}-proof-image`, version: '20260828.1' }
}

function runnerComponent(
  target: ProofTarget,
  path: string,
  contentKind: 'external-tree-v1' | 'file',
): JsonObject {
  const image = runnerImage(target)
  return {
    contentKind,
    kind: 'runner-component',
    path,
    runnerImage: image.image,
    runnerImageVersion: image.version,
  }
}

function sdkComponent(target: ProofTarget): JsonObject {
  const acquisition = runnerComponent(
    target,
    '/Applications/Xcode_16.0.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk',
    'external-tree-v1',
  )
  acquisition.macosSdk = {
    sdkBuild: '24A336',
    sdkSettingsSha256: fixtureHash(`${target}:sdk-settings`),
    sdkVersion: '15.0',
    xcodeBuild: '16A242d',
    xcodeVersion: '16.0',
  }
  return acquisition
}

function toolRecord(
  target: ProofTarget,
  role: 'linker' | 'sdk-or-sysroot' | 'strip' | 'zig',
): JsonObject {
  const zigBytes = 1_000 + target.length
  const zigSha256 = fixtureHash(`tool:${target}:zig`)
  if (role === 'linker') {
    return {
      acquisition: zigAcquisition(target),
      bytes: zigBytes,
      name: 'zig-integrated-linker',
      role,
      sha256: zigSha256,
      version: PROOF_ZIG_VERSION,
    }
  }
  if (role === 'zig') {
    return {
      acquisition: zigAcquisition(target),
      bytes: zigBytes,
      name: 'zig',
      role,
      sha256: zigSha256,
      version: PROOF_ZIG_VERSION,
    }
  }
  if (role === 'strip') {
    return {
      acquisition: runnerComponent(target, '/usr/bin/strip', 'file'),
      bytes: 2_000 + target.length,
      name: 'system-strip',
      role,
      sha256: fixtureHash(`tool:${target}:strip`),
      version: 'proof-runner-strip',
    }
  }
  if (target.startsWith('darwin-')) {
    return {
      acquisition: sdkComponent(target),
      bytes: 3_000 + target.length,
      name: 'macos-sdk-tree',
      role,
      sha256: fixtureHash(`tool:${target}:sdk`),
      version: '15.0',
    }
  }
  return {
    acquisition: zigAcquisition(target),
    bytes: 3_000 + target.length,
    name: 'zig-bundled-lib-tree',
    role,
    sha256: fixtureHash(`tool:${target}:zig-lib`),
    version: PROOF_ZIG_VERSION,
  }
}

function proofGenerationArgv(target: ProofTarget): JsonValue[] {
  const fixture = TARGET_FIXTURES[target]
  return [
    `${fixture.root}/toolchain/zig`,
    'build',
    'proof-materialize-generated',
    '-j1',
    '--seed',
    '0',
    '-fincremental',
    '--prefix',
    `${fixture.root}/prefix`,
    '--cache-dir',
    `${fixture.root}/cache`,
    '--global-cache-dir',
    `${fixture.root}/global-cache`,
    '-Doptimize=ReleaseSafe',
    `-Dtarget=${fixture.triple}`,
    '-Dproof-preverified-generated=false',
  ]
}

function proofGenerationSources(target: ProofTarget): JsonValue[] {
  const sdk = target.startsWith('darwin-') ? 'macos-sdk-tree' : 'zig-bundled-lib-tree'
  const sources = [
    'input:dependency',
    'input:upstream',
    `tool:${sdk}`,
    'tool:zig',
    'tool:zig-integrated-linker',
  ]
  if (target.startsWith('darwin-')) sources.push('input:zig-bundled-lib-tree')
  return sources.sort()
}

function ordinaryInput(target: ProofTarget, id: 'dependency' | 'runtime' | 'upstream'): JsonObject {
  const label = `${target}:${id}`
  if (id === 'dependency') {
    return {
      acquisition: officialDownload(label),
      bytes: 2_000 + label.length,
      id,
      role: 'dependency-archive',
      sha256: fixtureHash(`input:${label}`),
    }
  }
  if (id === 'runtime') {
    return {
      acquisition: runnerComponent(target, '/usr/share/ghostty/proof-runtime', 'file'),
      bytes: 2_000 + label.length,
      id,
      role: 'runtime-resource',
      sha256: fixtureHash(`input:${label}`),
    }
  }
  return {
    acquisition: upstreamAcquisition(),
    bytes: 2_000 + label.length,
    id,
    role: 'upstream-submodule',
    sha256: fixtureHash(`input:${label}`),
  }
}

function generatedInput(target: ProofTarget, id: string): JsonObject {
  return {
    acquisition: upstreamAcquisition(),
    bytes: 4_000 + id.length,
    generation: {
      argv: proofGenerationArgv(target),
      sources: proofGenerationSources(target),
    },
    id,
    role: 'generated-resource-source',
    sha256: fixtureHash(`input:${target}:${id}`),
  }
}

function targetInputs(target: ProofTarget): JsonValue[] {
  const generatedIds = target.startsWith('darwin-')
    ? ['proof-generated-help-strings', 'proof-generated-wuffs-c']
    : ['proof-generated-hb-c', 'proof-generated-help-strings', 'proof-generated-wuffs-c']
  const inputs: JsonObject[] = [ordinaryInput(target, 'dependency')]
  for (const id of generatedIds) inputs.push(generatedInput(target, id))
  if (target.startsWith('darwin-')) {
    inputs.push({
      acquisition: zigAcquisition(target),
      bytes: 5_000 + target.length,
      id: 'zig-bundled-lib-tree',
      role: 'generated-resource-source',
      sha256: fixtureHash(`input:${target}:zig-lib`),
    })
  }
  inputs.push(ordinaryInput(target, 'runtime'), ordinaryInput(target, 'upstream'))
  return inputs.sort((left, right) => {
    const leftKey = `${String(left.role)}\0${String(left.id)}`
    const rightKey = `${String(right.role)}\0${String(right.id)}`
    return compareStrings(leftKey, rightKey)
  })
}

function buildArgv(target: ProofTarget): JsonValue[] {
  const fixture = TARGET_FIXTURES[target]
  return [
    `${fixture.root}/toolchain/zig`,
    'build',
    '-j1',
    '--seed',
    '0',
    '-fincremental',
    '--prefix',
    `${fixture.root}/prefix`,
    '--cache-dir',
    `${fixture.root}/final-cache`,
    '--global-cache-dir',
    `${fixture.root}/global-cache`,
    '-Doptimize=ReleaseSafe',
    `-Dtarget=${fixture.triple}`,
    '-Dproof-preverified-generated=true',
    '--verbose',
  ]
}

function targetEnvironment(target: ProofTarget): JsonValue[] {
  const root = TARGET_FIXTURES[target].root
  return [
    { name: 'HOME', value: `${root}/cache/home` },
    { name: 'LANG', value: 'C.UTF-8' },
    { name: 'LC_ALL', value: 'C.UTF-8' },
    { name: 'PATH', value: '/usr/bin:/bin:/usr/sbin:/sbin' },
    { name: 'SOURCE_DATE_EPOCH', value: String(PROOF_SOURCE_DATE_EPOCH) },
    { name: 'TMPDIR', value: `${root}/cache/tmp` },
    { name: 'UMASK', value: '0022' },
    { name: 'XDG_CACHE_HOME', value: `${root}/global-cache` },
    { name: 'ZIG_EXE', value: `${root}/toolchain/zig` },
  ]
}

function observedLinkArgv(
  target: ProofTarget,
  keys: Readonly<Record<keyof typeof LINK_CACHE_KEYS, string>> = LINK_CACHE_KEYS,
): string[] {
  const fixture = TARGET_FIXTURES[target]
  const argv: string[] = [
    `${fixture.root}/toolchain/zig`,
    'build-exe',
    '--name',
    'ghostty-config-resolver-proof',
    '--zig-lib-dir',
    `${fixture.root}/toolchain/lib/`,
    '--cache-dir',
    `${fixture.root}/final-cache`,
    '--global-cache-dir',
    `${fixture.root}/global-cache`,
  ]
  const targetCount = OBSERVED_LINK_TARGET_COUNTS[target]
  for (let index = 0; index < targetCount; index += 1) {
    argv.push('-target', fixture.triple)
  }
  argv.push(`-Mroot=${fixture.root}/overlay/main.zig`)
  if (!target.startsWith('darwin-')) {
    argv.push(`-Mhb_c=${fixture.root}/prefix/proof-generated/hb_c.zig`)
  }
  argv.push(
    `-Mhelp_strings=${fixture.root}/prefix/proof-generated/help_strings.zig`,
    `-Mwuffs_c=${fixture.root}/prefix/proof-generated/wuffs_c.zig`,
    '-fincremental',
    `-Mcache_primary=${fixture.root}/final-cache/o/${keys.primary}/primary.zig`,
    `-Mcache_primary_alias=${fixture.root}/final-cache/o/${keys.primary}/alias.zig`,
    `--proof-secondary=${fixture.root}/final-cache/o/${keys.secondary}/secondary.a`,
    `${fixture.root}/final-cache/o/${keys.tertiary}/tertiary.o`,
    `--proof-secondary-alias=${fixture.root}/final-cache/o/${keys.secondary}/alias.a`,
  )
  while (argv.length < OBSERVED_LINK_ARGV_LENGTHS[target] - 1) {
    argv.push(`${LINK_FILLER_PREFIX}${argv.length}`)
  }
  argv.push('--listen=-')
  return argv
}

function targetRecipe(target: ProofTarget): JsonObject {
  const identity = targetIdentity(target)
  const image = runnerImage(target)
  const fixture = TARGET_FIXTURES[target]
  const stripOption = target.startsWith('darwin-') ? '-x' : '--strip-all'
  return {
    buildArgv: buildArgv(target),
    environment: targetEnvironment(target),
    inputs: targetInputs(target),
    linkPlan: [...projectObservedLinkArgv(observedLinkArgv(target), target)],
    optimizationMode: 'ReleaseSafe',
    runner: {
      arch: identity.arch,
      image: image.image,
      imageVersion: image.version,
      os: identity.os,
    },
    stripArgv: [
      '/usr/bin/strip',
      stripOption,
      `${fixture.root}/bundle/bin/ghostty-config-resolver-proof`,
    ],
    targetTriple: fixture.triple,
    tools: [
      toolRecord(target, 'linker'),
      toolRecord(target, 'sdk-or-sysroot'),
      toolRecord(target, 'strip'),
      toolRecord(target, 'zig'),
    ],
  }
}

function recipeFixture(): JsonObject {
  const targets: JsonObject = {}
  for (const target of PROOF_TARGETS) targets[target] = targetRecipe(target)
  return {
    schemaVersion: 2,
    sourceDateEpoch: PROOF_SOURCE_DATE_EPOCH,
    targets,
    upstream: {
      repository: PROOF_UPSTREAM_REPOSITORY,
      revision: PROOF_UPSTREAM_REVISION,
      treeSha256: PROOF_UPSTREAM_TREE_SHA256,
    },
    zigVersion: PROOF_ZIG_VERSION,
  }
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function valueAt(root: JsonValue, path: JsonPath): JsonValue {
  let value = root
  for (const component of path) {
    if (typeof component === 'number') {
      if (!Array.isArray(value) || value[component] === undefined)
        fail('invalid fixture array path')
      value = value[component]
      continue
    }
    if (!isJsonObject(value) || value[component] === undefined) fail('invalid fixture object path')
    value = value[component]
  }
  return value
}

function parentAt(
  root: JsonValue,
  path: JsonPath,
): { readonly key: number | string; readonly value: JsonValue } {
  if (path.length === 0) fail('fixture path has no parent')
  const key = path[path.length - 1]
  if (key === undefined) fail('fixture path has no key')
  return { key, value: valueAt(root, path.slice(0, -1)) }
}

function setValue(root: JsonValue, path: JsonPath, value: JsonValue): void {
  const parent = parentAt(root, path)
  if (typeof parent.key === 'number') {
    if (!Array.isArray(parent.value)) fail('fixture mutation expected an array')
    parent.value[parent.key] = value
    return
  }
  if (!isJsonObject(parent.value)) fail('fixture mutation expected an object')
  parent.value[parent.key] = value
}

function deleteValue(root: JsonValue, path: JsonPath): void {
  const parent = parentAt(root, path)
  if (typeof parent.key === 'number') {
    if (!Array.isArray(parent.value)) fail('fixture deletion expected an array')
    parent.value.splice(parent.key, 1)
    return
  }
  if (!isJsonObject(parent.value)) fail('fixture deletion expected an object')
  delete parent.value[parent.key]
}

function swapArray(root: JsonValue, path: JsonPath, left: number, right: number): void {
  const value = valueAt(root, path)
  if (!Array.isArray(value)) fail('fixture swap expected an array')
  const leftValue = value[left]
  const rightValue = value[right]
  if (leftValue === undefined || rightValue === undefined) fail('fixture swap index is invalid')
  value[left] = rightValue
  value[right] = leftValue
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function objectAt(root: JsonValue, path: JsonPath): JsonObject {
  const value = valueAt(root, path)
  if (!isJsonObject(value)) fail('fixture path did not resolve to an object')
  return value
}

function arrayAt(root: JsonValue, path: JsonPath): JsonValue[] {
  const value = valueAt(root, path)
  if (!Array.isArray(value)) fail('fixture path did not resolve to an array')
  return value
}

function targetAt(recipe: JsonObject, target: ProofTarget): JsonObject {
  return objectAt(recipe, ['targets', target])
}

function recordBy(
  recipe: JsonObject,
  target: ProofTarget,
  collection: 'inputs' | 'tools',
  key: 'id' | 'role',
  expected: string,
): JsonObject {
  const records = arrayAt(recipe, ['targets', target, collection])
  const matches = records.filter((record) => isJsonObject(record) && record[key] === expected)
  if (matches.length !== 1 || !isJsonObject(matches[0])) fail('fixture record lookup is ambiguous')
  return matches[0]
}

function toolByRole(recipe: JsonObject, target: ProofTarget, role: string): JsonObject {
  return recordBy(recipe, target, 'tools', 'role', role)
}

function inputById(recipe: JsonObject, target: ProofTarget, id: string): JsonObject {
  return recordBy(recipe, target, 'inputs', 'id', id)
}

function acquisitionOf(record: JsonObject): JsonObject {
  const acquisition = record.acquisition
  if (!isJsonObject(acquisition)) fail('fixture acquisition is not an object')
  return acquisition
}

function generationOf(record: JsonObject): JsonObject {
  const generation = record.generation
  if (!isJsonObject(generation)) fail('fixture generation is not an object')
  return generation
}

function mutateLinkArgument(
  recipe: JsonObject,
  target: ProofTarget,
  expected: string,
  replacement: string,
): void {
  const argv = arrayAt(recipe, ['targets', target, 'linkPlan'])
  const index = argv.indexOf(expected)
  if (index < 0) fail('fixture link argument was not found')
  argv[index] = replacement
}

function insertBeforeListen(recipe: JsonObject, target: ProofTarget, argument: string): void {
  const argv = arrayAt(recipe, ['targets', target, 'linkPlan'])
  const listen = argv.lastIndexOf('--listen=-')
  if (listen < 0) fail('fixture link listen argument was not found')
  argv.splice(listen, 0, argument)
}

function replaceLinkFiller(recipe: JsonObject, target: ProofTarget, replacement: string): void {
  const argv = arrayAt(recipe, ['targets', target, 'linkPlan'])
  const index = argv.findIndex(
    (argument) => typeof argument === 'string' && argument.startsWith(LINK_FILLER_PREFIX),
  )
  if (index < 0) fail('fixture link filler was not found')
  argv[index] = replacement
}

function mutateArrayValue(values: JsonValue[], expected: string, replacement: string): void {
  const index = values.indexOf(expected)
  if (index < 0) fail('fixture array value was not found')
  values[index] = replacement
}

function sortRecords(records: JsonValue[]): void {
  records.sort((left, right) => {
    if (!isJsonObject(left) || !isJsonObject(right)) fail('fixture record is not an object')
    const leftIdentity = left.id ?? left.name
    const rightIdentity = right.id ?? right.name
    const leftKey = `${String(left.role)}\0${String(leftIdentity)}`
    const rightKey = `${String(right.role)}\0${String(rightIdentity)}`
    return compareStrings(leftKey, rightKey)
  })
}

function mutateOptionValue(
  recipe: JsonObject,
  target: ProofTarget,
  option: string,
  replacement: string,
): void {
  const argv = arrayAt(recipe, ['targets', target, 'linkPlan'])
  const optionIndex = argv.indexOf(option)
  if (optionIndex < 0 || optionIndex + 1 >= argv.length) fail('fixture link option was not found')
  argv[optionIndex + 1] = replacement
}

function linkArgumentIndex(argv: readonly string[], marker: string): number {
  const index = argv.findIndex((argument) => argument.includes(marker))
  if (index < 0) fail(`fixture link argument was not found: ${marker}`)
  return index
}

function replaceLinkText(argv: string[], expected: string, replacement: string): void {
  let replacements = 0
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument?.includes(expected)) continue
    argv[index] = argument.replaceAll(expected, replacement)
    replacements += 1
  }
  if (replacements === 0) fail(`fixture link text was not found: ${expected}`)
}

function mutateMarkedLinkArgument(
  argv: string[],
  marker: string,
  mutate: (argument: string) => string,
): void {
  const index = linkArgumentIndex(argv, marker)
  const argument = argv[index]
  if (argument === undefined) fail('fixture marked link argument is missing')
  argv[index] = mutate(argument)
}

function planStrings(recipe: JsonObject, target: ProofTarget): string[] {
  const values = arrayAt(recipe, ['targets', target, 'linkPlan'])
  if (!values.every((value) => typeof value === 'string')) {
    fail('fixture link plan contains a non-string argument')
  }
  return values as string[]
}

function replacePlanText(
  recipe: JsonObject,
  target: ProofTarget,
  expected: string,
  replacement: string,
): void {
  replaceLinkText(planStrings(recipe, target), expected, replacement)
}

function projectionMutationCases(): readonly ProjectionMutationCase[] {
  return [
    {
      apply: (argv) => {
        replaceLinkText(argv, LINK_CACHE_KEYS.primary, DRIFTED_LINK_CACHE_KEYS.primary)
        replaceLinkText(argv, LINK_CACHE_KEYS.secondary, DRIFTED_LINK_CACHE_KEYS.secondary)
        replaceLinkText(argv, LINK_CACHE_KEYS.tertiary, DRIFTED_LINK_CACHE_KEYS.tertiary)
      },
      label: 'raw-cache-key-drift',
      outcome: 'equal',
    },
    {
      apply: (argv) => replaceLinkText(argv, LINK_CACHE_KEYS.primary, '0'.repeat(31)),
      label: 'raw-cache-key-malformed',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) =>
        replaceLinkText(argv, LINK_CACHE_KEYS.primary, LINK_CACHE_KEYS.primary.toUpperCase()),
      label: 'raw-cache-key-uppercase',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) => replaceLinkText(argv, LINK_CACHE_KEYS.primary, '{{zig-cache-key-0000}}'),
      label: 'raw-cache-placeholder',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) => {
        mutateMarkedLinkArgument(argv, '-Mcache_primary_alias=', (argument) =>
          argument.replace(LINK_CACHE_KEYS.primary, 'cccccccccccccccccccccccccccccccc'),
        )
      },
      label: 'raw-cache-alias-split',
      outcome: 'reject',
    },
    {
      apply: (argv) => replaceLinkText(argv, LINK_CACHE_KEYS.secondary, LINK_CACHE_KEYS.primary),
      label: 'raw-cache-alias-collapsed',
      outcome: 'reject',
    },
    {
      apply: (argv, target) => {
        const root = TARGET_FIXTURES[target].root
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace(root, '/var/tmp/ghostty-config-resolver-proof-build-v1'),
        )
      },
      label: 'raw-cache-wrong-root',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv, target) => {
        const root = TARGET_FIXTURES[target].root
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument
            .replace(root, '/evil')
            .replace(LINK_CACHE_KEYS.primary, LINK_CACHE_KEYS.primary.toUpperCase()),
        )
      },
      label: 'raw-cache-wrong-root-uppercase',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv, target) => {
        const root = TARGET_FIXTURES[target].root
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace(root, '/evil').replace(LINK_CACHE_KEYS.primary, '0'.repeat(31)),
        )
      },
      label: 'raw-cache-wrong-root-malformed',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv, target) => {
        const root = TARGET_FIXTURES[target].root
        const opposite = target.startsWith('darwin-')
          ? TARGET_FIXTURES['linux-x64'].root
          : TARGET_FIXTURES['darwin-x64'].root
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace(root, opposite),
        )
      },
      label: 'raw-cache-opposite-root',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) => {
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace('/primary.zig', '/../../evil/primary.zig'),
        )
      },
      label: 'raw-cache-parent-traversal',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) => {
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace('/primary.zig', '/./primary.zig'),
        )
      },
      label: 'raw-cache-current-directory',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) => {
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace('/primary.zig', '//primary.zig'),
        )
      },
      label: 'raw-cache-empty-component',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) => {
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace('/primary.zig', '/changed.zig'),
        )
      },
      label: 'raw-cache-suffix',
      outcome: 'reject',
    },
    {
      apply: (argv) => {
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace('-Mcache_primary=', '-Mcache_changed='),
        )
      },
      label: 'raw-cache-module',
      outcome: 'reject',
    },
    {
      apply: (argv) => {
        mutateMarkedLinkArgument(argv, '--proof-secondary=', (argument) =>
          argument.replace('--proof-secondary=', '--proof-changed='),
        )
      },
      label: 'raw-cache-flag',
      outcome: 'reject',
    },
    {
      apply: (argv) => {
        const primary = linkArgumentIndex(argv, '-Mcache_primary=')
        const secondary = linkArgumentIndex(argv, '--proof-secondary=')
        ;[argv[primary], argv[secondary]] = [argv[secondary] ?? '', argv[primary] ?? '']
      },
      label: 'raw-cache-order',
      outcome: 'reject',
    },
    {
      apply: (argv) => argv.splice(linkArgumentIndex(argv, '-Mcache_primary_alias='), 1),
      label: 'raw-cache-count',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) => {
        const index = argv.findIndex((argument) => argument.startsWith(LINK_FILLER_PREFIX))
        if (index < 0) fail('fixture link filler was not found')
        argv[index] = `${LINK_FILLER_PREFIX}{{zig-cache-key-0000}}`
      },
      label: 'raw-cache-placeholder-elsewhere',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv, target) => {
        const root = TARGET_FIXTURES[target].root
        mutateMarkedLinkArgument(
          argv,
          '-Mcache_primary=',
          (argument) => `${argument}=${root}/final-cache/o/${LINK_CACHE_KEYS.secondary}/second.zig`,
        )
      },
      label: 'raw-cache-multiple-per-argument',
      outcome: 'reject',
      requiresContractRejection: true,
    },
  ]
}

function testProjectionMutations(): ProjectionTestResult {
  const transcript: string[] = []
  let equalCount = 0
  let rejectedCount = 0
  for (const target of PROOF_TARGETS) {
    const expected = projectObservedLinkArgv(observedLinkArgv(target), target)
    for (const entry of projectionMutationCases()) {
      const candidate = observedLinkArgv(target)
      entry.apply(candidate, target)
      let projected: readonly string[] | null = null
      let rejected = false
      try {
        projected = projectObservedLinkArgv(candidate, target)
      } catch (error) {
        if (!(error instanceof ProofContractError)) throw error
        rejected = true
      }
      if (entry.requiresContractRejection && !rejected) {
        fail(`${target} ${entry.label} did not reject at the contract boundary`)
      }
      const equal = !rejected && stableJson(projected) === stableJson(expected)
      if (entry.outcome === 'equal') {
        if (!equal) fail(`${target} ${entry.label} changed or rejected the plan`)
        transcript.push(`${target}:${entry.label}:equal`)
        equalCount += 1
        continue
      }
      if (equal) fail(`${target} ${entry.label} did not reject the observed plan`)
      transcript.push(`${target}:${entry.label}:reject`)
      rejectedCount += 1
    }
  }
  return { equal: equalCount, rejected: rejectedCount, transcript }
}

function setMutation(
  label: string,
  covers: string,
  path: JsonPath,
  value: JsonValue,
  outcome: MutationOutcome,
): MutationCase {
  return {
    apply: (recipe) => setValue(recipe, path, value),
    covers: [covers],
    label,
    outcome,
  }
}

function deleteMutation(
  label: string,
  covers: string,
  path: JsonPath,
  outcome: MutationOutcome,
): MutationCase {
  return {
    apply: (recipe) => deleteValue(recipe, path),
    covers: [covers],
    label,
    outcome,
  }
}

function swapMutation(
  label: string,
  covers: string,
  path: JsonPath,
  left: number,
  right: number,
  outcome: MutationOutcome,
): MutationCase {
  return {
    apply: (recipe) => swapArray(recipe, path, left, right),
    covers: [covers],
    label,
    outcome,
  }
}

function customMutation(
  label: string,
  covers: readonly string[],
  outcome: MutationOutcome,
  apply: (recipe: JsonObject) => void,
): MutationCase {
  return { apply, covers, label, outcome }
}

function recipeMutations(): readonly MutationCase[] {
  const cases: MutationCase[] = [
    setMutation('schema-version-v1', 'recipe.schemaVersion', ['schemaVersion'], 1, 'reject'),
    setMutation(
      'source-date-epoch',
      'recipe.sourceDateEpoch',
      ['sourceDateEpoch'],
      PROOF_SOURCE_DATE_EPOCH + 1,
      'reject',
    ),
    deleteMutation('targets-property', 'recipe.targets', ['targets'], 'reject'),
    deleteMutation('upstream-property', 'recipe.upstream', ['upstream'], 'reject'),
    setMutation('zig-version', 'recipe.zigVersion', ['zigVersion'], '0.16.1', 'reject'),
    deleteMutation(
      'target-darwin-arm64',
      'targets.darwin-arm64',
      ['targets', 'darwin-arm64'],
      'reject',
    ),
    deleteMutation('target-darwin-x64', 'targets.darwin-x64', ['targets', 'darwin-x64'], 'reject'),
    deleteMutation(
      'target-linux-arm64',
      'targets.linux-arm64',
      ['targets', 'linux-arm64'],
      'reject',
    ),
    deleteMutation('target-linux-x64', 'targets.linux-x64', ['targets', 'linux-x64'], 'reject'),
    setMutation(
      'upstream-repository',
      'upstream.repository',
      ['upstream', 'repository'],
      'https://example.invalid/ghostty.git',
      'reject',
    ),
    setMutation(
      'upstream-revision',
      'upstream.revision',
      ['upstream', 'revision'],
      'f'.repeat(40),
      'reject',
    ),
    setMutation(
      'upstream-tree-sha256',
      'upstream.treeSha256',
      ['upstream', 'treeSha256'],
      'f'.repeat(64),
      'reject',
    ),
    swapMutation(
      'build-argv-order',
      'target.buildArgv',
      [...LINUX_TARGET, 'buildArgv'],
      0,
      1,
      'reject',
    ),
    swapMutation(
      'environment-order',
      'target.environment',
      [...LINUX_TARGET, 'environment'],
      0,
      1,
      'reject',
    ),
    swapMutation('input-order', 'target.inputs', [...LINUX_TARGET, 'inputs'], 0, 1, 'reject'),
    swapMutation(
      'link-plan-order',
      'target.linkPlan',
      [...LINUX_TARGET, 'linkPlan'],
      0,
      1,
      'reject',
    ),
    setMutation(
      'optimization-mode',
      'target.optimizationMode',
      [...LINUX_TARGET, 'optimizationMode'],
      'Debug',
      'reject',
    ),
    deleteMutation('runner-property', 'target.runner', [...LINUX_TARGET, 'runner'], 'reject'),
    swapMutation(
      'strip-argv-order',
      'target.stripArgv',
      [...LINUX_TARGET, 'stripArgv'],
      0,
      1,
      'reject',
    ),
    setMutation(
      'target-triple',
      'target.targetTriple',
      [...LINUX_TARGET, 'targetTriple'],
      'x86_64-linux-gnu',
      'reject',
    ),
    swapMutation('tool-order', 'target.tools', [...LINUX_TARGET, 'tools'], 0, 1, 'reject'),
    setMutation(
      'runner-arch',
      'runner.arch',
      [...LINUX_TARGET, 'runner', 'arch'],
      'arm64',
      'reject',
    ),
    setMutation(
      'runner-image',
      'runner.image',
      [...LINUX_TARGET, 'runner', 'image'],
      'changed-image',
      'reject',
    ),
    setMutation(
      'runner-image-version',
      'runner.imageVersion',
      [...LINUX_TARGET, 'runner', 'imageVersion'],
      'changed-version',
      'reject',
    ),
    setMutation('runner-os', 'runner.os', [...LINUX_TARGET, 'runner', 'os'], 'darwin', 'reject'),
    setMutation(
      'environment-name',
      'environment.name',
      [...LINUX_TARGET, 'environment', 0, 'name'],
      'LC_ALL',
      'reject',
    ),
    setMutation(
      'environment-value',
      'environment.value',
      [...LINUX_TARGET, 'environment', 0, 'value'],
      'C',
      'reject',
    ),
    customMutation('tool-acquisition-variant', ['tool.acquisition'], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'zig').acquisition = upstreamAcquisition()
    }),
    customMutation('tool-bytes', ['tool.bytes'], 'change', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'strip').bytes = 1_234_567
    }),
    customMutation('tool-generation', ['tool.generation'], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'strip').generation = {
        argv: ['/usr/bin/strip', '--version'],
        sources: ['tool:zig'],
      }
    }),
    customMutation('tool-name', ['tool.name'], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'linker').name = 'link-driver'
    }),
    customMutation('tool-role', ['tool.role'], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'linker').role = 'strip'
    }),
    customMutation('tool-sha256', ['tool.sha256'], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'linker').sha256 = 'e'.repeat(64)
    }),
    customMutation('tool-version', ['tool.version'], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'zig').version = '2.0.0'
    }),
    customMutation('input-acquisition-variant', ['input.acquisition'], 'change', (recipe) => {
      inputById(recipe, 'linux-x64', 'runtime').acquisition =
        officialDownload('replacement-runtime')
    }),
    customMutation('input-bytes', ['input.bytes'], 'change', (recipe) => {
      inputById(recipe, 'linux-x64', 'runtime').bytes = 7_654_321
    }),
    customMutation('input-generation', ['input.generation'], 'reject', (recipe) => {
      delete inputById(recipe, 'linux-x64', 'proof-generated-hb-c').generation
    }),
    customMutation('input-id', ['input.id'], 'change', (recipe) => {
      inputById(recipe, 'linux-x64', 'runtime').id = 'runtime-two'
    }),
    customMutation('input-role', ['input.role'], 'reject', (recipe) => {
      inputById(recipe, 'linux-x64', 'upstream').role = 'runtime-resource'
    }),
    customMutation('input-sha256', ['input.sha256'], 'change', (recipe) => {
      inputById(recipe, 'linux-x64', 'runtime').sha256 = 'd'.repeat(64)
    }),
    customMutation('generation-argv-order', ['generation.argv'], 'reject', (recipe) => {
      const argv = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).argv
      if (!Array.isArray(argv)) fail('fixture generation argv is not an array')
      ;[argv[0], argv[1]] = [argv[1] ?? null, argv[0] ?? null]
    }),
    customMutation('generation-source', ['generation.sources'], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.sources)) fail('fixture generation sources is not an array')
      generation.sources.splice(1, 1)
    }),
    customMutation(
      'official-archive-bytes',
      ['official-download.archiveBytes'],
      'reject',
      (recipe) => {
        acquisitionOf(toolByRole(recipe, 'linux-x64', 'zig')).archiveBytes = 999
      },
    ),
    customMutation(
      'official-archive-sha256',
      ['official-download.archiveSha256'],
      'reject',
      (recipe) => {
        acquisitionOf(toolByRole(recipe, 'linux-x64', 'zig')).archiveSha256 = 'c'.repeat(64)
      },
    ),
    customMutation('official-kind', ['official-download.kind'], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'linux-x64', 'zig')).kind = 'git'
    }),
    customMutation('official-url', ['official-download.url'], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'linux-x64', 'zig')).url =
        'https://example.invalid/downloads/replacement.tar.xz'
    }),
    customMutation('git-kind', ['git.kind'], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).kind =
        'runner-component'
    }),
    customMutation('git-repository', ['git.repository'], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).repository =
        'https://example.invalid/replacement.git'
    }),
    customMutation('git-revision', ['git.revision'], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).revision = 'b'.repeat(
        40,
      )
    }),
    customMutation('git-tree-algorithm', ['git.treeAlgorithm'], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).treeAlgorithm =
        'git-tree-v2'
    }),
    customMutation('git-tree-sha256', ['git.treeSha256'], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).treeSha256 = 'b'.repeat(
        64,
      )
    }),
    customMutation('runner-content-kind', ['runner-component.contentKind'], 'change', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'runtime')).contentKind = 'external-tree-v1'
    }),
    customMutation('runner-kind', ['runner-component.kind'], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'runtime')).kind = 'official-download'
    }),
    customMutation('runner-macos-sdk', ['runner-component.macosSdk'], 'reject', (recipe) => {
      delete acquisitionOf(toolByRole(recipe, 'darwin-arm64', 'sdk-or-sysroot')).macosSdk
    }),
    customMutation('runner-path', ['runner-component.path'], 'change', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'runtime')).path =
        '/usr/share/ghostty/proof-runtime-two'
    }),
    customMutation('runner-image-field', ['runner-component.runnerImage'], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'runtime')).runnerImage = 'other-image'
    }),
    customMutation(
      'runner-image-version-field',
      ['runner-component.runnerImageVersion'],
      'reject',
      (recipe) => {
        acquisitionOf(inputById(recipe, 'linux-x64', 'runtime')).runnerImageVersion =
          'other-version'
      },
    ),
    customMutation('macos-sdk-build', ['macosSdk.sdkBuild'], 'change', (recipe) => {
      macosSdkOf(recipe).sdkBuild = '24B100'
    }),
    customMutation(
      'macos-sdk-settings-sha256',
      ['macosSdk.sdkSettingsSha256'],
      'change',
      (recipe) => {
        macosSdkOf(recipe).sdkSettingsSha256 = 'a'.repeat(64)
      },
    ),
    customMutation('macos-sdk-version', ['macosSdk.sdkVersion'], 'reject', (recipe) => {
      macosSdkOf(recipe).sdkVersion = '15.1'
    }),
    customMutation('macos-xcode-build', ['macosSdk.xcodeBuild'], 'change', (recipe) => {
      macosSdkOf(recipe).xcodeBuild = '16B40'
    }),
    customMutation('macos-xcode-version', ['macosSdk.xcodeVersion'], 'change', (recipe) => {
      macosSdkOf(recipe).xcodeVersion = '16.1'
    }),
  ]
  cases.push(...strictUnknownKeyMutations())
  cases.push(...acquisitionVariantMutations())
  cases.push(...semanticContractMutations())
  return cases
}

function macosSdkOf(recipe: JsonObject): JsonObject {
  const acquisition = acquisitionOf(toolByRole(recipe, 'darwin-arm64', 'sdk-or-sysroot'))
  if (!isJsonObject(acquisition.macosSdk)) fail('fixture macOS SDK metadata is not an object')
  return acquisition.macosSdk
}

function strictUnknownKeyMutations(): readonly MutationCase[] {
  return [
    customMutation('unknown-key-recipe', [], 'reject', (recipe) => {
      recipe.unknownField = true
    }),
    customMutation('unknown-key-targets', [], 'reject', (recipe) => {
      objectAt(recipe, ['targets']).unknownField = true
    }),
    customMutation('unknown-key-upstream', [], 'reject', (recipe) => {
      objectAt(recipe, ['upstream']).unknownField = true
    }),
    customMutation('unknown-key-target', [], 'reject', (recipe) => {
      targetAt(recipe, 'linux-x64').unknownField = true
    }),
    customMutation('unknown-key-runner', [], 'reject', (recipe) => {
      objectAt(recipe, [...LINUX_TARGET, 'runner']).unknownField = true
    }),
    customMutation('unknown-key-environment', [], 'reject', (recipe) => {
      objectAt(recipe, [...LINUX_TARGET, 'environment', 0]).unknownField = true
    }),
    customMutation('unknown-key-tool', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'linker').unknownField = true
    }),
    customMutation('unknown-key-input', [], 'reject', (recipe) => {
      inputById(recipe, 'linux-x64', 'dependency').unknownField = true
    }),
    customMutation('unknown-key-generation', [], 'reject', (recipe) => {
      generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).unknownField = true
    }),
    customMutation('unknown-key-official-download', [], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'linux-x64', 'zig')).unknownField = true
    }),
    customMutation('unknown-key-git', [], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).unknownField = true
    }),
    customMutation('unknown-key-runner-component', [], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'runtime')).unknownField = true
    }),
    customMutation('unknown-key-macos-sdk', [], 'reject', (recipe) => {
      macosSdkOf(recipe).unknownField = true
    }),
  ]
}

function acquisitionVariantMutations(): readonly MutationCase[] {
  return [
    customMutation('official-to-git', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'zig').acquisition = upstreamAcquisition()
    }),
    customMutation('git-to-runner-component', [], 'reject', (recipe) => {
      inputById(recipe, 'linux-x64', 'proof-generated-hb-c').acquisition = runnerComponent(
        'linux-x64',
        '/usr/share/ghostty/generated-hb',
        'file',
      )
    }),
    customMutation('runner-component-to-official', [], 'change', (recipe) => {
      inputById(recipe, 'linux-x64', 'runtime').acquisition = officialDownload('runner-to-official')
    }),
  ]
}

function semanticContractMutations(): readonly MutationCase[] {
  return [
    ...targetSetMutations(),
    ...rootBoundaryMutations(),
    ...commandMutations(),
    ...linkContractMutations(),
    ...linkPlanTokenMutations(),
    ...generatedInputMutations(),
    ...toolContractMutations(),
  ]
}

function targetSetMutations(): readonly MutationCase[] {
  return [
    customMutation('target-set-extra', [], 'reject', (recipe) => {
      objectAt(recipe, ['targets'])['freebsd-x64'] = cloneJson(targetAt(recipe, 'linux-x64'))
    }),
    customMutation('target-set-swapped', [], 'reject', (recipe) => {
      const targets = objectAt(recipe, ['targets'])
      const arm64 = cloneJson(targetAt(recipe, 'darwin-arm64'))
      targets['darwin-arm64'] = cloneJson(targetAt(recipe, 'darwin-x64'))
      targets['darwin-x64'] = arm64
    }),
  ]
}

function rootBoundaryMutations(): readonly MutationCase[] {
  const cases: MutationCase[] = []
  const boundaries: readonly [ProofTarget, string][] = [
    ['darwin-arm64', TARGET_FIXTURES['linux-x64'].root],
    ['linux-x64', TARGET_FIXTURES['darwin-x64'].root],
  ]
  const forms: readonly [string, (root: string) => string][] = [
    ['standalone', (root) => `${root}/foreign`],
    ['assignment', (root) => `PROOF_ROOT=${root}/foreign`],
    ['framework', (root) => `-F${root}/foreign`],
    ['include', (root) => `-I${root}/foreign`],
    ['library', (root) => `-L${root}/foreign`],
  ]
  for (const [target, root] of boundaries) {
    for (const [label, argument] of forms) {
      cases.push(
        customMutation(`opposite-root-${target}-${label}`, [], 'reject', (recipe) => {
          replaceLinkFiller(recipe, target, argument(root))
        }),
      )
    }
  }
  cases.push(
    customMutation('opposite-root-runner-component', [], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'runtime')).path =
        `${TARGET_FIXTURES['darwin-x64'].root}/foreign`
    }),
    customMutation('opposite-root-generation-argv', [], 'reject', (recipe) => {
      const generation = generationOf(
        inputById(recipe, 'darwin-arm64', 'proof-generated-help-strings'),
      )
      if (!Array.isArray(generation.argv)) fail('fixture generation argv is not an array')
      generation.argv.push(`${TARGET_FIXTURES['linux-x64'].root}/foreign`)
    }),
  )
  return cases
}

function commandMutations(): readonly MutationCase[] {
  const linuxRoot = TARGET_FIXTURES['linux-x64'].root
  const darwinRoot = TARGET_FIXTURES['darwin-arm64'].root
  return [
    customMutation('build-fixed-child', [], 'reject', (recipe) => {
      const argv = arrayAt(recipe, [...LINUX_TARGET, 'buildArgv'])
      argv[0] = '/usr/bin/zig'
    }),
    customMutation('build-final-cache', [], 'reject', (recipe) => {
      mutateArrayValue(
        arrayAt(recipe, [...LINUX_TARGET, 'buildArgv']),
        `${linuxRoot}/final-cache`,
        `${linuxRoot}/cache`,
      )
    }),
    customMutation('build-proof-generation-mode', [], 'reject', (recipe) => {
      mutateArrayValue(
        arrayAt(recipe, [...LINUX_TARGET, 'buildArgv']),
        '-Dproof-preverified-generated=true',
        '-Dproof-preverified-generated=false',
      )
    }),
    customMutation('environment-missing-entry', [], 'reject', (recipe) => {
      arrayAt(recipe, [...LINUX_TARGET, 'environment']).splice(0, 1)
    }),
    customMutation('environment-extra-entry', [], 'reject', (recipe) => {
      arrayAt(recipe, [...LINUX_TARGET, 'environment']).push({
        name: 'TZ',
        value: 'UTC',
      })
    }),
    customMutation('environment-final-cache-boundary', [], 'reject', (recipe) => {
      objectAt(recipe, [...LINUX_TARGET, 'environment', 7]).value = `${linuxRoot}/cache`
    }),
    customMutation('strip-linux-option', [], 'reject', (recipe) => {
      arrayAt(recipe, [...LINUX_TARGET, 'stripArgv'])[1] = '-x'
    }),
    customMutation('strip-linux-output', [], 'reject', (recipe) => {
      arrayAt(recipe, [...LINUX_TARGET, 'stripArgv'])[2] = `${linuxRoot}/bundle/bin/other`
    }),
    customMutation('strip-darwin-option', [], 'reject', (recipe) => {
      arrayAt(recipe, [...DARWIN_TARGET, 'stripArgv'])[1] = '--strip-all'
    }),
    customMutation('strip-darwin-output', [], 'reject', (recipe) => {
      arrayAt(recipe, [...DARWIN_TARGET, 'stripArgv'])[2] = `${darwinRoot}/bundle/bin/other`
    }),
  ]
}

function linkContractMutations(): readonly MutationCase[] {
  const target: ProofTarget = 'linux-x64'
  const root = TARGET_FIXTURES[target].root
  const triple = TARGET_FIXTURES[target].triple
  const darwinRoot = TARGET_FIXTURES['darwin-arm64'].root
  return [
    customMutation('link-fixed-zig-child', [], 'reject', (recipe) => {
      arrayAt(recipe, [...LINUX_TARGET, 'linkPlan'])[0] = '/usr/bin/zig'
    }),
    customMutation('link-fixed-build-exe-child', [], 'reject', (recipe) => {
      arrayAt(recipe, [...LINUX_TARGET, 'linkPlan'])[1] = 'build-obj'
    }),
    customMutation('link-target-value', [], 'reject', (recipe) => {
      mutateOptionValue(recipe, target, '-target', 'aarch64-linux-musl')
    }),
    customMutation('link-target-form', [], 'reject', (recipe) => {
      mutateLinkArgument(recipe, target, '-target', `-target=${triple}`)
    }),
    customMutation('link-target-count', [], 'reject', (recipe) => {
      const argv = arrayAt(recipe, [...LINUX_TARGET, 'linkPlan'])
      const option = argv.indexOf('-target')
      if (option < 0 || option + 1 >= argv.length) fail('fixture target pair was not found')
      argv[option] = `${LINK_FILLER_PREFIX}removed-target-option`
      argv[option + 1] = `${LINK_FILLER_PREFIX}removed-target-value`
    }),
    customMutation('link-plan-length', [], 'reject', (recipe) => {
      insertBeforeListen(recipe, target, `${LINK_FILLER_PREFIX}extra`)
    }),
    customMutation('link-name', [], 'reject', (recipe) => {
      mutateOptionValue(recipe, target, '--name', 'other-proof')
    }),
    customMutation('link-name-form', [], 'reject', (recipe) => {
      const argv = arrayAt(recipe, [...LINUX_TARGET, 'linkPlan'])
      const option = argv.indexOf('--name')
      if (option < 0 || option + 1 >= argv.length) fail('fixture name pair was not found')
      argv[option] = '--name=ghostty-config-resolver-proof'
      argv[option + 1] = `${LINK_FILLER_PREFIX}removed-name-value`
    }),
    customMutation('link-zig-lib-dir', [], 'reject', (recipe) => {
      mutateOptionValue(recipe, target, '--zig-lib-dir', `${root}/toolchain/lib`)
    }),
    customMutation('link-final-cache', [], 'reject', (recipe) => {
      mutateOptionValue(recipe, target, '--cache-dir', `${root}/cache`)
    }),
    customMutation('link-option-value-adjacency', [], 'reject', (recipe) => {
      const argv = arrayAt(recipe, [...LINUX_TARGET, 'linkPlan'])
      const option = argv.indexOf('--cache-dir')
      if (option < 0 || option + 2 >= argv.length) fail('fixture cache option was not found')
      ;[argv[option + 1], argv[option + 2]] = [argv[option + 2] ?? null, argv[option + 1] ?? null]
    }),
    customMutation('link-global-cache', [], 'reject', (recipe) => {
      mutateOptionValue(recipe, target, '--global-cache-dir', `${root}/cache`)
    }),
    customMutation('link-root-module', [], 'reject', (recipe) => {
      mutateLinkArgument(
        recipe,
        target,
        `-Mroot=${root}/overlay/main.zig`,
        `-Mroot=${root}/upstream/src/main.zig`,
      )
    }),
    customMutation('link-generated-module-path', [], 'reject', (recipe) => {
      mutateLinkArgument(
        recipe,
        target,
        `-Mhelp_strings=${root}/prefix/proof-generated/help_strings.zig`,
        `-Mhelp_strings=${root}/cache/help_strings.zig`,
      )
    }),
    customMutation('link-generated-module-missing', [], 'reject', (recipe) => {
      mutateLinkArgument(
        recipe,
        target,
        `-Mwuffs_c=${root}/prefix/proof-generated/wuffs_c.zig`,
        `${LINK_FILLER_PREFIX}removed-wuffs`,
      )
    }),
    customMutation('link-generated-module-inactive', [], 'reject', (recipe) => {
      replaceLinkFiller(
        recipe,
        'darwin-arm64',
        `-Mhb_c=${darwinRoot}/prefix/proof-generated/hb_c.zig`,
      )
    }),
    customMutation('link-fincremental-missing', [], 'reject', (recipe) => {
      mutateLinkArgument(recipe, target, '-fincremental', `${LINK_FILLER_PREFIX}incremental`)
    }),
    customMutation('link-response-file', [], 'reject', (recipe) => {
      replaceLinkFiller(recipe, target, '@response.rsp')
    }),
    customMutation('link-verbose-link', [], 'reject', (recipe) => {
      replaceLinkFiller(recipe, target, '--verbose-link')
    }),
    customMutation('link-listen-value', [], 'reject', (recipe) => {
      mutateLinkArgument(recipe, target, '--listen=-', '--listen=1')
    }),
    customMutation('link-listen-duplicate', [], 'reject', (recipe) => {
      replaceLinkFiller(recipe, target, '--listen=-')
    }),
    customMutation('link-listen-not-terminal', [], 'reject', (recipe) => {
      const argv = arrayAt(recipe, [...LINUX_TARGET, 'linkPlan'])
      const listen = argv.length - 1
      const previous = listen - 1
      ;[argv[previous], argv[listen]] = [argv[listen] ?? null, argv[previous] ?? null]
    }),
  ]
}

function linkPlanTokenMutations(): readonly MutationCase[] {
  const target: ProofTarget = 'linux-x64'
  const root = TARGET_FIXTURES[target].root
  const oppositeRoot = TARGET_FIXTURES['darwin-x64'].root
  return [
    customMutation('link-plan-raw-cache-key', [], 'reject', (recipe) => {
      replacePlanText(recipe, target, '{{zig-cache-key-0000}}', LINK_CACHE_KEYS.primary)
    }),
    customMutation('link-plan-malformed-cache-key', [], 'reject', (recipe) => {
      replacePlanText(recipe, target, '{{zig-cache-key-0000}}', '0'.repeat(31))
    }),
    customMutation('link-plan-uppercase-cache-key', [], 'reject', (recipe) => {
      replacePlanText(recipe, target, '{{zig-cache-key-0000}}', 'A'.repeat(32))
    }),
    customMutation('link-plan-token-gap', [], 'reject', (recipe) => {
      replacePlanText(recipe, target, '{{zig-cache-key-0001}}', '{{zig-cache-key-0003}}')
    }),
    customMutation('link-plan-token-reorder', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      replaceLinkText(plan, '{{zig-cache-key-0000}}', '{{proof-token-swap}}')
      replaceLinkText(plan, '{{zig-cache-key-0001}}', '{{zig-cache-key-0000}}')
      replaceLinkText(plan, '{{proof-token-swap}}', '{{zig-cache-key-0001}}')
    }),
    customMutation('link-plan-wrong-root', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(plan, '-Mcache_primary=', (argument) =>
        argument.replace(root, '/var/tmp/ghostty-config-resolver-proof-build-v1'),
      )
    }),
    customMutation('link-plan-wrong-root-uppercase', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(plan, '{{zig-cache-key-0002}}', (argument) =>
        argument.replace(root, '/evil').replace('{{zig-cache-key-0002}}', 'A'.repeat(32)),
      )
    }),
    customMutation('link-plan-wrong-root-malformed', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(plan, '{{zig-cache-key-0002}}', (argument) =>
        argument.replace(root, '/evil').replace('{{zig-cache-key-0002}}', '0'.repeat(31)),
      )
    }),
    customMutation('link-plan-opposite-root', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(plan, '-Mcache_primary=', (argument) =>
        argument.replace(root, oppositeRoot),
      )
    }),
    customMutation('link-plan-parent-traversal', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(plan, '-Mcache_primary=', (argument) =>
        argument.replace('/primary.zig', '/../../evil/primary.zig'),
      )
    }),
    customMutation('link-plan-current-directory', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(plan, '-Mcache_primary=', (argument) =>
        argument.replace('/primary.zig', '/./primary.zig'),
      )
    }),
    customMutation('link-plan-empty-component', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(plan, '-Mcache_primary=', (argument) =>
        argument.replace('/primary.zig', '//primary.zig'),
      )
    }),
    customMutation('link-plan-placeholder-elsewhere', [], 'reject', (recipe) => {
      replaceLinkFiller(recipe, target, `${LINK_FILLER_PREFIX}{{zig-cache-key-0000}}`)
    }),
    customMutation('link-plan-multiple-tokens-per-argument', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(
        plan,
        '-Mcache_primary=',
        (argument) => `${argument}/${root}/final-cache/o/{{zig-cache-key-0001}}/second.zig`,
      )
    }),
  ]
}

function removeInputById(recipe: JsonObject, target: ProofTarget, id: string): void {
  const inputs = arrayAt(recipe, ['targets', target, 'inputs'])
  const index = inputs.findIndex((record) => isJsonObject(record) && record.id === id)
  if (index < 0) fail('fixture input was not found')
  inputs.splice(index, 1)
}

function generatedInputMutations(): readonly MutationCase[] {
  return [
    customMutation('generated-linux-id-missing', [], 'reject', (recipe) => {
      removeInputById(recipe, 'linux-x64', 'proof-generated-hb-c')
    }),
    customMutation('generated-linux-id-extra', [], 'reject', (recipe) => {
      const inputs = arrayAt(recipe, [...LINUX_TARGET, 'inputs'])
      const extra = cloneJson(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      extra.id = 'proof-generated-extra'
      inputs.push(extra)
      sortRecords(inputs)
    }),
    customMutation('generated-darwin-inactive-hb', [], 'reject', (recipe) => {
      const inputs = arrayAt(recipe, [...DARWIN_TARGET, 'inputs'])
      const extra = cloneJson(inputById(recipe, 'darwin-arm64', 'proof-generated-help-strings'))
      extra.id = 'proof-generated-hb-c'
      inputs.push(extra)
      sortRecords(inputs)
    }),
    customMutation('generated-argv-cache', [], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.argv)) fail('fixture generation argv is not an array')
      mutateArrayValue(
        generation.argv,
        `${TARGET_FIXTURES['linux-x64'].root}/cache`,
        `${TARGET_FIXTURES['linux-x64'].root}/final-cache`,
      )
    }),
    customMutation('generated-argv-mode', [], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.argv)) fail('fixture generation argv is not an array')
      mutateArrayValue(
        generation.argv,
        '-Dproof-preverified-generated=false',
        '-Dproof-preverified-generated=true',
      )
    }),
    customMutation('generated-sources-missing', [], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.sources)) fail('fixture generation sources is not an array')
      generation.sources.splice(0, 1)
    }),
    customMutation('generated-sources-order', [], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.sources)) fail('fixture generation sources is not an array')
      ;[generation.sources[0], generation.sources[1]] = [
        generation.sources[1] ?? null,
        generation.sources[0] ?? null,
      ]
    }),
    customMutation('generated-sources-extra-runtime', [], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.sources)) fail('fixture generation sources is not an array')
      generation.sources.push('input:runtime')
      generation.sources.sort()
    }),
    customMutation('generated-sources-unknown', [], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.sources)) fail('fixture generation sources is not an array')
      generation.sources.push('input:missing')
      generation.sources.sort()
    }),
    customMutation('generated-sources-self', [], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.sources)) fail('fixture generation sources is not an array')
      generation.sources.push('input:proof-generated-hb-c')
      generation.sources.sort()
    }),
    customMutation('generated-upstream-acquisition', [], 'reject', (recipe) => {
      inputById(recipe, 'linux-x64', 'proof-generated-hb-c').acquisition =
        officialDownload('generated-source')
    }),
    customMutation('darwin-zig-lib-missing', [], 'reject', (recipe) => {
      removeInputById(recipe, 'darwin-arm64', 'zig-bundled-lib-tree')
    }),
    customMutation('darwin-zig-lib-duplicate', [], 'reject', (recipe) => {
      const inputs = arrayAt(recipe, [...DARWIN_TARGET, 'inputs'])
      inputs.push(cloneJson(inputById(recipe, 'darwin-arm64', 'zig-bundled-lib-tree')))
      sortRecords(inputs)
    }),
    customMutation('darwin-zig-lib-generated', [], 'reject', (recipe) => {
      inputById(recipe, 'darwin-arm64', 'zig-bundled-lib-tree').generation = {
        argv: proofGenerationArgv('darwin-arm64'),
        sources: proofGenerationSources('darwin-arm64'),
      }
    }),
    customMutation('darwin-zig-lib-role', [], 'reject', (recipe) => {
      inputById(recipe, 'darwin-arm64', 'zig-bundled-lib-tree').role = 'runtime-resource'
    }),
    customMutation('darwin-zig-lib-acquisition', [], 'reject', (recipe) => {
      inputById(recipe, 'darwin-arm64', 'zig-bundled-lib-tree').acquisition =
        officialDownload('wrong-zig-lib')
    }),
    customMutation('linux-zig-lib-separate-input', [], 'reject', (recipe) => {
      const inputs = arrayAt(recipe, [...LINUX_TARGET, 'inputs'])
      inputs.push({
        acquisition: zigAcquisition('linux-x64'),
        bytes: 1,
        id: 'zig-bundled-lib-tree',
        role: 'generated-resource-source',
        sha256: fixtureHash('linux-separate-zig-lib'),
      })
      sortRecords(inputs)
    }),
  ]
}

function toolContractMutations(): readonly MutationCase[] {
  return [
    customMutation('tools-count-missing', [], 'reject', (recipe) => {
      arrayAt(recipe, [...LINUX_TARGET, 'tools']).splice(0, 1)
    }),
    customMutation('tools-count-extra', [], 'reject', (recipe) => {
      const tools = arrayAt(recipe, [...LINUX_TARGET, 'tools'])
      tools.push(cloneJson(toolByRole(recipe, 'linux-x64', 'zig')))
    }),
    customMutation('linker-bytes-equal-zig', [], 'reject', (recipe) => {
      const linker = toolByRole(recipe, 'linux-x64', 'linker')
      linker.bytes = Number(linker.bytes) + 1
    }),
    customMutation('linker-sha-equal-zig', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'linker').sha256 = fixtureHash('wrong-linker')
    }),
    customMutation('linker-archive-pin', [], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'linux-x64', 'linker')).archiveBytes = 1
    }),
    customMutation('zig-identity-name', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'zig').name = 'zig-proof'
    }),
    customMutation('zig-identity-version', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'zig').version = '0.16.1'
    }),
    customMutation('zig-architecture-archive-pin', [], 'reject', (recipe) => {
      toolByRole(recipe, 'darwin-arm64', 'zig').acquisition = zigAcquisition('darwin-x64')
    }),
    customMutation('strip-identity-name', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'strip').name = 'strip'
    }),
    customMutation('strip-component-path', [], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'linux-x64', 'strip')).path = '/bin/strip'
    }),
    customMutation('strip-component-kind', [], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'linux-x64', 'strip')).contentKind = 'external-tree-v1'
    }),
    customMutation('strip-acquisition-model', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'strip').acquisition = officialDownload('strip')
    }),
    customMutation('darwin-sdk-identity-name', [], 'reject', (recipe) => {
      toolByRole(recipe, 'darwin-arm64', 'sdk-or-sysroot').name = 'sdk'
    }),
    customMutation('darwin-sdk-version-metadata', [], 'reject', (recipe) => {
      toolByRole(recipe, 'darwin-arm64', 'sdk-or-sysroot').version = '14.0'
    }),
    customMutation('darwin-sdk-acquisition-model', [], 'reject', (recipe) => {
      toolByRole(recipe, 'darwin-arm64', 'sdk-or-sysroot').acquisition =
        zigAcquisition('darwin-arm64')
    }),
    customMutation('darwin-sdk-content-kind', [], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'darwin-arm64', 'sdk-or-sysroot')).contentKind = 'file'
    }),
    customMutation('darwin-sdk-component-path', [], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'darwin-arm64', 'sdk-or-sysroot')).path = '/opt/MacOSX.sdk'
    }),
    customMutation('linux-zig-lib-tool-name', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'sdk-or-sysroot').name = 'linux-sysroot'
    }),
    customMutation('linux-zig-lib-tool-version', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'sdk-or-sysroot').version = '0.16.1'
    }),
    customMutation('linux-zig-lib-tool-acquisition', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'sdk-or-sysroot').acquisition =
        officialDownload('linux-zig-lib')
    }),
  ]
}

function assertMutationCoverage(cases: readonly MutationCase[]): void {
  const covered = new Set(cases.flatMap((entry) => entry.covers).filter(Boolean))
  const expected = new Set<string>(RECIPE_SCHEMA_FIELDS)
  const missing = [...expected].filter((field) => !covered.has(field))
  const unexpected = [...covered].filter((field) => !expected.has(field))
  if (missing.length !== 0) fail(`recipe mutation coverage is missing ${missing.join(',')}`)
  if (unexpected.length !== 0)
    fail(`recipe mutation coverage is unexpected ${unexpected.join(',')}`)
}

function assertProofRejection(action: () => unknown, label: string): void {
  try {
    action()
  } catch (error) {
    if (error instanceof ProofContractError) return
    throw error
  }
  fail(`${label} was accepted`)
}

function reverseObjectKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(reverseObjectKeys)
  if (!isJsonObject(value)) return value
  const result: JsonObject = {}
  for (const key of Object.keys(value).reverse())
    result[key] = reverseObjectKeys(value[key] ?? null)
  return result
}

function testRecipe(root: string): SelfTestResult['recipe'] {
  createFixtureDirectory(root)
  const recipe = recipeFixture()
  const canonical = proofCanonicalBytes(recipe)
  const canonicalSha256 = sha256(canonical)
  const reordered = proofCanonicalBytes(reverseObjectKeys(recipe))
  if (!canonical.equals(reordered)) fail('object insertion order changed canonical recipe bytes')

  const canonicalPath = join(root, 'canonical.json')
  writeFileSync(canonicalPath, canonical)
  const loaded = loadProofRecipe(canonicalPath)
  if (loaded.sha256 !== canonicalSha256) fail('canonical recipe load digest changed')

  const noncanonicalPath = join(root, 'noncanonical.json')
  writeFileSync(noncanonicalPath, `${JSON.stringify(recipe, null, 2)}\n`)
  assertProofRejection(() => loadProofRecipe(noncanonicalPath), 'pretty-printed recipe')
  writeFileSync(noncanonicalPath, canonical.subarray(0, canonical.length - 1))
  assertProofRejection(() => loadProofRecipe(noncanonicalPath), 'recipe without final LF')

  const cases = recipeMutations()
  assertMutationCoverage(cases)
  const projection = testProjectionMutations()
  const transcript = [...projection.transcript]
  let changed = 0
  let rejected = 0
  for (const entry of cases) {
    const candidate = cloneJson(recipe)
    entry.apply(candidate)
    if (entry.outcome === 'reject') {
      assertProofRejection(() => proofCanonicalBytes(candidate), entry.label)
      transcript.push(`${entry.label}:reject`)
      rejected += 1
      continue
    }
    const candidateSha256 = sha256(proofCanonicalBytes(candidate))
    if (candidateSha256 === canonicalSha256) fail(`${entry.label} did not change canonical bytes`)
    transcript.push(`${entry.label}:change:${candidateSha256}`)
    changed += 1
  }

  return {
    canonicalBytes: canonical.length,
    canonicalSha256,
    changed,
    mutationSha256: sha256(`${transcript.join('\n')}\n`),
    mutations: cases.length + projection.transcript.length,
    projectedEqual: projection.equal,
    projectedRejected: projection.rejected,
    rejected,
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  const entries = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
  return `{${entries.join(',')}}`
}

function assertGoldenResult(actual: SelfTestResult): void {
  if (stableJson(actual) === stableJson(GOLDEN_RESULT)) return
  fail(`golden vectors changed: ${stableJson(actual)}`)
}

function runSelfTest(root: string): SelfTestResult {
  return {
    externalTree: testExternalTree(join(root, 'external-tree')),
    gitTree: testGitTree(join(root, 'git-tree')),
    recipe: testRecipe(join(root, 'recipe')),
  }
}

function checkedRecipeIdentity(path: string): CheckedRecipeIdentity {
  const loaded = loadProofRecipe(resolve(path))
  return { bytes: loaded.bytes.length, sha256: loaded.sha256 }
}

function recipeArgument(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--recipe' || !argv[1]) {
    fail('usage: proof-self-test.ts --recipe <canonical-proof-recipe.json>')
  }
  return argv[1]
}

function boundedError(error: unknown, root: string): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown failure'
  return raw.replaceAll(root, '<tmp>').replaceAll('\n', ' ').slice(0, 1_024)
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'ghostty-proof-self-test-'))
  try {
    const recipePath = recipeArgument(process.argv.slice(2))
    const result = runSelfTest(root)
    assertGoldenResult(result)
    const checkedRecipe = checkedRecipeIdentity(recipePath)
    process.stdout.write(`${stableJson({ checkedRecipe, result, status: 'PASS' })}\n`)
  } catch (error) {
    process.stderr.write(`${stableJson({ error: boundedError(error, root), status: 'FAIL' })}\n`)
    process.exitCode = 1
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

main()
