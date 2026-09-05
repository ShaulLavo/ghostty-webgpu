import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { canonicalSha256 } from '../config-resolver-native/canonical'
import {
  validateNativeArtifactProvenance,
  type NativeArtifactProvenance,
} from '../config-resolver-native/contract'
import { type NativeTarget } from '../config-resolver-native/constants'
import {
  acquireExclusiveLock,
  assertArtifactUnchanged,
  closeAndSync,
  parseCanonicalArtifact,
  publishExclusiveFile,
  readArtifactSnapshot,
  syncDirectory,
  writeCanonicalFile,
  writeExclusiveFile,
  type ArtifactSnapshot,
} from './artifacts'
import {
  assertReleaseSnapshotsUnchanged,
  constructReleaseCandidate,
  requireCanonicalProvisionalDigest,
  verifyReleaseCandidateSnapshots,
  verifyTarballIdentity,
  type VerifiedReleaseCandidate,
} from './bundle'
import {
  RELEASE_EVIDENCE_FILE,
  RELEASE_IDENTITY_FILE,
  RELEASE_MAX_JSON_BYTES,
  RELEASE_MAX_TARBALL_BYTES,
  RELEASE_PACKAGE_NAME,
  RELEASE_PACKAGE_VERSION,
  RELEASE_PROVISIONAL_FILE,
  RELEASE_TARBALL_FILE,
} from './constants'
import { validateNpmPackJson, verifyPackedPackage } from './package'
import {
  releaseToolVersions,
  requireCleanCommittedCheckout,
  requireGeneratedOnlyPackageDiff,
  requireVerifierAtHead,
  runCommand,
  type CommandRunner,
} from './repository'
import type {
  NativeTargetRecord,
  ReleaseCandidateProvisional,
  ReleaseSmokeProvenance,
} from './types'
import {
  ReleaseCandidateError,
  releaseTargetRecord,
  requireReleaseEpoch,
  validateReleaseCandidateProvisional,
  validateReleaseSmokeProvenance,
  validateRunAttempt,
  validateRunId,
} from './validation'

const MAX_PROVENANCE_BYTES = 4 * 1024 * 1024

export type PackReleaseCandidateOptions = {
  readonly repositoryRoot: string
  readonly artifactsDirectory: string
  readonly runId: string
  readonly runAttempt: number
  readonly commandRunner?: CommandRunner
}

export type PackedReleaseCandidate = {
  readonly tarballPath: string
  readonly provisionalPath: string
  readonly provisional: ReleaseCandidateProvisional
}

export type FinalizeReleaseCandidateOptions = {
  readonly repositoryRoot: string
  readonly outputDirectory: string
  readonly runId: string
  readonly runAttempt: number
  readonly tarballPath: string
  readonly provisionalPath: string
  readonly rebuildProvenancePaths: readonly string[]
  readonly smokeProvenancePaths: readonly string[]
  readonly commandRunner?: CommandRunner
}

export type FinalizedReleaseCandidate = {
  readonly directory: string
  readonly tarballPath: string
  readonly evidencePath: string
  readonly identityPath: string
}

export type VerifyReleaseCandidateOptions = {
  readonly repositoryRoot: string
  readonly tarballPath: string
  readonly identityPath: string
  readonly evidencePath: string
  readonly commandRunner?: CommandRunner
  readonly verifyRepository?: boolean
}

