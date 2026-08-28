import { createHash } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

export const PROOF_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const
export const PROOF_TOOL_ROLES = ['linker', 'sdk-or-sysroot', 'strip', 'zig'] as const
export const PROOF_INPUT_ROLES = [
  'dependency-archive',
  'generated-resource-source',
  'runtime-resource',
  'upstream-submodule',
] as const
export const PROOF_SOURCE_DATE_EPOCH = 1_787_590_337
export const PROOF_UPSTREAM_REPOSITORY = 'https://github.com/ghostty-org/ghostty.git'
export const PROOF_UPSTREAM_REVISION = 'c8554f28e0efe2f5595f32020371c34b25ec628f'
export const PROOF_UPSTREAM_TREE_SHA256 =
  '63d2b0c41531162a70b838369c0c225745e167495763ebbd0bc2fe546976a2bb'
export const PROOF_ZIG_VERSION = '0.16.0'

const HASH_PATTERN = /^[0-9a-f]{64}$/
const REVISION_PATTERN = /^[0-9a-f]{40}$/
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/
const RECORD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const SOURCE_REFERENCE_PATTERN = /^(?:input|tool):[a-z0-9][a-z0-9._-]{0,127}$/
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/
const MAX_RECIPE_BYTES = 2 * 1024 * 1024
const MAX_ARRAY_ITEMS = 4096
const MAX_ARGUMENT_BYTES = 4096
const MAX_STRING_BYTES = 256
const TREE_HEADER = Buffer.from('ghostty-external-tree-v1\0')

export type ProofTarget = (typeof PROOF_TARGETS)[number]
export type ProofToolRole = (typeof PROOF_TOOL_ROLES)[number]
export type ProofInputRole = (typeof PROOF_INPUT_ROLES)[number]
export type ProofContentKind = 'external-tree-v1' | 'file'

export type ProofRunner = {
  readonly os: 'darwin' | 'linux'
  readonly arch: 'arm64' | 'x64'
  readonly image: string
  readonly imageVersion: string
}

export type OfficialDownloadAcquisition = {
  readonly kind: 'official-download'
  readonly url: string
  readonly archiveBytes: number
  readonly archiveSha256: string
}

export type GitAcquisition = {
  readonly kind: 'git'
  readonly repository: string
  readonly revision: string
  readonly treeAlgorithm: 'ghostty-upstream-tree-v1'
  readonly treeSha256: string
}

export type MacosSdkIdentity = {
  readonly xcodeVersion: string
  readonly xcodeBuild: string
  readonly sdkVersion: string
  readonly sdkBuild: string
  readonly sdkSettingsSha256: string
}

export type RunnerComponentAcquisition = {
  readonly kind: 'runner-component'
  readonly runnerImage: string
  readonly runnerImageVersion: string
  readonly path: string
  readonly contentKind: ProofContentKind
  readonly macosSdk?: MacosSdkIdentity
}

export type ProofAcquisition =
  | OfficialDownloadAcquisition
  | GitAcquisition
  | RunnerComponentAcquisition

export type ProofGeneration = {
  readonly sources: readonly string[]
  readonly argv: readonly string[]
}

export type ProofToolRecord = {
  readonly role: ProofToolRole
  readonly name: string
  readonly version: string
  readonly bytes: number
  readonly sha256: string
  readonly acquisition: ProofAcquisition
  readonly generation?: ProofGeneration
}

export type ProofInputRecord = {
  readonly role: ProofInputRole
  readonly id: string
  readonly bytes: number
  readonly sha256: string
  readonly acquisition: ProofAcquisition
  readonly generation?: ProofGeneration
}

export type ProofTargetRecipe = {
  readonly runner: ProofRunner
  readonly targetTriple: string
  readonly optimizationMode: 'ReleaseSafe'
  readonly buildArgv: readonly string[]
  readonly linkArgv: readonly string[]
  readonly stripArgv: readonly string[]
  readonly environment: readonly {
    readonly name: string
    readonly value: string
  }[]
  readonly tools: readonly ProofToolRecord[]
  readonly inputs: readonly ProofInputRecord[]
}

