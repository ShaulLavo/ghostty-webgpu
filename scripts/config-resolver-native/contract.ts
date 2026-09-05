import { Buffer } from 'node:buffer'
import { compareBytes } from './order'
import {
  NATIVE_EXECUTABLE_PATH,
  NATIVE_MAX_ARCHIVE_OVERHEAD,
  NATIVE_PACKAGE_VERSION,
  NATIVE_PROOF_RECIPE_SHA256,
  NATIVE_RESOURCES_ROOT,
  NATIVE_SCHEMA_VERSION,
  NATIVE_SOURCE_DATE_EPOCH,
  NATIVE_TARGET_CEILINGS,
  NATIVE_TARGET_CONFIG,
  NATIVE_TARGETS,
  NATIVE_TOTAL_CEILING,
  NATIVE_UPSTREAM_REPOSITORY,
  NATIVE_UPSTREAM_REVISION,
  NATIVE_UPSTREAM_TREE_SHA256,
  NATIVE_ZIG_VERSION,
  type NativeTarget,
} from './constants'
import { loadCanonicalJson, NativeContractError } from './canonical'
import { validateLinkPlan } from './link-plan'

export type { NativeTarget } from './constants'

export type NativeCompatibility =
  | {
      readonly os: 'darwin'
      readonly minimumProductVersion: string
      readonly deploymentLoadCommand: 'pass'
      readonly dynamicDependencies: readonly string[]
    }
  | {
      readonly os: 'linux'
      readonly libc: 'none'
      readonly interpreter: null
      readonly dynamicDependencies: readonly []
    }
  | {
      readonly os: 'linux'
      readonly libc: 'glibc' | 'musl'
      readonly minimumVersion: string
      readonly interpreter: string
      readonly dynamicDependencies: readonly string[]
    }

export type NativeArtifactFile = {
  readonly role: 'executable' | 'resource'
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly mode: '0644' | '0755'
}

export type NativeRunner = {
  readonly os: 'darwin' | 'linux'
  readonly arch: 'arm64' | 'x64'
  readonly image: string
  readonly imageVersion: string
}

export type NativeTool = {
  readonly name: string
  readonly version: string
  readonly sha256: string
}

export type NativeToolchain = {
  readonly zig: { readonly version: '0.16.0'; readonly sha256: string }
  readonly linker: NativeTool
  readonly strip: NativeTool
  readonly sdk:
    | {
        readonly kind: 'macos'
        readonly xcodeVersion: string
        readonly xcodeBuild: string
        readonly sdkVersion: string
        readonly sdkSettingsSha256: string
      }
    | {
        readonly kind: 'linux'
        readonly sysrootName: string
        readonly sysrootVersion: string
        readonly sysrootSha256: string
      }
  readonly buildRecipeSha256: string
}

export type NativeArtifactProvenance = {
  readonly schemaVersion: 1
  readonly runId: string
  readonly runAttempt: number
  readonly nativeBuildSourceHead: string
  readonly nativeInputsTreeSha256: string
  readonly sourceTree: 'clean'
  readonly sourceDateEpoch: number
  readonly target: NativeTarget
  readonly upstreamRevision: typeof NATIVE_UPSTREAM_REVISION
  readonly upstreamTreeSha256: string
  readonly runner: NativeRunner
  readonly toolchain: NativeToolchain
  readonly archive: { readonly file: string; readonly sha256: string; readonly bytes: number }
  readonly files: readonly NativeArtifactFile[]
  readonly compatibility: NativeCompatibility
  readonly checks: {
    readonly semantic: 'pass'
    readonly noWrite: 'pass'
    readonly privacy: 'pass'
    readonly relocation: 'pass'
    readonly dependencies: 'pass'
  }
}

export type NativeManifestTarget = {
  readonly executablePath: string
  readonly resourcesRoot: string
  readonly totalBytes: number
  readonly files: readonly NativeArtifactFile[]
  readonly compatibility: NativeCompatibility
  readonly assemblyProvenance: NativeArtifactProvenance
  readonly assemblyProvenanceSha256: string
}

export type NativeResolverManifest = {
  readonly schemaVersion: 1
  readonly upstreamRevision: typeof NATIVE_UPSTREAM_REVISION
  readonly upstreamTreeSha256: string
  readonly nativeBuildSourceHead: string
  readonly nativeInputsTreeSha256: string
  readonly sourceDateEpoch: number
  readonly ceilings: {
    readonly perTargetBytes: Readonly<Record<NativeTarget, number>>
    readonly totalPackageBytes: number
  }
  readonly targets: Readonly<Record<NativeTarget, NativeManifestTarget>>
}

