import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalObjectBytes, canonicalObjectSha256 } from './canonicalize.js'
import { GHOSTTY_CONFIG_UPSTREAM_REVISION } from './types.js'

export const NATIVE_RESOLVER_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
] as const
export const APPROVED_TARGET_CEILINGS = {
  'darwin-arm64': 2_097_152,
  'darwin-x64': 2_097_152,
  'linux-arm64': 8_388_608,
  'linux-x64': 9_437_184,
} as const
export const APPROVED_TOTAL_PACKAGE_CEILING = 22_020_096

const MAXIMUM_MANIFEST_BYTES = 2 * 1024 * 1024
const MAXIMUM_FILES = 4_096
const MAXIMUM_PATH_BYTES = 240
const MAXIMUM_STRING_BYTES = 256
const HASH_PATTERN = /^[0-9a-f]{64}$/
const HEAD_PATTERN = /^[0-9a-f]{40}$/
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/
const XCODE_BUILD_PATTERN = /^[0-9]{1,4}[A-Z][0-9]{1,4}[a-z]?$/
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/

export type NativeResolverTarget = (typeof NATIVE_RESOLVER_TARGETS)[number]
export type NativeTargetRecord<T> = Readonly<Record<NativeResolverTarget, T>>

export type NativeCompatibility =
  | {
      readonly deploymentLoadCommand: 'pass'
      readonly dynamicDependencies: readonly string[]
      readonly minimumProductVersion: string
      readonly os: 'darwin'
    }
  | {
      readonly dynamicDependencies: readonly []
      readonly interpreter: null
      readonly libc: 'none'
      readonly os: 'linux'
    }
  | {
      readonly dynamicDependencies: readonly string[]
      readonly interpreter: string
      readonly libc: 'glibc' | 'musl'
      readonly minimumVersion: string
      readonly os: 'linux'
    }

export interface NativeArtifactFile {
  readonly bytes: number
  readonly mode: '0644' | '0755'
  readonly path: string
  readonly role: 'executable' | 'resource'
  readonly sha256: string
}

export interface NativeArtifactProvenance {
  readonly archive: { readonly bytes: number; readonly file: string; readonly sha256: string }
  readonly checks: {
    readonly dependencies: 'pass'
    readonly noWrite: 'pass'
    readonly privacy: 'pass'
    readonly relocation: 'pass'
    readonly semantic: 'pass'
  }
  readonly compatibility: NativeCompatibility
  readonly files: readonly NativeArtifactFile[]
  readonly nativeBuildSourceHead: string
  readonly nativeInputsTreeSha256: string
  readonly runAttempt: number
  readonly runId: string
  readonly runner: {
    readonly arch: 'arm64' | 'x64'
    readonly image: string
    readonly imageVersion: string
    readonly os: 'darwin' | 'linux'
  }
  readonly schemaVersion: 1
  readonly sourceDateEpoch: number
  readonly sourceTree: 'clean'
  readonly target: NativeResolverTarget
  readonly toolchain: {
    readonly buildRecipeSha256: string
    readonly linker: NativeTool
    readonly sdk:
      | {
          readonly kind: 'macos'
          readonly sdkSettingsSha256: string
          readonly sdkVersion: string
          readonly xcodeBuild: string
          readonly xcodeVersion: string
        }
      | {
          readonly kind: 'linux'
          readonly sysrootName: string
          readonly sysrootSha256: string
          readonly sysrootVersion: string
        }
    readonly strip: NativeTool
    readonly zig: { readonly sha256: string; readonly version: '0.16.0' }
  }
  readonly upstreamRevision: typeof GHOSTTY_CONFIG_UPSTREAM_REVISION
  readonly upstreamTreeSha256: string
}

interface NativeTool {
  readonly name: string
  readonly sha256: string
  readonly version: string
}

