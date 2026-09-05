import { gzipSync } from 'node:zlib'
import {
  canonicalObjectBytes,
  canonicalSha256,
  sha256,
} from '../../config-resolver-native/canonical'
import type {
  NativeArtifactFile,
  NativeArtifactProvenance,
  NativeCompatibility,
  NativeResolverManifest,
  NativeToolchain,
} from '../../config-resolver-native/contract'
import {
  NATIVE_EXECUTABLE_PATH,
  NATIVE_RESOURCES_ROOT,
  NATIVE_SOURCE_DATE_EPOCH,
  NATIVE_TARGET_CEILINGS,
  NATIVE_TARGET_CONFIG,
  NATIVE_TARGETS,
  NATIVE_TOTAL_CEILING,
  NATIVE_UPSTREAM_REVISION,
  NATIVE_UPSTREAM_TREE_SHA256,
  type NativeTarget,
} from '../../config-resolver-native/constants'
import { RELEASE_PACKAGE_NAME, RELEASE_PACKAGE_VERSION } from '../constants'
import { releaseTarballIdentity, verifyPackedPackage } from '../package'
import type {
  NativeTargetRecord,
  ReleaseCandidateProvisional,
  ReleaseSmokeProvenance,
} from '../types'

export const ASSEMBLY_RUN_ID = '111111'
export const RELEASE_RUN_ID = '222222'
export const RELEASE_RUN_ATTEMPT = 2
export const NATIVE_HEAD = 'a'.repeat(40)
export const PACKAGE_HEAD = 'b'.repeat(40)
export const INPUTS_HASH = 'c'.repeat(64)

export type TarEntry = {
  readonly path: string
  readonly bytes: Buffer
  readonly mode: 0o644 | 0o755
  readonly type?: string
  readonly linkname?: string
}

export type ReleaseFixture = {
  readonly entries: readonly TarEntry[]
  readonly tarball: Buffer
  readonly manifest: NativeResolverManifest
  readonly rebuild: NativeTargetRecord<NativeArtifactProvenance>
  readonly smoke: NativeTargetRecord<ReleaseSmokeProvenance>
  readonly provisional: ReleaseCandidateProvisional
  readonly npmJson: Buffer
}

export function createReleaseFixture(): ReleaseFixture {
  const packageFiles = new Map<string, TarEntry>()
  const manifestTargets = Object.fromEntries(
    NATIVE_TARGETS.map((target) => {
      const executable = Buffer.from(`resolver-${target}`)
      const resource = Buffer.from(`theme-${target}`)
      const files = artifactFiles(target, executable, resource)
      packageFiles.set(`native/config-resolver/${target}/${NATIVE_EXECUTABLE_PATH}`, {
        path: `package/native/config-resolver/${target}/${NATIVE_EXECUTABLE_PATH}`,
        bytes: executable,
        mode: 0o755,
      })
      packageFiles.set(`native/config-resolver/${target}/${NATIVE_RESOURCES_ROOT}/fixture`, {
        path: `package/native/config-resolver/${target}/${NATIVE_RESOURCES_ROOT}/fixture`,
        bytes: resource,
        mode: 0o644,
      })
      const compatibility = targetCompatibility(target)
      const assemblyProvenance = provenance(target, ASSEMBLY_RUN_ID, 1, files, compatibility)
      return [
        target,
        {
          executablePath: NATIVE_EXECUTABLE_PATH,
          resourcesRoot: NATIVE_RESOURCES_ROOT,
          totalBytes: executable.length + resource.length,
          files,
          compatibility,
          assemblyProvenance,
          assemblyProvenanceSha256: canonicalSha256(assemblyProvenance),
        },
      ]
    }),
  ) as NativeResolverManifest['targets']
  const manifest: NativeResolverManifest = {
    schemaVersion: 1,
    upstreamRevision: NATIVE_UPSTREAM_REVISION,
    upstreamTreeSha256: NATIVE_UPSTREAM_TREE_SHA256,
    nativeBuildSourceHead: NATIVE_HEAD,
    nativeInputsTreeSha256: INPUTS_HASH,
    sourceDateEpoch: NATIVE_SOURCE_DATE_EPOCH,
    ceilings: {
      perTargetBytes: NATIVE_TARGET_CEILINGS,
      totalPackageBytes: NATIVE_TOTAL_CEILING,
    },
    targets: manifestTargets,
  }
  packageFiles.set('native/config-resolver/manifest.json', {
    path: 'package/native/config-resolver/manifest.json',
    bytes: canonicalObjectBytes(manifest),
    mode: 0o644,
  })
  packageFiles.set('package.json', {
    path: 'package/package.json',
    bytes: Buffer.from(
      `${JSON.stringify({ name: RELEASE_PACKAGE_NAME, version: RELEASE_PACKAGE_VERSION })}\n`,
    ),
    mode: 0o644,
  })
  const entries = [...packageFiles.values()]
  const tarball = createTar(entries)
  const packed = verifyPackedPackage(tarball)
  const rebuild = Object.fromEntries(
    NATIVE_TARGETS.map((target) => [
      target,
      provenance(
        target,
        RELEASE_RUN_ID,
        RELEASE_RUN_ATTEMPT,
        manifest.targets[target].files,
        manifest.targets[target].compatibility,
      ),
    ]),
  ) as NativeTargetRecord<NativeArtifactProvenance>
  const smoke = Object.fromEntries(
    NATIVE_TARGETS.map((target) => [
      target,
      smokeProvenance(target, packed.nativeManifestSha256, packed.tarball, rebuild[target]),
    ]),
  ) as NativeTargetRecord<ReleaseSmokeProvenance>
  const provisional: ReleaseCandidateProvisional = {
    schemaVersion: 1,
    runId: RELEASE_RUN_ID,
    runAttempt: RELEASE_RUN_ATTEMPT,
    packageVersion: RELEASE_PACKAGE_VERSION,
    packageSourceHead: PACKAGE_HEAD,
    nativeBuildSourceHead: NATIVE_HEAD,
    nativeInputsTreeSha256: INPUTS_HASH,
    sourceDateEpoch: NATIVE_SOURCE_DATE_EPOCH,
    upstreamRevision: NATIVE_UPSTREAM_REVISION,
    tarball: packed.tarball,
    nativeManifestSha256: packed.nativeManifestSha256,
    packedFileListSha256: packed.packedFileListSha256,
    packTools: { bun: '1.3.10', node: '22.12.0', npm: '11.6.2' },
  }
  return { entries, tarball, manifest, rebuild, smoke, provisional, npmJson: npmPackJson(tarball) }
}