export type NativeAcquisition =
  | {
      readonly kind: 'official-download'
      readonly url: string
      readonly archiveBytes: number
      readonly archiveSha256: string
    }
  | {
      readonly kind: 'git'
      readonly repository: string
      readonly revision: string
      readonly treeAlgorithm: 'ghostty-upstream-tree-v1'
      readonly treeSha256: string
    }
  | {
      readonly kind: 'runner-component'
      readonly runnerImage: string
      readonly runnerImageVersion: string
      readonly path: string
      readonly contentKind: 'file' | 'external-tree-v1'
      readonly macosSdk?: {
        readonly xcodeVersion: string
        readonly xcodeBuild: string
        readonly sdkVersion: string
        readonly sdkBuild: string
        readonly sdkSettingsSha256: string
      }
    }

export type NativeGeneration = {
  readonly sources: readonly string[]
  readonly argv: readonly string[]
}

export type NativeToolRecord = {
  readonly role: 'zig' | 'linker' | 'strip' | 'sdk-or-sysroot'
  readonly name: string
  readonly version: string
  readonly bytes: number
  readonly sha256: string
  readonly acquisition: NativeAcquisition
  readonly generation?: NativeGeneration
}

export type NativeExternalInputRecord = {
  readonly role:
    | 'upstream-submodule'
    | 'dependency-archive'
    | 'generated-resource-source'
    | 'runtime-resource'
  readonly id: string
  readonly bytes: number
  readonly sha256: string
  readonly acquisition: NativeAcquisition
  readonly generation?: NativeGeneration
}

export type NativeTargetRecipe = {
  readonly runner: NativeRunner
  readonly targetTriple: string
  readonly optimizationMode: 'ReleaseSafe'
  readonly buildArgv: readonly string[]
  readonly linkPlan: readonly string[]
  readonly stripArgv: readonly string[]
  readonly environment: readonly { readonly name: string; readonly value: string }[]
  readonly tools: readonly NativeToolRecord[]
  readonly inputs: readonly NativeExternalInputRecord[]
}

export type NativeBuildRecipe = {
  readonly schemaVersion: 2
  readonly proofRecipeSha256: typeof NATIVE_PROOF_RECIPE_SHA256
  readonly sourceDateEpoch: number
  readonly upstream: {
    readonly repository: typeof NATIVE_UPSTREAM_REPOSITORY
    readonly revision: typeof NATIVE_UPSTREAM_REVISION
    readonly treeSha256: typeof NATIVE_UPSTREAM_TREE_SHA256
  }
  readonly zigVersion: typeof NATIVE_ZIG_VERSION
  readonly targets: Readonly<Record<NativeTarget, NativeTargetRecipe>>
}

export type NativeOwnedFile = {
  readonly path: string
  readonly mode: '100644' | '100755'
  readonly bytes: number
  readonly sha256: string
}

export type NativeInputs = {
  readonly schemaVersion: 1
  readonly upstream: {
    readonly repository: typeof NATIVE_UPSTREAM_REPOSITORY
    readonly revision: typeof NATIVE_UPSTREAM_REVISION
    readonly treeSha256: typeof NATIVE_UPSTREAM_TREE_SHA256
  }
  readonly proofRecipeSha256: typeof NATIVE_PROOF_RECIPE_SHA256
  readonly buildRecipeSha256: string
  readonly ownedFiles: readonly NativeOwnedFile[]
  readonly targets: Readonly<
    Record<
      NativeTarget,
      {
        readonly tools: readonly NativeToolRecord[]
        readonly inputs: readonly NativeExternalInputRecord[]
      }
    >
  >
}

export type NativeBootstrap = {
  readonly schemaVersion: 1
  readonly packageVersion: typeof NATIVE_PACKAGE_VERSION
  readonly upstreamRevision: typeof NATIVE_UPSTREAM_REVISION
  readonly targets: readonly NativeTarget[]
  readonly nativeInputsTreeSha256: string
}

export function loadBuildRecipe(path: string): {
  readonly value: NativeBuildRecipe
  readonly bytes: Buffer
  readonly sha256: string
} {
  const loaded = loadCanonicalJson(path)
  return { ...loaded, value: validateNativeBuildRecipe(loaded.value) }
}

export function loadNativeInputs(path: string): {
  readonly value: NativeInputs
  readonly bytes: Buffer
  readonly sha256: string
} {
  const loaded = loadCanonicalJson(path)
  return { ...loaded, value: validateNativeInputs(loaded.value) }
}

export function loadNativeBootstrap(path: string): {
  readonly value: NativeBootstrap
  readonly bytes: Buffer
  readonly sha256: string
} {
  const loaded = loadCanonicalJson(path, 16 * 1024)
  return { ...loaded, value: validateNativeBootstrap(loaded.value) }
}

export function loadNativeProvenance(path: string): {
  readonly value: NativeArtifactProvenance
  readonly bytes: Buffer
  readonly sha256: string
} {
  const loaded = loadCanonicalJson(path, 4 * 1024 * 1024)
  return { ...loaded, value: validateNativeArtifactProvenance(loaded.value) }
}

export function loadNativeManifest(path: string): {
  readonly value: NativeResolverManifest
  readonly bytes: Buffer
  readonly sha256: string
} {
  const loaded = loadCanonicalJson(path, 8 * 1024 * 1024)
  return { ...loaded, value: validateNativeResolverManifest(loaded.value) }
}