export type ProofRecipe = {
  readonly schemaVersion: 1
  readonly sourceDateEpoch: number
  readonly upstream: {
    readonly repository: string
    readonly revision: string
    readonly treeSha256: string
  }
  readonly zigVersion: '0.16.0'
  readonly targets: Readonly<Record<ProofTarget, ProofTargetRecipe>>
}

export type LoadedProofRecipe = {
  readonly value: ProofRecipe
  readonly bytes: Buffer
  readonly sha256: string
}

export type ContentIdentity = {
  readonly bytes: number
  readonly sha256: string
}

export type ExternalTreeIdentity = ContentIdentity & {
  readonly entries: number
}

type JsonObject = Record<string, unknown>
type RecordContext = {
  readonly target: ProofTarget
  readonly runner: ProofRunner
  readonly role: ProofToolRole | ProofInputRole
}
type TreeEntry = {
  readonly path: Buffer
  readonly type: 1 | 2 | 3
  readonly permissions: number
  readonly bytes: number
  readonly identity: Buffer | null
}

export class ProofContractError extends Error {}

function fail(message: string): never {
  throw new ProofContractError(message)
}

export function validateProofRecipe(value: unknown): ProofRecipe {
  const recipe = asObject(value, 'recipe')
  assertKeys(
    recipe,
    ['schemaVersion', 'sourceDateEpoch', 'targets', 'upstream', 'zigVersion'],
    'recipe',
  )
  if (recipe.schemaVersion !== 1) fail('recipe schemaVersion must be 1')
  if (recipe.sourceDateEpoch !== PROOF_SOURCE_DATE_EPOCH) {
    fail('recipe sourceDateEpoch does not match the upstream pin')
  }
  if (recipe.zigVersion !== PROOF_ZIG_VERSION) fail('recipe Zig version must be 0.16.0')
  validateUpstream(recipe.upstream)
  validateTargets(recipe.targets)
  return recipe as ProofRecipe
}

function validateUpstream(value: unknown): void {
  const upstream = asObject(value, 'upstream')
  assertKeys(upstream, ['repository', 'revision', 'treeSha256'], 'upstream')
  if (upstream.repository !== PROOF_UPSTREAM_REPOSITORY) {
    fail('upstream repository does not match the pin')
  }
  if (upstream.revision !== PROOF_UPSTREAM_REVISION)
    fail('upstream revision does not match the pin')
  if (upstream.treeSha256 !== PROOF_UPSTREAM_TREE_SHA256) {
    fail('upstream treeSha256 does not match the pin')
  }
}

function validateTargets(value: unknown): void {
  const targets = asObject(value, 'targets')
  assertKeys(targets, PROOF_TARGETS, 'targets')
  for (const target of PROOF_TARGETS) validateTarget(targets[target], target)
}

function validateTarget(value: unknown, target: ProofTarget): void {
  const record = asObject(value, target)
  assertKeys(
    record,
    [
      'buildArgv',
      'environment',
      'inputs',
      'linkArgv',
      'optimizationMode',
      'runner',
      'stripArgv',
      'targetTriple',
      'tools',
    ],
    target,
  )
  const runner = validateRunner(record.runner, target)
  validateTargetTriple(record.targetTriple, target)
  if (record.optimizationMode !== 'ReleaseSafe')
    fail(`${target} optimizationMode must be ReleaseSafe`)
  validateArgv(record.buildArgv, `${target} buildArgv`)
  validateArgv(record.linkArgv, `${target} linkArgv`)
  validateArgv(record.stripArgv, `${target} stripArgv`)
  validateEnvironment(record.environment, target)
  const tools = validateTools(record.tools, target, runner)
  const inputs = validateInputs(record.inputs, target, runner)
  validateGenerationReferences(tools, inputs, target)
}

