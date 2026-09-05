import {
  validateNativeArtifactProvenance,
  type NativeArtifactProvenance,
} from '../config-resolver-native/contract'
import {
  NATIVE_SOURCE_DATE_EPOCH,
  NATIVE_TARGET_CONFIG,
  NATIVE_TARGETS,
  type NativeTarget,
} from '../config-resolver-native/constants'
import { NativeContractError } from '../config-resolver-native/canonical'
import {
  RELEASE_EVIDENCE_FILE,
  RELEASE_MAX_FILES,
  RELEASE_MAX_JSON_BYTES,
  RELEASE_MAX_PATH_BYTES,
  RELEASE_MAX_TARBALL_BYTES,
  RELEASE_PACKAGE_VERSION,
  RELEASE_TARBALL_FILE,
  RELEASE_UPSTREAM_REVISION,
} from './constants'
import type {
  NativeTargetRecord,
  PackedFileList,
  ReleaseCandidateEvidence,
  ReleaseCandidateIdentity,
  ReleaseCandidateProvisional,
  ReleaseCandidateTarball,
  ReleaseSmokeProvenance,
} from './types'

const HASH = /^[0-9a-f]{64}$/
const HEAD = /^[0-9a-f]{40}$/
const RUN_ID = /^[1-9][0-9]{0,19}$/
const NPM_SHASUM = /^[0-9a-f]{40}$/
const NPM_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/

export class ReleaseCandidateError extends Error {}

export function validateReleaseCandidateProvisional(value: unknown): ReleaseCandidateProvisional {
  const record = strictRecord(value, 'release provisional', [
    'schemaVersion',
    'runId',
    'runAttempt',
    'packageVersion',
    'packageSourceHead',
    'nativeBuildSourceHead',
    'nativeInputsTreeSha256',
    'sourceDateEpoch',
    'upstreamRevision',
    'tarball',
    'nativeManifestSha256',
    'packedFileListSha256',
    'packTools',
  ])
  exact(record.schemaVersion, 1, 'release provisional schemaVersion')
  runId(record.runId, 'release provisional runId')
  integer(record.runAttempt, 1, 100, 'release provisional runAttempt')
  exact(record.packageVersion, RELEASE_PACKAGE_VERSION, 'release provisional packageVersion')
  head(record.packageSourceHead, 'release provisional packageSourceHead')
  head(record.nativeBuildSourceHead, 'release provisional nativeBuildSourceHead')
  hash(record.nativeInputsTreeSha256, 'release provisional nativeInputsTreeSha256')
  integer(record.sourceDateEpoch, 946_684_800, 4_102_444_800, 'release provisional sourceDateEpoch')
  exact(record.upstreamRevision, RELEASE_UPSTREAM_REVISION, 'release provisional upstreamRevision')
  validateReleaseTarball(record.tarball, 'release provisional tarball')
  hash(record.nativeManifestSha256, 'release provisional nativeManifestSha256')
  hash(record.packedFileListSha256, 'release provisional packedFileListSha256')
  validatePackTools(record.packTools)
  return record as unknown as ReleaseCandidateProvisional
}

export function validatePackedFileList(value: unknown): PackedFileList {
  const record = strictRecord(value, 'packed file list', ['schemaVersion', 'files'])
  exact(record.schemaVersion, 1, 'packed file list schemaVersion')
  if (
    !Array.isArray(record.files) ||
    record.files.length < 1 ||
    record.files.length > RELEASE_MAX_FILES
  ) {
    fail('packed file list has an invalid file count')
  }
  let previous = ''
  for (const [index, value] of record.files.entries()) {
    const file = strictRecord(value, `packed file list files[${index}]`, [
      'path',
      'mode',
      'bytes',
      'sha256',
    ])
    const path = relativePath(file.path, `packed file list files[${index}] path`)
    if (index > 0 && compareUtf8(previous, path) >= 0) {
      fail('packed file list paths are not byte-sorted and unique')
    }
    previous = path
    enumValue(file.mode, ['0644', '0755'], `packed file list files[${index}] mode`)
    integer(
      file.bytes,
      0,
      RELEASE_MAX_UNCOMPRESSED_FILE_BYTES,
      `packed file list files[${index}] bytes`,
    )
    hash(file.sha256, `packed file list files[${index}] sha256`)
  }
  return record as unknown as PackedFileList
}

