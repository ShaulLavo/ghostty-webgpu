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
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  hashExternalTree,
  loadProofRecipe,
  type ProofAcquisition,
  type ProofTargetRecipe,
} from './proof-contract'
import {
  assertPinnedUpstream,
  computeGitTreeSha256,
  UpstreamAuditFailure,
  type UpstreamAudit,
} from './upstream-audit'

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
const UPSTREAM_REVISION = 'c8554f28e0efe2f5595f32020371c34b25ec628f'
const SOURCE_DATE_EPOCH = '1787590337'
const BUILD_ROOT = '/tmp/ghostty-config-resolver-proof-build-v1'
const scriptDir = dirname(fileURLToPath(import.meta.url))

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
  readonly acquisition: ProofAcquisition
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

class ProofFailure extends Error {}

function main(): void {
  const args = parseArguments(process.argv.slice(2))
  process.umask(0o022)
  const target = TARGETS[args.target]
  const upstreamAudit = assertPinnedUpstream(args.upstream)
  assertSourceInputs(args, target)

  if (lstatExists(BUILD_ROOT)) throw new ProofFailure('fixed build root already exists')
  mkdirSync(BUILD_ROOT)
  try {
    const overlay = join(BUILD_ROOT, 'overlay')
    const prefix = join(BUILD_ROOT, 'prefix')
    const cache = join(BUILD_ROOT, 'cache')
    const globalCache = join(BUILD_ROOT, 'global-cache')
    const bundle = join(BUILD_ROOT, 'bundle')
    const fixedZig = join(BUILD_ROOT, 'toolchain', 'zig')
    mkdirSync(dirname(fixedZig), { recursive: true })
    symlinkSync(args.zig, fixedZig, 'file')
    createOverlay(args.upstream, overlay)
    const runner = runnerRecord(args.target)
    verifyExpectedRunner(args, runner)
    verifyPreUseToolIdentities(args, target, args.zig)
    const zigIdentity = fileIdentity(args.zig)
    assertFixedZig(args.zig, fixedZig, zigIdentity)
    const boundary = {
      runner,
      tools: toolRecords(args, target, fixedZig),
      inputs: [] as readonly ArchiveInput[],
    }
    verifyExpectedBoundaryTools(args, boundary)
    assertZigVersion(fixedZig, zigIdentity)
    const inputs =
      args.mode === 'inventory'
        ? discoverInventoryInputs(args, target, fixedZig, zigIdentity, overlay, cache, globalCache)
        : materializeExpectedInputs(args, fixedZig, zigIdentity, overlay, cache, globalCache)
    const completePrebuildBoundary = { ...boundary, inputs }
    removePackageGraph(overlay)
    verifyPrebuildBoundary(args, completePrebuildBoundary)
    const materialized = buildWithVerifiedInputs(
      args,
      target.zigTarget,
      fixedZig,
      zigIdentity,
      overlay,
      prefix,
      cache,
      globalCache,
      completePrebuildBoundary.inputs,
    )
    const completeBoundary = { ...completePrebuildBoundary, inputs: materialized.inputs }
    const stripArgv = assembleBundle(args, prefix, bundle)
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
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value) throw new ProofFailure('invalid arguments')
    values.set(name, value)
  }

  const target = values.get('--target')
  const mode = values.get('--mode')
  if (!target || !(target in TARGETS)) throw new ProofFailure('unsupported target')
  if (mode !== 'build' && mode !== 'inventory') throw new ProofFailure('unsupported mode')
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
  if (!value) throw new ProofFailure('missing path argument')
  return realpathSync(value)
}

function requiredNewPath(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new ProofFailure('missing output argument')
  if (lstatExists(value)) throw new ProofFailure('output already exists')
  return value
}

function assertSourceInputs(args: Arguments, target: (typeof TARGETS)[Target]): void {
  assertFile(args.zigArchive, target.zigArchiveBytes, target.zigArchiveSha256, 'Zig archive')
  assertFile(args.themesArchive, THEMES_BYTES, THEMES_SHA256, 'themes archive')
  const head = run('git', ['-C', args.upstream, 'rev-parse', 'HEAD']).trim()
  if (head !== UPSTREAM_REVISION) throw new ProofFailure('upstream revision mismatch')
  assertUpstreamClean(args.upstream)
}