function validateRunner(value: unknown, target: ProofTarget): ProofRunner {
  const runner = asObject(value, `${target} runner`)
  assertKeys(runner, ['arch', 'image', 'imageVersion', 'os'], `${target} runner`)
  const expected = targetIdentity(target)
  if (runner.os !== expected.os) fail(`${target} runner OS does not match`)
  if (runner.arch !== expected.arch) fail(`${target} runner architecture does not match`)
  assertPrintableAscii(runner.image, 1, MAX_STRING_BYTES, `${target} runner image`)
  assertPrintableAscii(runner.imageVersion, 1, MAX_STRING_BYTES, `${target} runner imageVersion`)
  return runner as ProofRunner
}

function validateTargetTriple(value: unknown, target: ProofTarget): void {
  assertPrintableAscii(value, 1, 64, `${target} targetTriple`)
  const patterns: Readonly<Record<ProofTarget, RegExp>> = {
    'darwin-arm64': /^aarch64-macos\.[0-9]{1,2}\.[0-9]{1,2}$/,
    'darwin-x64': /^x86_64-macos\.[0-9]{1,2}\.[0-9]{1,2}$/,
    'linux-arm64': /^aarch64-linux-musl$/,
    'linux-x64': /^x86_64-linux-musl$/,
  }
  if (!patterns[target].test(value)) fail(`${target} targetTriple does not match`)
}

function validateArgv(value: unknown, label: string): void {
  const argv = asArray(value, label, 1, MAX_ARRAY_ITEMS)
  for (const [index, argument] of argv.entries()) {
    assertPrintableAscii(argument, 1, MAX_ARGUMENT_BYTES, `${label}[${index}]`)
  }
}

function validateEnvironment(value: unknown, target: ProofTarget): void {
  const environment = asArray(value, `${target} environment`, 1, 256)
  const names: string[] = []
  for (const [index, item] of environment.entries()) {
    const entry = asObject(item, `${target} environment[${index}]`)
    assertKeys(entry, ['name', 'value'], `${target} environment[${index}]`)
    assertPattern(entry.name, ENVIRONMENT_NAME_PATTERN, `${target} environment name`)
    assertPrintableAscii(entry.value, 0, MAX_ARGUMENT_BYTES, `${target} environment value`)
    names.push(entry.name as string)
  }
  assertSortedUnique(names, `${target} environment`)
}

function validateTools(
  value: unknown,
  target: ProofTarget,
  runner: ProofRunner,
): readonly ProofToolRecord[] {
  const records = asArray(
    value,
    `${target} tools`,
    PROOF_TOOL_ROLES.length,
    PROOF_TOOL_ROLES.length,
  )
  const tools: ProofToolRecord[] = []
  for (const [index, item] of records.entries()) {
    const tool = validateTool(item, index, target, runner)
    tools.push(tool)
  }
  assertRecordOrder(tools, 'role', 'name', `${target} tools`)
  assertExactRoles(tools, PROOF_TOOL_ROLES, `${target} tools`)
  return tools
}

function validateTool(
  value: unknown,
  index: number,
  target: ProofTarget,
  runner: ProofRunner,
): ProofToolRecord {
  const label = `${target} tools[${index}]`
  const tool = asObject(value, label)
  assertRecordKeys(tool, label)
  assertEnum(tool.role, PROOF_TOOL_ROLES, `${label} role`)
  assertPattern(tool.name, RECORD_ID_PATTERN, `${label} name`)
  assertPrintableAscii(tool.version, 1, MAX_STRING_BYTES, `${label} version`)
  validateContentIdentity(tool, label)
  const context = { target, runner, role: tool.role as ProofToolRole }
  validateAcquisition(tool.acquisition, context, label)
  validateOptionalGeneration(tool.generation, label)
  return tool as ProofToolRecord
}