export function validateReleaseSmokeProvenance(value: unknown): ReleaseSmokeProvenance {
  const record = strictRecord(value, 'release smoke provenance', [
    'schemaVersion',
    'runId',
    'runAttempt',
    'target',
    'packageSourceHead',
    'nativeBuildSourceHead',
    'nativeInputsTreeSha256',
    'packageVersion',
    'upstreamRevision',
    'tarball',
    'nativeManifestSha256',
    'releaseRebuildProvenanceSha256',
    'runner',
    'runtimes',
    'checks',
  ])
  exact(record.schemaVersion, 1, 'release smoke schemaVersion')
  runId(record.runId, 'release smoke runId')
  integer(record.runAttempt, 1, 100, 'release smoke runAttempt')
  const target = nativeTarget(record.target, 'release smoke target')
  head(record.packageSourceHead, 'release smoke packageSourceHead')
  head(record.nativeBuildSourceHead, 'release smoke nativeBuildSourceHead')
  hash(record.nativeInputsTreeSha256, 'release smoke nativeInputsTreeSha256')
  exact(record.packageVersion, RELEASE_PACKAGE_VERSION, 'release smoke packageVersion')
  exact(record.upstreamRevision, RELEASE_UPSTREAM_REVISION, 'release smoke upstreamRevision')
  validateSmokeTarball(record.tarball)
  hash(record.nativeManifestSha256, 'release smoke nativeManifestSha256')
  hash(record.releaseRebuildProvenanceSha256, 'release smoke rebuild provenance sha256')
  validateSmokeRunner(record.runner, target)
  validateRuntimes(record.runtimes)
  validateSmokeChecks(record.checks)
  return record as unknown as ReleaseSmokeProvenance
}

export function validateReleaseCandidateEvidence(value: unknown): ReleaseCandidateEvidence {
  const record = strictRecord(value, 'release evidence', [
    'schemaVersion',
    'provisional',
    'assembly',
    'releaseRebuild',
    'releaseSmoke',
  ])
  exact(record.schemaVersion, 1, 'release evidence schemaVersion')
  validateReleaseCandidateProvisional(record.provisional)
  validateNativeProvenanceRecord(record.assembly, 'release evidence assembly')
  validateNativeProvenanceRecord(record.releaseRebuild, 'release evidence releaseRebuild')
  validateSmokeRecord(record.releaseSmoke, 'release evidence releaseSmoke')
  return record as unknown as ReleaseCandidateEvidence
}

export function validateReleaseCandidateIdentity(value: unknown): ReleaseCandidateIdentity {
  const record = strictRecord(value, 'release identity', [
    'schemaVersion',
    'packageVersion',
    'packageSourceHead',
    'nativeBuildSourceHead',
    'nativeInputsTreeSha256',
    'sourceDateEpoch',
    'upstreamRevision',
    'assemblyRun',
    'releaseRun',
    'tarball',
    'nativeManifestSha256',
    'packedFileListSha256',
    'provisionalSha256',
    'evidence',
    'provenanceSha256',
  ])
  exact(record.schemaVersion, 1, 'release identity schemaVersion')
  exact(record.packageVersion, RELEASE_PACKAGE_VERSION, 'release identity packageVersion')
  head(record.packageSourceHead, 'release identity packageSourceHead')
  head(record.nativeBuildSourceHead, 'release identity nativeBuildSourceHead')
  hash(record.nativeInputsTreeSha256, 'release identity nativeInputsTreeSha256')
  integer(record.sourceDateEpoch, 946_684_800, 4_102_444_800, 'release identity sourceDateEpoch')
  exact(record.upstreamRevision, RELEASE_UPSTREAM_REVISION, 'release identity upstreamRevision')
  validateRun(record.assemblyRun, 'release identity assemblyRun')
  validateRun(record.releaseRun, 'release identity releaseRun')
  validateReleaseTarball(record.tarball, 'release identity tarball')
  hash(record.nativeManifestSha256, 'release identity nativeManifestSha256')
  hash(record.packedFileListSha256, 'release identity packedFileListSha256')
  hash(record.provisionalSha256, 'release identity provisionalSha256')
  validateEvidenceIdentity(record.evidence)
  validateProvenanceDigests(record.provenanceSha256)
  return record as unknown as ReleaseCandidateIdentity
}

export function releaseTargetRecord<T>(
  entries: readonly T[],
  target: (entry: T) => NativeTarget,
  label: string,
): NativeTargetRecord<T> {
  const result = Object.create(null) as Record<NativeTarget, T>
  for (const entry of entries) {
    const key = target(entry)
    if (result[key]) fail(`${label} contains duplicate target ${key}`)
    result[key] = entry
  }
  for (const key of NATIVE_TARGETS) {
    if (!result[key]) fail(`${label} is missing target ${key}`)
  }
  if (entries.length !== NATIVE_TARGETS.length) fail(`${label} must contain exactly four targets`)
  return result
}

