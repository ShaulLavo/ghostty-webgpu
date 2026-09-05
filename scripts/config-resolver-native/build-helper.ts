import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashExternalTree } from '../config-resolver-proof/proof-contract'
import { assertNoEmbeddedFontPayloads } from './artifacts'
import {
  loadBuildRecipe,
  type NativeAcquisition,
  type NativeTargetRecipe,
  type NativeToolRecord,
} from './contract'
import { expandNativeToken, projectObservedLinkArgv } from './link-plan'
import {
  assertPinnedUpstream,
  computeGitTreeSha256,
  UpstreamAuditFailure,
  type UpstreamAudit,
} from '../config-resolver-proof/upstream-audit'

const TARGETS = {
  'darwin-arm64': {
    zigTarget: 'aarch64-macos.13.0',
    zigArchiveName: 'zig-aarch64-macos-0.16.0.tar.xz',
    zigArchiveUrl: 'https://ziglang.org/download/0.16.0/zig-aarch64-macos-0.16.0.tar.xz',
    zigArchiveBytes: 52_238_004,
    zigArchiveSha256: 'b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489',
  },
  'darwin-x64': {
    zigTarget: 'x86_64-macos.13.0',
    zigArchiveName: 'zig-x86_64-macos-0.16.0.tar.xz',
    zigArchiveUrl: 'https://ziglang.org/download/0.16.0/zig-x86_64-macos-0.16.0.tar.xz',
    zigArchiveBytes: 57_396_836,
    zigArchiveSha256: '0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7',
  },
  'linux-arm64': {
    zigTarget: 'aarch64-linux-musl',
    zigArchiveName: 'zig-aarch64-linux-0.16.0.tar.xz',
    zigArchiveUrl: 'https://ziglang.org/download/0.16.0/zig-aarch64-linux-0.16.0.tar.xz',
    zigArchiveBytes: 51_211_944,
    zigArchiveSha256: 'ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17',
  },
  'linux-x64': {
    zigTarget: 'x86_64-linux-musl',
    zigArchiveName: 'zig-x86_64-linux-0.16.0.tar.xz',
    zigArchiveUrl: 'https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz',
    zigArchiveBytes: 55_478_392,
    zigArchiveSha256: '70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00',
  },
} as const
const ZIG_VERSION = '0.16.0'
const THEMES_BYTES = 78_218
const THEMES_SHA256 = 'ea9878471420ee5b12e7f2ff480099c954ea50e573a1bdf83f43e105c9be63f0'
const THEMES_URL =
  'https://deps.files.ghostty.org/ghostty-themes-release-20260810-152212-0173c3c.tgz'
const UPSTREAM_REPOSITORY = 'https://github.com/ghostty-org/ghostty.git'
const UPSTREAM_REVISION = 'c8554f28e0efe2f5595f32020371c34b25ec628f'
const SOURCE_DATE_EPOCH = '1787590337'
const BUILD_ROOT =
  process.platform === 'darwin'
    ? '/private/tmp/ghostty-config-resolver-native-build-v1'
    : '/tmp/ghostty-config-resolver-native-build-v1'
const FIXED_GENERATED_MODULES = [
  {
    filename: 'help_strings.zig',
    id: 'native-generated-help-strings',
    name: 'help_strings',
    path: `${BUILD_ROOT}/prefix/native-generated/help_strings.zig`,
  },
  {
    filename: 'hb_c.zig',
    id: 'native-generated-hb-c',
    name: 'hb_c',
    path: `${BUILD_ROOT}/prefix/native-generated/hb_c.zig`,
  },
  {
    filename: 'wuffs_c.zig',
    id: 'native-generated-wuffs-c',
    name: 'wuffs_c',
    path: `${BUILD_ROOT}/prefix/native-generated/wuffs_c.zig`,
  },
] as const
const ZIG_LIB_INPUT_ID = 'zig-bundled-lib-tree'
const scriptDir = dirname(fileURLToPath(import.meta.url))
const nativeProtocolGolden = join(scriptDir, 'fixtures/native-protocol/canonical-ready.json')
const EXCLUDED_FONT_MODULES = [
  'jetbrains_mono_regular',
  'jetbrains_mono_bold',
  'jetbrains_mono_italic',
  'jetbrains_mono_bold_italic',
  'jetbrains_mono_variable',
  'jetbrains_mono_variable_italic',
  'nerd_fonts_symbols_only',
] as const

function targetGeneratedModules(
  zigTarget: string,
): readonly (typeof FIXED_GENERATED_MODULES)[number][] {
  if (!zigTarget.includes('macos')) return FIXED_GENERATED_MODULES
  return FIXED_GENERATED_MODULES.filter((module) => module.name !== 'hb_c')
}

type Target = keyof typeof TARGETS
type Mode = 'build' | 'inventory'
type Arguments = {
  readonly mode: Mode
  readonly upstream: string
  readonly zig: string
  readonly zigArchive: string
  readonly themesArchive: string
  readonly target: Target
  readonly output: string
  readonly evidence: string
}

type BuildResult = {
  readonly buildArgv: readonly string[]
  readonly buildEnvironment: readonly { readonly name: string; readonly value: string }[]
  readonly linkArgv: readonly string[]
  readonly stripArgv: readonly string[]
}

type ArchiveInput = {
  readonly role: 'dependency-archive' | 'generated-resource-source' | 'runtime-resource'
  readonly id: string
  readonly bytes: number
  readonly sha256: string
  readonly acquisition: NativeAcquisition
  readonly generation?: {
    readonly sources: readonly string[]
    readonly argv: readonly string[]
  }
}

type MaterializedSource = {
  readonly record: ArchiveInput
  readonly fetchUrl: string
}

type PackageDeclaration = {
  readonly hash: string
  readonly url: string
}

type FileIdentity = {
  readonly bytes: number
  readonly sha256: string
}

type PrebuildBoundary = {
  readonly tools: readonly unknown[]
  readonly inputs: readonly ArchiveInput[]
  readonly runner: ReturnType<typeof runnerRecord>
}

type MaterializedBuild = {
  readonly build: Omit<BuildResult, 'stripArgv'>
  readonly inputs: readonly ArchiveInput[]
}

class NativeBuildFailure extends Error {}

function main(): void {
  const args = parseArguments(process.argv.slice(2))
  process.umask(0o022)
  const target = TARGETS[args.target]
  const upstreamAudit = assertPinnedUpstream(args.upstream)
  assertSourceInputs(args, target)

  if (lstatExists(BUILD_ROOT)) throw new NativeBuildFailure('fixed build root already exists')
  mkdirSync(BUILD_ROOT)
  try {
    const overlay = join(BUILD_ROOT, 'overlay')
    const prefix = join(BUILD_ROOT, 'prefix')
    const cache = join(BUILD_ROOT, 'cache')
    const finalCache = join(BUILD_ROOT, 'final-cache')
    const globalCache = join(BUILD_ROOT, 'global-cache')
    const bundle = join(BUILD_ROOT, 'bundle')
    const fixedZig = join(BUILD_ROOT, 'toolchain', 'zig')
    const fixedUpstream = join(BUILD_ROOT, 'upstream')
    mkdirSync(dirname(fixedZig), { recursive: true })
    const runner = runnerRecord(args.target)
    verifyExpectedRunner(args, runner)
    verifyPreUseToolIdentities(args, target, args.zig)
    const zigIdentity = fileIdentity(args.zig)
    const zigLibIdentity = hashExternalTree(zigLibRoot(args.zig))
    const stripIdentity = fileIdentity('/usr/bin/strip')
    materializeFixedZig(args.zig, fixedZig)
    assertFixedZig(args.zig, fixedZig, zigIdentity, zigLibIdentity)
    materializeFixedUpstream(args.upstream, fixedUpstream, upstreamAudit)
    createOverlay(fixedUpstream, overlay)
    const tools = toolRecords(target, fixedZig, stripIdentity)
    const sdkOrSysroot = requiredToolRecord(tools, 'sdk-or-sysroot')
    const boundary = {
      runner,
      tools,
      inputs: [] as readonly ArchiveInput[],
    }
    verifyExpectedBoundaryTools(args, boundary)
    assertZigVersion(fixedZig, zigIdentity)
    verifyExpectedBuildEnvironment(
      args,
      buildContext(fixedZig, cache, globalCache).recordedEnvironment,
    )
    const inputs =
      args.mode === 'inventory'
        ? discoverInventoryInputs(
            args,
            target,
            fixedZig,
            zigIdentity,
            fixedUpstream,
            overlay,
            cache,
            globalCache,
          )
        : materializeExpectedInputs(args, fixedZig, zigIdentity, overlay, cache, globalCache)
    const completePrebuildBoundary = { ...boundary, inputs }
    removePackageGraph(overlay)
    verifyPrebuildBoundary(args, completePrebuildBoundary)
    const materialized = buildWithVerifiedInputs(
      args,
      target.zigTarget,
      fixedZig,
      zigIdentity,
      fixedUpstream,
      overlay,
      prefix,
      cache,
      finalCache,
      globalCache,
      completePrebuildBoundary.inputs,
      upstreamAudit,
      zigLibIdentity,
      sdkOrSysroot,
    )
    const completeBoundary = { ...completePrebuildBoundary, inputs: materialized.inputs }
    verifyExpectedObservedLinkArgv(args, materialized.build.linkArgv)
    const stripArgv = assembleBundle(
      args,
      prefix,
      bundle,
      stripIdentity,
      materialized.build.linkArgv,
    )
    assertFixedZig(args.zig, fixedZig, zigIdentity, zigLibIdentity)
    assertFixedUpstream(fixedUpstream, upstreamAudit)
    assertUpstreamClean(args.upstream)
    writeEvidence(args, target, bundle, upstreamAudit, completeBoundary, {
      ...materialized.build,
      stripArgv,
    })
    cpSync(bundle, args.output, { recursive: true, errorOnExist: true })
  } finally {
    rmSync(BUILD_ROOT, { recursive: true, force: true })
  }

  process.stdout.write(`${JSON.stringify({ target: args.target, result: args.mode })}\n`)
}