function validateInputs(
  value: unknown,
  target: ProofTarget,
  runner: ProofRunner,
): readonly ProofInputRecord[] {
  const records = asArray(value, `${target} inputs`, 1, MAX_ARRAY_ITEMS)
  const inputs: ProofInputRecord[] = []
  for (const [index, item] of records.entries()) {
    const input = validateInput(item, index, target, runner)
    inputs.push(input)
  }
  assertRecordOrder(inputs, 'role', 'id', `${target} inputs`)
  return inputs
}

function validateInput(
  value: unknown,
  index: number,
  target: ProofTarget,
  runner: ProofRunner,
): ProofInputRecord {
  const label = `${target} inputs[${index}]`
  const input = asObject(value, label)
  assertRecordKeys(input, label, 'id')
  assertEnum(input.role, PROOF_INPUT_ROLES, `${label} role`)
  assertPattern(input.id, RECORD_ID_PATTERN, `${label} id`)
  validateContentIdentity(input, label)
  const context = { target, runner, role: input.role as ProofInputRole }
  validateAcquisition(input.acquisition, context, label)
  validateOptionalGeneration(input.generation, label)
  return input as ProofInputRecord
}

function assertRecordKeys(value: JsonObject, label: string, identity = 'name'): void {
  const expected = ['acquisition', 'bytes', identity, 'role', 'sha256']
  if (identity === 'name') expected.push('version')
  if ('generation' in value) expected.push('generation')
  assertKeys(value, expected, label)
}

function validateContentIdentity(value: JsonObject, label: string): void {
  assertInteger(value.bytes, 1, Number.MAX_SAFE_INTEGER, `${label} bytes`)
  assertHash(value.sha256, `${label} sha256`)
}

function validateAcquisition(value: unknown, context: RecordContext, label: string): void {
  const acquisition = asObject(value, `${label} acquisition`)
  const requiresMacosSdk = context.runner.os === 'darwin' && context.role === 'sdk-or-sysroot'
  if (requiresMacosSdk && acquisition.kind !== 'runner-component') {
    fail(`${label} macOS SDK must be a runner component`)
  }
  if (acquisition.kind === 'official-download') {
    validateOfficialDownload(acquisition, label)
    return
  }
  if (acquisition.kind === 'git') {
    validateGitAcquisition(acquisition, label)
    return
  }
  if (acquisition.kind !== 'runner-component') fail(`${label} acquisition kind is unsupported`)
  validateRunnerComponent(acquisition, context, label)
}

function validateOfficialDownload(value: JsonObject, label: string): void {
  assertKeys(value, ['archiveBytes', 'archiveSha256', 'kind', 'url'], `${label} acquisition`)
  assertImmutableHttpsUrl(value.url, `${label} acquisition URL`)
  assertInteger(value.archiveBytes, 1, Number.MAX_SAFE_INTEGER, `${label} archiveBytes`)
  assertHash(value.archiveSha256, `${label} archiveSha256`)
}

function validateGitAcquisition(value: JsonObject, label: string): void {
  assertKeys(
    value,
    ['kind', 'repository', 'revision', 'treeAlgorithm', 'treeSha256'],
    `${label} acquisition`,
  )
  assertImmutableHttpsUrl(value.repository, `${label} Git repository`)
  assertRevision(value.revision, `${label} Git revision`)
  if (value.treeAlgorithm !== 'ghostty-upstream-tree-v1') {
    fail(`${label} Git tree algorithm does not match`)
  }
  assertHash(value.treeSha256, `${label} Git treeSha256`)
}