export function createTar(entries: readonly TarEntry[], trailing = Buffer.alloc(0)): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    blocks.push(tarHeader(entry))
    blocks.push(entry.bytes)
    const padding = (512 - (entry.bytes.length % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024), trailing)
  return gzipSync(Buffer.concat(blocks), { level: 9 })
}

function artifactFiles(
  target: NativeTarget,
  executable: Buffer,
  resource: Buffer,
): readonly NativeArtifactFile[] {
  return [
    {
      role: 'executable',
      path: NATIVE_EXECUTABLE_PATH,
      sha256: sha256(executable),
      bytes: executable.length,
      mode: '0755',
    },
    {
      role: 'resource',
      path: `${NATIVE_RESOURCES_ROOT}/fixture`,
      sha256: sha256(resource),
      bytes: resource.length,
      mode: '0644',
    },
  ]
}

function provenance(
  target: NativeTarget,
  runId: string,
  runAttempt: number,
  files: readonly NativeArtifactFile[],
  compatibility: NativeCompatibility,
): NativeArtifactProvenance {
  return {
    schemaVersion: 1,
    runId,
    runAttempt,
    nativeBuildSourceHead: NATIVE_HEAD,
    nativeInputsTreeSha256: INPUTS_HASH,
    sourceTree: 'clean',
    sourceDateEpoch: NATIVE_SOURCE_DATE_EPOCH,
    target,
    upstreamRevision: NATIVE_UPSTREAM_REVISION,
    upstreamTreeSha256: NATIVE_UPSTREAM_TREE_SHA256,
    runner: {
      os: NATIVE_TARGET_CONFIG[target].os,
      arch: NATIVE_TARGET_CONFIG[target].arch,
      image: NATIVE_TARGET_CONFIG[target].image,
      imageVersion: NATIVE_TARGET_CONFIG[target].imageVersion,
    },
    toolchain: toolchain(target),
    archive: {
      file: `ghostty-config-resolver-${target}.tar`,
      sha256: 'd'.repeat(64),
      bytes: 1024,
    },
    files,
    compatibility,
    checks: {
      semantic: 'pass',
      noWrite: 'pass',
      privacy: 'pass',
      relocation: 'pass',
      dependencies: 'pass',
    },
  }
}