function parseArguments(argv: readonly string[]): Arguments {
  const allowed = new Set([
    '--evidence',
    '--mode',
    '--output',
    '--target',
    '--themes-archive',
    '--upstream',
    '--zig',
    '--zig-archive',
  ])
  if (argv.length !== allowed.size * 2) throw new NativeBuildFailure('invalid argument count')
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value) throw new NativeBuildFailure('invalid arguments')
    if (!allowed.has(name) || values.has(name)) {
      throw new NativeBuildFailure('unsupported or duplicate argument')
    }
    values.set(name, value)
  }

  const target = values.get('--target')
  const mode = values.get('--mode')
  if (!target || !(target in TARGETS)) throw new NativeBuildFailure('unsupported target')
  if (mode !== 'build' && mode !== 'inventory') throw new NativeBuildFailure('unsupported mode')
  return {
    mode,
    upstream: requiredPath(values, '--upstream'),
    zig: requiredPath(values, '--zig'),
    zigArchive: requiredPath(values, '--zig-archive'),
    themesArchive: requiredPath(values, '--themes-archive'),
    target: target as Target,
    output: requiredNewPath(values, '--output'),
    evidence: requiredNewPath(values, '--evidence'),
  }
}

function requiredPath(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new NativeBuildFailure('missing path argument')
  return realpathSync(value)
}

function requiredNewPath(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new NativeBuildFailure('missing output argument')
  if (lstatExists(value)) throw new NativeBuildFailure('output already exists')
  return value
}

function assertSourceInputs(args: Arguments, target: (typeof TARGETS)[Target]): void {
  assertFile(args.zigArchive, target.zigArchiveBytes, target.zigArchiveSha256, 'Zig archive')
  assertFile(args.themesArchive, THEMES_BYTES, THEMES_SHA256, 'themes archive')
  const head = run('git', ['-C', args.upstream, 'rev-parse', 'HEAD']).trim()
  if (head !== UPSTREAM_REVISION) throw new NativeBuildFailure('upstream revision mismatch')
  assertUpstreamClean(args.upstream)
}

function assertZigVersion(zig: string, expected: FileIdentity): void {
  assertIdentity(fileIdentity(zig), expected.bytes, expected.sha256, 'Zig tool')
  if (run(zig, ['version']).trim() !== ZIG_VERSION) {
    throw new NativeBuildFailure('Zig version mismatch')
  }
  assertIdentity(fileIdentity(zig), expected.bytes, expected.sha256, 'Zig tool')
}

function assertFixedZig(
  source: string,
  fixed: string,
  expected: FileIdentity,
  expectedLib: FileIdentity,
): void {
  if (!lstatSync(fixed).isFile())
    throw new NativeBuildFailure('fixed Zig tool is not a regular file')
  assertIdentity(fileIdentity(source), expected.bytes, expected.sha256, 'source Zig tool')
  assertIdentity(fileIdentity(fixed), expected.bytes, expected.sha256, 'fixed Zig tool')
  const sourceLib = hashExternalTree(zigLibRoot(source))
  const fixedLib = hashExternalTree(zigLibRoot(fixed))
  assertIdentity(sourceLib, expectedLib.bytes, expectedLib.sha256, 'source Zig lib tree')
  assertIdentity(fixedLib, expectedLib.bytes, expectedLib.sha256, 'fixed Zig lib tree')
}

function materializeFixedZig(source: string, fixed: string): void {
  copyFileSync(source, fixed)
  chmodSync(fixed, 0o755)
  cpSync(zigLibRoot(source), join(dirname(fixed), 'lib'), {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  })
}

function materializeFixedUpstream(source: string, fixed: string, expected: UpstreamAudit): void {
  run('git', ['clone', '--quiet', '--no-checkout', '--no-hardlinks', source, fixed])
  run('git', ['-C', fixed, 'checkout', '--quiet', '--detach', UPSTREAM_REVISION])
  assertFixedUpstream(fixed, expected)
}

function assertFixedUpstream(fixed: string, expected: UpstreamAudit): void {
  const actual = assertPinnedUpstream(fixed)
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new NativeBuildFailure('fixed upstream identity mismatch')
  }
}

function assertFile(path: string, bytes: number, digest: string, label: string): void {
  const contents = readFileSync(path)
  if (contents.length !== bytes) throw new NativeBuildFailure(`${label} length mismatch`)
  if (sha256(contents) !== digest) throw new NativeBuildFailure(`${label} digest mismatch`)
}

function assertUpstreamClean(upstream: string): void {
  if (run('git', ['-C', upstream, 'status', '--short']).length !== 0) {
    throw new NativeBuildFailure('upstream checkout is dirty')
  }
  run('git', ['-C', upstream, 'diff', '--exit-code'])
}

function createOverlay(upstream: string, overlay: string): void {
  mkdirSync(overlay, { recursive: true })
  for (const directory of ['dist', 'images', 'pkg', 'src', 'vendor']) {
    symlinkSync(join(upstream, directory), join(overlay, directory), 'dir')
  }
  symlinkSync(join(upstream, 'build.zig.zon'), join(overlay, 'build.zig.zon'), 'file')
  symlinkSync(join(scriptDir, 'build.zig'), join(overlay, 'build.zig'), 'file')
  symlinkSync(join(scriptDir, 'main.zig'), join(overlay, 'main.zig'), 'file')
  symlinkSync(nativeProtocolGolden, join(overlay, 'native-protocol-golden.json'), 'file')
  assertOverlayBindings(upstream, overlay)
}

function assertOverlayBindings(upstream: string, overlay: string): void {
  const bindings = [
    ...['dist', 'images', 'pkg', 'src', 'vendor'].map((name) => [name, join(upstream, name)]),
    ['build.zig.zon', join(upstream, 'build.zig.zon')],
    ['build.zig', join(scriptDir, 'build.zig')],
    ['main.zig', join(scriptDir, 'main.zig')],
    ['native-protocol-golden.json', nativeProtocolGolden],
  ] as const
  for (const [name, target] of bindings) {
    const path = join(overlay, name)
    if (!lstatExists(path) || !lstatSync(path).isSymbolicLink()) {
      throw new NativeBuildFailure('native overlay binding is not a symlink')
    }
    if (readlinkSync(path) !== target || realpathSync(path) !== realpathSync(target)) {
      throw new NativeBuildFailure('native overlay binding target mismatch')
    }
  }
}

function discoverInventoryInputs(
  args: Arguments,
  target: (typeof TARGETS)[Target],
  zig: string,
  zigIdentity: FileIdentity,
  upstream: string,
  overlay: string,
  cache: string,
  globalCache: string,
): readonly ArchiveInput[] {
  const discoveryCache = join(BUILD_ROOT, 'discovery-cache')
  const discoveryGlobalCache = join(BUILD_ROOT, 'discovery-global-cache')
  fetchDependencies(
    zig,
    zigIdentity,
    target.zigTarget,
    overlay,
    discoveryCache,
    discoveryGlobalCache,
    'discovery',
  )
  const declarations = dependencyDeclarations(upstream, overlay)
  const packages = discoveredPackages(overlay, declarations)
  removePackageGraph(overlay)
  const inputs: ArchiveInput[] = []
  for (const dependency of packages) {
    inputs.push(
      ...acquireDiscoveredPackage(zig, zigIdentity, overlay, cache, globalCache, dependency),
    )
  }
  if (target.zigTarget.includes('macos')) inputs.push(zigLibInput(target, zig))
  inputs.push(runtimeInput(args))
  return inputs.sort(recordOrder)
}

function removePackageGraph(overlay: string): void {
  const root = join(overlay, 'zig-pkg')
  if (!lstatExists(root) || !lstatSync(root).isDirectory()) {
    throw new NativeBuildFailure('materialized package graph cannot be reset')
  }
  rmSync(root, { recursive: true })
  if (lstatExists(root)) throw new NativeBuildFailure('materialized package graph reset failed')
}

function materializeExpectedInputs(
  args: Arguments,
  zig: string,
  zigIdentity: FileIdentity,
  overlay: string,
  cache: string,
  globalCache: string,
): readonly ArchiveInput[] {
  const expected = expectedTarget(args)
  const inputs: ArchiveInput[] = []
  const sources = new Map<string, MaterializedSource>()
  for (const input of expected.inputs) {
    if (!isPackageSourceRecord(input)) continue
    const source = materializeExpectedSource(input)
    sources.set(input.id, source)
    inputs.push(source.record)
  }
  for (const input of expected.inputs) {
    if (
      isPackageSourceRecord(input) ||
      isPackageTreeRecord(input) ||
      isNativeGeneratedModuleRecord(input)
    ) {
      continue
    }
    inputs.push(
      materializeExpectedInput(args, zig, zigIdentity, overlay, cache, globalCache, sources, input),
    )
  }
  return inputs.sort(recordOrder)
}

function isPackageSourceRecord(input: NativeTargetRecipe['inputs'][number]): boolean {
  return input.role === 'generated-resource-source' && input.id.startsWith('zs-')
}

function isPackageTreeRecord(input: NativeTargetRecipe['inputs'][number]): boolean {
  return input.role === 'generated-resource-source' && input.id.startsWith('zt-')
}

function isNativeGeneratedModuleRecord(input: NativeTargetRecipe['inputs'][number]): boolean {
  return (
    input.role === 'generated-resource-source' &&
    FIXED_GENERATED_MODULES.some((module) => module.id === input.id)
  )
}

function discoveredPackages(
  overlay: string,
  declarations: ReadonlyMap<string, string>,
): readonly PackageDeclaration[] {
  const root = join(overlay, 'zig-pkg')
  if (!lstatExists(root)) throw new NativeBuildFailure('Zig package graph is missing')
  const packages: PackageDeclaration[] = []
  for (const name of readdirSync(root).sort()) {
    packages.push(discoveredPackage(root, name, declarations))
  }
  if (packages.length === 0) throw new NativeBuildFailure('Zig package cache is empty')
  return packages
}

function discoveredPackage(
  root: string,
  name: string,
  declarations: ReadonlyMap<string, string>,
): PackageDeclaration {
  const path = join(root, name)
  if (!lstatSync(path).isDirectory())
    throw new NativeBuildFailure('package graph entry is not a directory')
  const declaration = [...declarations.entries()].find(([hash]) => name === hash)
  if (!declaration) throw new NativeBuildFailure('fetched package has no pinned declaration')
  return { hash: declaration[0], url: declaration[1] }
}

function acquireDiscoveredPackage(
  zig: string,
  zigIdentity: FileIdentity,
  overlay: string,
  cache: string,
  globalCache: string,
  dependency: PackageDeclaration,
): readonly ArchiveInput[] {
  const git = parseGitDependency(dependency.url)
  const source = git
    ? materializeGitSource(dependency.hash, git.repository, git.revision)
    : materializeDownloadSource(dependency.hash, dependency.url)
  const input = fetchPackage(zig, zigIdentity, overlay, cache, globalCache, dependency.hash, source)
  return [source.record, input]
}