export interface NativeManifestTarget {
  readonly assemblyProvenance: NativeArtifactProvenance
  readonly assemblyProvenanceSha256: string
  readonly compatibility: NativeCompatibility
  readonly executablePath: string
  readonly files: readonly NativeArtifactFile[]
  readonly resourcesRoot: string
  readonly totalBytes: number
}

export interface NativeResolverManifest {
  readonly ceilings: {
    readonly perTargetBytes: NativeTargetRecord<number>
    readonly totalPackageBytes: number
  }
  readonly nativeBuildSourceHead: string
  readonly nativeInputsTreeSha256: string
  readonly schemaVersion: 1
  readonly sourceDateEpoch: number
  readonly targets: NativeTargetRecord<NativeManifestTarget>
  readonly upstreamRevision: typeof GHOSTTY_CONFIG_UPSTREAM_REVISION
  readonly upstreamTreeSha256: string
}

export interface VerifiedResolverBundle {
  readonly compatibility: NativeCompatibility
  readonly cwd: string
  readonly executable: string
  readonly resources: string
  readonly target: NativeResolverTarget
}

export interface HostCompatibilityDependencies {
  readonly linuxLibc: () => { readonly family: 'glibc' | 'musl'; readonly version: string } | null
  readonly macosVersion: () => string | null
}

type JsonObject = Record<string, unknown>

export class ResolverManifestError extends Error {}

const DEFAULT_HOST_DEPENDENCIES: HostCompatibilityDependencies = {
  linuxLibc: detectLinuxLibc,
  macosVersion: detectMacosVersion,
}

export function selectResolverTarget(
  platform: string,
  architecture: string,
): NativeResolverTarget | null {
  const target = `${platform}-${architecture}`
  if (!NATIVE_RESOLVER_TARGETS.includes(target as NativeResolverTarget)) return null
  return target as NativeResolverTarget
}

export function hostSupportsCompatibility(
  compatibility: NativeCompatibility,
  dependencies: HostCompatibilityDependencies = DEFAULT_HOST_DEPENDENCIES,
): boolean {
  if (compatibility.os === 'darwin') {
    const actual = dependencies.macosVersion()
    if (!actual) return false
    return compareVersions(actual, compatibility.minimumProductVersion) >= 0
  }
  if (compatibility.libc === 'none') return true
  const actual = dependencies.linuxLibc()
  if (!actual || actual.family !== compatibility.libc) return false
  return compareVersions(actual.version, compatibility.minimumVersion) >= 0
}

export async function loadVerifiedResolverBundle(
  target: NativeResolverTarget,
  moduleUrl: string = import.meta.url,
): Promise<VerifiedResolverBundle> {
  const nativePath = fileURLToPath(new URL('../../native/config-resolver/', moduleUrl))
  const nativeRoot = await realpath(nativePath)
  const manifestPath = join(nativeRoot, 'manifest.json')
  const bytes = await readStableFile(manifestPath, MAXIMUM_MANIFEST_BYTES)
  const manifest = validateNativeResolverManifest(parseJson(bytes, 'native manifest'))
  if (!bytes.equals(canonicalObjectBytes(manifest))) fail('native manifest is not canonical')
  const selected = manifest.targets[target]
  const targetRoot = await verifyTargetFiles(nativeRoot, target, selected)
  return {
    compatibility: selected.compatibility,
    cwd: targetRoot,
    executable: join(targetRoot, ...selected.executablePath.split('/')),
    resources: join(targetRoot, ...selected.resourcesRoot.split('/')),
    target,
  }
}