function validateRunnerComponent(value: JsonObject, context: RecordContext, label: string): void {
  const keys = ['contentKind', 'kind', 'path', 'runnerImage', 'runnerImageVersion']
  if ('macosSdk' in value) keys.push('macosSdk')
  assertKeys(value, keys, `${label} acquisition`)
  if (value.runnerImage !== context.runner.image) fail(`${label} runner image does not match`)
  if (value.runnerImageVersion !== context.runner.imageVersion) {
    fail(`${label} runner imageVersion does not match`)
  }
  assertPosixComponentPath(value.path, `${label} component path`)
  assertEnum(value.contentKind, ['external-tree-v1', 'file'], `${label} contentKind`)
  if (context.runner.os === 'darwin' && context.role === 'sdk-or-sysroot') {
    if (value.contentKind !== 'external-tree-v1')
      fail(`${label} macOS SDK must be an external tree`)
  }
  validateMacosSdkBoundary(value.macosSdk, context, label)
}

function validateMacosSdkBoundary(value: unknown, context: RecordContext, label: string): void {
  const isMacosSdk = context.runner.os === 'darwin' && context.role === 'sdk-or-sysroot'
  if (!isMacosSdk && value !== undefined) fail(`${label} has unexpected macosSdk metadata`)
  if (!isMacosSdk) return
  if (value === undefined) fail(`${label} is missing macosSdk metadata`)
  const metadata = asObject(value, `${label} macosSdk`)
  assertKeys(
    metadata,
    ['sdkBuild', 'sdkSettingsSha256', 'sdkVersion', 'xcodeBuild', 'xcodeVersion'],
    `${label} macosSdk`,
  )
  for (const key of ['sdkBuild', 'sdkVersion', 'xcodeBuild', 'xcodeVersion']) {
    assertPrintableAscii(metadata[key], 1, MAX_STRING_BYTES, `${label} macosSdk ${key}`)
  }
  assertHash(metadata.sdkSettingsSha256, `${label} macosSdk sdkSettingsSha256`)
}

function validateOptionalGeneration(value: unknown, label: string): void {
  if (value === undefined) return
  const generation = asObject(value, `${label} generation`)
  assertKeys(generation, ['argv', 'sources'], `${label} generation`)
  validateArgv(generation.argv, `${label} generation argv`)
  const sources = asArray(generation.sources, `${label} generation sources`, 1, MAX_ARRAY_ITEMS)
  for (const source of sources) {
    assertPattern(source, SOURCE_REFERENCE_PATTERN, `${label} generation source`)
  }
  assertSortedUnique(sources as string[], `${label} generation sources`)
}

function validateGenerationReferences(
  tools: readonly ProofToolRecord[],
  inputs: readonly ProofInputRecord[],
  target: ProofTarget,
): void {
  const references = new Set<string>()
  for (const tool of tools) references.add(`tool:${tool.name}`)
  for (const input of inputs) references.add(`input:${input.id}`)
  for (const tool of tools)
    validateRecordSources(tool.generation, `tool:${tool.name}`, references, target)
  for (const input of inputs) {
    validateRecordSources(input.generation, `input:${input.id}`, references, target)
  }
}

function validateRecordSources(
  generation: ProofGeneration | undefined,
  self: string,
  references: ReadonlySet<string>,
  target: ProofTarget,
): void {
  if (!generation) return
  for (const source of generation.sources) {
    if (source === self) fail(`${target} generation cannot reference itself`)
    if (!references.has(source)) fail(`${target} generation source is unknown`)
  }
}

function assertRecordOrder(
  records: readonly JsonObject[],
  roleKey: string,
  identityKey: string,
  label: string,
): void {
  const keys = records.map((record) => `${String(record[roleKey])}\0${String(record[identityKey])}`)
  assertSortedUnique(keys, label)
}

function assertExactRoles(
  records: readonly ProofToolRecord[],
  expected: readonly ProofToolRole[],
  label: string,
): void {
  const actual = records.map((record) => record.role).sort(compareUtf8)
  const sortedExpected = [...expected].sort(compareUtf8)
  if (!sameStrings(actual, sortedExpected)) fail(`${label} roles do not match`)
}

function targetIdentity(target: ProofTarget): Pick<ProofRunner, 'arch' | 'os'> {
  const os = target.startsWith('darwin-') ? 'darwin' : 'linux'
  const arch = target.endsWith('arm64') ? 'arm64' : 'x64'
  return { os, arch }
}