export function validateNativeBootstrap(value: unknown): NativeBootstrap {
  const record = strictRecord(value, 'bootstrap', [
    'schemaVersion',
    'packageVersion',
    'upstreamRevision',
    'targets',
    'nativeInputsTreeSha256',
  ])
  exactInteger(record.schemaVersion, NATIVE_SCHEMA_VERSION, 'bootstrap schemaVersion')
  exactString(record.packageVersion, NATIVE_PACKAGE_VERSION, 'bootstrap packageVersion')
  exactString(record.upstreamRevision, NATIVE_UPSTREAM_REVISION, 'bootstrap upstreamRevision')
  assertExactTargets(record.targets, 'bootstrap targets')
  hash(record.nativeInputsTreeSha256, 'bootstrap nativeInputsTreeSha256')
  return record as NativeBootstrap
}

export function validateNativeBuildRecipe(value: unknown): NativeBuildRecipe {
  const record = strictRecord(value, 'build recipe', [
    'schemaVersion',
    'proofRecipeSha256',
    'sourceDateEpoch',
    'upstream',
    'zigVersion',
    'targets',
  ])
  exactInteger(record.schemaVersion, 2, 'build recipe schemaVersion')
  exactString(record.proofRecipeSha256, NATIVE_PROOF_RECIPE_SHA256, 'proof recipe hash')
  exactInteger(record.sourceDateEpoch, NATIVE_SOURCE_DATE_EPOCH, 'sourceDateEpoch')
  validateUpstream(record.upstream, 'build recipe upstream')
  exactString(record.zigVersion, NATIVE_ZIG_VERSION, 'build recipe Zig version')
  const targets = targetRecord(record.targets, 'build recipe targets')
  for (const target of NATIVE_TARGETS) validateTargetRecipe(targets[target], target)
  return record as NativeBuildRecipe
}

export function validateNativeInputs(value: unknown): NativeInputs {
  const record = strictRecord(value, 'native inputs', [
    'schemaVersion',
    'upstream',
    'proofRecipeSha256',
    'buildRecipeSha256',
    'ownedFiles',
    'targets',
  ])
  exactInteger(record.schemaVersion, 1, 'native inputs schemaVersion')
  validateUpstream(record.upstream, 'native inputs upstream')
  exactString(record.proofRecipeSha256, NATIVE_PROOF_RECIPE_SHA256, 'proof recipe hash')
  hash(record.buildRecipeSha256, 'build recipe hash')
  validateOwnedFiles(record.ownedFiles)
  const targets = targetRecord(record.targets, 'native input targets')
  for (const target of NATIVE_TARGETS) {
    const targetRecordValue = strictRecord(targets[target], `${target} native inputs`, [
      'tools',
      'inputs',
    ])
    validateTools(targetRecordValue.tools, target)
    validateExternalInputs(targetRecordValue.inputs, target)
  }
  return record as NativeInputs
}

export function validateNativeArtifactProvenance(value: unknown): NativeArtifactProvenance {
  const record = strictRecord(value, 'native provenance', [
    'schemaVersion',
    'runId',
    'runAttempt',
    'nativeBuildSourceHead',
    'nativeInputsTreeSha256',
    'sourceTree',
    'sourceDateEpoch',
    'target',
    'upstreamRevision',
    'upstreamTreeSha256',
    'runner',
    'toolchain',
    'archive',
    'files',
    'compatibility',
    'checks',
  ])
  exactInteger(record.schemaVersion, 1, 'provenance schemaVersion')
  runId(record.runId)
  integerRange(record.runAttempt, 1, 100, 'runAttempt')
  revision(record.nativeBuildSourceHead, 'nativeBuildSourceHead')
  hash(record.nativeInputsTreeSha256, 'nativeInputsTreeSha256')
  exactString(record.sourceTree, 'clean', 'sourceTree')
  exactInteger(record.sourceDateEpoch, NATIVE_SOURCE_DATE_EPOCH, 'sourceDateEpoch')
  const target = nativeTarget(record.target, 'provenance target')
  exactString(record.upstreamRevision, NATIVE_UPSTREAM_REVISION, 'upstreamRevision')
  exactString(record.upstreamTreeSha256, NATIVE_UPSTREAM_TREE_SHA256, 'upstreamTreeSha256')
  validateRunner(record.runner, target)
  validateToolchain(record.toolchain, target)
  validateArchive(record.archive, target)
  validateArtifactFiles(record.files, target)
  validateCompatibility(record.compatibility, target)
  validateChecks(record.checks)
  return record as NativeArtifactProvenance
}