export function validateNativeResolverManifest(value: unknown): NativeResolverManifest {
  const manifest = objectValue(value, 'native manifest')
  exactKeys(
    manifest,
    [
      'ceilings',
      'nativeBuildSourceHead',
      'nativeInputsTreeSha256',
      'schemaVersion',
      'sourceDateEpoch',
      'targets',
      'upstreamRevision',
      'upstreamTreeSha256',
    ],
    'native manifest',
  )
  if (manifest.schemaVersion !== 1) fail('native manifest schema version does not match')
  if (manifest.upstreamRevision !== GHOSTTY_CONFIG_UPSTREAM_REVISION) {
    fail('native manifest upstream revision does not match')
  }
  headValue(manifest.nativeBuildSourceHead, 'native build source head')
  hashValue(manifest.nativeInputsTreeSha256, 'native inputs tree')
  hashValue(manifest.upstreamTreeSha256, 'upstream tree')
  integerValue(manifest.sourceDateEpoch, 946_684_800, 4_102_444_800, 'source date epoch')
  validateCeilings(manifest.ceilings)
  const targets = objectValue(manifest.targets, 'native manifest targets')
  exactKeys(targets, NATIVE_RESOLVER_TARGETS, 'native manifest targets')
  let total = 0
  let matrixIdentity: NativeMatrixIdentity | null = null
  for (const target of NATIVE_RESOLVER_TARGETS) {
    const record = validateManifestTarget(targets[target], target, manifest)
    total = safeSum(total, record.totalBytes, 'combined native total')
    matrixIdentity = validateMatrixIdentity(record.assemblyProvenance, matrixIdentity, target)
  }
  if (total > APPROVED_TOTAL_PACKAGE_CEILING) fail('combined native total exceeds its ceiling')
  return manifest as unknown as NativeResolverManifest
}

interface NativeMatrixIdentity {
  readonly buildRecipeSha256: string
  readonly runAttempt: number
  readonly runId: string
}

function validateMatrixIdentity(
  provenance: NativeArtifactProvenance,
  expected: NativeMatrixIdentity | null,
  target: NativeResolverTarget,
): NativeMatrixIdentity {
  const actual = {
    buildRecipeSha256: provenance.toolchain.buildRecipeSha256,
    runAttempt: provenance.runAttempt,
    runId: provenance.runId,
  }
  if (!expected) return actual
  if (!isDeepStrictEqual(actual, expected)) fail(`${target} assembly run identity differs`)
  return expected
}

function validateCeilings(value: unknown): void {
  const ceilings = objectValue(value, 'native manifest ceilings')
  exactKeys(ceilings, ['perTargetBytes', 'totalPackageBytes'], 'native manifest ceilings')
  const perTarget = objectValue(ceilings.perTargetBytes, 'native target ceilings')
  exactKeys(perTarget, NATIVE_RESOLVER_TARGETS, 'native target ceilings')
  for (const target of NATIVE_RESOLVER_TARGETS) {
    if (perTarget[target] !== APPROVED_TARGET_CEILINGS[target]) {
      fail(`${target} ceiling does not match acceptance`)
    }
  }
  if (ceilings.totalPackageBytes !== APPROVED_TOTAL_PACKAGE_CEILING) {
    fail('total package ceiling does not match acceptance')
  }
}

function validateManifestTarget(
  value: unknown,
  target: NativeResolverTarget,
  manifest: JsonObject,
): NativeManifestTarget {
  const record = objectValue(value, `${target} manifest target`)
  exactKeys(
    record,
    [
      'assemblyProvenance',
      'assemblyProvenanceSha256',
      'compatibility',
      'executablePath',
      'files',
      'resourcesRoot',
      'totalBytes',
    ],
    `${target} manifest target`,
  )
  relativePathValue(record.executablePath, `${target} executablePath`)
  relativePathValue(record.resourcesRoot, `${target} resourcesRoot`)
  const files = validateArtifactFiles(record.files, target)
  validateTargetFileRoles(
    files,
    record.executablePath as string,
    record.resourcesRoot as string,
    target,
  )
  integerValue(record.totalBytes, 0, APPROVED_TARGET_CEILINGS[target], `${target} totalBytes`)
  const total = files.reduce((sum, file) => safeSum(sum, file.bytes, `${target} file total`), 0)
  if (record.totalBytes !== total) fail(`${target} totalBytes does not match its files`)
  const compatibility = validateCompatibility(record.compatibility, target)
  const provenance = validateNativeArtifactProvenance(record.assemblyProvenance, target)
  hashValue(record.assemblyProvenanceSha256, `${target} assembly provenance hash`)
  if (record.assemblyProvenanceSha256 !== canonicalObjectSha256(provenance)) {
    fail(`${target} assembly provenance hash does not match`)
  }
  if (!isDeepStrictEqual(files, provenance.files)) fail(`${target} files differ from provenance`)
  if (!isDeepStrictEqual(compatibility, provenance.compatibility)) {
    fail(`${target} compatibility differs from provenance`)
  }
  validateProvenanceManifestIdentity(provenance, manifest, target)
  return record as unknown as NativeManifestTarget
}