export function proofCanonicalBytes(value: unknown): Buffer {
  const recipe = validateProofRecipe(value)
  return Buffer.from(`${canonicalize(recipe)}\n`, 'utf8')
}

export function loadProofRecipe(path: string): LoadedProofRecipe {
  return contractBoundary('recipe load failed', () => loadProofRecipeUnchecked(path))
}

function loadProofRecipeUnchecked(path: string): LoadedProofRecipe {
  const bytes = readFileSync(path)
  if (bytes.length === 0 || bytes.length > MAX_RECIPE_BYTES) fail('recipe byte length is invalid')
  const text = decodeUtf8(bytes, 'recipe')
  const parsed = parseJson(text)
  const canonical = proofCanonicalBytes(parsed)
  if (!bytes.equals(canonical)) fail('recipe is not RFC 8785 canonical JSON plus one LF')
  return { value: parsed as ProofRecipe, bytes, sha256: sha256(bytes) }
}

export function toolchainHashes(target: ProofTargetRecipe): {
  readonly zigSha256: string
  readonly linkerSha256: string
  readonly stripSha256: string
  readonly sdkOrSysrootSha256: string
} {
  return {
    zigSha256: toolHash(target, 'zig'),
    linkerSha256: toolHash(target, 'linker'),
    stripSha256: toolHash(target, 'strip'),
    sdkOrSysrootSha256: toolHash(target, 'sdk-or-sysroot'),
  }
}

function toolHash(target: ProofTargetRecipe, role: ProofToolRole): string {
  const tool = target.tools.find((candidate) => candidate.role === role)
  if (!tool) fail(`recipe is missing ${role}`)
  return tool.sha256
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') return canonicalNumber(value)
  if (Array.isArray(value)) return canonicalArray(value)
  return canonicalObject(asObject(value, 'canonical value'))
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) fail('canonical JSON contains a non-finite number')
  return JSON.stringify(value)
}

function canonicalArray(value: readonly unknown[]): string {
  const items: string[] = []
  for (const item of value) items.push(canonicalize(item))
  return `[${items.join(',')}]`
}

function canonicalObject(value: JsonObject): string {
  const keys = Object.keys(value).sort(compareUtf16)
  const entries: string[] = []
  for (const key of keys) entries.push(`${JSON.stringify(key)}:${canonicalize(value[key])}`)
  return `{${entries.join(',')}}`
}

export function hashFileIdentity(path: string): ContentIdentity {
  return contractBoundary('file identity failed', () => hashFileIdentityUnchecked(path))
}

function hashFileIdentityUnchecked(path: string): ContentIdentity {
  const handle = openSync(path, 'r')
  try {
    const before = fstatSync(handle)
    if (!before.isFile()) fail('materialized component is not a regular file')
    const identity = hashFileDescriptor(handle)
    const after = fstatSync(handle)
    assertStableFile(before, after, identity.bytes)
    return identity
  } finally {
    closeSync(handle)
  }
}

function hashFileDescriptor(handle: number): ContentIdentity {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let bytes = 0
  while (true) {
    const count = readSync(handle, buffer, 0, buffer.length, null)
    if (count === 0) break
    hash.update(buffer.subarray(0, count))
    bytes += count
  }
  return { bytes, sha256: hash.digest('hex') }
}

function assertStableFile(
  before: ReturnType<typeof fstatSync>,
  after: ReturnType<typeof fstatSync>,
  bytes: number,
): void {
  if (before.size !== bytes || after.size !== bytes) fail('materialized file changed while hashing')
  if (before.dev !== after.dev || before.ino !== after.ino)
    fail('materialized file identity changed')
  if (before.mode !== after.mode || before.mtimeMs !== after.mtimeMs) {
    fail('materialized file metadata changed while hashing')
  }
}