function materializeExpectedInput(
  args: Arguments,
  zig: string,
  zigIdentity: FileIdentity,
  overlay: string,
  cache: string,
  globalCache: string,
  sources: ReadonlyMap<string, MaterializedSource>,
  expected: NativeTargetRecipe['inputs'][number],
): ArchiveInput {
  if (expected.role === 'runtime-resource') {
    const actual = runtimeInput(args)
    assertSameRecord(actual, expected, 'runtime resource')
    return actual
  }
  if (expected.role === 'generated-resource-source' && expected.id === ZIG_LIB_INPUT_ID) {
    const target = TARGETS[args.target]
    if (!target.zigTarget.includes('macos')) {
      throw new NativeBuildFailure('unexpected Zig lib input target')
    }
    const actual = zigLibInput(target, zig)
    assertSameRecord(actual, expected, 'Zig lib input')
    return actual
  }
  if (expected.role !== 'dependency-archive') {
    throw new NativeBuildFailure('unsupported expected input role')
  }
  return materializeExpectedPackage(
    zig,
    zigIdentity,
    overlay,
    cache,
    globalCache,
    sources,
    expected,
  )
}

function materializeExpectedSource(
  expected: NativeTargetRecipe['inputs'][number],
): MaterializedSource {
  const hash = packageHashFromId(expected.id, 'zs-')
  const acquisition = expected.acquisition
  const source =
    acquisition.kind === 'official-download'
      ? materializeDownloadSource(hash, acquisition.url)
      : materializeExpectedGitSource(hash, acquisition)
  assertSameRecord(source.record, expected, 'package source')
  return source
}

function materializeExpectedGitSource(
  hash: string,
  acquisition: NativeAcquisition,
): MaterializedSource {
  if (acquisition.kind !== 'git')
    throw new NativeBuildFailure('package source acquisition is invalid')
  return materializeGitSource(hash, acquisition.repository, acquisition.revision)
}

function materializeExpectedPackage(
  zig: string,
  zigIdentity: FileIdentity,
  overlay: string,
  cache: string,
  globalCache: string,
  sources: ReadonlyMap<string, MaterializedSource>,
  expected: NativeTargetRecipe['inputs'][number],
): ArchiveInput {
  const hash = packageHashFromId(expected.id, 'zp-')
  const sourceId = sourceReference(expected)
  const source = sources.get(sourceId)
  if (!source) throw new NativeBuildFailure('dependency source is missing')
  verifyExpectedGeneration(
    expected,
    packageGeneration(zig, globalCache, source),
    source.record.acquisition,
    'dependency input generation',
  )
  const actual = fetchPackage(zig, zigIdentity, overlay, cache, globalCache, hash, source)
  assertSameRecord(actual, expected, 'dependency input')
  return actual
}

function fetchPackage(
  zig: string,
  zigIdentity: FileIdentity,
  overlay: string,
  cache: string,
  globalCache: string,
  hash: string,
  source: MaterializedSource,
): ArchiveInput {
  assertMaterializedSource(source)
  const actualHash = fetchPackageHash(
    zig,
    zigIdentity,
    overlay,
    cache,
    globalCache,
    source.fetchUrl,
  )
  assertMaterializedSource(source)
  if (actualHash !== hash) throw new NativeBuildFailure('fetched package hash mismatch')
  return packageInputRecord(zig, globalCache, hash, source)
}

function fetchPackageHash(
  zig: string,
  zigIdentity: FileIdentity,
  overlay: string,
  cache: string,
  globalCache: string,
  fetchUrl: string,
): string {
  const context = buildContext(zig, cache, globalCache)
  const argv = ['fetch', fetchUrl, '--global-cache-dir', globalCache]
  assertOverlayBindings(join(BUILD_ROOT, 'upstream'), overlay)
  assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
  const result = spawnSync(zig, argv, {
    cwd: overlay,
    encoding: 'utf8',
    env: context.environment,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) throw new NativeBuildFailure('explicit Zig package fetch failed')
  assertOverlayBindings(join(BUILD_ROOT, 'upstream'), overlay)
  assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
  if (result.stderr.length !== 0)
    throw new NativeBuildFailure('explicit Zig package fetch wrote stderr')
  const hash = result.stdout.trim()
  if (!/^[A-Za-z0-9_.+-]{1,256}$/.test(hash)) {
    throw new NativeBuildFailure('explicit Zig package fetch returned an invalid hash')
  }
  return hash
}

function packageInputRecord(
  zig: string,
  globalCache: string,
  hash: string,
  source: MaterializedSource,
): ArchiveInput {
  const path = join(globalCache, 'p', `${hash}.tar.gz`)
  if (!lstatExists(path) || !statSync(path).isFile()) {
    throw new NativeBuildFailure('explicit Zig package archive is missing')
  }
  return {
    role: 'dependency-archive',
    id: packageId(hash),
    ...fileIdentity(path),
    acquisition: source.record.acquisition,
    generation: packageGeneration(zig, globalCache, source),
  }
}

function packageGeneration(
  zig: string,
  globalCache: string,
  source: MaterializedSource,
): NonNullable<ArchiveInput['generation']> {
  return {
    sources: [`input:${source.record.id}`, 'tool:zig'],
    argv: [zig, 'fetch', source.fetchUrl, '--global-cache-dir', globalCache],
  }
}

function packageId(hash: string): string {
  return encodedPackageId('zp-', hash)
}

function sourceId(hash: string): string {
  return encodedPackageId('zs-', hash)
}

function treeId(hash: string): string {
  return encodedPackageId('zt-', hash)
}

type PackageIdPrefix = 'zp-' | 'zs-' | 'zt-'

function encodedPackageId(prefix: PackageIdPrefix, hash: string): string {
  const encoded = Buffer.from(hash, 'utf8').toString('hex')
  const id = `${prefix}${encoded}`
  if (id.length > 128) throw new NativeBuildFailure('Zig package hash is too long for a recipe ID')
  return id
}

function packageHashFromId(id: string, prefix: PackageIdPrefix): string {
  if (!id.startsWith(prefix))
    throw new NativeBuildFailure('Zig package recipe ID prefix is invalid')
  const encoded = id.slice(prefix.length)
  if (!encoded || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/.test(encoded)) {
    throw new NativeBuildFailure('Zig package recipe ID encoding is invalid')
  }
  const hash = Buffer.from(encoded, 'hex').toString('utf8')
  if (encodedPackageId(prefix, hash) !== id)
    throw new NativeBuildFailure('Zig package recipe ID is invalid')
  return hash
}

function sourceReference(expected: NativeTargetRecipe['inputs'][number]): string {
  const sources = expected.generation?.sources
  if (!sources || sources.length !== 2 || !sources.includes('tool:zig')) {
    throw new NativeBuildFailure('dependency generation sources are invalid')
  }
  const source = sources.find((value) => value.startsWith('input:'))
  if (!source) throw new NativeBuildFailure('dependency generation source is missing')
  return source.slice('input:'.length)
}

function materializeDownloadSource(hash: string, url: string): MaterializedSource {
  const id = sourceId(hash)
  const identity = downloadArchive(id, url)
  const acquisition = {
    kind: 'official-download' as const,
    url,
    archiveBytes: identity.bytes,
    archiveSha256: identity.sha256,
  }
  return {
    record: {
      role: 'generated-resource-source',
      id,
      ...identity,
      acquisition,
    },
    fetchUrl: sourceArchivePath(id, url),
  }
}

function materializeGitSource(
  hash: string,
  repository: string,
  revision: string,
): MaterializedSource {
  const id = sourceId(hash)
  const tree = acquireGitRepository(id, repository, revision)
  return {
    record: {
      role: 'generated-resource-source',
      id,
      bytes: tree.bytes,
      sha256: tree.sha256,
      acquisition: tree.acquisition,
    },
    fetchUrl: tree.sourcePath,
  }
}

function downloadArchive(
  id: string,
  url: string,
): { readonly bytes: number; readonly sha256: string } {
  const root = join(BUILD_ROOT, 'source-archives')
  mkdirSync(root, { recursive: true })
  const path = sourceArchivePath(id, url)
  if (lstatExists(path)) throw new NativeBuildFailure('source archive path already exists')
  const effectiveUrl = run('/usr/bin/curl', [
    '--disable',
    '--fail',
    '--location',
    '--connect-timeout',
    '30',
    '--max-filesize',
    '1073741824',
    '--max-time',
    '600',
    '--proto',
    '=https',
    '--proto-redir',
    '=https',
    '--retry',
    '3',
    '--retry-all-errors',
    '--silent',
    '--show-error',
    '--output',
    path,
    '--write-out',
    '%{url_effective}',
    url,
  ]).trim()
  assertEffectiveHttpsUrl(effectiveUrl)
  return fileIdentity(path)
}

function sourceArchivePath(id: string, url: string): string {
  return join(BUILD_ROOT, 'source-archives', `${id}${archiveSuffix(url)}`)
}

function archiveSuffix(value: string): string {
  const pathname = new URL(value).pathname
  for (const suffix of ['.tar.gz', '.tar.xz', '.tar.zst', '.tgz', '.zip']) {
    if (pathname.endsWith(suffix)) return suffix
  }
  throw new NativeBuildFailure('download source has an unsupported archive suffix')
}

function assertEffectiveHttpsUrl(value: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new NativeBuildFailure('download effective URL is invalid')
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    throw new NativeBuildFailure('download redirect policy was violated')
  }
}

function parseGitDependency(
  value: string,
): { readonly repository: string; readonly revision: string } | null {
  if (!value.startsWith('git+https://')) return null
  let parsed: URL
  try {
    parsed = new URL(value.slice(4))
  } catch {
    throw new NativeBuildFailure('invalid Git dependency URL')
  }
  const revision = parsed.hash.slice(1)
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new NativeBuildFailure('unpinned Git dependency URL')
  if (parsed.protocol !== 'https:' || parsed.search || parsed.username || parsed.password) {
    throw new NativeBuildFailure('mutable Git dependency URL')
  }
  parsed.hash = ''
  parsed.pathname = parsed.pathname.replace(/\/$/, '')
  if (!parsed.pathname.endsWith('.git')) parsed.pathname += '.git'
  const repository = parsed.toString()
  return { repository, revision }
}