function validateProvenanceManifestIdentity(
  provenance: NativeArtifactProvenance,
  manifest: JsonObject,
  target: NativeResolverTarget,
): void {
  if (provenance.nativeBuildSourceHead !== manifest.nativeBuildSourceHead) {
    fail(`${target} native build source head differs from manifest`)
  }
  if (provenance.nativeInputsTreeSha256 !== manifest.nativeInputsTreeSha256) {
    fail(`${target} native inputs tree differs from manifest`)
  }
  if (provenance.sourceDateEpoch !== manifest.sourceDateEpoch) {
    fail(`${target} source epoch differs from manifest`)
  }
  if (provenance.upstreamTreeSha256 !== manifest.upstreamTreeSha256) {
    fail(`${target} upstream tree differs from manifest`)
  }
}

export function validateNativeArtifactProvenance(
  value: unknown,
  expectedTarget?: NativeResolverTarget,
): NativeArtifactProvenance {
  const record = objectValue(value, 'native artifact provenance')
  exactKeys(
    record,
    [
      'archive',
      'checks',
      'compatibility',
      'files',
      'nativeBuildSourceHead',
      'nativeInputsTreeSha256',
      'runAttempt',
      'runId',
      'runner',
      'schemaVersion',
      'sourceDateEpoch',
      'sourceTree',
      'target',
      'toolchain',
      'upstreamRevision',
      'upstreamTreeSha256',
    ],
    'native artifact provenance',
  )
  if (record.schemaVersion !== 1 || record.sourceTree !== 'clean') {
    fail('native artifact provenance identity does not match')
  }
  targetValue(record.target, 'native artifact provenance target')
  const target = record.target as NativeResolverTarget
  if (expectedTarget && target !== expectedTarget) fail('native artifact provenance target differs')
  if (record.upstreamRevision !== GHOSTTY_CONFIG_UPSTREAM_REVISION) {
    fail(`${target} upstream revision does not match`)
  }
  runIdValue(record.runId, `${target} runId`)
  integerValue(record.runAttempt, 1, 100, `${target} runAttempt`)
  headValue(record.nativeBuildSourceHead, `${target} nativeBuildSourceHead`)
  hashValue(record.nativeInputsTreeSha256, `${target} nativeInputsTreeSha256`)
  hashValue(record.upstreamTreeSha256, `${target} upstreamTreeSha256`)
  integerValue(record.sourceDateEpoch, 946_684_800, 4_102_444_800, `${target} sourceDateEpoch`)
  validateRunner(record.runner, target)
  validateToolchain(record.toolchain, target)
  validateArchive(record.archive, target)
  validateArtifactFiles(record.files, target)
  validateCompatibility(record.compatibility, target)
  validateChecks(record.checks, target)
  return record as unknown as NativeArtifactProvenance
}

function validateRunner(value: unknown, target: NativeResolverTarget): void {
  const runner = objectValue(value, `${target} runner`)
  exactKeys(runner, ['arch', 'image', 'imageVersion', 'os'], `${target} runner`)
  const os = target.startsWith('darwin-') ? 'darwin' : 'linux'
  const arch = target.endsWith('arm64') ? 'arm64' : 'x64'
  if (runner.os !== os || runner.arch !== arch) fail(`${target} runner identity does not match`)
  printableAscii(runner.image, `${target} runner image`)
  printableAscii(runner.imageVersion, `${target} runner imageVersion`)
}

