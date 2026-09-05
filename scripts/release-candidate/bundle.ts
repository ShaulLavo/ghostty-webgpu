import { basename } from 'node:path'
import { canonicalObjectBytes, canonicalSha256 } from '../config-resolver-native/canonical'
import type {
  NativeArtifactProvenance,
  NativeResolverManifest,
} from '../config-resolver-native/contract'
import { NATIVE_TARGETS, type NativeTarget } from '../config-resolver-native/constants'
import {
  RELEASE_EVIDENCE_FILE,
  RELEASE_IDENTITY_FILE,
  RELEASE_MAX_JSON_BYTES,
  RELEASE_MAX_TARBALL_BYTES,
  RELEASE_PACKAGE_VERSION,
  RELEASE_TARBALL_FILE,
  RELEASE_UPSTREAM_REVISION,
} from './constants'
import { assertArtifactUnchanged, parseCanonicalArtifact, type ArtifactSnapshot } from './artifacts'
import { releaseTarballIdentity, verifyPackedPackage, type VerifiedPackedPackage } from './package'
import type {
  NativeTargetRecord,
  ProvenanceDigests,
  ReleaseCandidateEvidence,
  ReleaseCandidateIdentity,
  ReleaseCandidateProvisional,
  ReleaseSmokeProvenance,
} from './types'
import {
  ReleaseCandidateError,
  validateReleaseCandidateEvidence,
  validateReleaseCandidateIdentity,
} from './validation'

export type VerifiedReleaseCandidate = {
  readonly identity: ReleaseCandidateIdentity
  readonly evidence: ReleaseCandidateEvidence
  readonly packed: VerifiedPackedPackage
}

export type ConstructedReleaseCandidate = {
  readonly evidence: ReleaseCandidateEvidence
  readonly evidenceBytes: Buffer
  readonly identity: ReleaseCandidateIdentity
  readonly identityBytes: Buffer
}

export function constructReleaseCandidate(
  provisional: ReleaseCandidateProvisional,
  provisionalSha256: string,
  packed: VerifiedPackedPackage,
  releaseRebuild: NativeTargetRecord<NativeArtifactProvenance>,
  releaseSmoke: NativeTargetRecord<ReleaseSmokeProvenance>,
): ConstructedReleaseCandidate {
  const assembly = assemblyFromManifest(packed.manifest)
  const evidence = validateReleaseCandidateEvidence({
    schemaVersion: 1,
    provisional,
    assembly,
    releaseRebuild,
    releaseSmoke,
  })
  const evidenceBytes = canonicalObjectBytes(evidence)
  const provenanceSha256 = provenanceDigests(evidence)
  const assemblyRun = commonRun(evidence.assembly, 'assembly')
  const identity = validateReleaseCandidateIdentity({
    schemaVersion: 1,
    packageVersion: RELEASE_PACKAGE_VERSION,
    packageSourceHead: provisional.packageSourceHead,
    nativeBuildSourceHead: provisional.nativeBuildSourceHead,
    nativeInputsTreeSha256: provisional.nativeInputsTreeSha256,
    sourceDateEpoch: provisional.sourceDateEpoch,
    upstreamRevision: RELEASE_UPSTREAM_REVISION,
    assemblyRun: { id: assemblyRun.runId, attempt: assemblyRun.runAttempt },
    releaseRun: { id: provisional.runId, attempt: provisional.runAttempt },
    tarball: provisional.tarball,
    nativeManifestSha256: provisional.nativeManifestSha256,
    packedFileListSha256: provisional.packedFileListSha256,
    provisionalSha256,
    evidence: {
      file: RELEASE_EVIDENCE_FILE,
      sha256: canonicalSha256(evidence),
      bytes: evidenceBytes.length,
    },
    provenanceSha256,
  })
  const identityBytes = canonicalObjectBytes(identity)
  verifyReleaseRecords(packed, identity, evidence, evidenceBytes)
  return { evidence, evidenceBytes, identity, identityBytes }
}

export function verifyReleaseCandidateSnapshots(
  tarball: ArtifactSnapshot,
  identityFile: ArtifactSnapshot,
  evidenceFile: ArtifactSnapshot,
): VerifiedReleaseCandidate {
  requireFilename(tarball.path, RELEASE_TARBALL_FILE, 'release tarball')
  requireFilename(identityFile.path, RELEASE_IDENTITY_FILE, 'release identity')
  requireFilename(evidenceFile.path, RELEASE_EVIDENCE_FILE, 'release evidence')
  const identity = parseCanonicalArtifact(identityFile, validateReleaseCandidateIdentity)
  const evidence = parseCanonicalArtifact(evidenceFile, validateReleaseCandidateEvidence)
  const packed = verifyPackedPackage(tarball.bytes)
  verifyReleaseRecords(packed, identity, evidence, evidenceFile.bytes)
  if (tarball.sha256 !== identity.tarball.sha256) {
    throw new ReleaseCandidateError('release tarball snapshot hash differs')
  }
  return { identity, evidence, packed }
}