export function validateNativeResolverManifest(value: unknown): NativeResolverManifest {
  const record = strictRecord(value, 'native manifest', [
    'schemaVersion',
    'upstreamRevision',
    'upstreamTreeSha256',
    'nativeBuildSourceHead',
    'nativeInputsTreeSha256',
    'sourceDateEpoch',
    'ceilings',
    'targets',
  ])
  exactInteger(record.schemaVersion, 1, 'manifest schemaVersion')
  exactString(record.upstreamRevision, NATIVE_UPSTREAM_REVISION, 'manifest upstreamRevision')
  exactString(record.upstreamTreeSha256, NATIVE_UPSTREAM_TREE_SHA256, 'manifest upstream tree')
  revision(record.nativeBuildSourceHead, 'manifest nativeBuildSourceHead')
  hash(record.nativeInputsTreeSha256, 'manifest nativeInputsTreeSha256')
  exactInteger(record.sourceDateEpoch, NATIVE_SOURCE_DATE_EPOCH, 'manifest sourceDateEpoch')
  validateCeilings(record.ceilings)
  const targets = targetRecord(record.targets, 'manifest targets')
  let combined = 0
  for (const target of NATIVE_TARGETS) {
    const entry = validateManifestTarget(targets[target], target)
    combined += entry.totalBytes
    if (entry.assemblyProvenance.nativeBuildSourceHead !== record.nativeBuildSourceHead) {
      fail(`${target} provenance source head differs from manifest`)
    }
    if (entry.assemblyProvenance.nativeInputsTreeSha256 !== record.nativeInputsTreeSha256) {
      fail(`${target} provenance native inputs differ from manifest`)
    }
  }
  if (combined > NATIVE_TOTAL_CEILING) fail('manifest combined total exceeds its ceiling')
  return record as NativeResolverManifest
}

function validateManifestTarget(value: unknown, target: NativeTarget): NativeManifestTarget {
  const record = strictRecord(value, `${target} manifest target`, [
    'executablePath',
    'resourcesRoot',
    'totalBytes',
    'files',
    'compatibility',
    'assemblyProvenance',
    'assemblyProvenanceSha256',
  ])
  exactString(record.executablePath, NATIVE_EXECUTABLE_PATH, `${target} executablePath`)
  exactString(record.resourcesRoot, NATIVE_RESOURCES_ROOT, `${target} resourcesRoot`)
  const files = validateArtifactFiles(record.files, target)
  const totalBytes = integerRange(
    record.totalBytes,
    0,
    NATIVE_TARGET_CEILINGS[target],
    'totalBytes',
  )
  if (totalBytes !== files.reduce((sum, file) => sum + file.bytes, 0)) {
    fail(`${target} manifest total does not equal file bytes`)
  }
  const compatibility = validateCompatibility(record.compatibility, target)
  const provenance = validateNativeArtifactProvenance(record.assemblyProvenance)
  if (provenance.target !== target) fail(`${target} embeds provenance for another target`)
  if (JSON.stringify(files) !== JSON.stringify(provenance.files)) {
    fail(`${target} manifest files are not a provenance projection`)
  }
  if (JSON.stringify(compatibility) !== JSON.stringify(provenance.compatibility)) {
    fail(`${target} compatibility is not a provenance projection`)
  }
  hash(record.assemblyProvenanceSha256, `${target} assemblyProvenanceSha256`)
  return record as NativeManifestTarget
}

function validateTargetRecipe(value: unknown, target: NativeTarget): void {
  const record = strictRecord(value, `${target} recipe`, [
    'runner',
    'targetTriple',
    'optimizationMode',
    'buildArgv',
    'linkPlan',
    'stripArgv',
    'environment',
    'tools',
    'inputs',
  ])
  validateRunner(record.runner, target)
  exactString(record.targetTriple, NATIVE_TARGET_CONFIG[target].targetTriple, `${target} triple`)
  exactString(record.optimizationMode, 'ReleaseSafe', `${target} optimization`)
  validateTokenArgv(record.buildArgv, `${target} buildArgv`)
  const linkPlan = stringArray(record.linkPlan, 1, 4096, `${target} linkPlan`)
  for (const argument of linkPlan) validateTokens(argument, `${target} linkPlan`)
  validateLinkPlan(linkPlan, '$WORK')
  validateTokenArgv(record.stripArgv, `${target} stripArgv`)
  validateExpectedStripArgv(record.stripArgv, target)
  validateEnvironment(record.environment, target)
  validateTools(record.tools, target)
  validateExternalInputs(record.inputs, target)
}