export function packReleaseCandidate(options: PackReleaseCandidateOptions): PackedReleaseCandidate {
  const runId = validateRunId(options.runId, 'pack run ID')
  const runAttempt = validateRunAttempt(options.runAttempt, 'pack run attempt')
  requireAbsoluteDirectoryPath(options.artifactsDirectory, 'pack artifacts directory')
  const runner = options.commandRunner ?? runCommand
  const packageSourceHead = requireCleanCommittedCheckout(options.repositoryRoot, runner)
  verifySourcePackage(options.repositoryRoot)
  ensureArtifactDirectory(options.artifactsDirectory)

  const tarballPath = join(options.artifactsDirectory, RELEASE_TARBALL_FILE)
  const provisionalPath = join(options.artifactsDirectory, RELEASE_PROVISIONAL_FILE)
  const lockPath = join(
    options.artifactsDirectory,
    `.${RELEASE_PACKAGE_NAME}-${RELEASE_PACKAGE_VERSION}.pack.lock`,
  )
  const stagingPath = join(
    options.artifactsDirectory,
    `.${RELEASE_PACKAGE_NAME}-${RELEASE_PACKAGE_VERSION}.pack-${runId}-attempt-${runAttempt}.staging`,
  )
  requireAbsent(tarballPath, 'release candidate tarball')
  requireAbsent(provisionalPath, 'release provisional')
  requireAbsent(lockPath, 'release pack lock')
  requireAbsent(stagingPath, 'release pack staging directory')

  let lockCreated = false
  let stagingCreated = false
  let finalTarballCreated = false
  let finalProvisionalCreated = false
  try {
    const lock = acquireExclusiveLock(lockPath)
    lockCreated = true
    closeAndSync(lock)
    requireAbsent(tarballPath, 'release candidate tarball')
    requireAbsent(provisionalPath, 'release provisional')
    requireAbsent(stagingPath, 'release pack staging directory')
    mkdirSync(stagingPath, { mode: 0o700 })
    stagingCreated = true
    const tools = releaseToolVersions(options.repositoryRoot, runner)
    const npmResult = runner(
      'npm',
      ['pack', '.', '--json', '--silent', '--pack-destination', stagingPath],
      options.repositoryRoot,
    )
    if (npmResult.status !== 0 || npmResult.stderr.length !== 0) {
      throw new ReleaseCandidateError('npm pack failed')
    }
    const stagingTarball = join(stagingPath, RELEASE_TARBALL_FILE)
    requireOnlyStagingFile(stagingPath, RELEASE_TARBALL_FILE)
    const tarballSnapshot = readArtifactSnapshot(stagingTarball, RELEASE_MAX_TARBALL_BYTES)
    const packed = verifyPackedPackage(tarballSnapshot.bytes)
    validateNpmPackJson(npmResult.stdout, packed)
    const packageHeadAfterPack = requireCleanCommittedCheckout(options.repositoryRoot, runner)
    if (packageHeadAfterPack !== packageSourceHead) {
      throw new ReleaseCandidateError('package source HEAD changed during npm pack')
    }
    requireGeneratedOnlyPackageDiff(
      options.repositoryRoot,
      packageSourceHead,
      packed.manifest,
      runner,
    )
    requireReleaseEpoch(packed.manifest.sourceDateEpoch)
    const provisional = validateReleaseCandidateProvisional({
      schemaVersion: 1,
      runId,
      runAttempt,
      packageVersion: RELEASE_PACKAGE_VERSION,
      packageSourceHead,
      nativeBuildSourceHead: packed.manifest.nativeBuildSourceHead,
      nativeInputsTreeSha256: packed.manifest.nativeInputsTreeSha256,
      sourceDateEpoch: packed.manifest.sourceDateEpoch,
      upstreamRevision: packed.manifest.upstreamRevision,
      tarball: packed.tarball,
      nativeManifestSha256: packed.nativeManifestSha256,
      packedFileListSha256: packed.packedFileListSha256,
      packTools: tools,
    })
    const stagingProvisional = join(stagingPath, RELEASE_PROVISIONAL_FILE)
    writeCanonicalFile(stagingProvisional, provisional)
    syncDirectory(stagingPath)
    assertArtifactUnchanged(tarballSnapshot, RELEASE_MAX_TARBALL_BYTES)
    publishExclusiveFile(stagingTarball, tarballPath)
    finalTarballCreated = true
    publishExclusiveFile(stagingProvisional, provisionalPath)
    finalProvisionalCreated = true
    syncDirectory(options.artifactsDirectory)
    rmdirSync(stagingPath)
    stagingCreated = false
    return { tarballPath, provisionalPath, provisional }
  } catch (error) {
    if (finalProvisionalCreated) unlinkOwnedPath(provisionalPath)
    if (finalTarballCreated) unlinkOwnedPath(tarballPath)
    throw error
  } finally {
    if (stagingCreated) rmOwnedDirectory(stagingPath)
    if (lockCreated) unlinkOwnedPath(lockPath)
  }
}