function validateToolchain(value: unknown, target: NativeResolverTarget): void {
  const toolchain = objectValue(value, `${target} toolchain`)
  exactKeys(
    toolchain,
    ['buildRecipeSha256', 'linker', 'sdk', 'strip', 'zig'],
    `${target} toolchain`,
  )
  hashValue(toolchain.buildRecipeSha256, `${target} build recipe`)
  const zig = objectValue(toolchain.zig, `${target} Zig`)
  exactKeys(zig, ['sha256', 'version'], `${target} Zig`)
  if (zig.version !== '0.16.0') fail(`${target} Zig version does not match`)
  hashValue(zig.sha256, `${target} Zig hash`)
  validateNativeTool(toolchain.linker, `${target} linker`)
  validateNativeTool(toolchain.strip, `${target} strip`)
  validateSdk(toolchain.sdk, target)
}

function validateNativeTool(value: unknown, label: string): void {
  const tool = objectValue(value, label)
  exactKeys(tool, ['name', 'sha256', 'version'], label)
  printableAscii(tool.name, `${label} name`)
  printableAscii(tool.version, `${label} version`)
  hashValue(tool.sha256, `${label} hash`)
}

function validateSdk(value: unknown, target: NativeResolverTarget): void {
  const sdk = objectValue(value, `${target} SDK`)
  if (sdk.kind === 'macos') {
    exactKeys(
      sdk,
      ['kind', 'sdkSettingsSha256', 'sdkVersion', 'xcodeBuild', 'xcodeVersion'],
      `${target} SDK`,
    )
    if (!target.startsWith('darwin-')) fail(`${target} cannot use a macOS SDK`)
    versionValue(sdk.sdkVersion, `${target} SDK version`)
    versionValue(sdk.xcodeVersion, `${target} Xcode version`)
    patternValue(sdk.xcodeBuild, XCODE_BUILD_PATTERN, `${target} Xcode build`)
    hashValue(sdk.sdkSettingsSha256, `${target} SDK settings`)
    return
  }
  if (sdk.kind !== 'linux') fail(`${target} SDK kind is unsupported`)
  exactKeys(sdk, ['kind', 'sysrootName', 'sysrootSha256', 'sysrootVersion'], `${target} SDK`)
  if (!target.startsWith('linux-')) fail(`${target} cannot use a Linux sysroot`)
  printableAscii(sdk.sysrootName, `${target} sysroot name`)
  printableAscii(sdk.sysrootVersion, `${target} sysroot version`)
  hashValue(sdk.sysrootSha256, `${target} sysroot hash`)
}

function validateArchive(value: unknown, target: NativeResolverTarget): void {
  const archive = objectValue(value, `${target} archive`)
  exactKeys(archive, ['bytes', 'file', 'sha256'], `${target} archive`)
  if (archive.file !== `ghostty-config-resolver-${target}.tar`) {
    fail(`${target} archive file does not match`)
  }
  integerValue(
    archive.bytes,
    1,
    APPROVED_TARGET_CEILINGS[target] + 1_048_576,
    `${target} archive bytes`,
  )
  hashValue(archive.sha256, `${target} archive hash`)
}