function validateExpectedStripArgv(value: unknown, target: NativeTarget): void {
  const expected = target.startsWith('darwin-')
    ? ['/usr/bin/strip', '-x', '-no_uuid', '$OUTPUT/bin/ghostty-config-resolver']
    : ['/usr/bin/strip', '--strip-all', '$OUTPUT/bin/ghostty-config-resolver']
  const actual = stringArray(value, expected.length, expected.length, `${target} stripArgv`)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${target} stripArgv is not exact`)
}

function validateEnvironment(value: unknown, target: NativeTarget): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    fail(`${target} environment has an invalid count`)
  }
  const names: string[] = []
  for (const item of value) {
    const record = strictRecord(item, `${target} environment row`, ['name', 'value'])
    const name = ascii(record.name, `${target} environment name`, 1, 128)
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) fail(`${target} environment name is invalid`)
    printable(record.value, `${target} environment value`, 0, 4096)
    validateTokens(record.value as string, `${target} environment value`)
    names.push(name)
  }
  assertSortedUnique(names, `${target} environment names`)
}

function validateTools(value: unknown, target: NativeTarget): void {
  if (!Array.isArray(value) || value.length !== 4) fail(`${target} tools must contain four rows`)
  const roles: string[] = []
  for (const item of value) {
    const record = flexibleGenerationRecord(item, `${target} tool`)
    if (!['zig', 'linker', 'strip', 'sdk-or-sysroot'].includes(String(record.role))) {
      fail(`${target} tool role is invalid`)
    }
    roles.push(String(record.role))
    ascii(record.name, `${target} tool name`, 1, 128)
    printable(record.version, `${target} tool version`, 1, 256)
    integerRange(record.bytes, 1, Number.MAX_SAFE_INTEGER, `${target} tool bytes`)
    hash(record.sha256, `${target} tool sha256`)
    validateAcquisition(record.acquisition, `${target} tool acquisition`)
    if (record.generation !== undefined) validateGeneration(record.generation, `${target} tool`)
  }
  const expected = ['linker', 'sdk-or-sysroot', 'strip', 'zig']
  if (JSON.stringify(roles) !== JSON.stringify(expected)) {
    fail(`${target} tool roles are not exact, sorted, and unique`)
  }
}

function validateExternalInputs(value: unknown, target: NativeTarget): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4096) {
    fail(`${target} external inputs have an invalid count`)
  }
  const order: string[] = []
  for (const item of value) {
    const record = flexibleGenerationRecord(item, `${target} external input`)
    const role = String(record.role)
    if (
      ![
        'upstream-submodule',
        'dependency-archive',
        'generated-resource-source',
        'runtime-resource',
      ].includes(role)
    ) {
      fail(`${target} external input role is invalid`)
    }
    const id = recordId(record.id, `${target} input id`)
    integerRange(record.bytes, 0, Number.MAX_SAFE_INTEGER, `${target} input bytes`)
    hash(record.sha256, `${target} input sha256`)
    validateAcquisition(record.acquisition, `${target} input acquisition`)
    if (record.generation !== undefined) validateGeneration(record.generation, `${target} input`)
    order.push(`${role}\0${id}`)
  }
  assertSortedUnique(order, `${target} external inputs`)
}

function flexibleGenerationRecord(value: unknown, label: string): Record<string, unknown> {
  const base = strictRecordValue(value, label)
  const expected = ['acquisition', 'bytes', 'role', 'sha256']
  if ('name' in base) expected.push('name', 'version')
  if ('id' in base) expected.push('id')
  if ('generation' in base) expected.push('generation')
  assertExactKeys(base, expected, label)
  if (!('name' in base) && !('id' in base)) fail(`${label} has no stable identifier`)
  return base
}

function validateAcquisition(value: unknown, label: string): void {
  const record = strictRecordValue(value, label)
  const kind = record.kind
  if (kind === 'official-download') {
    assertExactKeys(record, ['kind', 'url', 'archiveBytes', 'archiveSha256'], label)
    httpsUrl(record.url, `${label} URL`)
    integerRange(record.archiveBytes, 1, Number.MAX_SAFE_INTEGER, `${label} archive bytes`)
    hash(record.archiveSha256, `${label} archive hash`)
    return
  }
  if (kind === 'git') {
    assertExactKeys(
      record,
      ['kind', 'repository', 'revision', 'treeAlgorithm', 'treeSha256'],
      label,
    )
    httpsUrl(record.repository, `${label} repository`)
    revision(record.revision, `${label} revision`)
    exactString(record.treeAlgorithm, 'ghostty-upstream-tree-v1', `${label} tree algorithm`)
    hash(record.treeSha256, `${label} tree hash`)
    return
  }
  if (kind !== 'runner-component') fail(`${label} kind is invalid`)
  const keys = ['kind', 'runnerImage', 'runnerImageVersion', 'path', 'contentKind']
  if ('macosSdk' in record) keys.push('macosSdk')
  assertExactKeys(record, keys, label)
  printable(record.runnerImage, `${label} runner image`, 1, 256)
  printable(record.runnerImageVersion, `${label} image version`, 1, 256)
  absolutePosixPath(record.path, `${label} component path`)
  if (record.contentKind !== 'file' && record.contentKind !== 'external-tree-v1') {
    fail(`${label} content kind is invalid`)
  }
  if (record.macosSdk !== undefined) validateMacosSdk(record.macosSdk, `${label} macOS SDK`)
}

function validateMacosSdk(value: unknown, label: string): void {
  const record = strictRecord(value, label, [
    'xcodeVersion',
    'xcodeBuild',
    'sdkVersion',
    'sdkBuild',
    'sdkSettingsSha256',
  ])
  printable(record.xcodeVersion, `${label} Xcode version`, 1, 256)
  xcodeBuild(record.xcodeBuild, `${label} Xcode build`)
  dottedVersion(record.sdkVersion, `${label} SDK version`)
  printable(record.sdkBuild, `${label} SDK build`, 1, 256)
  hash(record.sdkSettingsSha256, `${label} settings hash`)
}

function validateGeneration(value: unknown, label: string): void {
  const record = strictRecord(value, `${label} generation`, ['sources', 'argv'])
  const sources = stringArray(record.sources, 1, 4096, `${label} generation sources`)
  assertSortedUnique(sources, `${label} generation sources`)
  for (const source of sources) {
    if (!/^(?:input|tool):[a-z0-9][a-z0-9._-]{0,127}$/.test(source)) {
      fail(`${label} generation source is invalid`)
    }
  }
  validateTokenArgv(record.argv, `${label} generation argv`)
}

function validateOwnedFiles(value: unknown): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4096) {
    fail('ownedFiles has an invalid count')
  }
  const paths: string[] = []
  for (const item of value) {
    const record = strictRecord(item, 'owned file', ['path', 'mode', 'bytes', 'sha256'])
    const path = relativePath(record.path, 'owned file path')
    if (record.mode !== '100644' && record.mode !== '100755') fail('owned file mode is invalid')
    integerRange(record.bytes, 0, Number.MAX_SAFE_INTEGER, 'owned file bytes')
    hash(record.sha256, 'owned file sha256')
    paths.push(path)
  }
  assertSortedUnique(paths, 'owned file paths')
}

function validateArtifactFiles(
  value: unknown,
  target: NativeTarget,
): readonly NativeArtifactFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4096) {
    fail(`${target} files have an invalid count`)
  }
  const paths: string[] = []
  let executableCount = 0
  for (const item of value) {
    const record = strictRecord(item, `${target} artifact file`, [
      'role',
      'path',
      'sha256',
      'bytes',
      'mode',
    ])
    const path = relativePath(record.path, `${target} artifact path`)
    hash(record.sha256, `${target} artifact hash`)
    integerRange(record.bytes, 0, NATIVE_TARGET_CEILINGS[target], `${target} artifact bytes`)
    if (record.role === 'executable') {
      executableCount += 1
      if (path !== NATIVE_EXECUTABLE_PATH || record.mode !== '0755') {
        fail(`${target} executable path or mode is invalid`)
      }
    } else if (record.role === 'resource') {
      if (!path.startsWith(`${NATIVE_RESOURCES_ROOT}/`) || record.mode !== '0644') {
        fail(`${target} resource path or mode is invalid`)
      }
    } else {
      fail(`${target} artifact role is invalid`)
    }
    paths.push(path)
  }
  if (executableCount !== 1) fail(`${target} must contain exactly one executable`)
  assertSortedUnique(paths, `${target} artifact paths`)
  return value as readonly NativeArtifactFile[]
}

function validateCompatibility(value: unknown, target: NativeTarget): NativeCompatibility {
  const record = strictRecordValue(value, `${target} compatibility`)
  if (target.startsWith('darwin-')) {
    assertExactKeys(
      record,
      ['os', 'minimumProductVersion', 'deploymentLoadCommand', 'dynamicDependencies'],
      `${target} compatibility`,
    )
    exactString(record.os, 'darwin', `${target} compatibility OS`)
    dottedVersion(record.minimumProductVersion, `${target} minimum product version`)
    exactString(record.deploymentLoadCommand, 'pass', `${target} deployment check`)
    dependencies(record.dynamicDependencies, `${target} dynamic dependencies`)
    return record as NativeCompatibility
  }
  if (record.libc === 'none') {
    assertExactKeys(
      record,
      ['os', 'libc', 'interpreter', 'dynamicDependencies'],
      `${target} compatibility`,
    )
    exactString(record.os, 'linux', `${target} compatibility OS`)
    if (record.interpreter !== null) fail(`${target} static interpreter must be null`)
    const dynamic = dependencies(record.dynamicDependencies, `${target} dynamic dependencies`)
    if (dynamic.length !== 0) fail(`${target} static artifact has dynamic dependencies`)
    return record as NativeCompatibility
  }
  assertExactKeys(
    record,
    ['os', 'libc', 'minimumVersion', 'interpreter', 'dynamicDependencies'],
    `${target} compatibility`,
  )
  exactString(record.os, 'linux', `${target} compatibility OS`)
  if (record.libc !== 'glibc' && record.libc !== 'musl') fail(`${target} libc is invalid`)
  dottedVersion(record.minimumVersion, `${target} minimum libc version`)
  absolutePosixPath(record.interpreter, `${target} interpreter`)
  dependencies(record.dynamicDependencies, `${target} dynamic dependencies`)
  return record as NativeCompatibility
}

function validateRunner(value: unknown, target: NativeTarget): void {
  const record = strictRecord(value, `${target} runner`, ['os', 'arch', 'image', 'imageVersion'])
  const expected = NATIVE_TARGET_CONFIG[target]
  exactString(record.os, expected.os, `${target} runner OS`)
  exactString(record.arch, expected.arch, `${target} runner arch`)
  exactString(record.image, expected.image, `${target} runner image`)
  exactString(record.imageVersion, expected.imageVersion, `${target} runner image version`)
}

function validateToolchain(value: unknown, target: NativeTarget): void {
  const record = strictRecord(value, `${target} toolchain`, [
    'zig',
    'linker',
    'strip',
    'sdk',
    'buildRecipeSha256',
  ])
  const zig = strictRecord(record.zig, `${target} Zig`, ['version', 'sha256'])
  exactString(zig.version, NATIVE_ZIG_VERSION, `${target} Zig version`)
  hash(zig.sha256, `${target} Zig hash`)
  validateNativeTool(record.linker, `${target} linker`)
  validateNativeTool(record.strip, `${target} strip`)
  validateToolchainSdk(record.sdk, target)
  hash(record.buildRecipeSha256, `${target} build recipe hash`)
}

function validateNativeTool(value: unknown, label: string): void {
  const record = strictRecord(value, label, ['name', 'version', 'sha256'])
  printable(record.name, `${label} name`, 1, 256)
  printable(record.version, `${label} version`, 1, 256)
  hash(record.sha256, `${label} hash`)
}

function validateToolchainSdk(value: unknown, target: NativeTarget): void {
  const record = strictRecordValue(value, `${target} SDK`)
  if (target.startsWith('darwin-')) {
    assertExactKeys(
      record,
      ['kind', 'xcodeVersion', 'xcodeBuild', 'sdkVersion', 'sdkSettingsSha256'],
      `${target} SDK`,
    )
    exactString(record.kind, 'macos', `${target} SDK kind`)
    printable(record.xcodeVersion, `${target} Xcode version`, 1, 256)
    xcodeBuild(record.xcodeBuild, `${target} Xcode build`)
    dottedVersion(record.sdkVersion, `${target} SDK version`)
    hash(record.sdkSettingsSha256, `${target} SDK settings hash`)
    return
  }
  assertExactKeys(
    record,
    ['kind', 'sysrootName', 'sysrootVersion', 'sysrootSha256'],
    `${target} SDK`,
  )
  exactString(record.kind, 'linux', `${target} SDK kind`)
  printable(record.sysrootName, `${target} sysroot name`, 1, 256)
  printable(record.sysrootVersion, `${target} sysroot version`, 1, 256)
  hash(record.sysrootSha256, `${target} sysroot hash`)
}

function validateArchive(value: unknown, target: NativeTarget): void {
  const record = strictRecord(value, `${target} archive`, ['file', 'sha256', 'bytes'])
  exactString(record.file, `ghostty-config-resolver-${target}.tar`, `${target} archive filename`)
  hash(record.sha256, `${target} archive hash`)
  integerRange(
    record.bytes,
    1,
    NATIVE_TARGET_CEILINGS[target] + NATIVE_MAX_ARCHIVE_OVERHEAD,
    `${target} archive bytes`,
  )
}

function validateChecks(value: unknown): void {
  const record = strictRecord(value, 'native checks', [
    'semantic',
    'noWrite',
    'privacy',
    'relocation',
    'dependencies',
  ])
  for (const key of Object.keys(record)) exactString(record[key], 'pass', `check ${key}`)
}

function validateCeilings(value: unknown): void {
  const record = strictRecord(value, 'manifest ceilings', ['perTargetBytes', 'totalPackageBytes'])
  const perTarget = targetRecord(record.perTargetBytes, 'per-target ceilings')
  for (const target of NATIVE_TARGETS) {
    exactInteger(perTarget[target], NATIVE_TARGET_CEILINGS[target], `${target} ceiling`)
  }
  exactInteger(record.totalPackageBytes, NATIVE_TOTAL_CEILING, 'total package ceiling')
}

function validateUpstream(value: unknown, label: string): void {
  const record = strictRecord(value, label, ['repository', 'revision', 'treeSha256'])
  exactString(record.repository, NATIVE_UPSTREAM_REPOSITORY, `${label} repository`)
  exactString(record.revision, NATIVE_UPSTREAM_REVISION, `${label} revision`)
  exactString(record.treeSha256, NATIVE_UPSTREAM_TREE_SHA256, `${label} tree hash`)
}

function validateTokenArgv(value: unknown, label: string): readonly string[] {
  const argv = stringArray(value, 1, 4096, label)
  for (const argument of argv) validateTokens(argument, label)
  return argv
}

function validateTokens(value: string, label: string): void {
  const scrubbed = value.replaceAll(/\$(?:WORK|UPSTREAM|OUTPUT|SDK|SYSROOT|RESOURCES)/g, '')
  if (/\$[A-Z][A-Z0-9_]*/.test(scrubbed)) fail(`${label} has an unsupported token`)
  if (scrubbed.includes('/tmp/') || scrubbed.includes('/private/tmp/')) {
    fail(`${label} contains an ambient build path`)
  }
  const fixedSystemPath = '/usr/bin:/bin:/usr/sbin:/sbin'
  if (value.startsWith('/') && value !== '/usr/bin/strip' && value !== fixedSystemPath) {
    fail(`${label} contains an ambient absolute path`)
  }
}

function dependencies(value: unknown, label: string): readonly string[] {
  const result = stringArray(value, 0, 64, label)
  for (const item of result) printable(item, label, 1, 256)
  assertSortedUnique(result, label)
  return result
}

function targetRecord(value: unknown, label: string): Record<NativeTarget, unknown> {
  const record = strictRecordValue(value, label)
  assertExactKeys(record, [...NATIVE_TARGETS], label)
  return record as Record<NativeTarget, unknown>
}

function assertExactTargets(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length !== NATIVE_TARGETS.length) fail(`${label} is not exact`)
  if (JSON.stringify(value) !== JSON.stringify(NATIVE_TARGETS)) fail(`${label} is not exact`)
}

function nativeTarget(value: unknown, label: string): NativeTarget {
  if (typeof value !== 'string' || !NATIVE_TARGETS.includes(value as NativeTarget)) {
    fail(`${label} is invalid`)
  }
  return value as NativeTarget
}

function relativePath(value: unknown, label: string): string {
  const path = printable(value, label, 1, 240)
  if (path.startsWith('/') || path.includes('\\')) fail(`${label} is not a POSIX relative path`)
  const components = path.split('/')
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    fail(`${label} has an invalid component`)
  }
  return path
}

function absolutePosixPath(value: unknown, label: string): string {
  const path = printable(value, label, 1, 4096)
  if (!path.startsWith('/') || path.includes('\\')) fail(`${label} is not an absolute POSIX path`)
  if (path.split('/').some((component) => component === '.' || component === '..')) {
    fail(`${label} has an invalid component`)
  }
  return path
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(`${label} is invalid`)
  return value as string
}

function revision(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) fail(`${label} is invalid`)
  return value as string
}

function runId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) fail('runId is invalid')
  return value as string
}

function xcodeBuild(value: unknown, label: string): string {
  const result = printable(value, label, 1, 256)
  if (!/^[0-9]{1,4}[A-Z][0-9]{1,4}[a-z]?$/.test(result)) fail(`${label} is invalid`)
  return result
}

function dottedVersion(value: unknown, label: string): string {
  const result = printable(value, label, 3, 17)
  if (!/^(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})(?:\.(?:0|[1-9][0-9]{0,4}))?$/.test(result)) {
    fail(`${label} is invalid`)
  }
  for (const component of result.split('.')) {
    if (Number(component) > 65_535) fail(`${label} component exceeds 65535`)
  }
  return result
}

function httpsUrl(value: unknown, label: string): string {
  const result = printable(value, label, 1, 2048)
  let url: URL
  try {
    url = new URL(result)
  } catch {
    fail(`${label} is invalid`)
  }
  if (url!.protocol !== 'https:' || url!.username || url!.password || url!.hash) {
    fail(`${label} is not an immutable HTTPS URL`)
  }
  return result
}

function recordId(value: unknown, label: string): string {
  const result = ascii(value, label, 1, 128)
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(result)) fail(`${label} is invalid`)
  return result
}

function stringArray(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${label} has an invalid count`)
  }
  const result: string[] = []
  for (const item of value) result.push(printable(item, `${label} item`, 0, 4096))
  return result
}