function assertZigVersion(zig: string, expected: FileIdentity): void {
  assertIdentity(fileIdentity(zig), expected.bytes, expected.sha256, 'Zig tool')
  if (run(zig, ['version']).trim() !== ZIG_VERSION) {
    throw new ProofFailure('Zig version mismatch')
  }
  assertIdentity(fileIdentity(zig), expected.bytes, expected.sha256, 'Zig tool')
}

function assertFixedZig(source: string, fixed: string, expected: FileIdentity): void {
  if (realpathSync(fixed) !== realpathSync(source)) {
    throw new ProofFailure('fixed Zig tool target mismatch')
  }
  assertIdentity(fileIdentity(fixed), expected.bytes, expected.sha256, 'fixed Zig tool')
}

function assertFile(path: string, bytes: number, digest: string, label: string): void {
  const contents = readFileSync(path)
  if (contents.length !== bytes) throw new ProofFailure(`${label} length mismatch`)
  if (sha256(contents) !== digest) throw new ProofFailure(`${label} digest mismatch`)
}

function assertUpstreamClean(upstream: string): void {
  if (run('git', ['-C', upstream, 'status', '--short']).length !== 0) {
    throw new ProofFailure('upstream checkout is dirty')
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
}

function discoverInventoryInputs(
  args: Arguments,
  target: (typeof TARGETS)[Target],
  zig: string,
  zigIdentity: FileIdentity,
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
  const declarations = dependencyDeclarations(args.upstream, overlay)
  const packages = discoveredPackages(overlay, declarations)
  removePackageGraph(overlay)
  const inputs: ArchiveInput[] = []
  for (const dependency of packages) {
    inputs.push(
      ...acquireDiscoveredPackage(zig, zigIdentity, overlay, cache, globalCache, dependency),
    )
  }
  inputs.push(runtimeInput(args))
  return inputs.sort(recordOrder)
}

function removePackageGraph(overlay: string): void {
  const root = join(overlay, 'zig-pkg')
  if (!lstatExists(root) || !lstatSync(root).isDirectory()) {
    throw new ProofFailure('materialized package graph cannot be reset')
  }
  rmSync(root, { recursive: true })
  if (lstatExists(root)) throw new ProofFailure('materialized package graph reset failed')
}

function materializeExpectedInputs(
  args: Arguments,
  zig: string,
  zigIdentity: FileIdentity,
  overlay: string,
  cache: string,
  globalCache: string,
): readonly ArchiveInput[] {
  const recipe = loadProofRecipe(join(scriptDir, 'proof-recipe.json'))
  const expected = recipe.value.targets[args.target]
  const inputs: ArchiveInput[] = []
  const sources = new Map<string, MaterializedSource>()
  for (const input of expected.inputs) {
    if (!isPackageSourceRecord(input)) continue
    const source = materializeExpectedSource(input)
    sources.set(input.id, source)
    inputs.push(source.record)
  }
  for (const input of expected.inputs) {
    if (isPackageSourceRecord(input) || isPackageTreeRecord(input)) continue
    inputs.push(
      materializeExpectedInput(args, zig, zigIdentity, overlay, cache, globalCache, sources, input),
    )
  }
  return inputs.sort(recordOrder)
}

function isPackageSourceRecord(input: ProofTargetRecipe['inputs'][number]): boolean {
  return input.role === 'generated-resource-source' && input.id.startsWith('zs-')
}

function isPackageTreeRecord(input: ProofTargetRecipe['inputs'][number]): boolean {
  return input.role === 'generated-resource-source' && input.id.startsWith('zt-')
}

function discoveredPackages(
  overlay: string,
  declarations: ReadonlyMap<string, string>,
): readonly PackageDeclaration[] {
  const root = join(overlay, 'zig-pkg')
  if (!lstatExists(root)) throw new ProofFailure('Zig package graph is missing')
  const packages: PackageDeclaration[] = []
  for (const name of readdirSync(root).sort()) {
    packages.push(discoveredPackage(root, name, declarations))
  }
  if (packages.length === 0) throw new ProofFailure('Zig package cache is empty')
  return packages
}

function discoveredPackage(
  root: string,
  name: string,
  declarations: ReadonlyMap<string, string>,
): PackageDeclaration {
  const path = join(root, name)
  if (!lstatSync(path).isDirectory())
    throw new ProofFailure('package graph entry is not a directory')
  const declaration = [...declarations.entries()].find(([hash]) => name === hash)
  if (!declaration) throw new ProofFailure('fetched package has no pinned declaration')
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
    ? materializeGitSource(dependency.hash, git.repository, git.revision, git.fetchUrl)
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
  expected: ProofTargetRecipe['inputs'][number],
): ArchiveInput {
  if (expected.role === 'runtime-resource') {
    const actual = runtimeInput(args)
    assertSameRecord(actual, expected, 'runtime resource')
    return actual
  }
  if (expected.role !== 'dependency-archive') {
    throw new ProofFailure('unsupported expected input role')
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
  expected: ProofTargetRecipe['inputs'][number],
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
  acquisition: ProofAcquisition,
): MaterializedSource {
  if (acquisition.kind !== 'git') throw new ProofFailure('package source acquisition is invalid')
  return materializeGitSource(
    hash,
    acquisition.repository,
    acquisition.revision,
    `git+${acquisition.repository}#${acquisition.revision}`,
  )
}

function materializeExpectedPackage(
  zig: string,
  zigIdentity: FileIdentity,
  overlay: string,
  cache: string,
  globalCache: string,
  sources: ReadonlyMap<string, MaterializedSource>,
  expected: ProofTargetRecipe['inputs'][number],
): ArchiveInput {
  const hash = packageHashFromId(expected.id, 'zp-')
  const sourceId = sourceReference(expected)
  const source = sources.get(sourceId)
  if (!source) throw new ProofFailure('dependency source is missing')
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
  const actualHash = fetchPackageHash(
    zig,
    zigIdentity,
    overlay,
    cache,
    globalCache,
    source.fetchUrl,
  )
  if (actualHash !== hash) throw new ProofFailure('fetched package hash mismatch')
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
  const context = buildContext(cache, globalCache)
  const argv = ['fetch', fetchUrl, '--global-cache-dir', globalCache]
  assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
  const result = spawnSync(zig, argv, {
    cwd: overlay,
    encoding: 'utf8',
    env: context.environment,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) throw new ProofFailure('explicit Zig package fetch failed')
  assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
  if (result.stderr.length !== 0) throw new ProofFailure('explicit Zig package fetch wrote stderr')
  const hash = result.stdout.trim()
  if (!/^[A-Za-z0-9_.+-]{1,256}$/.test(hash)) {
    throw new ProofFailure('explicit Zig package fetch returned an invalid hash')
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
    throw new ProofFailure('explicit Zig package archive is missing')
  }
  return {
    role: 'dependency-archive',
    id: packageId(hash),
    ...fileIdentity(path),
    acquisition: source.record.acquisition,
    generation: {
      sources: [`input:${source.record.id}`, 'tool:zig'],
      argv: [zig, 'fetch', source.fetchUrl, '--global-cache-dir', globalCache],
    },
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
  if (id.length > 128) throw new ProofFailure('Zig package hash is too long for a recipe ID')
  return id
}

function packageHashFromId(id: string, prefix: PackageIdPrefix): string {
  if (!id.startsWith(prefix)) throw new ProofFailure('Zig package recipe ID prefix is invalid')
  const encoded = id.slice(prefix.length)
  if (!encoded || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/.test(encoded)) {
    throw new ProofFailure('Zig package recipe ID encoding is invalid')
  }
  const hash = Buffer.from(encoded, 'hex').toString('utf8')
  if (encodedPackageId(prefix, hash) !== id)
    throw new ProofFailure('Zig package recipe ID is invalid')
  return hash
}

function sourceReference(expected: ProofTargetRecipe['inputs'][number]): string {
  const sources = expected.generation?.sources
  if (!sources || sources.length !== 2 || !sources.includes('tool:zig')) {
    throw new ProofFailure('dependency generation sources are invalid')
  }
  const source = sources.find((value) => value.startsWith('input:'))
  if (!source) throw new ProofFailure('dependency generation source is missing')
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
  fetchUrl: string,
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
    fetchUrl,
  }
}

function downloadArchive(
  id: string,
  url: string,
): { readonly bytes: number; readonly sha256: string } {
  const root = join(BUILD_ROOT, 'source-archives')
  mkdirSync(root, { recursive: true })
  const path = sourceArchivePath(id, url)
  if (lstatExists(path)) throw new ProofFailure('source archive path already exists')
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
  throw new ProofFailure('download source has an unsupported archive suffix')
}

function assertEffectiveHttpsUrl(value: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ProofFailure('download effective URL is invalid')
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    throw new ProofFailure('download redirect policy was violated')
  }
}

function parseGitDependency(
  value: string,
): { readonly fetchUrl: string; readonly repository: string; readonly revision: string } | null {
  if (!value.startsWith('git+https://')) return null
  let parsed: URL
  try {
    parsed = new URL(value.slice(4))
  } catch {
    throw new ProofFailure('invalid Git dependency URL')
  }
  const revision = parsed.hash.slice(1)
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new ProofFailure('unpinned Git dependency URL')
  if (parsed.protocol !== 'https:' || parsed.search || parsed.username || parsed.password) {
    throw new ProofFailure('mutable Git dependency URL')
  }
  parsed.hash = ''
  parsed.pathname = parsed.pathname.replace(/\/$/, '')
  if (!parsed.pathname.endsWith('.git')) parsed.pathname += '.git'
  const repository = parsed.toString()
  return { fetchUrl: `git+${repository}#${revision}`, repository, revision }
}

function acquireGitRepository(
  id: string,
  repository: string,
  revision: string,
): {
  readonly acquisition: ProofAcquisition
  readonly bytes: number
  readonly sha256: string
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
  assertGitRepository(checkout, revision)
  const tree = computeGitTreeSha256(checkout, revision)
  if (tree.gitlinks !== 0) throw new ProofFailure('Git dependency has an unresolved gitlink')
  return {
    bytes: tree.bytes,
    sha256: tree.sha256,
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
  const context = buildContext(cache, globalCache)
  const argv = dependencyFetchArgv(zigTarget, cache, globalCache)
  const attempts = phase === 'discovery' ? 3 : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
    const result = spawnSync(zig, argv, {
      cwd: overlay,
      encoding: 'buffer',
      env: context.environment,
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
    if (result.status === 0) return
  }
  throw new ProofFailure(`${phase} Zig dependency fetch failed`)
}

function dependencyFetchArgv(
  zigTarget: string,
  cache: string,
  globalCache: string,
): readonly string[] {
  return [
    'build',
    '-j1',
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
  overlay: string,
  prefix: string,
  cache: string,
  globalCache: string,
  inputs: readonly ArchiveInput[],
): MaterializedBuild {
  verifyPackageCacheFiles(globalCache, inputs)
  const before = packageCacheSnapshot(globalCache)
  fetchDependencies(zig, zigIdentity, zigTarget, overlay, cache, globalCache, 'materialization')
  verifyPackageCache(args, overlay, globalCache, inputs)
  const materialized = packageCacheSnapshot(globalCache)
  if (canonicalJson(before) !== canonicalJson(materialized)) {
    throw new ProofFailure('package cache changed during graph materialization')
  }
  const treeInputs = packageTreeInputs(zig, zigTarget, overlay, cache, globalCache, inputs)
  const completeInputs = [...inputs, ...treeInputs].sort(recordOrder)
  verifyExpectedInputs(args, completeInputs)
  const buildResult = build(zig, zigIdentity, zigTarget, overlay, prefix, cache, globalCache)
  verifyPackageCache(args, overlay, globalCache, inputs)
  const afterTrees = packageTreeInputs(zig, zigTarget, overlay, cache, globalCache, inputs)
  if (canonicalJson(treeInputs) !== canonicalJson(afterTrees)) {
    throw new ProofFailure('materialized package graph changed during the build')
  }
  const after = packageCacheSnapshot(globalCache)
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new ProofFailure('package cache changed during the build')
  }
  return { build: buildResult, inputs: completeInputs }
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
  if (!lstatExists(root)) throw new ProofFailure('materialized package graph is missing')
  const names = readdirSync(root).sort()
  if (names.length !== expected.length)
    throw new ProofFailure('materialized package count mismatch')
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
    throw new ProofFailure('materialized package entry is not a directory')
  }
  const archive = expected.find((input) => input.id === packageId(hash))
  if (!archive) throw new ProofFailure('materialized package is not recorded')
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
  if (!lstatExists(root)) throw new ProofFailure('package cache is missing before use')
  return readdirSync(root)
    .sort()
    .map((name) => ({ name, ...fileIdentity(join(root, name)) }))
}

function build(
  zig: string,
  zigIdentity: FileIdentity,
  zigTarget: string,
  overlay: string,
  prefix: string,
  cache: string,
  globalCache: string,
): Omit<BuildResult, 'stripArgv'> {
  const context = buildContext(cache, globalCache)
  const argv = [
    'build',
    '--prefix',
    prefix,
    '--cache-dir',
    cache,
    '--global-cache-dir',
    globalCache,
    '-Doptimize=ReleaseSafe',
    `-Dtarget=${zigTarget}`,
    '--verbose-link',
  ]
  assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
  const result = spawnSync(zig, argv, {
    cwd: overlay,
    encoding: 'buffer',
    env: context.environment,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assertIdentity(fileIdentity(zig), zigIdentity.bytes, zigIdentity.sha256, 'Zig tool')
  if (result.status !== 0) throw new ProofFailure('Zig build failed')
  return {
    buildArgv: [zig, ...argv],
    buildEnvironment: context.recordedEnvironment,
    linkArgv: parseLinkArgv(Buffer.concat([result.stdout, result.stderr]).toString('utf8')),
  }
}

function buildContext(
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
  }
  const recordedEnvironment = Object.entries(environment)
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([name, value]) => ({ name, value }))
  return { environment, recordedEnvironment }
}

function parseLinkArgv(output: string): readonly string[] {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .map((line) => (line.startsWith('error: ') ? line.slice('error: '.length) : line))
    .filter(
      (line) =>
        line.startsWith('zig ld ') || line.startsWith('ld.lld ') || line.startsWith('ld64.lld '),
    )
  const candidates: (readonly string[])[] = []
  for (const line of lines) {
    const argv = tokenizeCommand(line)
    if (!isHelperLinkArgv(argv)) continue
    candidates.push(argv)
  }
  const uniqueCandidates = [
    ...new Map(candidates.map((argv) => [canonicalJson(argv), argv])).values(),
  ]
  if (uniqueCandidates.length !== 1) throw new ProofFailure('exact link command was not observed')
  return uniqueCandidates[0]!
}

function isHelperLinkArgv(argv: readonly string[]): boolean {
  const outputIndex = argv.indexOf('-o')
  if (outputIndex < 0) return false
  const output = argv[outputIndex + 1]
  if (!output) return false
  return basename(output) === 'ghostty-config-resolver-proof'
}

function tokenizeCommand(command: string): readonly string[] {
  const values: string[] = []
  let current = ''
  let quote = ''
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (quote && character === quote) {
      quote = ''
      continue
    }
    if (!quote && (character === "'" || character === '"')) {
      quote = character
      continue
    }
    if (!quote && character === ' ') {
      if (current) values.push(current)
      current = ''
      continue
    }
    if (character === '\\' && quote !== "'") {
      index += 1
      if (index >= command.length) throw new ProofFailure('invalid link command escape')
      current += command[index]
      continue
    }
    current += character
  }
  if (quote) throw new ProofFailure('unterminated link command quote')
  if (current) values.push(current)
  if (values.length === 0) throw new ProofFailure('empty link command')
  return values
}

function assembleBundle(args: Arguments, prefix: string, bundle: string): readonly string[] {
  const source = join(prefix, 'bin', 'ghostty-config-resolver-proof')
  const helper = join(bundle, 'bin', 'ghostty-config-resolver-proof')
  const resources = join(bundle, 'resources', 'themes')
  mkdirSync(dirname(helper), { recursive: true })
  mkdirSync(resources, { recursive: true })
  copyFileSync(source, helper)
  chmodSync(helper, 0o755)

  const stripArgv = process.platform === 'darwin' ? ['-x', helper] : ['--strip-all', helper]
  run('/usr/bin/strip', stripArgv)
  run('/usr/bin/tar', ['-xzf', args.themesArchive, '-C', resources, '--strip-components=1'])
  return ['/usr/bin/strip', ...stripArgv]
}

function writeEvidence(
  args: Arguments,
  target: (typeof TARGETS)[Target],
  bundle: string,
  upstreamAudit: UpstreamAudit,
  boundary: PrebuildBoundary,
  buildResult: BuildResult,
): void {
  const helper = join(bundle, 'bin', 'ghostty-config-resolver-proof')
  const resources = join(bundle, 'resources')
  const resource = resourceIdentity(resources)
  const targetRecipe = buildTargetRecipe(
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
    runId: requiredEnvironment('PROOF_RUN_ID'),
    runAttempt: Number(requiredEnvironment('PROOF_RUN_ATTEMPT')),
    ghosttyWebGpuHead: requiredEnvironment('EXPECTED_HEAD'),
    sourceDateEpoch: Number(SOURCE_DATE_EPOCH),
    upstreamRevision: UPSTREAM_REVISION,
    upstreamTreeSha256: upstreamAudit.sha256,
    upstreamTreeEntries: upstreamAudit.entries,
    officialReadOnlyGraph: 'pass',
    zigVersion: ZIG_VERSION,
    proofRecipeSha256: recipeSha256,
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
  runner: ReturnType<typeof runnerRecord>,
  target: (typeof TARGETS)[Target],
  buildResult: BuildResult,
  tools: readonly unknown[],
  inputs: readonly ArchiveInput[],
): ProofTargetRecipe {
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
    linkArgv: buildResult.linkArgv,
    stripArgv: buildResult.stripArgv,
    environment: buildResult.buildEnvironment,
    tools: tools as ProofTargetRecipe['tools'],
    inputs,
  }
}

function verifyRecipeTarget(args: Arguments, actual: ProofTargetRecipe): string | null {
  if (args.mode === 'inventory') return null
  const recipe = loadProofRecipe(join(scriptDir, 'proof-recipe.json'))
  const expected = recipe.value.targets[args.target]
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new ProofFailure('materialized build does not match the proof recipe')
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
    label: requiredEnvironment('PROOF_RUNNER_LABEL'),
  }
}

function verifyExpectedRunner(args: Arguments, actual: ReturnType<typeof runnerRecord>): void {
  if (args.mode === 'inventory') return
  const expected = loadProofRecipe(join(scriptDir, 'proof-recipe.json')).value.targets[args.target]
  const identity = {
    os: actual.os,
    arch: actual.arch,
    image: actual.image,
    imageVersion: actual.imageVersion,
  }
  if (canonicalJson(identity) !== canonicalJson(expected.runner)) {
    throw new ProofFailure('runner identity does not match the proof recipe')
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
  const expected = loadProofRecipe(join(scriptDir, 'proof-recipe.json')).value.targets[args.target]
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
  if (target.zigTarget.includes('macos')) return
  const sysroot = expectedTool(expected, 'sdk-or-sysroot')
  const zigLibIdentity = hashExternalTree(zigLibRoot(zig))
  assertIdentity(zigLibIdentity, sysroot.bytes, sysroot.sha256, 'Zig lib tree')
}

function expectedTool(
  expected: ProofTargetRecipe,
  role: ProofTargetRecipe['tools'][number]['role'],
): ProofTargetRecipe['tools'][number] {
  const tool = expected.tools.find((candidate) => candidate.role === role)
  if (!tool) throw new ProofFailure('proof recipe tool is missing')
  return tool
}

function verifyExpectedBoundaryTools(args: Arguments, actual: PrebuildBoundary): void {
  if (args.mode === 'inventory') return
  const expected = loadProofRecipe(join(scriptDir, 'proof-recipe.json')).value.targets[args.target]
  verifyExpectedRunnerAndTools(actual, expected)
}

function verifyPrebuildBoundary(args: Arguments, actual: PrebuildBoundary): void {
  if (args.mode === 'inventory') return
  const expected = loadProofRecipe(join(scriptDir, 'proof-recipe.json')).value.targets[args.target]
  verifyExpectedRunnerAndTools(actual, expected)
  const expectedInputs = expected.inputs.filter((input) => !isPackageTreeRecord(input))
  if (canonicalJson(actual.inputs) !== canonicalJson(expectedInputs)) {
    throw new ProofFailure('input identities do not match the proof recipe')
  }
}

function verifyExpectedInputs(args: Arguments, actual: readonly ArchiveInput[]): void {
  if (args.mode === 'inventory') return
  const expected = loadProofRecipe(join(scriptDir, 'proof-recipe.json')).value.targets[args.target]
  if (canonicalJson(actual) !== canonicalJson(expected.inputs)) {
    throw new ProofFailure('materialized inputs do not match the proof recipe')
  }
}

function verifyExpectedRunnerAndTools(actual: PrebuildBoundary, expected: ProofTargetRecipe): void {
  const runner = {
    os: actual.runner.os,
    arch: actual.runner.arch,
    image: actual.runner.image,
    imageVersion: actual.runner.imageVersion,
  }
  if (canonicalJson(runner) !== canonicalJson(expected.runner)) {
    throw new ProofFailure('runner identity does not match the proof recipe')
  }
  if (canonicalJson(actual.tools) !== canonicalJson(expected.tools)) {
    throw new ProofFailure('tool identities do not match the proof recipe')
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new ProofFailure(`missing ${name} environment identity`)
  return value
}

function toolRecords(
  args: Arguments,
  target: (typeof TARGETS)[Target],
  zigPath: string,
): readonly unknown[] {
  const zig = fileIdentity(zigPath)
  const strip = fileIdentity('/usr/bin/strip')
  const download = {
    kind: 'official-download',
    url: target.zigArchiveUrl,
    archiveBytes: target.zigArchiveBytes,
    archiveSha256: target.zigArchiveSha256,
  } as const
  const records: unknown[] = [
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
  records.push(sdkOrSysrootRecord(args, target, download))
  return records.sort(recordOrder)
}

function sdkOrSysrootRecord(
  args: Arguments,
  target: (typeof TARGETS)[Target],
  download: JsonObject,
): unknown {
  if (!target.zigTarget.includes('macos')) {
    const zigLib = hashExternalTree(zigLibRoot(args.zig))
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
    name: 'macos-sdk-settings',
    version: sdkVersion,
    bytes: identity.bytes,
    sha256: identity.sha256,
    acquisition: {
      ...runnerAcquisition(sdk, 'external-tree-v1'),
      macosSdk: {
        xcodeVersion: xcode[0] ?? '',
        xcodeBuild: xcode[1] ?? '',
        sdkVersion,
        sdkBuild: sdkBuild(),
        sdkSettingsSha256: settings.sha256,
      },
    },
  }
}

type JsonObject = Record<string, unknown>

function sdkBuild(): string {
  const version = run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-build-version']).trim()
  if (!version) throw new ProofFailure('SDK build is unavailable')
  return version
}

function runnerAcquisition(
  path: string,
  contentKind: 'external-tree-v1' | 'file' = 'file',
): JsonObject {
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
  if (!lstatExists(root) || !lstatSync(root).isDirectory()) {
    throw new ProofFailure('Zig lib tree is unavailable')
  }
  return root
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
  if (!url || !hash) throw new ProofFailure('invalid dependency declaration')
  const previous = declarations.get(hash)
  if (!previous || previous === url) {
    declarations.set(hash, url)
    return
  }
  const preferred = preferredDependencyUrl(previous, url)
  if (!preferred) throw new ProofFailure('dependency hash has multiple URLs')
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
  args: Arguments,
  overlay: string,
  globalCache: string,
  inputs: readonly ArchiveInput[],
): void {
  verifyPackageCacheFiles(globalCache, inputs)
  const expected = inputs.filter((input) => input.role === 'dependency-archive')
  const declarations = dependencyDeclarations(args.upstream, overlay)
  for (const input of expected) verifyPackageDeclaration(input, declarations)
}

function verifyPackageCacheFiles(globalCache: string, inputs: readonly ArchiveInput[]): void {
  const expected = inputs.filter((input) => input.role === 'dependency-archive')
  const root = join(globalCache, 'p')
  if (!lstatExists(root)) throw new ProofFailure('verified package cache is missing')
  const names = readdirSync(root).sort()
  if (names.length !== expected.length) throw new ProofFailure('verified package count mismatch')
  for (const name of names) verifyPackageCacheEntry(root, name, expected)
}

function verifyPackageCacheEntry(
  root: string,
  name: string,
  expected: readonly ArchiveInput[],
): void {
  if (!name.endsWith('.tar.gz')) throw new ProofFailure('verified package name is invalid')
  const hash = name.slice(0, -'.tar.gz'.length)
  const input = expected.find((candidate) => candidate.id === packageId(hash))
  if (!input) throw new ProofFailure('verified package is not recorded')
  const path = join(root, name)
  if (!lstatSync(path).isFile()) throw new ProofFailure('verified package is not a regular file')
  const actual = fileIdentity(path)
  assertIdentity(actual, input.bytes, input.sha256, 'verified package')
}

function verifyPackageDeclaration(
  input: ArchiveInput,
  declarations: ReadonlyMap<string, string>,
): void {
  const hash = packageHashFromId(input.id, 'zp-')
  const declaration = declarations.get(hash)
  if (!declaration) throw new ProofFailure('verified package declaration is missing')
  assertDeclaredAcquisition(input.acquisition, declaration)
}

function assertDeclaredAcquisition(acquisition: ProofAcquisition, declaration: string): void {
  if (acquisition.kind === 'official-download') {
    if (acquisition.url !== declaration) throw new ProofFailure('download declaration mismatch')
    return
  }
  if (acquisition.kind !== 'git') throw new ProofFailure('package acquisition kind is invalid')
  const git = parseGitDependency(declaration)
  if (!git) throw new ProofFailure('Git package declaration is invalid')
  if (git.repository !== acquisition.repository || git.revision !== acquisition.revision) {
    throw new ProofFailure('Git package declaration mismatch')
  }
}

function assertIdentity(
  actual: { readonly bytes: number; readonly sha256: string },
  bytes: number,
  digest: string,
  label: string,
): void {
  if (actual.bytes !== bytes || actual.sha256 !== digest) {
    throw new ProofFailure(`${label} identity mismatch`)
  }
}

function assertSameRecord(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new ProofFailure(`${label} does not match the proof recipe`)
  }
}

function assertGitRepository(checkout: string, revision: string): void {
  if (run('git', ['-C', checkout, 'rev-parse', 'FETCH_HEAD']).trim() !== revision) {
    throw new ProofFailure('Git dependency revision mismatch')
  }
  if (run('git', ['-C', checkout, 'rev-parse', '--show-object-format']).trim() !== 'sha1') {
    throw new ProofFailure('Git dependency object format mismatch')
  }
  if (run('git', ['-C', checkout, 'rev-parse', '--is-bare-repository']).trim() !== 'true') {
    throw new ProofFailure('Git dependency repository is not bare')
  }
}

function recordOrder(left: unknown, right: unknown): number {
  const leftRecord = left as Record<string, string>
  const rightRecord = right as Record<string, string>
  const leftKey = `${leftRecord.role}\0${leftRecord.id ?? leftRecord.name}`
  const rightKey = `${rightRecord.role}\0${rightRecord.id ?? rightRecord.name}`
  return Buffer.compare(Buffer.from(leftKey), Buffer.from(rightKey))
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
  if (!output) throw new ProofFailure('tool version is unavailable')
  return output.slice(0, 256)
}

function resourceIdentity(root: string): {
  readonly sha256: string
  readonly bytes: number
  readonly entries: number
} {
  const hash = createHash('sha256').update('ghostty-proof-resources-v1\0')
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
  if (!stat.isDirectory()) throw new ProofFailure('resource tree has an unsupported entry')
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
  if (result.status !== 0) throw new ProofFailure('proof subprocess failed')
  return result.stdout
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
    error instanceof ProofFailure || error instanceof UpstreamAuditFailure
      ? error.message
      : 'unexpected proof failure'
  process.stdout.write(`${JSON.stringify({ result: 'fail', reason })}\n`)
  process.exitCode = 1
}
