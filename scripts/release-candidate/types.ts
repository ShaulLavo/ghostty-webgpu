import type { NativeArtifactProvenance } from '../config-resolver-native/contract'
import type { NativeTarget } from '../config-resolver-native/constants'

export type NativeTargetRecord<T> = Readonly<Record<NativeTarget, T>>

export type ReleaseCandidateTarball = {
  readonly file: 'ghostty-webgpu-0.1.2.tgz'
  readonly sha256: string
  readonly bytes: number
  readonly npmShasum: string
  readonly npmIntegrity: string
}

export type ReleaseCandidateProvisional = {
  readonly schemaVersion: 1
  readonly runId: string
  readonly runAttempt: number
  readonly packageVersion: '0.1.2'
  readonly packageSourceHead: string
  readonly nativeBuildSourceHead: string
  readonly nativeInputsTreeSha256: string
  readonly sourceDateEpoch: number
  readonly upstreamRevision: 'c8554f28e0efe2f5595f32020371c34b25ec628f'
  readonly tarball: ReleaseCandidateTarball
  readonly nativeManifestSha256: string
  readonly packedFileListSha256: string
  readonly packTools: { readonly bun: string; readonly node: string; readonly npm: string }
}

export type PackedFileRecord = {
  readonly path: string
  readonly mode: '0644' | '0755'
  readonly bytes: number
  readonly sha256: string
}

export type PackedFileList = {
  readonly schemaVersion: 1
  readonly files: readonly PackedFileRecord[]
}

export type ReleaseSmokeProvenance = {
  readonly schemaVersion: 1
  readonly runId: string
  readonly runAttempt: number
  readonly target: NativeTarget
  readonly packageSourceHead: string
  readonly nativeBuildSourceHead: string
  readonly nativeInputsTreeSha256: string
  readonly packageVersion: '0.1.2'
  readonly upstreamRevision: 'c8554f28e0efe2f5595f32020371c34b25ec628f'
  readonly tarball: { readonly file: string; readonly sha256: string; readonly bytes: number }
  readonly nativeManifestSha256: string
  readonly releaseRebuildProvenanceSha256: string
  readonly runner: {
    readonly os: 'darwin' | 'linux'
    readonly arch: 'arm64' | 'x64'
    readonly image: string
    readonly imageVersion: string
  }
  readonly runtimes: { readonly bun: string; readonly node: string }
  readonly checks: {
    readonly artifactVerification: 'pass'
    readonly packageSmoke: 'pass'
    readonly nativeFixture: 'pass'
    readonly abi: 'pass'
    readonly relocation: 'pass'
    readonly privacy: 'pass'
  }
}

export type ReleaseCandidateEvidence = {
  readonly schemaVersion: 1
  readonly provisional: ReleaseCandidateProvisional
  readonly assembly: NativeTargetRecord<NativeArtifactProvenance>
  readonly releaseRebuild: NativeTargetRecord<NativeArtifactProvenance>
  readonly releaseSmoke: NativeTargetRecord<ReleaseSmokeProvenance>
}

export type ProvenanceDigests = {
  readonly assembly: NativeTargetRecord<string>
  readonly releaseRebuild: NativeTargetRecord<string>
  readonly releaseSmoke: NativeTargetRecord<string>
}

export type ReleaseCandidateIdentity = {
  readonly schemaVersion: 1
  readonly packageVersion: '0.1.2'
  readonly packageSourceHead: string
  readonly nativeBuildSourceHead: string
  readonly nativeInputsTreeSha256: string
  readonly sourceDateEpoch: number
  readonly upstreamRevision: 'c8554f28e0efe2f5595f32020371c34b25ec628f'
  readonly assemblyRun: { readonly id: string; readonly attempt: number }
  readonly releaseRun: { readonly id: string; readonly attempt: number }
  readonly tarball: ReleaseCandidateTarball
  readonly nativeManifestSha256: string
  readonly packedFileListSha256: string
  readonly provisionalSha256: string
  readonly evidence: {
    readonly file: 'ghostty-webgpu-0.1.2.evidence.json'
    readonly sha256: string
    readonly bytes: number
  }
  readonly provenanceSha256: ProvenanceDigests
}