function acquireGitRepository(
  id: string,
  repository: string,
  revision: string,
): {
  readonly acquisition: NativeAcquisition
  readonly bytes: number
  readonly sha256: string
  readonly sourcePath: string
} {
  const checkout = join(BUILD_ROOT, 'git-acquisitions', id)
  mkdirSync(checkout, { recursive: true })
  run('git', ['init', '--bare', '--quiet', checkout])
  run('git', ['-C', checkout, 'remote', 'add', 'origin', repository])
  run('git', [
    '-C',
    checkout,
    '-c',
    'protocol.version=2',
    'fetch',
    '--quiet',
    '--no-tags',
    '--depth=1',
    'origin',
    revision,
  ])
  run('git', ['-C', checkout, 'update-ref', 'refs/heads/native-source', revision])
  assertGitRepository(checkout, revision)
  const tree = computeGitTreeSha256(checkout, revision)
  if (tree.gitlinks !== 0) throw new NativeBuildFailure('Git dependency has an unresolved gitlink')
  const sourcePath = join(BUILD_ROOT, 'git-source-trees', id)
  mkdirSync(dirname(sourcePath), { recursive: true })
  run('git', ['clone', '--quiet', '--no-checkout', '--no-hardlinks', checkout, sourcePath])
  run('git', ['-C', sourcePath, 'checkout', '--quiet', '--detach', revision])
  assertGitSourceCheckout(sourcePath, revision, tree)
  return {
    bytes: tree.bytes,
    sha256: tree.sha256,
    sourcePath,
    acquisition: {
      kind: 'git',
      repository,
      revision,
      treeAlgorithm: 'ghostty-upstream-tree-v1',
      treeSha256: tree.sha256,
    },
  }
}

function fetchDependencies(
  zig: string,
  zigIdentity: FileIdentity,
  zigTarget: string,
  overlay: string,
  cache: string,
  globalCache: string,
  phase: 'discovery' | 'materialization',
): void {
  const context = buildContext(zig, cache, globalCache)
  const argv = dependencyFetchArgv(zigTarget, cache, globalCache)
  const attempts = phase === 'discovery' ? 3 : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    assertOverlayBindings(join(BUILD_ROOT, 'upstream'), overlay)
    assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
    const result = spawnSync(zig, argv, {
      cwd: overlay,
      encoding: 'buffer',
      env: context.environment,
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    assertOverlayBindings(join(BUILD_ROOT, 'upstream'), overlay)
    assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
    if (result.status === 0) return
  }
  throw new NativeBuildFailure(`${phase} Zig dependency fetch failed`)
}

function dependencyFetchArgv(
  zigTarget: string,
  cache: string,
  globalCache: string,
): readonly string[] {
  return [
    'build',
    '-j1',
    '--seed',
    '0',
    '-fincremental',
    '--fetch=all',
    '--cache-dir',
    cache,
    '--global-cache-dir',
    globalCache,
    '-Doptimize=ReleaseSafe',
    `-Dtarget=${zigTarget}`,
  ]
}

function buildWithVerifiedInputs(
  args: Arguments,
  zigTarget: string,
  zig: string,
  zigIdentity: FileIdentity,
  upstream: string,
  overlay: string,
  prefix: string,
  cache: string,
  finalCache: string,
  globalCache: string,
  inputs: readonly ArchiveInput[],
  upstreamAudit: UpstreamAudit,
  zigLibIdentity: FileIdentity,
  sdkOrSysroot: NativeToolRecord,
): MaterializedBuild {
  verifyPackageCacheFiles(globalCache, inputs)
  const before = packageCacheSnapshot(globalCache)
  verifyExpectedTreeGeneration(
    args,
    [zig, ...dependencyFetchArgv(zigTarget, cache, globalCache)],
    inputs,
  )
  assertDarwinSdkTool(args, zig, sdkOrSysroot)
  fetchDependencies(zig, zigIdentity, zigTarget, overlay, cache, globalCache, 'materialization')
  verifyPackageCache(upstream, overlay, globalCache, inputs)
  const materialized = packageCacheSnapshot(globalCache)
  if (canonicalJson(before) !== canonicalJson(materialized)) {
    throw new NativeBuildFailure('package cache changed during graph materialization')
  }
  const treeInputs = packageTreeInputs(zig, zigTarget, overlay, cache, globalCache, inputs)
  const generationInputs = [...inputs, ...treeInputs].sort(recordOrder)
  verifyExpectedGenerationInputs(args, generationInputs)
  const generatedInputs = materializeGeneratedModules(
    args,
    zig,
    zigIdentity,
    zigTarget,
    overlay,
    prefix,
    cache,
    globalCache,
    generationInputs,
    upstreamAudit,
    sdkOrSysroot,
    zigLibIdentity,
  )
  const completeInputs = [...inputs, ...treeInputs, ...generatedInputs].sort(recordOrder)
  assertGeneratedModules(zigTarget, generatedInputs)
  assertPreFinalBoundary(
    args,
    zig,
    zigIdentity,
    zigLibIdentity,
    zigTarget,
    upstream,
    upstreamAudit,
    overlay,
    cache,
    globalCache,
    inputs,
    treeInputs,
    before,
    sdkOrSysroot,
  )
  verifyExpectedInputs(args, completeInputs)
  const buildResult = build(
    args,
    zig,
    zigIdentity,
    zigTarget,
    overlay,
    prefix,
    cache,
    finalCache,
    globalCache,
  )
  assertDarwinSdkTool(args, zig, sdkOrSysroot)
  assertGeneratedModules(zigTarget, generatedInputs)
  verifyPackageCache(upstream, overlay, globalCache, inputs)
  const afterTrees = packageTreeInputs(zig, zigTarget, overlay, cache, globalCache, inputs)
  if (canonicalJson(treeInputs) !== canonicalJson(afterTrees)) {
    throw new NativeBuildFailure('materialized package graph changed during the build')
  }
  const after = packageCacheSnapshot(globalCache)
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new NativeBuildFailure('package cache changed during the build')
  }
  return { build: buildResult, inputs: completeInputs }
}

function assertPreFinalBoundary(
  args: Arguments,
  zig: string,
  zigIdentity: FileIdentity,
  zigLibIdentity: FileIdentity,
  zigTarget: string,
  upstream: string,
  upstreamAudit: UpstreamAudit,
  overlay: string,
  cache: string,
  globalCache: string,
  inputs: readonly ArchiveInput[],
  treeInputs: readonly ArchiveInput[],
  packageSnapshot: readonly unknown[],
  sdkOrSysroot: NativeToolRecord,
): void {
  assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
  const actualLib = hashExternalTree(zigLibRoot(zig))
  assertIdentity(actualLib, zigLibIdentity.bytes, zigLibIdentity.sha256, 'Zig lib tree')
  assertFixedUpstream(upstream, upstreamAudit)
  verifyPackageCache(upstream, overlay, globalCache, inputs)
  const actualTrees = packageTreeInputs(zig, zigTarget, overlay, cache, globalCache, inputs)
  if (canonicalJson(actualTrees) !== canonicalJson(treeInputs)) {
    throw new NativeBuildFailure('generation changed the materialized package graph')
  }
  if (canonicalJson(packageCacheSnapshot(globalCache)) !== canonicalJson(packageSnapshot)) {
    throw new NativeBuildFailure('generation changed the package cache')
  }
  assertDarwinSdkTool(args, zig, sdkOrSysroot)
}

function packageTreeInputs(
  zig: string,
  zigTarget: string,
  overlay: string,
  cache: string,
  globalCache: string,
  inputs: readonly ArchiveInput[],
): readonly ArchiveInput[] {
  const expected = inputs.filter((input) => input.role === 'dependency-archive')
  const root = join(overlay, 'zig-pkg')
  if (!lstatExists(root)) throw new NativeBuildFailure('materialized package graph is missing')
  const names = readdirSync(root).sort()
  if (names.length !== expected.length)
    throw new NativeBuildFailure('materialized package count mismatch')
  const argv = [zig, ...dependencyFetchArgv(zigTarget, cache, globalCache)]
  return names.map((name) => packageTreeInput(root, name, expected, argv)).sort(recordOrder)
}

function packageTreeInput(
  root: string,
  hash: string,
  expected: readonly ArchiveInput[],
  argv: readonly string[],
): ArchiveInput {
  const path = join(root, hash)
  if (!lstatSync(path).isDirectory()) {
    throw new NativeBuildFailure('materialized package entry is not a directory')
  }
  const archive = expected.find((input) => input.id === packageId(hash))
  if (!archive) throw new NativeBuildFailure('materialized package is not recorded')
  const identity = hashExternalTree(path)
  return {
    role: 'generated-resource-source',
    id: treeId(hash),
    bytes: identity.bytes,
    sha256: identity.sha256,
    acquisition: archive.acquisition,
    generation: {
      sources: [`input:${archive.id}`, `input:${sourceId(hash)}`, 'tool:zig'],
      argv,
    },
  }
}

function packageCacheSnapshot(globalCache: string): readonly unknown[] {
  const root = join(globalCache, 'p')
  if (!lstatExists(root)) throw new NativeBuildFailure('package cache is missing before use')
  return readdirSync(root)
    .sort()
    .map((name) => ({ name, ...fileIdentity(join(root, name)) }))
}

function materializeGeneratedModules(
  args: Arguments,
  zig: string,
  zigIdentity: FileIdentity,
  zigTarget: string,
  overlay: string,
  prefix: string,
  cache: string,
  globalCache: string,
  sourceInputs: readonly ArchiveInput[],
  upstreamAudit: UpstreamAudit,
  sdkOrSysroot: NativeToolRecord,
  zigLibIdentity: FileIdentity,
): readonly ArchiveInput[] {
  const modules = targetGeneratedModules(zigTarget)
  for (const module of modules) {
    if (lstatExists(module.path))
      throw new NativeBuildFailure('native generated input already exists')
  }
  const context = buildContext(zig, cache, globalCache)
  const argv = generatedMaterializationArgv(zig, zigTarget, prefix, cache, globalCache)
  const sources = generatedModuleSources(zigTarget, sourceInputs)
  const acquisition = upstreamAcquisition(upstreamAudit)
  verifyExpectedGeneratedModulePlan(args, sources, argv, acquisition)
  assertDarwinSdkTool(args, zig, sdkOrSysroot)
  assertOverlayBindings(join(BUILD_ROOT, 'upstream'), overlay)
  const beforeLib = hashExternalTree(zigLibRoot(zig))
  assertIdentity(beforeLib, zigLibIdentity.bytes, zigLibIdentity.sha256, 'Zig lib tree')
  assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd: overlay,
    encoding: 'buffer',
    env: context.environment,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assertOverlayBindings(join(BUILD_ROOT, 'upstream'), overlay)
  assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
  const afterLib = hashExternalTree(zigLibRoot(zig))
  assertIdentity(afterLib, zigLibIdentity.bytes, zigLibIdentity.sha256, 'Zig lib tree')
  if (result.status !== 0)
    throw new NativeBuildFailure('native generated input materialization failed')

  assertGeneratedModuleDirectory(modules)
  return modules
    .map((module) => ({
      role: 'generated-resource-source' as const,
      id: module.id,
      ...fileIdentity(module.path),
      acquisition,
      generation: { sources, argv },
    }))
    .sort(recordOrder)
}