function validateArtifactFiles(
  value: unknown,
  target: NativeResolverTarget,
): readonly NativeArtifactFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAXIMUM_FILES) {
    fail(`${target} files length is invalid`)
  }
  const paths = new Set<string>()
  let previous: string | null = null
  for (const [index, entry] of value.entries()) {
    const file = objectValue(entry, `${target} files[${index}]`)
    exactKeys(file, ['bytes', 'mode', 'path', 'role', 'sha256'], `${target} files[${index}]`)
    enumValue(file.role, ['executable', 'resource'], `${target} files[${index}] role`)
    enumValue(file.mode, ['0644', '0755'], `${target} files[${index}] mode`)
    if (file.role === 'executable' && file.mode !== '0755')
      fail(`${target} executable mode differs`)
    if (file.role === 'resource' && file.mode !== '0644') fail(`${target} resource mode differs`)
    relativePathValue(file.path, `${target} files[${index}] path`)
    integerValue(file.bytes, 0, APPROVED_TARGET_CEILINGS[target], `${target} files[${index}] bytes`)
    hashValue(file.sha256, `${target} files[${index}] hash`)
    const path = file.path as string
    if (paths.has(path) || (previous !== null && compareUtf8(previous, path) >= 0)) {
      fail(`${target} files are not sorted and unique`)
    }
    paths.add(path)
    previous = path
  }
  return value as unknown as readonly NativeArtifactFile[]
}

function validateTargetFileRoles(
  files: readonly NativeArtifactFile[],
  executablePath: string,
  resourcesRoot: string,
  target: NativeResolverTarget,
): void {
  const executable = files.filter((file) => file.role === 'executable')
  if (executable.length !== 1 || executable[0]?.path !== executablePath) {
    fail(`${target} executable record does not match`)
  }
  for (const file of files) {
    if (file.role !== 'resource') continue
    if (!file.path.startsWith(`${resourcesRoot}/`)) fail(`${target} resource escapes its root`)
  }
}

function validateCompatibility(value: unknown, target: NativeResolverTarget): NativeCompatibility {
  const compatibility = objectValue(value, `${target} compatibility`)
  if (compatibility.os === 'darwin') {
    exactKeys(
      compatibility,
      ['deploymentLoadCommand', 'dynamicDependencies', 'minimumProductVersion', 'os'],
      `${target} compatibility`,
    )
    if (!target.startsWith('darwin-') || compatibility.deploymentLoadCommand !== 'pass') {
      fail(`${target} Darwin compatibility does not match`)
    }
    versionValue(compatibility.minimumProductVersion, `${target} minimum product version`)
    stringList(compatibility.dynamicDependencies, `${target} dynamic dependencies`)
    return compatibility as unknown as NativeCompatibility
  }
  if (compatibility.os !== 'linux' || !target.startsWith('linux-')) {
    fail(`${target} compatibility OS does not match`)
  }
  if (compatibility.libc === 'none') {
    exactKeys(
      compatibility,
      ['dynamicDependencies', 'interpreter', 'libc', 'os'],
      `${target} compatibility`,
    )
    if (compatibility.interpreter !== null) fail(`${target} static interpreter is not null`)
    if (
      !Array.isArray(compatibility.dynamicDependencies) ||
      compatibility.dynamicDependencies.length !== 0
    ) {
      fail(`${target} static dependencies are not empty`)
    }
    return compatibility as unknown as NativeCompatibility
  }
  exactKeys(
    compatibility,
    ['dynamicDependencies', 'interpreter', 'libc', 'minimumVersion', 'os'],
    `${target} compatibility`,
  )
  enumValue(compatibility.libc, ['glibc', 'musl'], `${target} libc`)
  printableAscii(compatibility.interpreter, `${target} interpreter`)
  versionValue(compatibility.minimumVersion, `${target} minimum libc version`)
  stringList(compatibility.dynamicDependencies, `${target} dynamic dependencies`)
  return compatibility as unknown as NativeCompatibility
}

function validateChecks(value: unknown, target: NativeResolverTarget): void {
  const checks = objectValue(value, `${target} checks`)
  exactKeys(
    checks,
    ['dependencies', 'noWrite', 'privacy', 'relocation', 'semantic'],
    `${target} checks`,
  )
  for (const value of Object.values(checks)) {
    if (value !== 'pass') fail(`${target} check is not pass`)
  }
}