function printable(
  value: unknown,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
): string {
  if (typeof value !== 'string') fail(`${label} is not a string`)
  const bytes = Buffer.byteLength(value as string)
  if (
    bytes < minimumBytes ||
    bytes > maximumBytes ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    fail(`${label} has invalid bytes`)
  }
  return value as string
}

function ascii(value: unknown, label: string, minimumBytes: number, maximumBytes: number): string {
  const result = printable(value, label, minimumBytes, maximumBytes)
  if (!/^[\x20-\x7e]*$/.test(result)) fail(`${label} is not printable ASCII`)
  return result
}

function exactString(value: unknown, expected: string, label: string): void {
  if (value !== expected) fail(`${label} does not match`)
}

function exactInteger(value: unknown, expected: number, label: string): void {
  if (value !== expected || !Number.isInteger(value)) fail(`${label} does not match`)
}

function integerRange(value: unknown, minimum: number, maximum: number, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(`${label} is outside its bound`)
  }
  return value
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (previous === undefined || current === undefined || compareBytes(previous, current) >= 0) {
      fail(`${label} is not sorted and unique`)
    }
  }
}

function strictRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  const record = strictRecordValue(value, label)
  assertExactKeys(record, keys, label)
  return record
}

function strictRecordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object`)
  return value as Record<string, unknown>
}

function assertExactKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${label} has unknown or missing keys`)
}

function fail(message: string): never {
  throw new NativeContractError(message)
}