function generatedMaterializationArgv(
  zig: string,
  zigTarget: string,
  prefix: string,
  cache: string,
  globalCache: string,
): readonly string[] {
  return [
    zig,
    'build',
    'native-materialize-generated',
    '-j1',
    '--seed',
    '0',
    '-fincremental',
    '--prefix',
    prefix,
    '--cache-dir',
    cache,
    '--global-cache-dir',
    globalCache,
    '-Doptimize=ReleaseSafe',
    `-Dtarget=${zigTarget}`,
    '-Dnative-preverified-generated=false',
  ]
}

function generatedModuleSources(
  zigTarget: string,
  inputs: readonly ArchiveInput[],
): readonly string[] {
  const sdk = zigTarget.includes('macos') ? 'macos-sdk-tree' : 'zig-bundled-lib-tree'
  const sources = inputs
    .filter((input) => input.role !== 'runtime-resource')
    .map((input) => `input:${input.id}`)
  sources.push('tool:zig', 'tool:zig-integrated-linker', `tool:${sdk}`)
  return sources.sort(compareStringBytes)
}

function upstreamAcquisition(upstreamAudit: UpstreamAudit): NativeAcquisition {
  return {
    kind: 'git',
    repository: UPSTREAM_REPOSITORY,
    revision: UPSTREAM_REVISION,
    treeAlgorithm: 'ghostty-upstream-tree-v1',
    treeSha256: upstreamAudit.sha256,
  }
}

function assertGeneratedModules(zigTarget: string, expected: readonly ArchiveInput[]): void {
  const modules = targetGeneratedModules(zigTarget)
  if (expected.length !== modules.length) {
    throw new NativeBuildFailure('native generated input count mismatch')
  }
  assertGeneratedModuleDirectory(modules)
  for (const module of modules) {
    const record = expected.find((input) => input.id === module.id)
    if (!record) throw new NativeBuildFailure('native generated input record is missing')
    const identity = fileIdentity(module.path)
    assertIdentity(identity, record.bytes, record.sha256, 'native generated input')
  }
}

function assertGeneratedModuleDirectory(
  modules: readonly (typeof FIXED_GENERATED_MODULES)[number][],
): void {
  const first = modules[0]
  if (!first) throw new NativeBuildFailure('native generated module set is empty')
  const root = dirname(first.path)
  if (!lstatExists(root) || !lstatSync(root).isDirectory()) {
    throw new NativeBuildFailure('native generated input directory is missing')
  }
  const actual = readdirSync(root).sort(compareStringBytes)
  const expected = modules.map((module) => module.filename).sort(compareStringBytes)
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new NativeBuildFailure('native generated input directory mismatch')
  }
  for (const module of modules) {
    if (!lstatSync(module.path).isFile()) {
      throw new NativeBuildFailure('native generated input is not a regular file')
    }
  }
}