export function assertReleaseSnapshotsUnchanged(
  tarball: ArtifactSnapshot,
  identity: ArtifactSnapshot,
  evidence: ArtifactSnapshot,
): void {
  assertArtifactUnchanged(tarball, RELEASE_MAX_TARBALL_BYTES)
  assertArtifactUnchanged(identity, RELEASE_MAX_JSON_BYTES)
  assertArtifactUnchanged(evidence, RELEASE_MAX_JSON_BYTES)
}

function verifyReleaseRecords(
  packed: VerifiedPackedPackage,
  identity: ReleaseCandidateIdentity,
  evidence: ReleaseCandidateEvidence,
  evidenceBytes: Uint8Array,
): void {
  const provisional = evidence.provisional
  requireEqual(identity.packageVersion, provisional.packageVersion, 'package version')
  requireEqual(identity.packageSourceHead, provisional.packageSourceHead, 'package source head')
  requireEqual(
    identity.nativeBuildSourceHead,
    provisional.nativeBuildSourceHead,
    'native source head',
  )
  requireEqual(
    identity.nativeInputsTreeSha256,
    provisional.nativeInputsTreeSha256,
    'native inputs tree',
  )
  requireEqual(identity.sourceDateEpoch, provisional.sourceDateEpoch, 'source date epoch')
  requireEqual(identity.upstreamRevision, provisional.upstreamRevision, 'upstream revision')
  requireJsonEqual(identity.tarball, provisional.tarball, 'tarball identity')
  requireEqual(
    identity.nativeManifestSha256,
    provisional.nativeManifestSha256,
    'native manifest digest',
  )
  requireEqual(
    identity.packedFileListSha256,
    provisional.packedFileListSha256,
    'packed file-list digest',
  )
  requireEqual(identity.provisionalSha256, canonicalSha256(provisional), 'provisional digest')
  requireEqual(identity.evidence.sha256, canonicalSha256(evidence), 'evidence digest')
  requireEqual(identity.evidence.bytes, evidenceBytes.byteLength, 'evidence byte length')
  requireEqual(packed.nativeManifestSha256, identity.nativeManifestSha256, 'packed manifest digest')
  requireEqual(
    packed.packedFileListSha256,
    identity.packedFileListSha256,
    'packed file-list digest',
  )
  requireJsonEqual(packed.tarball, identity.tarball, 'packed tarball identity')
  verifyManifestIdentity(packed.manifest, provisional)
  verifyEvidenceRunsAndProvenance(packed.manifest, identity, evidence)
  requireJsonEqual(identity.provenanceSha256, provenanceDigests(evidence), 'provenance digests')
}

function verifyManifestIdentity(
  manifest: NativeResolverManifest,
  provisional: ReleaseCandidateProvisional,
): void {
  requireEqual(
    manifest.nativeBuildSourceHead,
    provisional.nativeBuildSourceHead,
    'manifest native head',
  )
  requireEqual(
    manifest.nativeInputsTreeSha256,
    provisional.nativeInputsTreeSha256,
    'manifest native inputs',
  )
  requireEqual(manifest.sourceDateEpoch, provisional.sourceDateEpoch, 'manifest source epoch')
  requireEqual(
    manifest.upstreamRevision,
    provisional.upstreamRevision,
    'manifest upstream revision',
  )
}

function verifyEvidenceRunsAndProvenance(
  manifest: NativeResolverManifest,
  identity: ReleaseCandidateIdentity,
  evidence: ReleaseCandidateEvidence,
): void {
  const assemblyRun = commonRun(evidence.assembly, 'assembly')
  requireEqual(identity.assemblyRun.id, assemblyRun.runId, 'assembly run ID')
  requireEqual(identity.assemblyRun.attempt, assemblyRun.runAttempt, 'assembly run attempt')
  requireEqual(identity.releaseRun.id, evidence.provisional.runId, 'release run ID')
  requireEqual(identity.releaseRun.attempt, evidence.provisional.runAttempt, 'release run attempt')

  for (const target of NATIVE_TARGETS) {
    const assembly = evidence.assembly[target]
    const embedded = manifest.targets[target].assemblyProvenance
    const rebuild = evidence.releaseRebuild[target]
    const smoke = evidence.releaseSmoke[target]
    requireJsonEqual(assembly, embedded, `${target} embedded assembly provenance`)
    verifyNativeIdentity(assembly, evidence.provisional, target)
    verifyReleaseRebuild(assembly, rebuild, evidence.provisional, target)
    verifyReleaseSmoke(rebuild, smoke, evidence.provisional, target)
  }
}

function verifyNativeIdentity(
  provenance: NativeArtifactProvenance,
  provisional: ReleaseCandidateProvisional,
  target: NativeTarget,
): void {
  requireEqual(provenance.target, target, `${target} provenance target`)
  requireEqual(
    provenance.nativeBuildSourceHead,
    provisional.nativeBuildSourceHead,
    `${target} native source head`,
  )
  requireEqual(
    provenance.nativeInputsTreeSha256,
    provisional.nativeInputsTreeSha256,
    `${target} native inputs`,
  )
  requireEqual(provenance.sourceDateEpoch, provisional.sourceDateEpoch, `${target} source epoch`)
  requireEqual(provenance.upstreamRevision, provisional.upstreamRevision, `${target} upstream`)
}

