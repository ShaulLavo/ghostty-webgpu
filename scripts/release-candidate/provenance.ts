import { lstatSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { canonicalObjectBytes, canonicalSha256 } from '../config-resolver-native/canonical'
import {
  NATIVE_MANIFEST_PATH,
  NATIVE_MAX_ARCHIVE_OVERHEAD,
  NATIVE_TARGET_CEILINGS,
  NATIVE_TARGET_CONFIG,
  NATIVE_TARGETS,
  type NativeTarget,
} from '../config-resolver-native/constants'
import {
  loadNativeManifest,
  validateNativeArtifactProvenance,
  type NativeArtifactProvenance,
  type NativeResolverManifest,
} from '../config-resolver-native/contract'
import { verifyNativeRepositoryState } from '../config-resolver-native/state'
import {
  assertArtifactUnchanged,
  parseCanonicalArtifact,
  readArtifactSnapshot,
  syncDirectory,
  writeCanonicalFile,
} from './artifacts'
import { verifyTarballIdentity } from './bundle'
import {
  RELEASE_MAX_JSON_BYTES,
  RELEASE_MAX_TARBALL_BYTES,
  RELEASE_PACKAGE_VERSION,
  RELEASE_UPSTREAM_REVISION,
} from './constants'
import { verifyPackedPackage } from './package'
import {
  releaseRuntimeVersions,
  requireCleanCommittedCheckout,
  requireGeneratedOnlyPackageDiff,
  runCommand,
  type CommandRunner,
} from './repository'
import type { ReleaseCandidateProvisional, ReleaseSmokeProvenance } from './types'
import {
  ReleaseCandidateError,
  validateHead,
  validateReleaseCandidateProvisional,
  validateReleaseSmokeProvenance,
  validateRunAttempt,
  validateRunId,
} from './validation'

const MAX_PROVENANCE_BYTES = 4 * 1024 * 1024

type RepositoryStateVerifier = (repositoryRoot: string) => void

export type VerifyReleaseRebuildOptions = {
  readonly repositoryRoot: string
  readonly packageSourceHead: string
  readonly runId: string
  readonly runAttempt: number
  readonly target: NativeTarget
  readonly runnerImage: string
  readonly runnerImageVersion: string
  readonly archivePath: string
  readonly provenancePath: string
  readonly commandRunner?: CommandRunner
  readonly verifyRepositoryState?: RepositoryStateVerifier
  readonly platform?: NodeJS.Platform
  readonly architecture?: string
}

export type CreateReleaseSmokeOptions = {
  readonly repositoryRoot: string
  readonly packageSourceHead: string
  readonly runId: string
  readonly runAttempt: number
  readonly target: NativeTarget
  readonly runnerImage: string
  readonly runnerImageVersion: string
  readonly tarballPath: string
  readonly provisionalPath: string
  readonly rebuildProvenancePath: string
  readonly outputPath: string
  readonly commandRunner?: CommandRunner
  readonly verifyRepositoryState?: RepositoryStateVerifier
  readonly platform?: NodeJS.Platform
  readonly architecture?: string
}

export function verifyReleaseRebuildProvenance(
  options: VerifyReleaseRebuildOptions,
): NativeArtifactProvenance {
  const binding = releaseBinding(options)
  requireHostTarget(
    binding.target,
    options.platform ?? process.platform,
    options.architecture ?? process.arch,
  )
  requireAbsoluteFile(options.archivePath, 'release rebuild archive')
  requireAbsoluteFile(options.provenancePath, 'release rebuild provenance')
  const runner = options.commandRunner ?? runCommand
  requirePackageCheckout(options.repositoryRoot, binding.packageSourceHead, runner)
  const verifyState = options.verifyRepositoryState ?? requireAssembledState
  verifyState(options.repositoryRoot)
  const manifest = loadNativeManifest(join(options.repositoryRoot, NATIVE_MANIFEST_PATH)).value
  requireGeneratedOnlyPackageDiff(
    options.repositoryRoot,
    binding.packageSourceHead,
    manifest,
    runner,
  )
  const provenanceSnapshot = readArtifactSnapshot(options.provenancePath, MAX_PROVENANCE_BYTES)
  const provenance = parseCanonicalArtifact(provenanceSnapshot, validateNativeArtifactProvenance)
  const archiveSnapshot = readArtifactSnapshot(
    options.archivePath,
    NATIVE_TARGET_CEILINGS[binding.target] + NATIVE_MAX_ARCHIVE_OVERHEAD,
  )
  requireRebuildMatchesManifest(manifest, provenance, binding)
  requireArchiveMatchesProvenance(options.archivePath, archiveSnapshot, provenance)
  requirePackageCheckout(options.repositoryRoot, binding.packageSourceHead, runner)
  assertArtifactUnchanged(provenanceSnapshot, MAX_PROVENANCE_BYTES)
  assertArtifactUnchanged(
    archiveSnapshot,
    NATIVE_TARGET_CEILINGS[binding.target] + NATIVE_MAX_ARCHIVE_OVERHEAD,
  )
  return provenance
}

export function createReleaseSmokeProvenance(
  options: CreateReleaseSmokeOptions,
): ReleaseSmokeProvenance {
  const binding = releaseBinding(options)
  requireAbsoluteFile(options.tarballPath, 'release smoke tarball')
  requireAbsoluteFile(options.provisionalPath, 'release smoke provisional')
  requireAbsoluteFile(options.rebuildProvenancePath, 'release smoke rebuild provenance')
  requireAbsoluteFile(options.outputPath, 'release smoke output')
  requireOutputDirectory(options.outputPath)
  requireAbsentOutput(options.outputPath)
  requireHostTarget(
    binding.target,
    options.platform ?? process.platform,
    options.architecture ?? process.arch,
  )

  const runner = options.commandRunner ?? runCommand
  requirePackageCheckout(options.repositoryRoot, binding.packageSourceHead, runner)
  const verifyState = options.verifyRepositoryState ?? requireAssembledState
  verifyState(options.repositoryRoot)

  const provisionalSnapshot = readArtifactSnapshot(options.provisionalPath, RELEASE_MAX_JSON_BYTES)
  const provisional = parseCanonicalArtifact(
    provisionalSnapshot,
    validateReleaseCandidateProvisional,
  )
  requireProvisionalBinding(provisional, binding)
  const tarballSnapshot = readArtifactSnapshot(options.tarballPath, RELEASE_MAX_TARBALL_BYTES)
  verifyTarballIdentity(tarballSnapshot.bytes, provisional)
  const packed = verifyPackedPackage(tarballSnapshot.bytes)
  requirePackedBinding(packed, provisional)
  requireGeneratedOnlyPackageDiff(
    options.repositoryRoot,
    binding.packageSourceHead,
    packed.manifest,
    runner,
  )

  const rebuildSnapshot = readArtifactSnapshot(options.rebuildProvenancePath, MAX_PROVENANCE_BYTES)
  const rebuild = parseCanonicalArtifact(rebuildSnapshot, validateNativeArtifactProvenance)
  requireRebuildMatchesManifest(packed.manifest, rebuild, binding)
  runExactPackageSmoke(options.repositoryRoot, options.tarballPath, provisional, runner)
  const runtimes = releaseRuntimeVersions(options.repositoryRoot, runner)
  requirePackageCheckout(options.repositoryRoot, binding.packageSourceHead, runner)
  const smoke = validateReleaseSmokeProvenance({
    schemaVersion: 1,
    runId: binding.runId,
    runAttempt: binding.runAttempt,
    target: binding.target,
    packageSourceHead: binding.packageSourceHead,
    nativeBuildSourceHead: provisional.nativeBuildSourceHead,
    nativeInputsTreeSha256: provisional.nativeInputsTreeSha256,
    packageVersion: RELEASE_PACKAGE_VERSION,
    upstreamRevision: RELEASE_UPSTREAM_REVISION,
    tarball: {
      file: provisional.tarball.file,
      sha256: provisional.tarball.sha256,
      bytes: provisional.tarball.bytes,
    },
    nativeManifestSha256: provisional.nativeManifestSha256,
    releaseRebuildProvenanceSha256: canonicalSha256(rebuild),
    runner: rebuild.runner,
    runtimes,
    checks: {
      artifactVerification: 'pass',
      packageSmoke: 'pass',
      nativeFixture: 'pass',
      abi: 'pass',
      relocation: 'pass',
      privacy: 'pass',
    },
  })
  requireSmokeBinding(smoke, provisional, rebuild)
  assertSmokeInputsUnchanged(tarballSnapshot, provisionalSnapshot, rebuildSnapshot)
  writeSmokeOutput(options.outputPath, smoke, () =>
    assertSmokeInputsUnchanged(tarballSnapshot, provisionalSnapshot, rebuildSnapshot),
  )
  return smoke
}

type ReleaseBinding = {
  readonly packageSourceHead: string
  readonly runId: string
  readonly runAttempt: number
  readonly target: NativeTarget
}

function releaseBinding(
  options: Pick<
    VerifyReleaseRebuildOptions,
    'packageSourceHead' | 'runId' | 'runAttempt' | 'target' | 'runnerImage' | 'runnerImageVersion'
  >,
): ReleaseBinding {
  const packageSourceHead = validateHead(options.packageSourceHead, 'release package source HEAD')
  const runId = validateRunId(options.runId, 'release provenance run ID')
  const runAttempt = validateRunAttempt(options.runAttempt, 'release provenance run attempt')
  if (!NATIVE_TARGETS.includes(options.target)) {
    throw new ReleaseCandidateError('release provenance target is invalid')
  }
  const expectedRunner = NATIVE_TARGET_CONFIG[options.target]
  requireEqual(options.runnerImage, expectedRunner.image, 'release provenance runner image')
  requireEqual(
    options.runnerImageVersion,
    expectedRunner.imageVersion,
    'release provenance runner image version',
  )
  return { packageSourceHead, runId, runAttempt, target: options.target }
}

function requirePackageCheckout(
  repositoryRoot: string,
  packageSourceHead: string,
  runner: CommandRunner,
): void {
  const actual = requireCleanCommittedCheckout(repositoryRoot, runner)
  if (actual !== packageSourceHead) {
    throw new ReleaseCandidateError('release provenance checkout differs from package source')
  }
}

function requireAssembledState(repositoryRoot: string): void {
  verifyNativeRepositoryState(repositoryRoot, 'assembled')
}

function requireRebuildMatchesManifest(
  manifest: NativeResolverManifest,
  rebuild: NativeArtifactProvenance,
  binding: ReleaseBinding,
): void {
  const assemblyTarget = manifest.targets[binding.target]
  const assembly = assemblyTarget.assemblyProvenance
  if (assemblyTarget.assemblyProvenanceSha256 !== canonicalSha256(assembly)) {
    throw new ReleaseCandidateError('assembly provenance digest differs from manifest')
  }
  requireEqual(rebuild.target, binding.target, 'release rebuild target')
  requireEqual(rebuild.runId, binding.runId, 'release rebuild run ID')
  requireEqual(rebuild.runAttempt, binding.runAttempt, 'release rebuild run attempt')
  requireEqual(
    rebuild.nativeBuildSourceHead,
    manifest.nativeBuildSourceHead,
    'release rebuild native source',
  )
  requireEqual(
    rebuild.nativeInputsTreeSha256,
    manifest.nativeInputsTreeSha256,
    'release rebuild native inputs',
  )
  requireEqual(rebuild.sourceDateEpoch, manifest.sourceDateEpoch, 'release rebuild source epoch')
  requireEqual(rebuild.upstreamRevision, manifest.upstreamRevision, 'release rebuild upstream')
  for (const key of [
    'upstreamTreeSha256',
    'runner',
    'toolchain',
    'archive',
    'files',
    'compatibility',
  ] as const) {
    requireJsonEqual(rebuild[key], assembly[key], `release rebuild ${key}`)
  }
}

function requireArchiveMatchesProvenance(
  archivePath: string,
  archive: ReturnType<typeof readArtifactSnapshot>,
  provenance: NativeArtifactProvenance,
): void {
  requireEqual(basename(archivePath), provenance.archive.file, 'release rebuild archive filename')
  requireEqual(archive.sha256, provenance.archive.sha256, 'release rebuild archive hash')
  requireEqual(archive.bytes.length, provenance.archive.bytes, 'release rebuild archive bytes')
}

function requireProvisionalBinding(
  provisional: ReleaseCandidateProvisional,
  binding: ReleaseBinding,
): void {
  requireEqual(provisional.runId, binding.runId, 'release smoke run ID')
  requireEqual(provisional.runAttempt, binding.runAttempt, 'release smoke run attempt')
  requireEqual(
    provisional.packageSourceHead,
    binding.packageSourceHead,
    'release smoke package source',
  )
}

function requirePackedBinding(
  packed: ReturnType<typeof verifyPackedPackage>,
  provisional: ReleaseCandidateProvisional,
): void {
  requireJsonEqual(packed.tarball, provisional.tarball, 'release smoke tarball')
  requireEqual(
    packed.nativeManifestSha256,
    provisional.nativeManifestSha256,
    'release smoke native manifest',
  )
  requireEqual(
    packed.packedFileListSha256,
    provisional.packedFileListSha256,
    'release smoke packed file list',
  )
  requireEqual(
    packed.manifest.nativeBuildSourceHead,
    provisional.nativeBuildSourceHead,
    'release smoke native source',
  )
  requireEqual(
    packed.manifest.nativeInputsTreeSha256,
    provisional.nativeInputsTreeSha256,
    'release smoke native inputs',
  )
  requireEqual(
    packed.manifest.sourceDateEpoch,
    provisional.sourceDateEpoch,
    'release smoke source epoch',
  )
  requireEqual(
    packed.manifest.upstreamRevision,
    provisional.upstreamRevision,
    'release smoke upstream',
  )
}

function runExactPackageSmoke(
  repositoryRoot: string,
  tarballPath: string,
  provisional: ReleaseCandidateProvisional,
  runner: CommandRunner,
): void {
  const result = runner(
    'bun',
    [join(repositoryRoot, 'scripts/package-smoke.ts'), '--tarball', tarballPath],
    repositoryRoot,
  )
  const expected = Buffer.from(`Verified packed consumer ${provisional.tarball.sha256}\n`)
  if (result.status !== 0 || result.stderr.length !== 0 || !result.stdout.equals(expected)) {
    throw new ReleaseCandidateError('exact release package smoke failed')
  }
}

function requireSmokeBinding(
  smoke: ReleaseSmokeProvenance,
  provisional: ReleaseCandidateProvisional,
  rebuild: NativeArtifactProvenance,
): void {
  requireEqual(
    smoke.nativeBuildSourceHead,
    provisional.nativeBuildSourceHead,
    'smoke native source',
  )
  requireEqual(
    smoke.nativeInputsTreeSha256,
    provisional.nativeInputsTreeSha256,
    'smoke native inputs',
  )
  requireEqual(smoke.nativeManifestSha256, provisional.nativeManifestSha256, 'smoke manifest')
  requireEqual(
    smoke.releaseRebuildProvenanceSha256,
    canonicalSha256(rebuild),
    'smoke rebuild provenance',
  )
  requireJsonEqual(smoke.runner, rebuild.runner, 'smoke runner')
}

function assertSmokeInputsUnchanged(
  tarball: ReturnType<typeof readArtifactSnapshot>,
  provisional: ReturnType<typeof readArtifactSnapshot>,
  rebuild: ReturnType<typeof readArtifactSnapshot>,
): void {
  assertArtifactUnchanged(tarball, RELEASE_MAX_TARBALL_BYTES)
  assertArtifactUnchanged(provisional, RELEASE_MAX_JSON_BYTES)
  assertArtifactUnchanged(rebuild, MAX_PROVENANCE_BYTES)
}

function writeSmokeOutput(
  outputPath: string,
  smoke: ReleaseSmokeProvenance,
  verifyInputs: () => void,
): void {
  let created = false
  try {
    writeCanonicalFile(outputPath, smoke)
    created = true
    verifyInputs()
    syncDirectory(dirname(outputPath))
  } catch (error) {
    if (created) removeCreatedOutput(outputPath)
    throw error
  }
}

function removeCreatedOutput(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // The invocation never removes a path it did not create.
  }
}