function build(
  args: Arguments,
  zig: string,
  zigIdentity: FileIdentity,
  zigTarget: string,
  overlay: string,
  prefix: string,
  cache: string,
  finalCache: string,
  globalCache: string,
): Omit<BuildResult, 'stripArgv'> {
  const context = buildContext(zig, cache, globalCache)
  const argv = [
    'build',
    '-j1',
    '--seed',
    '0',
    '-fincremental',
    '--prefix',
    prefix,
    '--cache-dir',
    finalCache,
    '--global-cache-dir',
    globalCache,
    '-Doptimize=ReleaseSafe',
    `-Dtarget=${zigTarget}`,
    '-Dnative-preverified-generated=true',
    '--verbose',
  ]
  verifyExpectedBuildInvocation(args, [zig, ...argv], context.recordedEnvironment)
  if (lstatExists(finalCache)) throw new NativeBuildFailure('final build cache already exists')
  mkdirSync(finalCache)
  assertOverlayBindings(join(BUILD_ROOT, 'upstream'), overlay)
  assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
  const result = spawnSync(zig, argv, {
    cwd: overlay,
    encoding: 'buffer',
    env: context.environment,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assertOverlayBindings(join(BUILD_ROOT, 'upstream'), overlay)
  assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
  if (result.status !== 0) throw new NativeBuildFailure('Zig build failed')
  const output = Buffer.concat([result.stdout, result.stderr]).toString('utf8')
  assertNoGeneratedProducerCommands(output)
  return {
    buildArgv: [zig, ...argv],
    buildEnvironment: context.recordedEnvironment,
    linkArgv: parseLinkDriverArgv(output, zig, zigTarget),
  }
}

function assertNoGeneratedProducerCommands(output: string): void {
  for (const line of output.split('\n')) {
    if (line.includes('--name helpgen') || hasCommandPath(line, 'helpgen')) {
      throw new NativeBuildFailure('generated input producer ran during final build')
    }
    if (!line.includes(' translate-c ') && !hasCommandPath(line, 'translate-c')) continue
    if (hasCommandPath(line, 'hb_c.h') || hasCommandPath(line, 'wuffs_c.h')) {
      throw new NativeBuildFailure('generated input producer ran during final build')
    }
  }
}

function hasCommandPath(line: string, basename: string): boolean {
  return line.endsWith(`/${basename}`) || line.includes(`/${basename} `)
}

function buildContext(
  zig: string,
  cache: string,
  globalCache: string,
): {
  readonly environment: NodeJS.ProcessEnv
  readonly recordedEnvironment: readonly { readonly name: string; readonly value: string }[]
} {
  mkdirSync(cache, { recursive: true })
  mkdirSync(globalCache, { recursive: true })
  const buildHome = join(cache, 'home')
  const buildTemporary = join(cache, 'tmp')
  mkdirSync(buildHome, { recursive: true })
  mkdirSync(buildTemporary, { recursive: true })
  const environment = {
    HOME: buildHome,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SOURCE_DATE_EPOCH,
    TMPDIR: buildTemporary,
    UMASK: '0022',
    XDG_CACHE_HOME: globalCache,
    ZIG_EXE: zig,
  }
  const recordedEnvironment = Object.entries(environment)
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([name, value]) => ({ name, value }))
  return { environment, recordedEnvironment }
}

function parseLinkDriverArgv(output: string, zig: string, zigTarget: string): readonly string[] {
  // Darwin links in-process inside this spawned build-exe child, so this is the common link driver.
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${zig} `) && line.includes('--name ghostty-config-resolver'))
  const candidates: (readonly string[])[] = []
  for (const line of lines) {
    const argv = tokenizeCommand(line)
    if (!isHelperLinkDriverArgv(argv, zig, zigTarget)) continue
    candidates.push(argv)
  }
  if (candidates.length !== 1) {
    throw new NativeBuildFailure('exact link driver command was not observed')
  }
  return candidates[0]!
}

function isHelperLinkDriverArgv(argv: readonly string[], zig: string, zigTarget: string): boolean {
  if (argv[0] !== zig || argv[1] !== 'build-exe') return false
  if (argv.some((argument) => argument.startsWith('@'))) return false
  const names = argv.flatMap((argument, index) => (argument === '--name' ? [index] : []))
  if (names.length !== 1 || argv[names[0]! + 1] !== 'ghostty-config-resolver') return false
  if (argv.filter((argument) => argument === '--listen=-').length !== 1) return false
  if (argv.at(-1) !== '--listen=-') return false
  const libDirectories = argv.flatMap((argument, index) =>
    argument === '--zig-lib-dir' ? [index] : [],
  )
  if (libDirectories.length !== 1) return false
  if (argv[libDirectories[0]! + 1] !== `${join(dirname(zig), 'lib')}/`) return false
  if (argv.filter((argument) => argument === '-fincremental').length !== 1) return false
  return hasFixedGeneratedModules(argv, zigTarget)
}

function hasFixedGeneratedModules(argv: readonly string[], zigTarget: string): boolean {
  const modules = targetGeneratedModules(zigTarget)
  for (const module of modules) {
    const prefix = `-M${module.name}=`
    const matches = argv.filter((argument) => argument.startsWith(prefix))
    if (matches.length !== 1 || matches[0] !== `${prefix}${module.path}`) return false
  }
  for (const module of FIXED_GENERATED_MODULES) {
    if (modules.includes(module)) continue
    if (argv.some((argument) => argument.startsWith(`-M${module.name}=`))) return false
  }
  return true
}

function tokenizeCommand(command: string): readonly string[] {
  const values: string[] = []
  let current = ''
  let quote = ''
  let wordStarted = false
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (quote && character === quote) {
      quote = ''
      continue
    }
    if (!quote && character === '"') {
      quote = character
      wordStarted = true
      continue
    }
    if (!quote && character === "'") throw new NativeBuildFailure('invalid link command quote')
    if (!quote && (character === ' ' || character === '\t')) {
      if (wordStarted) values.push(current)
      current = ''
      wordStarted = false
      continue
    }
    if (character === '\\') {
      if (quote !== '"') throw new NativeBuildFailure('invalid link command escape')
      index += 1
      if (index >= command.length) throw new NativeBuildFailure('invalid link command escape')
      current += decodedPrintableEscape(command[index]!)
      wordStarted = true
      continue
    }
    current += character
    wordStarted = true
  }
  if (quote) throw new NativeBuildFailure('unterminated link command quote')
  if (wordStarted) values.push(current)
  if (values.length === 0) throw new NativeBuildFailure('empty link command')
  return values
}

function decodedPrintableEscape(character: string): string {
  if (['!', '"', '$', '\\', '`'].includes(character)) return character
  throw new NativeBuildFailure('unsupported link command escape')
}

function assembleBundle(
  args: Arguments,
  prefix: string,
  bundle: string,
  expectedStrip: FileIdentity,
  linkArgv: readonly string[],
): readonly string[] {
  const source = join(prefix, 'bin', 'ghostty-config-resolver')
  const helper = join(bundle, 'bin', 'ghostty-config-resolver')
  const resources = join(bundle, 'resources', 'themes')
  mkdirSync(dirname(helper), { recursive: true })
  mkdirSync(resources, { recursive: true })
  copyFileSync(source, helper)
  chmodSync(helper, 0o755)

  const stripArgv =
    process.platform === 'darwin' ? ['-x', '-no_uuid', helper] : ['--strip-all', helper]
  const fullStripArgv = ['/usr/bin/strip', ...stripArgv]
  verifyExpectedStripArgv(args, fullStripArgv)
  const actualStrip = fileIdentity('/usr/bin/strip')
  assertIdentity(actualStrip, expectedStrip.bytes, expectedStrip.sha256, 'strip tool')
  run('/usr/bin/strip', stripArgv)
  const afterStrip = fileIdentity('/usr/bin/strip')
  assertIdentity(afterStrip, expectedStrip.bytes, expectedStrip.sha256, 'strip tool')
  assertNoEmbeddedFontPayloads(helper, args.target, fontModulePaths(linkArgv))
  assertFile(args.themesArchive, THEMES_BYTES, THEMES_SHA256, 'themes archive')
  run('/usr/bin/tar', ['-xzf', args.themesArchive, '-C', resources, '--strip-components=1'])
  return fullStripArgv
}

function fontModulePaths(linkArgv: readonly string[]): readonly string[] {
  return EXCLUDED_FONT_MODULES.map((name) => fontModulePath(linkArgv, name))
}

function fontModulePath(linkArgv: readonly string[], name: string): string {
  const prefix = `-M${name}=`
  const matches = linkArgv.filter((argument) => argument.startsWith(prefix))
  if (matches.length !== 1) {
    throw new NativeBuildFailure('native font module is not unique in observed link argv')
  }
  const path = matches[0]!.slice(prefix.length)
  const packageRoot = join(BUILD_ROOT, 'overlay', 'zig-pkg')
  if (!path.startsWith(`${packageRoot}/`)) {
    throw new NativeBuildFailure('native font module escapes the verified package root')
  }
  return path
}

function writeEvidence(
  args: Arguments,
  target: (typeof TARGETS)[Target],
  bundle: string,
  upstreamAudit: UpstreamAudit,
  boundary: PrebuildBoundary,
  buildResult: BuildResult,
): void {
  const helper = join(bundle, 'bin', 'ghostty-config-resolver')
  const resources = join(bundle, 'resources')
  const resource = resourceIdentity(resources)
  const targetRecipe = buildTargetRecipe(
    args.target,
    boundary.runner,
    target,
    buildResult,
    boundary.tools,
    boundary.inputs,
  )
  const recipeSha256 = verifyRecipeTarget(args, targetRecipe)
  const evidence = {
    schemaVersion: 1,
    kind: args.mode === 'inventory' ? 'config-resolver-inventory' : 'config-resolver-build',
    target: args.target,
    runId: requiredEnvironment('NATIVE_RUN_ID'),
    runAttempt: Number(requiredEnvironment('NATIVE_RUN_ATTEMPT')),
    ghosttyWebGpuHead: requiredEnvironment('EXPECTED_HEAD'),
    sourceDateEpoch: Number(SOURCE_DATE_EPOCH),
    upstreamRevision: UPSTREAM_REVISION,
    upstreamTreeSha256: upstreamAudit.sha256,
    upstreamTreeEntries: upstreamAudit.entries,
    officialReadOnlyGraph: 'pass',
    zigVersion: ZIG_VERSION,
    buildRecipeSha256: recipeSha256,
    runner: boundary.runner,
    targetTriple: target.zigTarget,
    optimizationMode: 'ReleaseSafe',
    buildArgv: buildResult.buildArgv,
    linkArgv: buildResult.linkArgv,
    stripArgv: buildResult.stripArgv,
    environment: buildResult.buildEnvironment,
    tools: boundary.tools,
    inputs: boundary.inputs,
    artifactSha256: sha256(readFileSync(helper)),
    artifactBytes: statSync(helper).size,
    resourceTreeSha256: resource.sha256,
    resourceBytes: resource.bytes,
    resourceEntries: resource.entries,
    fileOutput: run('/usr/bin/file', ['-b', helper]).trim(),
  } as const
  mkdirSync(dirname(args.evidence), { recursive: true })
  writeFileSync(args.evidence, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
}

function buildTargetRecipe(
  nativeTarget: Target,
  runner: ReturnType<typeof runnerRecord>,
  target: (typeof TARGETS)[Target],
  buildResult: BuildResult,
  tools: readonly unknown[],
  inputs: readonly ArchiveInput[],
): NativeTargetRecipe {
  return {
    runner: {
      os: runner.os,
      arch: runner.arch,
      image: runner.image,
      imageVersion: runner.imageVersion,
    },
    targetTriple: target.zigTarget,
    optimizationMode: 'ReleaseSafe',
    buildArgv: buildResult.buildArgv,
    linkPlan: projectObservedLinkArgv(buildResult.linkArgv, nativeTarget),
    stripArgv: buildResult.stripArgv,
    environment: buildResult.buildEnvironment,
    tools: tools as NativeTargetRecipe['tools'],
    inputs,
  }
}

function verifyRecipeTarget(args: Arguments, actual: NativeTargetRecipe): string | null {
  if (args.mode === 'inventory') return null
  const recipe = loadBuildRecipe(join(scriptDir, 'build-recipe.json'))
  const expected = expandRecipeTarget(recipe.value.targets[args.target])
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new NativeBuildFailure('materialized build does not match the native build recipe')
  }
  return recipe.sha256
}

function canonicalJson(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as JsonObject
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
  return `{${entries.join(',')}}`
}

function runnerRecord(target: Target): {
  readonly os: 'darwin' | 'linux'
  readonly arch: 'arm64' | 'x64'
  readonly image: string
  readonly imageVersion: string
  readonly label: string
} {
  return {
    os: target.startsWith('darwin-') ? 'darwin' : 'linux',
    arch: target.endsWith('arm64') ? 'arm64' : 'x64',
    image: requiredEnvironment('ImageOS'),
    imageVersion: requiredEnvironment('ImageVersion'),
    label: requiredEnvironment('NATIVE_RUNNER_LABEL'),
  }
}

function verifyExpectedRunner(args: Arguments, actual: ReturnType<typeof runnerRecord>): void {
  if (args.mode === 'inventory') return
  const expected = loadBuildRecipe(join(scriptDir, 'build-recipe.json')).value.targets[args.target]
  const identity = {
    os: actual.os,
    arch: actual.arch,
    image: actual.image,
    imageVersion: actual.imageVersion,
  }
  if (canonicalJson(identity) !== canonicalJson(expected.runner)) {
    throw new NativeBuildFailure('runner identity does not match the native build recipe')
  }
}

function verifyPreUseToolIdentities(
  args: Arguments,
  target: (typeof TARGETS)[Target],
  zig: string,
): void {
  const zigIdentity = fileIdentity(zig)
  const stripIdentity = fileIdentity('/usr/bin/strip')
  if (args.mode === 'inventory') return
  const expected = loadBuildRecipe(join(scriptDir, 'build-recipe.json')).value.targets[args.target]
  assertIdentity(
    zigIdentity,
    expectedTool(expected, 'zig').bytes,
    expectedTool(expected, 'zig').sha256,
    'Zig tool',
  )
  assertIdentity(
    zigIdentity,
    expectedTool(expected, 'linker').bytes,
    expectedTool(expected, 'linker').sha256,
    'linker tool',
  )
  assertIdentity(
    stripIdentity,
    expectedTool(expected, 'strip').bytes,
    expectedTool(expected, 'strip').sha256,
    'strip tool',
  )
  if (target.zigTarget.includes('macos')) {
    const input = expected.inputs.find(
      (candidate) =>
        candidate.role === 'generated-resource-source' && candidate.id === ZIG_LIB_INPUT_ID,
    )
    if (!input) throw new NativeBuildFailure('native build recipe Zig lib input is missing')
    const zigLibIdentity = hashExternalTree(zigLibRoot(zig))
    assertIdentity(zigLibIdentity, input.bytes, input.sha256, 'Zig lib tree')
    return
  }
  const sysroot = expectedTool(expected, 'sdk-or-sysroot')
  const zigLibIdentity = hashExternalTree(zigLibRoot(zig))
  assertIdentity(zigLibIdentity, sysroot.bytes, sysroot.sha256, 'Zig lib tree')
}

function expectedTool(
  expected: NativeTargetRecipe,
  role: NativeTargetRecipe['tools'][number]['role'],
): NativeTargetRecipe['tools'][number] {
  const tool = expected.tools.find((candidate) => candidate.role === role)
  if (!tool) throw new NativeBuildFailure('native build recipe tool is missing')
  return tool
}

function expectedTarget(args: Arguments): NativeTargetRecipe {
  const recipe = loadBuildRecipe(join(scriptDir, 'build-recipe.json')).value.targets[args.target]
  return expandRecipeTarget(recipe)
}

function expandRecipeTarget(target: NativeTargetRecipe): NativeTargetRecipe {
  const sdk = target.tools.find((tool) => tool.role === 'sdk-or-sysroot')
  const sdkPath = sdk?.acquisition.kind === 'runner-component' ? sdk.acquisition.path : BUILD_ROOT
  const tokens = {
    $WORK: BUILD_ROOT,
    $UPSTREAM: join(BUILD_ROOT, 'upstream'),
    $OUTPUT: join(BUILD_ROOT, 'bundle'),
    $SDK: sdkPath,
    $SYSROOT: sdkPath,
    $RESOURCES: join(BUILD_ROOT, 'bundle', 'resources'),
  }
  return expandRecipeValue(target, tokens) as NativeTargetRecipe
}

function expandRecipeValue(value: unknown, tokens: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') return expandNativeToken(value, tokens)
  if (Array.isArray(value)) return value.map((item) => expandRecipeValue(item, tokens))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, expandRecipeValue(item, tokens)]),
  )
}

function verifyExpectedBuildEnvironment(
  args: Arguments,
  actual: readonly { readonly name: string; readonly value: string }[],
): void {
  if (args.mode === 'inventory') return
  if (canonicalJson(actual) !== canonicalJson(expectedTarget(args).environment)) {
    throw new NativeBuildFailure('build environment does not match the native build recipe')
  }
}

function verifyExpectedGeneration(
  expected: NativeTargetRecipe['inputs'][number],
  generation: NonNullable<ArchiveInput['generation']>,
  acquisition: NativeAcquisition,
  label: string,
): void {
  const actual = { acquisition, generation }
  const expectedPlan = { acquisition: expected.acquisition, generation: expected.generation }
  if (canonicalJson(actual) !== canonicalJson(expectedPlan)) {
    throw new NativeBuildFailure(`${label} does not match the native build recipe`)
  }
}

function verifyExpectedTreeGeneration(
  args: Arguments,
  argv: readonly string[],
  inputs: readonly ArchiveInput[],
): void {
  if (args.mode === 'inventory') return
  const expected = expectedTarget(args)
    .inputs.filter(isPackageTreeRecord)
    .map(generatedModulePlanProjection)
  const actual = inputs
    .filter((input) => input.role === 'dependency-archive')
    .map((input) => packageTreePlan(input, argv))
    .sort(recordOrder)
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new NativeBuildFailure(
      'package tree generation plan does not match the native build recipe',
    )
  }
}