async function verifyTargetFiles(
  nativeRoot: string,
  target: NativeResolverTarget,
  manifest: NativeManifestTarget,
): Promise<string> {
  const targetRoot = join(nativeRoot, target)
  const targetStats = await lstat(targetRoot)
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    fail(`${target} root is not a regular directory`)
  }
  const root = await realpath(targetRoot)
  if (!isContained(nativeRoot, root)) fail(`${target} root escapes native package`)
  const actual = await collectRegularFiles(root)
  const expected = new Map(manifest.files.map((file) => [file.path, file]))
  if (actual.length !== expected.size) fail(`${target} packaged file count does not match`)
  for (const path of actual) {
    const file = expected.get(path)
    if (!file) fail(`${target} has an unexpected packaged file`)
    await verifyPackagedFile(root, path, file, target)
  }
  return root
}

async function collectRegularFiles(root: string): Promise<readonly string[]> {
  const files: string[] = []
  await walkDirectory(root, '', files)
  return files.sort(compareUtf8)
}

async function walkDirectory(root: string, parent: string, files: string[]): Promise<void> {
  const directory = parent ? join(root, ...parent.split('/')) : root
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => compareUtf8(left.name, right.name))
  for (const entry of entries) {
    const path = parent ? `${parent}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) fail('native package contains a symlink')
    if (entry.isFile()) {
      files.push(path)
      continue
    }
    if (!entry.isDirectory()) fail('native package contains a special file')
    await walkDirectory(root, path, files)
  }
}

async function verifyPackagedFile(
  root: string,
  path: string,
  expected: NativeArtifactFile,
  target: NativeResolverTarget,
): Promise<void> {
  const absolute = join(root, ...path.split('/'))
  const resolved = await realpath(absolute)
  if (!isContained(root, resolved)) fail(`${target} packaged file escapes its root`)
  const identity = await stableFileIdentity(absolute, APPROVED_TARGET_CEILINGS[target])
  const mode = (identity.stats.mode & 0o777).toString(8).padStart(4, '0')
  if (mode !== expected.mode) fail(`${target} packaged file mode does not match`)
  if (identity.bytes !== expected.bytes || identity.sha256 !== expected.sha256) {
    fail(`${target} packaged file identity does not match`)
  }
}

async function readStableFile(path: string, maximum: number): Promise<Buffer> {
  const identity = await stableFileIdentity(path, maximum)
  if (identity.bytes < 1) fail('stable file is empty')
  return identity.content
}

async function stableFileIdentity(
  path: string,
  maximum: number,
): Promise<{
  readonly bytes: number
  readonly content: Buffer
  readonly sha256: string
  readonly stats: Stats
}> {
  const beforeLink = await lstat(path)
  if (!beforeLink.isFile() || beforeLink.isSymbolicLink()) fail('stable path is not a regular file')
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size < 0 || before.size > maximum)
      fail('stable file size is invalid')
    const content = await handle.readFile()
    const after = await handle.stat()
    assertStableStats(before, after, content.length)
    return {
      bytes: content.length,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
      stats: after,
    }
  } finally {
    await handle.close()
  }
}

function assertStableStats(before: Stats, after: Stats, bytes: number): void {
  if (before.size !== bytes || after.size !== bytes) fail('stable file changed while reading')
  if (before.dev !== after.dev || before.ino !== after.ino) fail('stable file identity changed')
  if (before.mode !== after.mode || before.mtimeMs !== after.mtimeMs) {
    fail('stable file metadata changed')
  }
}

function detectMacosVersion(): string | null {
  const result = spawnSync('/usr/bin/sw_vers', ['-productVersion'], {
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C' },
    maxBuffer: 1_024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 500,
  })
  if (result.status !== 0) return null
  return normalizeVersion(result.stdout)
}

function detectLinuxLibc(): { readonly family: 'glibc' | 'musl'; readonly version: string } | null {
  const report = process.report?.getReport() as
    | { readonly header?: { readonly glibcVersionRuntime?: unknown } }
    | undefined
  const version = report?.header?.glibcVersionRuntime
  if (typeof version !== 'string') return null
  const normalized = normalizeVersion(version)
  if (!normalized) return null
  return { family: 'glibc', version: normalized }
}

function normalizeVersion(value: string): string | null {
  const match = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})(?:\.(0|[1-9][0-9]{0,4}))?$/.exec(
    value.trim(),
  )
  if (!match) return null
  const parts = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
  if (parts.some((part) => part > 65_535)) return null
  return parts.join('.')
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  if (!leftParts || !rightParts) return -1
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!
    if (difference !== 0) return difference
  }
  return 0
}

function versionParts(value: string): readonly [number, number, number] | null {
  const normalized = normalizeVersion(value)
  if (!normalized) return null
  const parts = normalized.split('.').map(Number)
  return [parts[0]!, parts[1]!, parts[2]!]
}

function versionValue(value: unknown, label: string): void {
  if (typeof value !== 'string' || normalizeVersion(value) === null) {
    fail(`${label} is not a canonical version`)
  }
}

function stringList(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length > 64) fail(`${label} length is invalid`)
  let previous: string | null = null
  for (const entry of value) {
    printableAscii(entry, label)
    if (previous !== null && compareUtf8(previous, entry as string) >= 0) {
      fail(`${label} is not sorted and unique`)
    }
    previous = entry as string
  }
}

function relativePathValue(value: unknown, label: string): void {
  if (typeof value !== 'string') fail(`${label} is not a string`)
  if (Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > MAXIMUM_PATH_BYTES) {
    fail(`${label} length is invalid`)
  }
  if (value.includes('\\') || isAbsolute(value) || posix.normalize(value) !== value) {
    fail(`${label} is not a normalized relative POSIX path`)
  }
  if (value.includes('\0')) fail(`${label} contains NUL`)
  const components = value.split('/')
  if (components.some((component) => !component || component === '.' || component === '..')) {
    fail(`${label} has an invalid component`)
  }
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} is not a JSON object`)
  return value as JsonObject
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (!isDeepStrictEqual(actual, sortedExpected)) fail(`${label} keys do not match`)
}