function requireOutputDirectory(path: string): void {
  const directory = dirname(path)
  const stats = lstatSync(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ReleaseCandidateError('release provenance output directory is not a real directory')
  }
}

function requireAbsentOutput(path: string): void {
  try {
    lstatSync(path)
  } catch (error) {
    if (isMissing(error)) return
    throw new ReleaseCandidateError('release provenance output cannot be inspected')
  }
  throw new ReleaseCandidateError('release provenance output already exists')
}

function isMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  )
}

function requireHostTarget(
  target: NativeTarget,
  platform: NodeJS.Platform,
  architecture: string,
): void {
  const expected = NATIVE_TARGET_CONFIG[target]
  if (platform !== expected.os || architecture !== expected.arch) {
    throw new ReleaseCandidateError('release smoke host does not match its target')
  }
}

function requireAbsoluteFile(path: string, label: string): void {
  if (!isAbsolute(path)) throw new ReleaseCandidateError(`${label} path must be absolute`)
}

function requireJsonEqual(left: unknown, right: unknown, label: string): void {
  if (!canonicalObjectBytes(left).equals(canonicalObjectBytes(right))) {
    throw new ReleaseCandidateError(`${label} differs`)
  }
}

function requireEqual(left: unknown, right: unknown, label: string): void {
  if (left !== right) throw new ReleaseCandidateError(`${label} differs`)
}