export function finalizeReleaseCandidate(
  options: FinalizeReleaseCandidateOptions,
): FinalizedReleaseCandidate {
  const runId = validateRunId(options.runId, 'finalize run ID')
  const runAttempt = validateRunAttempt(options.runAttempt, 'finalize run attempt')
  requireAbsoluteFilePath(options.provisionalPath, 'finalize provisional')
  requireFilename(options.provisionalPath, RELEASE_PROVISIONAL_FILE, 'finalize provisional')
  const provisionalSnapshot = readArtifactSnapshot(options.provisionalPath, RELEASE_MAX_JSON_BYTES)
  const provisional = parseCanonicalArtifact(
    provisionalSnapshot,
    validateReleaseCandidateProvisional,
  )
  if (provisional.runId !== runId || provisional.runAttempt !== runAttempt) {
    throw new ReleaseCandidateError('finalize run differs from provisional')
  }
  requireCanonicalProvisionalDigest(provisional, provisionalSnapshot.sha256)

  requireAbsoluteFilePath(options.tarballPath, 'finalize tarball')
  requireFilename(options.tarballPath, RELEASE_TARBALL_FILE, 'finalize tarball')
  const tarballSnapshot = readArtifactSnapshot(options.tarballPath, RELEASE_MAX_TARBALL_BYTES)
  verifyTarballIdentity(tarballSnapshot.bytes, provisional)
  const packed = verifyPackedPackage(tarballSnapshot.bytes)
  const runner = options.commandRunner ?? runCommand
  requireVerifierAtHead(options.repositoryRoot, provisional.packageSourceHead, runner)

  const rebuildSnapshots = readProvenanceSnapshots(options.rebuildProvenancePaths, 'rebuild')
  const smokeSnapshots = readProvenanceSnapshots(options.smokeProvenancePaths, 'smoke')
  const releaseRebuild = loadNativeProvenanceRecord(rebuildSnapshots, 'release rebuild')
  const releaseSmoke = loadSmokeProvenanceRecord(smokeSnapshots, 'release smoke')
  const constructed = constructReleaseCandidate(
    provisional,
    provisionalSnapshot.sha256,
    packed,
    releaseRebuild,
    releaseSmoke,
  )
  assertFinalizationInputsUnchanged(
    tarballSnapshot,
    provisionalSnapshot,
    rebuildSnapshots,
    smokeSnapshots,
  )

  requireAbsoluteDirectoryPath(options.outputDirectory, 'finalize output directory')
  ensureArtifactDirectory(options.outputDirectory)
  const base = `release-final-${runId}-attempt-${runAttempt}-${provisional.tarball.sha256}`
  const lockPath = join(options.outputDirectory, `.${base}.lock`)
  const stagingPath = join(options.outputDirectory, `.${base}.staging`)
  const finalPath = join(options.outputDirectory, base)
  requireAbsent(lockPath, 'release finalizer lock')
  requireAbsent(stagingPath, 'release finalizer staging directory')
  requireAbsent(finalPath, 'release final directory')

  let lockCreated = false
  let stagingCreated = false
  try {
    const lock = acquireExclusiveLock(lockPath)
    lockCreated = true
    closeAndSync(lock)
    requireAbsent(stagingPath, 'release finalizer staging directory')
    requireAbsent(finalPath, 'release final directory')
    mkdirSync(stagingPath, { mode: 0o700 })
    stagingCreated = true
    const stagedTarball = join(stagingPath, RELEASE_TARBALL_FILE)
    const stagedEvidence = join(stagingPath, RELEASE_EVIDENCE_FILE)
    const stagedIdentity = join(stagingPath, RELEASE_IDENTITY_FILE)
    writeExclusiveFile(stagedTarball, tarballSnapshot.bytes)
    writeExclusiveFile(stagedEvidence, constructed.evidenceBytes)
    writeExclusiveFile(stagedIdentity, constructed.identityBytes)
    syncDirectory(stagingPath)
    verifyStagedRelease(stagedTarball, stagedIdentity, stagedEvidence)
    assertFinalizationInputsUnchanged(
      tarballSnapshot,
      provisionalSnapshot,
      rebuildSnapshots,
      smokeSnapshots,
    )
    requireExactDirectoryFiles(stagingPath, [
      RELEASE_TARBALL_FILE,
      RELEASE_EVIDENCE_FILE,
      RELEASE_IDENTITY_FILE,
    ])
    renameSync(stagingPath, finalPath)
    stagingCreated = false
    syncDirectory(options.outputDirectory)
    return {
      directory: finalPath,
      tarballPath: join(finalPath, RELEASE_TARBALL_FILE),
      evidencePath: join(finalPath, RELEASE_EVIDENCE_FILE),
      identityPath: join(finalPath, RELEASE_IDENTITY_FILE),
    }
  } finally {
    if (stagingCreated) rmOwnedDirectory(stagingPath)
    if (lockCreated) unlinkOwnedPath(lockPath)
  }
}