function packageTreePlan(input: ArchiveInput, argv: readonly string[]): unknown {
  const hash = packageHashFromId(input.id, 'zp-')
  return {
    role: 'generated-resource-source',
    id: treeId(hash),
    acquisition: input.acquisition,
    generation: {
      sources: [`input:${input.id}`, `input:${sourceId(hash)}`, 'tool:zig'],
      argv,
    },
  }
}

function verifyExpectedGenerationInputs(args: Arguments, actual: readonly ArchiveInput[]): void {
  if (args.mode === 'inventory') return
  const expected = expectedTarget(args).inputs.filter(
    (input) => !isNativeGeneratedModuleRecord(input),
  )
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new NativeBuildFailure('generation inputs do not match the native build recipe')
  }
}

function verifyExpectedGeneratedModulePlan(
  args: Arguments,
  sources: readonly string[],
  argv: readonly string[],
  acquisition: NativeAcquisition,
): void {
  if (args.mode === 'inventory') return
  const expected = expectedTarget(args)
    .inputs.filter(isNativeGeneratedModuleRecord)
    .map(generatedModulePlanProjection)
  const modules = targetGeneratedModules(TARGETS[args.target].zigTarget)
  const actual = modules
    .map((module) => ({
      role: 'generated-resource-source' as const,
      id: module.id,
      acquisition,
      generation: { sources, argv },
    }))
    .sort(recordOrder)
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new NativeBuildFailure(
      'native generated input plan does not match the native build recipe',
    )
  }
}

function generatedModulePlanProjection(input: NativeTargetRecipe['inputs'][number]): unknown {
  return {
    role: input.role,
    id: input.id,
    acquisition: input.acquisition,
    generation: input.generation,
  }
}

function verifyExpectedBuildInvocation(
  args: Arguments,
  argv: readonly string[],
  environment: readonly { readonly name: string; readonly value: string }[],
): void {
  if (args.mode === 'inventory') return
  const expected = expectedTarget(args)
  if (canonicalJson(argv) !== canonicalJson(expected.buildArgv)) {
    throw new NativeBuildFailure('build argv does not match the native build recipe')
  }
  if (canonicalJson(environment) !== canonicalJson(expected.environment)) {
    throw new NativeBuildFailure('build environment does not match the native build recipe')
  }
}

function verifyExpectedObservedLinkArgv(args: Arguments, actual: readonly string[]): void {
  if (args.mode === 'inventory') return
  let actualPlan: readonly string[]
  try {
    actualPlan = projectObservedLinkArgv(actual, args.target)
  } catch {
    throw new NativeBuildFailure('observed link argv does not match the native build recipe')
  }
  if (canonicalJson(actualPlan) !== canonicalJson(expectedTarget(args).linkPlan)) {
    throw new NativeBuildFailure('observed link argv does not match the native build recipe')
  }
}

function verifyExpectedStripArgv(args: Arguments, actual: readonly string[]): void {
  if (args.mode === 'inventory') return
  if (canonicalJson(actual) !== canonicalJson(expectedTarget(args).stripArgv)) {
    throw new NativeBuildFailure('strip argv does not match the native build recipe')
  }
}

function verifyExpectedBoundaryTools(args: Arguments, actual: PrebuildBoundary): void {
  if (args.mode === 'inventory') return
  const expected = expectedTarget(args)
  verifyExpectedRunnerAndTools(actual, expected)
}

function verifyPrebuildBoundary(args: Arguments, actual: PrebuildBoundary): void {
  if (args.mode === 'inventory') return
  const expected = expectedTarget(args)
  verifyExpectedRunnerAndTools(actual, expected)
  const expectedInputs = expected.inputs.filter(
    (input) => !isPackageTreeRecord(input) && !isNativeGeneratedModuleRecord(input),
  )
  if (canonicalJson(actual.inputs) !== canonicalJson(expectedInputs)) {
    throw new NativeBuildFailure('input identities do not match the native build recipe')
  }
}

function verifyExpectedInputs(args: Arguments, actual: readonly ArchiveInput[]): void {
  if (args.mode === 'inventory') return
  const expected = expectedTarget(args)
  if (canonicalJson(actual) !== canonicalJson(expected.inputs)) {
    throw new NativeBuildFailure('materialized inputs do not match the native build recipe')
  }
}

function verifyExpectedRunnerAndTools(
  actual: PrebuildBoundary,
  expected: NativeTargetRecipe,
): void {
  const runner = {
    os: actual.runner.os,
    arch: actual.runner.arch,
    image: actual.runner.image,
    imageVersion: actual.runner.imageVersion,
  }
  if (canonicalJson(runner) !== canonicalJson(expected.runner)) {
    throw new NativeBuildFailure('runner identity does not match the native build recipe')
  }
  if (canonicalJson(actual.tools) !== canonicalJson(expected.tools)) {
    throw new NativeBuildFailure('tool identities do not match the native build recipe')
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new NativeBuildFailure(`missing ${name} environment identity`)
  return value
}

function toolRecords(
  target: (typeof TARGETS)[Target],
  zigPath: string,
  strip: FileIdentity,
): readonly NativeToolRecord[] {
  const zig = fileIdentity(zigPath)
  const download = zigDownload(target)
  const records: NativeToolRecord[] = [
    {
      role: 'linker',
      name: 'zig-integrated-linker',
      version: ZIG_VERSION,
      ...zig,
      acquisition: download,
    },
    {
      role: 'strip',
      name: 'system-strip',
      version: stripVersion(target.zigTarget),
      ...strip,
      acquisition: runnerAcquisition('/usr/bin/strip'),
    },
    { role: 'zig', name: 'zig', version: ZIG_VERSION, ...zig, acquisition: download },
  ]
  records.push(sdkOrSysrootRecord(target, download, zigPath))
  return records.sort(recordOrder)
}

function sdkOrSysrootRecord(
  target: (typeof TARGETS)[Target],
  download: Extract<NativeAcquisition, { readonly kind: 'official-download' }>,
  zigPath: string,
): NativeToolRecord {
  if (!target.zigTarget.includes('macos')) {
    const zigLib = hashExternalTree(zigLibRoot(zigPath))
    return {
      role: 'sdk-or-sysroot',
      name: 'zig-bundled-lib-tree',
      version: ZIG_VERSION,
      bytes: zigLib.bytes,
      sha256: zigLib.sha256,
      acquisition: download,
    }
  }
  const sdk = run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path']).trim()
  const settingsPath = join(sdk, 'SDKSettings.json')
  const settings = fileIdentity(settingsPath)
  const identity = hashExternalTree(sdk)
  const xcode = run('/usr/bin/xcodebuild', ['-version']).trim().split('\n')
  const sdkVersion = run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version']).trim()
  return {
    role: 'sdk-or-sysroot',
    name: 'macos-sdk-tree',
    version: sdkVersion,
    bytes: identity.bytes,
    sha256: identity.sha256,
    acquisition: {
      ...runnerAcquisition(sdk, 'external-tree-v1'),
      macosSdk: {
        xcodeVersion: stripPrefix(xcode[0] ?? '', 'Xcode '),
        xcodeBuild: stripPrefix(xcode[1] ?? '', 'Build version '),
        sdkVersion,
        sdkBuild: sdkBuild(),
        sdkSettingsSha256: settings.sha256,
      },
    },
  }
}

function requiredToolRecord(
  tools: readonly NativeToolRecord[],
  role: NativeToolRecord['role'],
): NativeToolRecord {
  const matches = tools.filter((tool) => tool.role === role)
  if (matches.length !== 1) throw new NativeBuildFailure('native tool identity is not unique')
  return matches[0]!
}

function assertDarwinSdkTool(args: Arguments, zig: string, expected: NativeToolRecord): void {
  const target = TARGETS[args.target]
  if (!target.zigTarget.includes('macos')) return
  const actual = sdkOrSysrootRecord(target, zigDownload(target), zig)
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new NativeBuildFailure('macOS SDK identity changed during the native build')
  }
}

type JsonObject = Record<string, unknown>

function sdkBuild(): string {
  const version = run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-build-version']).trim()
  if (!version) throw new NativeBuildFailure('SDK build is unavailable')
  return version
}

function stripPrefix(value: string, prefix: string): string {
  if (!value.startsWith(prefix)) return value
  return value.slice(prefix.length)
}

function runnerAcquisition(
  path: string,
  contentKind: 'external-tree-v1' | 'file' = 'file',
): Extract<NativeAcquisition, { readonly kind: 'runner-component' }> {
  return {
    kind: 'runner-component',
    runnerImage: requiredEnvironment('ImageOS'),
    runnerImageVersion: requiredEnvironment('ImageVersion'),
    path,
    contentKind,
  }
}

function zigLibRoot(zig: string): string {
  const root = join(dirname(realpathSync(zig)), 'lib')
  if (!lstatExists(root) || !statSync(root).isDirectory()) {
    throw new NativeBuildFailure('Zig lib tree is unavailable')
  }
  return root
}

function zigDownload(
  target: (typeof TARGETS)[Target],
): Extract<NativeAcquisition, { readonly kind: 'official-download' }> {
  return {
    kind: 'official-download',
    url: target.zigArchiveUrl,
    archiveBytes: target.zigArchiveBytes,
    archiveSha256: target.zigArchiveSha256,
  }
}

function zigLibInput(target: (typeof TARGETS)[Target], zig: string): ArchiveInput {
  const identity = hashExternalTree(zigLibRoot(zig))
  return {
    role: 'generated-resource-source',
    id: ZIG_LIB_INPUT_ID,
    bytes: identity.bytes,
    sha256: identity.sha256,
    acquisition: zigDownload(target),
  }
}