function toolchain(target: NativeTarget): NativeToolchain {
  const sdk = target.startsWith('darwin-')
    ? {
        kind: 'macos' as const,
        xcodeVersion: '16.0',
        xcodeBuild: '16A123',
        sdkVersion: '15.0',
        sdkSettingsSha256: 'e'.repeat(64),
      }
    : {
        kind: 'linux' as const,
        sysrootName: 'musl',
        sysrootVersion: '1.2.5',
        sysrootSha256: 'e'.repeat(64),
      }
  return {
    zig: { version: '0.16.0', sha256: '1'.repeat(64) },
    linker: { name: 'linker', version: '1.0.0', sha256: '2'.repeat(64) },
    strip: { name: 'strip', version: '1.0.0', sha256: '3'.repeat(64) },
    sdk,
    buildRecipeSha256: '4'.repeat(64),
  }
}

function targetCompatibility(target: NativeTarget): NativeCompatibility {
  if (target.startsWith('darwin-')) {
    return {
      os: 'darwin',
      minimumProductVersion: '13.0',
      deploymentLoadCommand: 'pass',
      dynamicDependencies: [],
    }
  }
  return { os: 'linux', libc: 'none', interpreter: null, dynamicDependencies: [] }
}

function smokeProvenance(
  target: NativeTarget,
  nativeManifestSha256: string,
  tarball: ReturnType<typeof releaseTarballIdentity>,
  rebuild: NativeArtifactProvenance,
): ReleaseSmokeProvenance {
  return {
    schemaVersion: 1,
    runId: RELEASE_RUN_ID,
    runAttempt: RELEASE_RUN_ATTEMPT,
    target,
    packageSourceHead: PACKAGE_HEAD,
    nativeBuildSourceHead: NATIVE_HEAD,
    nativeInputsTreeSha256: INPUTS_HASH,
    packageVersion: RELEASE_PACKAGE_VERSION,
    upstreamRevision: NATIVE_UPSTREAM_REVISION,
    tarball: { file: tarball.file, sha256: tarball.sha256, bytes: tarball.bytes },
    nativeManifestSha256,
    releaseRebuildProvenanceSha256: canonicalSha256(rebuild),
    runner: rebuild.runner,
    runtimes: { bun: '1.3.10', node: '22.12.0' },
    checks: {
      artifactVerification: 'pass',
      packageSmoke: 'pass',
      nativeFixture: 'pass',
      abi: 'pass',
      relocation: 'pass',
      privacy: 'pass',
    },
  }
}

function npmPackJson(tarball: Buffer): Buffer {
  const packed = verifyPackedPackage(tarball)
  const unpackedSize = packed.fileList.files.reduce((total, file) => total + file.bytes, 0)
  return Buffer.from(
    JSON.stringify([
      {
        name: RELEASE_PACKAGE_NAME,
        version: RELEASE_PACKAGE_VERSION,
        filename: packed.tarball.file,
        size: packed.tarball.bytes,
        unpackedSize,
        shasum: packed.tarball.npmShasum,
        integrity: packed.tarball.npmIntegrity,
        entryCount: packed.fileList.files.length,
        files: packed.fileList.files.map((file) => ({
          path: file.path,
          size: file.bytes,
          mode: file.mode === '0755' ? 0o755 : 0o644,
        })),
      },
    ]),
  )
}

function tarHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(512)
  writeText(header, 0, 100, entry.path)
  writeOctal(header, 100, 8, entry.mode)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, entry.bytes.length)
  writeOctal(header, 136, 12, NATIVE_SOURCE_DATE_EPOCH)
  header.fill(0x20, 148, 156)
  header[156] = (entry.type ?? '0').charCodeAt(0)
  if (entry.linkname) writeText(header, 157, 100, entry.linkname)
  writeText(header, 257, 6, 'ustar\0')
  writeText(header, 263, 2, '00')
  const checksum = header.reduce((total, byte) => total + byte, 0)
  const checksumText = checksum.toString(8).padStart(6, '0')
  writeText(header, 148, 6, checksumText)
  header[154] = 0
  header[155] = 0x20
  return header
}

function writeOctal(target: Buffer, offset: number, width: number, value: number): void {
  const source = value.toString(8).padStart(width - 1, '0')
  writeText(target, offset, width - 1, source)
  target[offset + width - 1] = 0
}

function writeText(target: Buffer, offset: number, width: number, value: string): void {
  const bytes = Buffer.from(value)
  if (bytes.length > width) throw new Error('fixture tar field is too long')
  bytes.copy(target, offset)
}