function verifyReleaseRebuild(
  assembly: NativeArtifactProvenance,
  rebuild: NativeArtifactProvenance,
  provisional: ReleaseCandidateProvisional,
  target: NativeTarget,
): void {
  verifyNativeIdentity(rebuild, provisional, target)
  requireEqual(rebuild.runId, provisional.runId, `${target} rebuild run ID`)
  requireEqual(rebuild.runAttempt, provisional.runAttempt, `${target} rebuild run attempt`)
  for (const key of [
    'upstreamTreeSha256',
    'runner',
    'toolchain',
    'archive',
    'files',
    'compatibility',
  ] as const) {
    requireJsonEqual(rebuild[key], assembly[key], `${target} rebuild ${key}`)
  }
}

function verifyReleaseSmoke(
  rebuild: NativeArtifactProvenance,
  smoke: ReleaseSmokeProvenance,
  provisional: ReleaseCandidateProvisional,
  target: NativeTarget,
): void {
  requireEqual(smoke.target, target, `${target} smoke target`)
  requireEqual(smoke.runId, provisional.runId, `${target} smoke run ID`)
  requireEqual(smoke.runAttempt, provisional.runAttempt, `${target} smoke run attempt`)
  requireEqual(
    smoke.packageSourceHead,
    provisional.packageSourceHead,
    `${target} smoke package head`,
  )
  requireEqual(
    smoke.nativeBuildSourceHead,
    provisional.nativeBuildSourceHead,
    `${target} smoke native head`,
  )
  requireEqual(
    smoke.nativeInputsTreeSha256,
    provisional.nativeInputsTreeSha256,
    `${target} smoke native inputs`,
  )
  requireEqual(smoke.packageVersion, provisional.packageVersion, `${target} smoke package version`)
  requireEqual(smoke.upstreamRevision, provisional.upstreamRevision, `${target} smoke upstream`)
  requireJsonEqual(
    smoke.tarball,
    {
      file: provisional.tarball.file,
      sha256: provisional.tarball.sha256,
      bytes: provisional.tarball.bytes,
    },
    `${target} smoke tarball`,
  )
  requireEqual(
    smoke.nativeManifestSha256,
    provisional.nativeManifestSha256,
    `${target} smoke manifest`,
  )
  requireEqual(
    smoke.releaseRebuildProvenanceSha256,
    canonicalSha256(rebuild),
    `${target} smoke rebuild provenance`,
  )
  requireJsonEqual(smoke.runner, rebuild.runner, `${target} smoke runner`)
}

function assemblyFromManifest(
  manifest: NativeResolverManifest,
): NativeTargetRecord<NativeArtifactProvenance> {
  return Object.fromEntries(
    NATIVE_TARGETS.map((target) => [target, manifest.targets[target].assemblyProvenance]),
  ) as NativeTargetRecord<NativeArtifactProvenance>
}

function commonRun(
  record: NativeTargetRecord<NativeArtifactProvenance>,
  label: string,
): NativeArtifactProvenance {
  const first = record[NATIVE_TARGETS[0]]
  for (const target of NATIVE_TARGETS.slice(1)) {
    const candidate = record[target]
    requireEqual(candidate.runId, first.runId, `${label} run ID`)
    requireEqual(candidate.runAttempt, first.runAttempt, `${label} run attempt`)
  }
  return first
}

function provenanceDigests(evidence: ReleaseCandidateEvidence): ProvenanceDigests {
  return {
    assembly: digestRecord(evidence.assembly),
    releaseRebuild: digestRecord(evidence.releaseRebuild),
    releaseSmoke: digestRecord(evidence.releaseSmoke),
  }
}

function digestRecord<T>(record: NativeTargetRecord<T>): NativeTargetRecord<string> {
  return Object.fromEntries(
    NATIVE_TARGETS.map((target) => [target, canonicalSha256(record[target])]),
  ) as NativeTargetRecord<string>
}

function requireFilename(path: string, expected: string, label: string): void {
  if (basename(path) !== expected) throw new ReleaseCandidateError(`${label} filename differs`)
}

function requireJsonEqual(left: unknown, right: unknown, label: string): void {
  if (!canonicalObjectBytes(left).equals(canonicalObjectBytes(right))) {
    throw new ReleaseCandidateError(`${label} differs`)
  }
}

function requireEqual(left: unknown, right: unknown, label: string): void {
  if (left !== right) throw new ReleaseCandidateError(`${label} differs`)
}

export function verifyTarballIdentity(
  bytes: Uint8Array,
  expected: ReleaseCandidateProvisional,
): void {
  requireJsonEqual(releaseTarballIdentity(bytes), expected.tarball, 'provisional tarball identity')
}

export function requireCanonicalProvisionalDigest(
  provisional: ReleaseCandidateProvisional,
  digest: string,
): void {
  requireEqual(canonicalSha256(provisional), digest, 'provisional canonical digest')
}