function dependencyDeclarations(upstream: string, overlay: string): ReadonlyMap<string, string> {
  const paths: string[] = []
  collectNamedFiles(upstream, 'build.zig.zon', paths)
  collectNamedFiles(join(overlay, 'zig-pkg'), 'build.zig.zon', paths)
  const declarations = new Map<string, string>()
  const pattern = /\.url\s*=\s*"([^"]+)"\s*,[\s\S]{0,512}?\.hash\s*=\s*"([^"]+)"/g
  for (const path of paths) {
    const source = readFileSync(path, 'utf8')
    recordDependencyDeclarations(source, pattern, declarations)
  }
  return declarations
}

function recordDependencyDeclarations(
  source: string,
  pattern: RegExp,
  declarations: Map<string, string>,
): void {
  for (const match of source.matchAll(pattern)) {
    recordDependencyDeclaration(match, declarations)
  }
}

function recordDependencyDeclaration(
  match: RegExpMatchArray,
  declarations: Map<string, string>,
): void {
  const url = match[1]
  const hash = match[2]
  if (!url || !hash) throw new NativeBuildFailure('invalid dependency declaration')
  const previous = declarations.get(hash)
  if (!previous || previous === url) {
    declarations.set(hash, url)
    return
  }
  const preferred = preferredDependencyUrl(previous, url)
  if (!preferred) throw new NativeBuildFailure('dependency hash has multiple URLs')
  declarations.set(hash, preferred)
}

function preferredDependencyUrl(first: string, second: string): string | null {
  const mirror = [first, second].find((url) => mirrorRevision(url))
  const git = [first, second].find((url) => gitRevision(url))
  if (!mirror || !git) return null
  if (mirrorRevision(mirror) !== gitRevision(git)) return null
  return mirror
}

function mirrorRevision(url: string): string | null {
  if (!url.startsWith('https://deps.files.ghostty.org/')) return null
  return url.match(/([0-9a-f]{40})\.(?:tar\.gz|tgz)$/)?.[1] ?? null
}

function gitRevision(url: string): string | null {
  if (!url.startsWith('git+https://')) return null
  return url.match(/#([0-9a-f]{40})$/)?.[1] ?? null
}

function collectNamedFiles(root: string, name: string, paths: string[]): void {
  if (!lstatExists(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      collectNamedFiles(path, name, paths)
      continue
    }
    if (entry.isFile() && entry.name === name) paths.push(path)
  }
}

function runtimeInput(args: Arguments): ArchiveInput {
  const identity = fileIdentity(args.themesArchive)
  return {
    role: 'runtime-resource',
    id: 'ghostty-themes',
    ...identity,
    acquisition: {
      kind: 'official-download',
      url: THEMES_URL,
      archiveBytes: identity.bytes,
      archiveSha256: identity.sha256,
    },
  }
}

function verifyPackageCache(
  upstream: string,
  overlay: string,
  globalCache: string,
  inputs: readonly ArchiveInput[],
): void {
  verifyPackageCacheFiles(globalCache, inputs)
  const expected = inputs.filter((input) => input.role === 'dependency-archive')
  const declarations = dependencyDeclarations(upstream, overlay)
  for (const input of expected) verifyPackageDeclaration(input, declarations)
}

function verifyPackageCacheFiles(globalCache: string, inputs: readonly ArchiveInput[]): void {
  const expected = inputs.filter((input) => input.role === 'dependency-archive')
  const root = join(globalCache, 'p')
  if (!lstatExists(root)) throw new NativeBuildFailure('verified package cache is missing')
  const names = readdirSync(root).sort()
  if (names.length !== expected.length)
    throw new NativeBuildFailure('verified package count mismatch')
  for (const name of names) verifyPackageCacheEntry(root, name, expected)
}

function verifyPackageCacheEntry(
  root: string,
  name: string,
  expected: readonly ArchiveInput[],
): void {
  if (!name.endsWith('.tar.gz')) throw new NativeBuildFailure('verified package name is invalid')
  const hash = name.slice(0, -'.tar.gz'.length)
  const input = expected.find((candidate) => candidate.id === packageId(hash))
  if (!input) throw new NativeBuildFailure('verified package is not recorded')
  const path = join(root, name)
  if (!lstatSync(path).isFile())
    throw new NativeBuildFailure('verified package is not a regular file')
  const actual = fileIdentity(path)
  assertIdentity(actual, input.bytes, input.sha256, 'verified package')
}

function verifyPackageDeclaration(
  input: ArchiveInput,
  declarations: ReadonlyMap<string, string>,
): void {
  const hash = packageHashFromId(input.id, 'zp-')
  const declaration = declarations.get(hash)
  if (!declaration) throw new NativeBuildFailure('verified package declaration is missing')
  assertDeclaredAcquisition(input.acquisition, declaration)
}

function assertDeclaredAcquisition(acquisition: NativeAcquisition, declaration: string): void {
  if (acquisition.kind === 'official-download') {
    if (acquisition.url !== declaration)
      throw new NativeBuildFailure('download declaration mismatch')
    return
  }
  if (acquisition.kind !== 'git')
    throw new NativeBuildFailure('package acquisition kind is invalid')
  const git = parseGitDependency(declaration)
  if (!git) throw new NativeBuildFailure('Git package declaration is invalid')
  if (git.repository !== acquisition.repository || git.revision !== acquisition.revision) {
    throw new NativeBuildFailure('Git package declaration mismatch')
  }
}

function assertIdentity(
  actual: { readonly bytes: number; readonly sha256: string },
  bytes: number,
  digest: string,
  label: string,
): void {
  if (actual.bytes !== bytes || actual.sha256 !== digest) {
    throw new NativeBuildFailure(`${label} identity mismatch`)
  }
}

function assertSameRecord(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new NativeBuildFailure(`${label} does not match the native build recipe`)
  }
}

function assertGitRepository(checkout: string, revision: string): void {
  if (run('git', ['-C', checkout, 'rev-parse', 'FETCH_HEAD']).trim() !== revision) {
    throw new NativeBuildFailure('Git dependency revision mismatch')
  }
  if (run('git', ['-C', checkout, 'rev-parse', '--show-object-format']).trim() !== 'sha1') {
    throw new NativeBuildFailure('Git dependency object format mismatch')
  }
  if (run('git', ['-C', checkout, 'rev-parse', '--is-bare-repository']).trim() !== 'true') {
    throw new NativeBuildFailure('Git dependency repository is not bare')
  }
  if (run('git', ['-C', checkout, 'rev-parse', 'refs/heads/native-source']).trim() !== revision) {
    throw new NativeBuildFailure('Git dependency source ref mismatch')
  }
}

function assertGitSourceCheckout(
  checkout: string,
  revision: string,
  expected: { readonly bytes: number; readonly sha256: string },
): void {
  if (run('git', ['-C', checkout, 'rev-parse', 'HEAD']).trim() !== revision) {
    throw new NativeBuildFailure('Git dependency source revision mismatch')
  }
  if (run('git', ['-C', checkout, 'rev-parse', '--show-object-format']).trim() !== 'sha1') {
    throw new NativeBuildFailure('Git dependency source object format mismatch')
  }
  if (run('git', ['-C', checkout, 'rev-parse', '--is-bare-repository']).trim() !== 'false') {
    throw new NativeBuildFailure('Git dependency source checkout is bare')
  }
  if (run('git', ['-C', checkout, 'status', '--short']).trim()) {
    throw new NativeBuildFailure('Git dependency source checkout is dirty')
  }
  const actual = computeGitTreeSha256(checkout, revision)
  assertIdentity(actual, expected.bytes, expected.sha256, 'Git dependency source')
}

function assertMaterializedSource(source: MaterializedSource): void {
  if (source.record.acquisition.kind === 'official-download') {
    const actual = fileIdentity(source.fetchUrl)
    assertIdentity(actual, source.record.bytes, source.record.sha256, 'download source')
    return
  }
  if (source.record.acquisition.kind !== 'git') {
    throw new NativeBuildFailure('materialized source acquisition is invalid')
  }
  assertGitSourceCheckout(source.fetchUrl, source.record.acquisition.revision, source.record)
}

function recordOrder(left: unknown, right: unknown): number {
  const leftRecord = left as Record<string, string>
  const rightRecord = right as Record<string, string>
  const leftKey = `${leftRecord.role}\0${leftRecord.id ?? leftRecord.name}`
  const rightKey = `${rightRecord.role}\0${rightRecord.id ?? rightRecord.name}`
  return Buffer.compare(Buffer.from(leftKey), Buffer.from(rightKey))
}

function compareStringBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function fileIdentity(path: string): { readonly bytes: number; readonly sha256: string } {
  const value = readFileSync(path)
  return { bytes: value.length, sha256: sha256(value) }
}

function stripVersion(target: string): string {
  if (target.includes('macos')) {
    return run('/usr/bin/xcodebuild', ['-version']).trim().replaceAll('\n', ' ').slice(0, 256)
  }
  const output = run('/usr/bin/strip', ['--version']).trim().split('\n')[0]
  if (!output) throw new NativeBuildFailure('tool version is unavailable')
  return output.slice(0, 256)
}

function resourceIdentity(root: string): {
  readonly sha256: string
  readonly bytes: number
  readonly entries: number
} {
  const hash = createHash('sha256').update('ghostty-native-resources-v1\0')
  const state = { bytes: 0, entries: 0 }
  walkResources(root, '', hash, state)
  return { sha256: hash.digest('hex'), ...state }
}

function walkResources(
  path: string,
  relative: string,
  hash: ReturnType<typeof createHash>,
  state: { bytes: number; entries: number },
): void {
  const stat = lstatSync(path)
  const label = relative || '.'
  if (stat.isFile()) {
    const contents = readFileSync(path)
    hash.update(`f\0${label}\0${stat.mode & 0o777}\0${contents.length}\0`)
    hash.update(createHash('sha256').update(contents).digest())
    state.bytes += contents.length
    state.entries += 1
    return
  }
  if (!stat.isDirectory()) throw new NativeBuildFailure('resource tree has an unsupported entry')
  hash.update(`d\0${label}\0${stat.mode & 0o777}\0`)
  state.entries += 1
  for (const entry of sortedDirectory(path)) {
    const child = relative ? `${relative}/${entry}` : entry
    walkResources(join(path, entry), child, hash, state)
  }
}

function sortedDirectory(path: string): readonly string[] {
  return readdirSync(path).sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )
}

function run(command: string, argv: readonly string[]): string {
  const result = spawnSync(command, argv, {
    encoding: 'utf8',
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    },
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) throw new NativeBuildFailure(subprocessFailure(command))
  return result.stdout
}

function subprocessFailure(command: string): string {
  if (command === 'git') return 'Git subprocess failed'
  if (command === '/usr/bin/curl') return 'curl subprocess failed'
  if (command === '/usr/bin/file') return 'file subprocess failed'
  if (command === '/usr/bin/strip') return 'strip subprocess failed'
  if (command === '/usr/bin/tar') return 'tar subprocess failed'
  if (command === '/usr/bin/xcodebuild') return 'xcodebuild subprocess failed'
  if (command === '/usr/bin/xcrun') return 'xcrun subprocess failed'
  if (command.endsWith('/zig')) return 'Zig version subprocess failed'
  return 'native subprocess failed'
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

try {
  main()
} catch (error) {
  const reason =
    error instanceof NativeBuildFailure || error instanceof UpstreamAuditFailure
      ? error.message
      : 'unexpected native failure'
  process.stdout.write(`${JSON.stringify({ result: 'fail', reason })}\n`)
  process.exitCode = 1
}
