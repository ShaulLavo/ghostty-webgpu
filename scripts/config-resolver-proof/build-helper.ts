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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashExternalTree, loadProofRecipe, type ProofTargetRecipe } from './proof-contract'
import { assertPinnedUpstream, UpstreamAuditFailure, type UpstreamAudit } from './upstream-audit'

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
  readonly role: 'dependency-archive' | 'runtime-resource'
  readonly id: string
  readonly bytes: number
  readonly sha256: string
  readonly acquisition: {
    readonly kind: 'official-download'
    readonly url: string
    readonly archiveBytes: number
    readonly archiveSha256: string
  }
}

class ProofFailure extends Error {}

function main(): void {
  const args = parseArguments(process.argv.slice(2))
  const target = TARGETS[args.target]
  const upstreamAudit = assertPinnedUpstream(args.upstream)
  assertInputs(args, target)

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
    fetchDependencies(fixedZig, target.zigTarget, overlay, cache, globalCache)
    const result = build(fixedZig, target.zigTarget, overlay, prefix, cache, globalCache)
    const stripArgv = assembleBundle(args, prefix, bundle)
    assertUpstreamClean(args.upstream)
    writeEvidence(args, target, overlay, globalCache, bundle, upstreamAudit, {
      ...result,
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

function assertInputs(args: Arguments, target: (typeof TARGETS)[Target]): void {
  if (run(args.zig, ['version']).trim() !== ZIG_VERSION) {
    throw new ProofFailure('Zig version mismatch')
  }
  assertFile(args.zigArchive, target.zigArchiveBytes, target.zigArchiveSha256, 'Zig archive')
  assertFile(args.themesArchive, THEMES_BYTES, THEMES_SHA256, 'themes archive')
  const head = run('git', ['-C', args.upstream, 'rev-parse', 'HEAD']).trim()
  if (head !== UPSTREAM_REVISION) throw new ProofFailure('upstream revision mismatch')
  assertUpstreamClean(args.upstream)
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

function fetchDependencies(
  zig: string,
  zigTarget: string,
  overlay: string,
  cache: string,
  globalCache: string,
): void {
  const context = buildContext(cache, globalCache)
  const argv = [
    'build',
    '--fetch=needed',
    '--cache-dir',
    cache,
    '--global-cache-dir',
    globalCache,
    '-Doptimize=ReleaseSafe',
    `-Dtarget=${zigTarget}`,
  ]
  const result = spawnSync(zig, argv, {
    cwd: overlay,
    encoding: 'buffer',
    env: context.environment,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) throw new ProofFailure('Zig dependency fetch failed')
}

function build(
  zig: string,
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
  const result = spawnSync(zig, argv, {
    cwd: overlay,
    encoding: 'buffer',
    env: context.environment,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) throw new ProofFailure('Zig build failed')
  return {
    buildArgv: [zig, ...argv],
    buildEnvironment: context.recordedEnvironment,
    linkArgv: parseLinkArgv(result.stderr.toString('utf8')),
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
    XDG_CACHE_HOME: globalCache,
  }
  const recordedEnvironment = Object.entries(environment)
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([name, value]) => ({ name, value }))
  return { environment, recordedEnvironment }
}

function parseLinkArgv(stderr: string): readonly string[] {
  const candidates = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('ghostty-config-resolver-proof'))
    .filter(
      (line) =>
        line.startsWith('zig ld ') || line.startsWith('ld.lld ') || line.startsWith('ld64.lld '),
    )
  if (candidates.length !== 1) throw new ProofFailure('exact link command was not observed')
  return tokenizeCommand(candidates[0]!)
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
  overlay: string,
  globalCache: string,
  bundle: string,
  upstreamAudit: UpstreamAudit,
  buildResult: BuildResult,
): void {
  const helper = join(bundle, 'bin', 'ghostty-config-resolver-proof')
  const resources = join(bundle, 'resources')
  const tools = toolRecords(args, target)
  const inputs = archiveInputs(args, overlay, globalCache)
  const runner = runnerRecord(args.target)
  const resource = resourceIdentity(resources)
  const targetRecipe = buildTargetRecipe(runner, target, buildResult, tools, inputs)
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
    runner,
    targetTriple: target.zigTarget,
    optimizationMode: 'ReleaseSafe',
    buildArgv: buildResult.buildArgv,
    linkArgv: buildResult.linkArgv,
    stripArgv: buildResult.stripArgv,
    environment: buildResult.buildEnvironment,
    tools,
    inputs,
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

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new ProofFailure(`missing ${name} environment identity`)
  return value
}

function toolRecords(args: Arguments, target: (typeof TARGETS)[Target]): readonly unknown[] {
  const zig = fileIdentity(args.zig)
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
    const archive = fileIdentity(args.zigArchive)
    return {
      role: 'sdk-or-sysroot',
      name: 'zig-bundled-musl-sysroot',
      version: ZIG_VERSION,
      ...archive,
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

function archiveInputs(
  args: Arguments,
  overlay: string,
  globalCache: string,
): readonly ArchiveInput[] {
  const declarations = dependencyDeclarations(args.upstream, overlay)
  const packageRoot = join(globalCache, 'p')
  const inputs: ArchiveInput[] = []
  collectPackageInputs(packageRoot, declarations, inputs)
  const themes = archiveInput('runtime-resource', 'ghostty-themes', THEMES_URL, args.themesArchive)
  const withoutDuplicateTheme = inputs.filter((input) => input.sha256 !== themes.sha256)
  withoutDuplicateTheme.push(themes)
  return withoutDuplicateTheme.sort(recordOrder) as ArchiveInput[]
}

function collectPackageInputs(
  root: string,
  declarations: ReadonlyMap<string, string>,
  inputs: ArchiveInput[],
): void {
  if (!lstatExists(root)) return
  for (const name of readdirSync(root).sort()) {
    inputs.push(packageInput(root, name, declarations))
  }
}

function packageInput(
  root: string,
  name: string,
  declarations: ReadonlyMap<string, string>,
): ArchiveInput {
  const path = join(root, name)
  if (!statSync(path).isFile()) throw new ProofFailure('package cache entry is not a file')
  const declaration = [...declarations.entries()].find(([hash]) => name.startsWith(`${hash}.`))
  if (!declaration) throw new ProofFailure('fetched package has no pinned declaration')
  const [hash, url] = declaration
  const id = `zig-package-${sha256(Buffer.from(hash)).slice(0, 32)}`
  return archiveInput('dependency-archive', id, url, path)
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
  if (previous && previous !== url) throw new ProofFailure('dependency hash has multiple URLs')
  declarations.set(hash, url)
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

function archiveInput(
  role: ArchiveInput['role'],
  id: string,
  url: string,
  path: string,
): ArchiveInput {
  const identity = fileIdentity(path)
  return {
    role,
    id,
    ...identity,
    acquisition: {
      kind: 'official-download',
      url,
      archiveBytes: identity.bytes,
      archiveSha256: identity.sha256,
    },
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
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
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