export function validateRunId(value: unknown, label: string): string {
  return runId(value, label)
}

export function validateRunAttempt(value: unknown, label: string): number {
  return integer(value, 1, 100, label)
}

export function validateCanonicalSemver(value: unknown, label: string): string {
  const version = printableAscii(value, label, 1, 256)
  const match =
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version,
    )
  if (!match) fail(`${label} is not canonical SemVer`)
  const prerelease = match[4]
  if (!prerelease) return version
  for (const identifier of prerelease.split('.')) {
    if (/^[0-9]+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
      fail(`${label} has a noncanonical numeric prerelease identifier`)
    }
  }
  return version
}

export function validateHash(value: unknown, label: string): string {
  return hash(value, label)
}

export function validateHead(value: unknown, label: string): string {
  return head(value, label)
}

export function validateReleaseEpoch(value: unknown, label: string): number {
  return integer(value, 946_684_800, 4_102_444_800, label)
}

const RELEASE_MAX_UNCOMPRESSED_FILE_BYTES = 128 * 1024 * 1024

function validateReleaseTarball(value: unknown, label: string): ReleaseCandidateTarball {
  const record = strictRecord(value, label, [
    'file',
    'sha256',
    'bytes',
    'npmShasum',
    'npmIntegrity',
  ])
  exact(record.file, RELEASE_TARBALL_FILE, `${label} file`)
  hash(record.sha256, `${label} sha256`)
  integer(record.bytes, 1, RELEASE_MAX_TARBALL_BYTES, `${label} bytes`)
  pattern(record.npmShasum, NPM_SHASUM, `${label} npmShasum`)
  pattern(record.npmIntegrity, NPM_INTEGRITY, `${label} npmIntegrity`)
  return record as unknown as ReleaseCandidateTarball
}

function validatePackTools(value: unknown): void {
  const record = strictRecord(value, 'release provisional packTools', ['bun', 'node', 'npm'])
  validateCanonicalSemver(record.bun, 'release provisional Bun version')
  validateCanonicalSemver(record.node, 'release provisional Node version')
  validateCanonicalSemver(record.npm, 'release provisional npm version')
}

function validateSmokeTarball(value: unknown): void {
  const record = strictRecord(value, 'release smoke tarball', ['file', 'sha256', 'bytes'])
  printableAscii(record.file, 'release smoke tarball file', 1, 256)
  hash(record.sha256, 'release smoke tarball sha256')
  integer(record.bytes, 1, RELEASE_MAX_TARBALL_BYTES, 'release smoke tarball bytes')
}

function validateSmokeRunner(value: unknown, target: NativeTarget): void {
  const record = strictRecord(value, 'release smoke runner', [
    'os',
    'arch',
    'image',
    'imageVersion',
  ])
  const expected = NATIVE_TARGET_CONFIG[target]
  exact(record.os, expected.os, 'release smoke runner os')
  exact(record.arch, expected.arch, 'release smoke runner arch')
  printableAscii(record.image, 'release smoke runner image', 1, 256)
  printableAscii(record.imageVersion, 'release smoke runner imageVersion', 1, 256)
}

function validateRuntimes(value: unknown): void {
  const record = strictRecord(value, 'release smoke runtimes', ['bun', 'node'])
  validateCanonicalSemver(record.bun, 'release smoke Bun version')
  validateCanonicalSemver(record.node, 'release smoke Node version')
}

function validateSmokeChecks(value: unknown): void {
  const record = strictRecord(value, 'release smoke checks', [
    'artifactVerification',
    'packageSmoke',
    'nativeFixture',
    'abi',
    'relocation',
    'privacy',
  ])
  for (const key of Object.keys(record)) exact(record[key], 'pass', `release smoke check ${key}`)
}

function validateNativeProvenanceRecord(
  value: unknown,
  label: string,
): NativeTargetRecord<NativeArtifactProvenance> {
  const record = targetRecord(value, label)
  for (const target of NATIVE_TARGETS) {
    const provenance = validateNativeArtifactProvenance(record[target])
    if (provenance.target !== target) fail(`${label}.${target} names another target`)
  }
  return record as unknown as NativeTargetRecord<NativeArtifactProvenance>
}

