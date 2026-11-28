import {
  PROOF_SOURCE_DATE_EPOCH,
  PROOF_TARGETS,
  PROOF_UPSTREAM_REPOSITORY,
  PROOF_UPSTREAM_REVISION,
  PROOF_UPSTREAM_TREE_SHA256,
  PROOF_ZIG_VERSION,
  projectObservedLinkArgv,
  type ProofTarget,
} from './proof-contract'
import { sha256 } from './proof-self-test-support'

export type JsonObject = { [key: string]: JsonValue }
export type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string

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
export const LINK_FILLER_PREFIX = '--proof-self-test-link-filler='
export const LINK_CACHE_KEYS = {
  primary: '0123456789abcdef0123456789abcdef',
  secondary: 'fedcba9876543210fedcba9876543210',
  tertiary: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const
export const DRIFTED_LINK_CACHE_KEYS = {
  primary: '13579bdf02468ace13579bdf02468ace',
  secondary: '2468ace013579bdf2468ace013579bdf',
  tertiary: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
} as const

export const TARGET_FIXTURES: Readonly<
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

function targetIdentity(target: ProofTarget): {
  readonly arch: 'arm64' | 'x64'
  readonly os: 'darwin' | 'linux'
} {
  const os = target.startsWith('darwin-') ? 'darwin' : 'linux'
  const arch = target.endsWith('arm64') ? 'arm64' : 'x64'
  return { arch, os }
}

export function fixtureHash(label: string): string {
  return sha256(`proof-self-test:${label}`)
}

export function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function officialDownload(label: string): JsonObject {
  return {
    archiveBytes: 100 + label.length,
    archiveSha256: fixtureHash(`archive:${label}`),
    kind: 'official-download',
    url: `https://example.invalid/downloads/${label}.tar.xz`,
  }
}

export function upstreamAcquisition(): JsonObject {
  return {
    kind: 'git',
    repository: PROOF_UPSTREAM_REPOSITORY,
    revision: PROOF_UPSTREAM_REVISION,
    treeAlgorithm: 'ghostty-upstream-tree-v1',
    treeSha256: PROOF_UPSTREAM_TREE_SHA256,
  }
}

export function zigAcquisition(target: ProofTarget): JsonObject {
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

export function runnerComponent(
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

export function proofGenerationArgv(target: ProofTarget): JsonValue[] {
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

export function proofGenerationSources(target: ProofTarget): JsonValue[] {
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

export function observedLinkArgv(
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
    linkPlan: projectObservedLinkArgv(observedLinkArgv(target), target),
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

export function recipeFixture(): JsonObject {
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