function integerValue(value: unknown, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(`${label} is outside its bound`)
  }
}

function printableAscii(value: unknown, label: string): void {
  if (typeof value !== 'string') fail(`${label} is not a string`)
  const bytes = Buffer.byteLength(value)
  if (bytes < 1 || bytes > MAXIMUM_STRING_BYTES || !PRINTABLE_ASCII_PATTERN.test(value)) {
    fail(`${label} is not bounded printable ASCII`)
  }
}

function hashValue(value: unknown, label: string): void {
  patternValue(value, HASH_PATTERN, label)
}

function headValue(value: unknown, label: string): void {
  patternValue(value, HEAD_PATTERN, label)
}

function runIdValue(value: unknown, label: string): void {
  patternValue(value, RUN_ID_PATTERN, label)
}

function targetValue(value: unknown, label: string): void {
  if (
    typeof value !== 'string' ||
    !NATIVE_RESOLVER_TARGETS.includes(value as NativeResolverTarget)
  ) {
    fail(`${label} is unsupported`)
  }
}

function enumValue(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(`${label} is unsupported`)
}

function patternValue(value: unknown, pattern: RegExp, label: string): void {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} does not match`)
}

function parseJson(bytes: Buffer, label: string): unknown {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail(`${label} is not UTF-8`)
  }
  try {
    return JSON.parse(text)
  } catch {
    fail(`${label} is not JSON`)
  }
}

function safeSum(left: number, right: number, label: string): number {
  const total = left + right
  if (!Number.isSafeInteger(total)) fail(`${label} is outside its bound`)
  return total
}

function isContained(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path))
  if (!child) return true
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function fail(message: string): never {
  throw new ResolverManifestError(message)
}