export function hashExternalTree(root: string): ExternalTreeIdentity {
  return contractBoundary('external tree identity failed', () => hashExternalTreeUnchecked(root))
}

function hashExternalTreeUnchecked(root: string): ExternalTreeIdentity {
  const verifiedRoot = realpathSync(root)
  if (!lstatSync(verifiedRoot).isDirectory()) fail('external tree root is not a directory')
  const entries: TreeEntry[] = []
  collectTreeEntries(verifiedRoot, '', entries)
  entries.sort((left, right) => Buffer.compare(left.path, right.path))
  return hashTreeEntries(entries)
}

function collectTreeEntries(root: string, parent: string, entries: TreeEntry[]): void {
  const directory = parent ? join(root, ...parent.split('/')) : root
  const names = readDirectoryNames(directory)
  for (const name of names) collectTreeEntry(root, parent, name, entries)
}

function collectTreeEntry(root: string, parent: string, name: string, entries: TreeEntry[]): void {
  const relativePath = parent ? `${parent}/${name}` : name
  const absolutePath = join(root, ...relativePath.split('/'))
  const entry = readTreeEntry(root, absolutePath, relativePath)
  entries.push(entry)
  if (entry.type !== 1) return
  collectTreeEntries(root, relativePath, entries)
}

function readDirectoryNames(path: string): string[] {
  const rawNames = readdirSync(path, { encoding: 'buffer' })
  rawNames.sort(Buffer.compare)
  return rawNames.map((name) => decodePathName(name))
}

function decodePathName(value: Buffer): string {
  const name = decodeUtf8(value, 'external tree path')
  if (!name || name === '.' || name === '..') fail('external tree path component is invalid')
  if (name.includes('/') || name.includes('\0')) fail('external tree path component is invalid')
  return name
}

function readTreeEntry(root: string, path: string, relativePath: string): TreeEntry {
  const stat = lstatSync(path)
  const pathBytes = Buffer.from(relativePath, 'utf8')
  const permissions = stat.mode & 0o7777
  if (stat.isDirectory()) return treeDirectory(pathBytes, permissions)
  if (stat.isFile()) return treeFile(path, pathBytes, permissions)
  if (stat.isSymbolicLink()) return treeSymlink(root, path, pathBytes, permissions)
  fail('external tree contains an unsupported entry type')
}

function treeDirectory(path: Buffer, permissions: number): TreeEntry {
  return { path, type: 1, permissions, bytes: 0, identity: null }
}

function treeFile(path: string, relativePath: Buffer, permissions: number): TreeEntry {
  const identity = hashFileIdentity(path)
  return {
    path: relativePath,
    type: 2,
    permissions,
    bytes: identity.bytes,
    identity: Buffer.from(identity.sha256, 'hex'),
  }
}

function treeSymlink(
  root: string,
  path: string,
  relativePath: Buffer,
  permissions: number,
): TreeEntry {
  const target = readlinkSync(path, { encoding: 'buffer' })
  assertContainedSymlink(root, path, target)
  return {
    path: relativePath,
    type: 3,
    permissions,
    bytes: target.length,
    identity: createHash('sha256').update(target).digest(),
  }
}

function assertContainedSymlink(root: string, path: string, target: Buffer): void {
  const targetText = decodeUtf8(target, 'external tree symlink target')
  const resolvedTarget = realpathSync(resolve(dirname(path), targetText))
  const targetRelative = relative(root, resolvedTarget)
  if (!targetRelative) fail('external tree symlink target has no hashed entry')
  if (isAbsolute(targetRelative)) fail('external tree symlink escapes its root')
  if (targetRelative === '..' || targetRelative.startsWith(`..${sep}`)) {
    fail('external tree symlink escapes its root')
  }
}

