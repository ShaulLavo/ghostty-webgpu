import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { canonicalObjectBytes, canonicalObjectSha256 } from '../canonicalize.js'
import {
  APPROVED_TARGET_CEILINGS,
  APPROVED_TOTAL_PACKAGE_CEILING,
  NATIVE_RESOLVER_TARGETS,
  ResolverManifestError,
  hostSupportsCompatibility,
  loadVerifiedResolverBundle,
  selectResolverTarget,
  validateNativeResolverManifest,
  type NativeArtifactFile,
  type NativeArtifactProvenance,
  type NativeCompatibility,
  type NativeResolverManifest,
  type NativeResolverTarget,
} from '../manifest.js'
import { GHOSTTY_CONFIG_UPSTREAM_REVISION } from '../types.js'

const HASH = 'a'.repeat(64)
const HEAD = 'b'.repeat(40)
const EPOCH = 1_787_590_337
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

function compatibility(target: NativeResolverTarget): NativeCompatibility {
  if (target.startsWith('darwin-')) {
    return {
      deploymentLoadCommand: 'pass',
      dynamicDependencies: ['/usr/lib/libSystem.B.dylib'],
      minimumProductVersion: '13.0.0',
      os: 'darwin',
    }
  }
  return { dynamicDependencies: [], interpreter: null, libc: 'none', os: 'linux' }
}

function provenance(
  target: NativeResolverTarget,
  files: readonly NativeArtifactFile[],
): NativeArtifactProvenance {
  const darwin = target.startsWith('darwin-')
  return {
    archive: {
      bytes: 1,
      file: `ghostty-config-resolver-${target}.tar`,
      sha256: HASH,
    },
    checks: {
      dependencies: 'pass',
      noWrite: 'pass',
      privacy: 'pass',
      relocation: 'pass',
      semantic: 'pass',
    },
    compatibility: compatibility(target),
    files,
    nativeBuildSourceHead: HEAD,
    nativeInputsTreeSha256: HASH,
    runAttempt: 1,
    runId: '33212162580',
    runner: {
      arch: target.endsWith('arm64') ? 'arm64' : 'x64',
      image: darwin ? 'macos15' : 'ubuntu24',
      imageVersion: '20260824.1',
      os: darwin ? 'darwin' : 'linux',
    },
    schemaVersion: 1,
    sourceDateEpoch: EPOCH,
    sourceTree: 'clean',
    target,
    toolchain: {
      buildRecipeSha256: HASH,
      linker: { name: 'zig-linker', sha256: HASH, version: '0.16.0' },
      sdk: darwin
        ? {
            kind: 'macos',
            sdkSettingsSha256: HASH,
            sdkVersion: '15.0',
            xcodeBuild: '16A100',
            xcodeVersion: '16.0',
          }
        : {
            kind: 'linux',
            sysrootName: 'zig-lib',
            sysrootSha256: HASH,
            sysrootVersion: '0.16.0',
          },
      strip: { name: 'strip', sha256: HASH, version: '1.0.0' },
      zig: { sha256: HASH, version: '0.16.0' },
    },
    upstreamRevision: GHOSTTY_CONFIG_UPSTREAM_REVISION,
    upstreamTreeSha256: HASH,
  }
}

function manifest(files: readonly NativeArtifactFile[]): NativeResolverManifest {
  const targets = Object.fromEntries(
    NATIVE_RESOLVER_TARGETS.map((target) => {
      const assemblyProvenance = provenance(target, files)
      return [
        target,
        {
          assemblyProvenance,
          assemblyProvenanceSha256: canonicalObjectSha256(assemblyProvenance),
          compatibility: compatibility(target),
          executablePath: 'bin/resolver',
          files,
          resourcesRoot: 'resources',
          totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
        },
      ]
    }),
  ) as unknown as NativeResolverManifest['targets']
  return {
    ceilings: {
      perTargetBytes: APPROVED_TARGET_CEILINGS,
      totalPackageBytes: APPROVED_TOTAL_PACKAGE_CEILING,
    },
    nativeBuildSourceHead: HEAD,
    nativeInputsTreeSha256: HASH,
    schemaVersion: 1,
    sourceDateEpoch: EPOCH,
    targets,
    upstreamRevision: GHOSTTY_CONFIG_UPSTREAM_REVISION,
    upstreamTreeSha256: HASH,
  }
}