function validateSmokeRecord(
  value: unknown,
  label: string,
): NativeTargetRecord<ReleaseSmokeProvenance> {
  const record = targetRecord(value, label)
  for (const target of NATIVE_TARGETS) {
    const smoke = validateReleaseSmokeProvenance(record[target])
    if (smoke.target !== target) fail(`${label}.${target} names another target`)
  }
  return record as unknown as NativeTargetRecord<ReleaseSmokeProvenance>
}

function validateRun(value: unknown, label: string): void {
  const record = strictRecord(value, label, ['id', 'attempt'])
  runId(record.id, `${label} id`)
  integer(record.attempt, 1, 100, `${label} attempt`)
}

function validateEvidenceIdentity(value: unknown): void {
  const record = strictRecord(value, 'release identity evidence', ['file', 'sha256', 'bytes'])
  exact(record.file, RELEASE_EVIDENCE_FILE, 'release identity evidence file')
  hash(record.sha256, 'release identity evidence sha256')
  integer(record.bytes, 1, RELEASE_MAX_JSON_BYTES, 'release identity evidence bytes')
}

function validateProvenanceDigests(value: unknown): void {
  const record = strictRecord(value, 'release identity provenanceSha256', [
    'assembly',
    'releaseRebuild',
    'releaseSmoke',
  ])
  validateHashRecord(record.assembly, 'release identity assembly digests')
  validateHashRecord(record.releaseRebuild, 'release identity rebuild digests')
  validateHashRecord(record.releaseSmoke, 'release identity smoke digests')
}

function validateHashRecord(value: unknown, label: string): void {
  const record = targetRecord(value, label)
  for (const target of NATIVE_TARGETS) hash(record[target], `${label}.${target}`)
}

function targetRecord(value: unknown, label: string): Record<NativeTarget, unknown> {
  const record = strictRecordValue(value, label)
  exactKeys(record, [...NATIVE_TARGETS], label)
  return record as Record<NativeTarget, unknown>
}

function strictRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  const record = strictRecordValue(value, label)
  exactKeys(record, keys, label)
  return record
}

function strictRecordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object`)
  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null)
    fail(`${label} has an invalid prototype`)
  return value as Record<string, unknown>
}

function exactKeys(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length) fail(`${label} has unknown or missing keys`)
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) fail(`${label} has unknown or missing keys`)
  }
}

function exact(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) fail(`${label} does not match`)
}

function pattern(value: unknown, expression: RegExp, label: string): string {
  if (typeof value !== 'string' || !expression.test(value)) fail(`${label} is invalid`)
  return value as string
}

function hash(value: unknown, label: string): string {
  return pattern(value, HASH, label)
}

function head(value: unknown, label: string): string {
  return pattern(value, HEAD, label)
}

function runId(value: unknown, label: string): string {
  return pattern(value, RUN_ID, label)
}

function nativeTarget(value: unknown, label: string): NativeTarget {
  if (typeof value !== 'string' || !NATIVE_TARGETS.includes(value as NativeTarget)) {
    fail(`${label} is invalid`)
  }
  return value as NativeTarget
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(`${label} is outside its integer bound`)
  }
  return value as number
}

function enumValue(value: unknown, allowed: readonly string[], label: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(`${label} is invalid`)
  return value as string
}

function printableAscii(
  value: unknown,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
): string {
  if (typeof value !== 'string') fail(`${label} is not a string`)
  const bytes = Buffer.byteLength(value as string, 'utf8')
  if (bytes < minimumBytes || bytes > maximumBytes || /[^\x20-\x7e]/.test(value as string)) {
    fail(`${label} is outside its string bound`)
  }
  return value as string
}

function relativePath(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} is not a string`)
  if (
    Buffer.byteLength(value, 'utf8') < 1 ||
    Buffer.byteLength(value, 'utf8') > RELEASE_MAX_PATH_BYTES
  ) {
    fail(`${label} is outside its byte bound`)
  }
  if (value.startsWith('/') || value.includes('\\')) fail(`${label} is not a POSIX relative path`)
  if (
    value
      .split('/')
      .some((component) => component === '' || component === '.' || component === '..')
  ) {
    fail(`${label} contains an invalid component`)
  }
  return value
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function fail(message: string): never {
  throw new ReleaseCandidateError(message)
}

export function normalizeReleaseError(error: unknown): ReleaseCandidateError {
  if (error instanceof ReleaseCandidateError) return error
  if (error instanceof NativeContractError) return new ReleaseCandidateError(error.message)
  return new ReleaseCandidateError('release candidate operation failed')
}

export function requireReleaseEpoch(value: number): void {
  if (value !== NATIVE_SOURCE_DATE_EPOCH)
    fail('release sourceDateEpoch differs from the native pin')
}