function hashTreeEntries(entries: readonly TreeEntry[]): ExternalTreeIdentity {
  const hash = createHash('sha256').update(TREE_HEADER)
  let bytes = 0
  for (const entry of entries) {
    hashTreeEntry(hash, entry)
    bytes += entry.bytes
    if (!Number.isSafeInteger(bytes)) fail('external tree byte length is too large')
  }
  return { bytes, sha256: hash.digest('hex'), entries: entries.length }
}

function hashTreeEntry(hash: ReturnType<typeof createHash>, entry: TreeEntry): void {
  if (entry.path.length > 0xffff_ffff) fail('external tree path is too long')
  hash.update(uint32(entry.path.length))
  hash.update(entry.path)
  hash.update(Buffer.from([entry.type]))
  hash.update(uint16(entry.permissions))
  hash.update(uint64(entry.bytes))
  if (entry.identity) hash.update(entry.identity)
}

export function verifyMaterializedIdentity(
  path: string,
  contentKind: ProofContentKind,
  expected: ContentIdentity,
): ContentIdentity {
  const actual = contentKind === 'file' ? hashFileIdentity(path) : hashExternalTree(path)
  if (actual.bytes !== expected.bytes) fail('materialized component byte length does not match')
  if (actual.sha256 !== expected.sha256) fail('materialized component digest does not match')
  return actual
}

function uint16(value: number): Buffer {
  const bytes = Buffer.alloc(2)
  bytes.writeUInt16BE(value)
  return bytes
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}

function uint64(value: number): Buffer {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64BE(BigInt(value))
  return bytes
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`)
  return value as JsonObject
}

function asArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  if (value.length < minimum || value.length > maximum) fail(`${label} length is invalid`)
  return value
}

function assertKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareUtf16)
  const sortedExpected = [...expected].sort(compareUtf16)
  if (!sameStrings(actual, sortedExpected)) fail(`${label} keys do not match`)
}

function assertInteger(value: unknown, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value)) fail(`${label} must be an integer`)
  if ((value as number) < minimum || (value as number) > maximum) fail(`${label} is out of range`)
}

function assertHash(value: unknown, label: string): void {
  assertPattern(value, HASH_PATTERN, label)
}

function assertRevision(value: unknown, label: string): void {
  assertPattern(value, REVISION_PATTERN, label)
}

function assertPattern(value: unknown, pattern: RegExp, label: string): void {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} does not match`)
}

function assertEnum(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(`${label} is unsupported`)
}

function assertPrintableAscii(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): asserts value is string {
  if (typeof value !== 'string') fail(`${label} must be a string`)
  const length = Buffer.byteLength(value)
  if (length < minimum || length > maximum) fail(`${label} length is invalid`)
  if (value && !PRINTABLE_ASCII_PATTERN.test(value)) fail(`${label} must be printable ASCII`)
}

function assertImmutableHttpsUrl(value: unknown, label: string): void {
  assertPrintableAscii(value, 1, MAX_ARGUMENT_BYTES, label)
  let parsed: URL
  try {
    parsed = new URL(value as string)
  } catch {
    fail(`${label} is not a URL`)
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) fail(`${label} must use HTTPS`)
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    fail(`${label} contains mutable URL components`)
  }
}

function assertPosixComponentPath(value: unknown, label: string): void {
  assertPrintableAscii(value, 1, MAX_ARGUMENT_BYTES, label)
  const path = value as string
  if (!path.startsWith('/') || path === '/') fail(`${label} must be an absolute component path`)
  if (posix.normalize(path) !== path) fail(`${label} must be normalized`)
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (previous === undefined || current === undefined) fail(`${label} ordering is invalid`)
    if (compareUtf8(previous, current) >= 0) fail(`${label} must be sorted and unique`)
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function contractBoundary<T>(label: string, action: () => T): T {
  try {
    return action()
  } catch (error) {
    if (error instanceof ProofContractError) throw error
    fail(label)
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    fail('recipe is not valid JSON')
  }
}

function decodeUtf8(value: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    fail(`${label} is not valid UTF-8`)
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