export function verifyReleaseCandidate(
  options: VerifyReleaseCandidateOptions,
): VerifiedReleaseCandidate {
  requireAbsoluteFilePath(options.tarballPath, 'verify tarball')
  requireAbsoluteFilePath(options.identityPath, 'verify identity')
  requireAbsoluteFilePath(options.evidencePath, 'verify evidence')
  const tarball = readArtifactSnapshot(options.tarballPath, RELEASE_MAX_TARBALL_BYTES)
  const identity = readArtifactSnapshot(options.identityPath, RELEASE_MAX_JSON_BYTES)
  const evidence = readArtifactSnapshot(options.evidencePath, RELEASE_MAX_JSON_BYTES)
  const verified = verifyReleaseCandidateSnapshots(tarball, identity, evidence)
  if (options.verifyRepository !== false) {
    requireVerifierAtHead(
      options.repositoryRoot,
      verified.identity.packageSourceHead,
      options.commandRunner ?? runCommand,
    )
  }
  assertReleaseSnapshotsUnchanged(tarball, identity, evidence)
  return verified
}

function readProvenanceSnapshots(
  paths: readonly string[],
  label: string,
): readonly ArtifactSnapshot[] {
  if (paths.length !== 4) throw new ReleaseCandidateError(`${label} requires exactly four files`)
  return paths.map((path) => {
    requireAbsoluteFilePath(path, `${label} provenance`)
    return readArtifactSnapshot(path, MAX_PROVENANCE_BYTES)
  })
}

function loadNativeProvenanceRecord(
  snapshots: readonly ArtifactSnapshot[],
  label: string,
): NativeTargetRecord<NativeArtifactProvenance> {
  const values = snapshots.map((snapshot) =>
    parseCanonicalArtifact(snapshot, validateNativeArtifactProvenance),
  )
  return releaseTargetRecord(values, (value) => value.target, label)
}

function loadSmokeProvenanceRecord(
  snapshots: readonly ArtifactSnapshot[],
  label: string,
): NativeTargetRecord<ReleaseSmokeProvenance> {
  const values = snapshots.map((snapshot) =>
    parseCanonicalArtifact(snapshot, validateReleaseSmokeProvenance),
  )
  return releaseTargetRecord(values, (value) => value.target, label)
}