function identity(
  path: string,
  bytes: Buffer,
  mode: NativeArtifactFile['mode'],
  role: NativeArtifactFile['role'],
): NativeArtifactFile {
  return {
    bytes: bytes.length,
    mode,
    path,
    role,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

describe('native resolver manifest schema', () => {
  it('accepts the exact four-target manifest and accepted ceilings', () => {
    const files = [
      identity('bin/resolver', Buffer.from('executable'), '0755', 'executable'),
      identity('resources/theme', Buffer.from('theme'), '0644', 'resource'),
    ]
    expect(validateNativeResolverManifest(manifest(files))).toBeDefined()
  })

  it('rejects drifted ceilings, provenance, ordering, and unknown fields', () => {
    const files = [
      identity('bin/resolver', Buffer.from('executable'), '0755', 'executable'),
      identity('resources/theme', Buffer.from('theme'), '0644', 'resource'),
    ]
    const wrongCeiling = structuredClone(manifest(files)) as unknown as Record<string, unknown>
    const ceilings = wrongCeiling.ceilings as { perTargetBytes: Record<string, number> }
    ceilings.perTargetBytes['linux-x64'] = ceilings.perTargetBytes['linux-x64']! + 1
    expect(() => validateNativeResolverManifest(wrongCeiling)).toThrow(ResolverManifestError)

    const unknown = structuredClone(manifest(files)) as unknown as Record<string, unknown>
    unknown.extra = true
    expect(() => validateNativeResolverManifest(unknown)).toThrow(ResolverManifestError)

    const mismatched = structuredClone(manifest(files))
    const target = mismatched.targets['linux-x64'] as unknown as Record<string, unknown>
    target.assemblyProvenanceSha256 = HASH
    expect(() => validateNativeResolverManifest(mismatched)).toThrow(ResolverManifestError)

    const mixedRun = structuredClone(manifest(files))
    const mixedTarget = mixedRun.targets['linux-x64']
    const mixedProvenance = mixedTarget.assemblyProvenance as unknown as Record<string, unknown>
    mixedProvenance.runAttempt = 2
    ;(mixedTarget as unknown as Record<string, unknown>).assemblyProvenanceSha256 =
      canonicalObjectSha256(mixedProvenance)
    expect(() => validateNativeResolverManifest(mixedRun)).toThrow(ResolverManifestError)

    const reversed = structuredClone(manifest([...files].reverse()))
    expect(() => validateNativeResolverManifest(reversed)).toThrow(ResolverManifestError)
  })
})

describe('native bundle loading', () => {
  it('resolves from the package URL and verifies every selected file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ghostty-resolver-manifest-'))
    roots.push(root)
    const nativeRoot = join(root, 'native/config-resolver')
    const targetRoot = join(nativeRoot, 'linux-x64')
    const executable = Buffer.from('verified executable')
    const resource = Buffer.from('verified resource')
    await mkdir(join(targetRoot, 'bin'), { recursive: true })
    await mkdir(join(targetRoot, 'resources'), { recursive: true })
    await writeFile(join(targetRoot, 'bin/resolver'), executable)
    await chmod(join(targetRoot, 'bin/resolver'), 0o755)
    await writeFile(join(targetRoot, 'resources/theme'), resource)
    await chmod(join(targetRoot, 'resources/theme'), 0o644)
    const files = [
      identity('bin/resolver', executable, '0755', 'executable'),
      identity('resources/theme', resource, '0644', 'resource'),
    ]
    await writeFile(join(nativeRoot, 'manifest.json'), canonicalObjectBytes(manifest(files)))
    const moduleUrl = pathToFileURL(join(root, 'dist/config-resolver/manifest.js')).href

    await expect(loadVerifiedResolverBundle('linux-x64', moduleUrl)).resolves.toEqual({
      compatibility: compatibility('linux-x64'),
      cwd: targetRoot,
      executable: join(targetRoot, 'bin/resolver'),
      resources: join(targetRoot, 'resources'),
      target: 'linux-x64',
    })

    await writeFile(join(targetRoot, 'resources/theme'), 'tampered')
    await expect(loadVerifiedResolverBundle('linux-x64', moduleUrl)).rejects.toThrow(
      ResolverManifestError,
    )
  })

  it('rejects unexpected symlinks before spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ghostty-resolver-symlink-'))
    roots.push(root)
    const nativeRoot = join(root, 'native/config-resolver')
    const targetRoot = join(nativeRoot, 'linux-x64')
    const executable = Buffer.from('verified executable')
    const resource = Buffer.from('verified resource')
    await mkdir(join(targetRoot, 'bin'), { recursive: true })
    await mkdir(join(targetRoot, 'resources'), { recursive: true })
    await writeFile(join(targetRoot, 'bin/resolver'), executable)
    await chmod(join(targetRoot, 'bin/resolver'), 0o755)
    await writeFile(join(targetRoot, 'resources/theme'), resource)
    await chmod(join(targetRoot, 'resources/theme'), 0o644)
    await symlink('theme', join(targetRoot, 'resources/alias'))
    const files = [
      identity('bin/resolver', executable, '0755', 'executable'),
      identity('resources/theme', resource, '0644', 'resource'),
    ]
    await writeFile(join(nativeRoot, 'manifest.json'), canonicalObjectBytes(manifest(files)))
    const moduleUrl = pathToFileURL(join(root, 'dist/config-resolver/manifest.js')).href
    await expect(loadVerifiedResolverBundle('linux-x64', moduleUrl)).rejects.toThrow(
      ResolverManifestError,
    )
  })
})