function assertProvenanceUnchanged(snapshots: readonly ArtifactSnapshot[]): void {
  for (const snapshot of snapshots) assertArtifactUnchanged(snapshot, MAX_PROVENANCE_BYTES)
}

function assertFinalizationInputsUnchanged(
  tarball: ArtifactSnapshot,
  provisional: ArtifactSnapshot,
  rebuild: readonly ArtifactSnapshot[],
  smoke: readonly ArtifactSnapshot[],
): void {
  assertArtifactUnchanged(tarball, RELEASE_MAX_TARBALL_BYTES)
  assertArtifactUnchanged(provisional, RELEASE_MAX_JSON_BYTES)
  assertProvenanceUnchanged(rebuild)
  assertProvenanceUnchanged(smoke)
}

function verifyStagedRelease(
  tarballPath: string,
  identityPath: string,
  evidencePath: string,
): void {
  const tarball = readArtifactSnapshot(tarballPath, RELEASE_MAX_TARBALL_BYTES)
  const identity = readArtifactSnapshot(identityPath, RELEASE_MAX_JSON_BYTES)
  const evidence = readArtifactSnapshot(evidencePath, RELEASE_MAX_JSON_BYTES)
  verifyReleaseCandidateSnapshots(tarball, identity, evidence)
  assertReleaseSnapshotsUnchanged(tarball, identity, evidence)
}

function verifySourcePackage(repositoryRoot: string): void {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
  } catch {
    throw new ReleaseCandidateError('source package.json is invalid')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReleaseCandidateError('source package.json is not an object')
  }
  const record = value as Readonly<Record<string, unknown>>
  if (record.name !== RELEASE_PACKAGE_NAME || record.version !== RELEASE_PACKAGE_VERSION) {
    throw new ReleaseCandidateError('source package identity differs')
  }
}

function requireOnlyStagingFile(directory: string, filename: string): void {
  const names = readdirSync(directory)
  if (names.length !== 1 || names[0] !== filename) {
    throw new ReleaseCandidateError('npm pack staging directory has unexpected output')
  }
}

export function requireExactDirectoryFiles(directory: string, filenames: readonly string[]): void {
  const entries = readdirSync(directory, { withFileTypes: true })
  const actual = entries.map((entry) => entry.name).sort()
  const expected = [...filenames].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ReleaseCandidateError('release staging directory has unexpected output')
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new ReleaseCandidateError('release staging output is not a regular file')
    }
  }
}

function ensureArtifactDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
  const stats = lstatSync(path)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ReleaseCandidateError('release artifact directory is not a real directory')
  }
}

function requireAbsent(path: string, label: string): void {
  try {
    lstatSync(path)
  } catch (error) {
    if (isMissing(error)) return
    throw new ReleaseCandidateError(`${label} cannot be inspected`)
  }
  throw new ReleaseCandidateError(`${label} already exists`)
}

function requireAbsoluteFilePath(path: string, label: string): void {
  if (!isAbsolute(path)) throw new ReleaseCandidateError(`${label} path must be absolute`)
}

function requireAbsoluteDirectoryPath(path: string, label: string): void {
  if (!isAbsolute(path)) throw new ReleaseCandidateError(`${label} path must be absolute`)
}

function requireFilename(path: string, expected: string, label: string): void {
  if (basename(path) !== expected) throw new ReleaseCandidateError(`${label} filename differs`)
}

function isMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  )
}

function rmOwnedDirectory(path: string): void {
  try {
    rmSync(path, { force: true, recursive: true })
  } catch {
    // The caller-created staging path is the only recursive cleanup target.
  }
}

function unlinkOwnedPath(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Cleanup never expands beyond the exact path created by this invocation.
  }
}

export function releaseProvisionalSha256(provisional: ReleaseCandidateProvisional): string {
  return canonicalSha256(provisional)
}

export type ReleaseProvenanceTarget = NativeTarget