describe('host selection and compatibility', () => {
  it('selects only the four supported runtime identities', () => {
    expect(selectResolverTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(selectResolverTarget('linux', 'x64')).toBe('linux-x64')
    expect(selectResolverTarget('win32', 'x64')).toBeNull()
    expect(selectResolverTarget('linux', 'ia32')).toBeNull()
  })

  it('checks minimum versions and libc family before spawn', () => {
    const macosVersion = vi.fn(() => '13.0.0')
    const linuxLibc = vi.fn(() => ({ family: 'glibc' as const, version: '2.39.0' }))
    expect(
      hostSupportsCompatibility(compatibility('darwin-arm64'), { linuxLibc, macosVersion }),
    ).toBe(true)
    macosVersion.mockReturnValue('12.9.9')
    expect(
      hostSupportsCompatibility(compatibility('darwin-arm64'), { linuxLibc, macosVersion }),
    ).toBe(false)

    expect(hostSupportsCompatibility(compatibility('linux-x64'), { linuxLibc, macosVersion })).toBe(
      true,
    )
    expect(linuxLibc).not.toHaveBeenCalled()

    const dynamic: NativeCompatibility = {
      dynamicDependencies: ['libc.so.6'],
      interpreter: '/lib64/ld-linux-x86-64.so.2',
      libc: 'glibc',
      minimumVersion: '2.40.0',
      os: 'linux',
    }
    expect(hostSupportsCompatibility(dynamic, { linuxLibc, macosVersion })).toBe(false)
    linuxLibc.mockReturnValue({ family: 'glibc', version: '2.40.0-trailing' })
    expect(hostSupportsCompatibility(dynamic, { linuxLibc, macosVersion })).toBe(false)
  })
})
