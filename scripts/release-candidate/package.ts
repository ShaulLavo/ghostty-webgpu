import { createHash } from 'node:crypto'
import { canonicalObjectBytes, canonicalSha256, sha256 } from '../config-resolver-native/canonical'
import {
  validateNativeResolverManifest,
  type NativeResolverManifest,
} from '../config-resolver-native/contract'
import { NATIVE_TARGETS } from '../config-resolver-native/constants'
import {
  RELEASE_NATIVE_MANIFEST_PATH,
  RELEASE_NATIVE_ROOT,
  RELEASE_PACKAGE_NAME,
  RELEASE_PACKAGE_VERSION,
  RELEASE_TARBALL_FILE,
} from './constants'
import { inspectPackageTarball, type InspectedPackageTar } from './tar'
import type { PackedFileRecord, ReleaseCandidateTarball } from './types'
import { ReleaseCandidateError } from './validation'

export type VerifiedPackedPackage = InspectedPackageTar & {
  readonly manifest: NativeResolverManifest
  readonly nativeManifestSha256: string
  readonly packedFileListSha256: string
  readonly tarball: ReleaseCandidateTarball
}

export function verifyPackedPackage(bytes: Uint8Array): VerifiedPackedPackage {
  const inspected = inspectPackageTarball(bytes)
  verifyPackageJson(inspected)
  const manifestBytes = inspected.contents.get(RELEASE_NATIVE_MANIFEST_PATH)
  if (!manifestBytes) throw new ReleaseCandidateError('package tar omits its native manifest')
  const manifest = parsePackagedManifest(manifestBytes)
  verifyManifestRunIdentity(manifest)
  verifyPackagedNativeFiles(inspected, manifest)
  const tarball = releaseTarballIdentity(bytes)
  return {
    ...inspected,
    manifest,
    nativeManifestSha256: sha256(manifestBytes),
    packedFileListSha256: canonicalSha256(inspected.fileList),
    tarball,
  }
}

export function releaseTarballIdentity(bytes: Uint8Array): ReleaseCandidateTarball {
  const buffer = Buffer.from(bytes)
  return {
    file: RELEASE_TARBALL_FILE,
    sha256: sha256(buffer),
    bytes: buffer.length,
    npmShasum: createHash('sha1').update(buffer).digest('hex'),
    npmIntegrity: `sha512-${createHash('sha512').update(buffer).digest('base64')}`,
  }
}

export function validateNpmPackJson(stdout: Uint8Array, packed: VerifiedPackedPackage): void {
  if (stdout.byteLength < 2 || stdout.byteLength > 1024 * 1024) {
    throw new ReleaseCandidateError('npm pack JSON is outside its byte bound')
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout))
  } catch {
    throw new ReleaseCandidateError('npm pack did not emit one valid JSON record')
  }
  if (!Array.isArray(value) || value.length !== 1) {
    throw new ReleaseCandidateError('npm pack did not emit exactly one package record')
  }
  const record = objectValue(value[0], 'npm pack record')
  exact(record.name, RELEASE_PACKAGE_NAME, 'npm pack package name')
  exact(record.version, RELEASE_PACKAGE_VERSION, 'npm pack package version')
  exact(record.filename, RELEASE_TARBALL_FILE, 'npm pack filename')
  exact(record.size, packed.tarball.bytes, 'npm pack byte length')
  exact(record.shasum, packed.tarball.npmShasum, 'npm pack shasum')
  exact(record.integrity, packed.tarball.npmIntegrity, 'npm pack integrity')
  validateNpmFileList(record, packed.fileList.files)
}

function verifyPackageJson(inspected: InspectedPackageTar): void {
  const bytes = inspected.contents.get('package.json')
  if (!bytes) throw new ReleaseCandidateError('package tar omits package.json')
  const record = findFile(inspected.fileList.files, 'package.json')
  if (record.mode !== '0644') throw new ReleaseCandidateError('packed package.json mode differs')
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ReleaseCandidateError('packed package.json is invalid')
  }
  const packageRecord = objectValue(value, 'packed package.json')
  exact(packageRecord.name, RELEASE_PACKAGE_NAME, 'packed package name')
  exact(packageRecord.version, RELEASE_PACKAGE_VERSION, 'packed package version')
}

function parsePackagedManifest(bytes: Buffer): NativeResolverManifest {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ReleaseCandidateError('packaged native manifest is invalid JSON')
  }
  if (!bytes.equals(canonicalObjectBytes(value))) {
    throw new ReleaseCandidateError('packaged native manifest is not canonical JSON+LF')
  }
  return validateNativeResolverManifest(value)
}

function verifyPackagedNativeFiles(
  inspected: InspectedPackageTar,
  manifest: NativeResolverManifest,
): void {
  const expected = new Map<
    string,
    { readonly bytes: number; readonly sha256: string; readonly mode: string }
  >()
  expected.set(RELEASE_NATIVE_MANIFEST_PATH, {
    bytes: inspected.contents.get(RELEASE_NATIVE_MANIFEST_PATH)?.length ?? -1,
    sha256: sha256(inspected.contents.get(RELEASE_NATIVE_MANIFEST_PATH) ?? Buffer.alloc(0)),
    mode: '0644',
  })
  for (const target of NATIVE_TARGETS) {
    const targetManifest = manifest.targets[target]
    if (
      targetManifest.assemblyProvenanceSha256 !== canonicalSha256(targetManifest.assemblyProvenance)
    ) {
      throw new ReleaseCandidateError(`${target} assembly provenance digest differs`)
    }
    for (const file of targetManifest.files) {
      expected.set(`${RELEASE_NATIVE_ROOT}/${target}/${file.path}`, file)
    }
  }

  for (const [path, expectedFile] of expected) {
    const actual = findFile(inspected.fileList.files, path)
    if (
      actual.bytes !== expectedFile.bytes ||
      actual.sha256 !== expectedFile.sha256 ||
      actual.mode !== expectedFile.mode
    ) {
      throw new ReleaseCandidateError(`packed native file identity differs: ${path}`)
    }
  }
  for (const file of inspected.fileList.files) {
    if (file.path !== 'native' && !file.path.startsWith('native/')) continue
    if (!expected.has(file.path))
      throw new ReleaseCandidateError('package contains an unexpected native file')
  }
  verifyNativeDirectories(inspected.directories, expected)
}

function verifyNativeDirectories(
  directories: readonly string[],
  expectedFiles: ReadonlyMap<string, unknown>,
): void {
  const allowed = new Set<string>(['native', RELEASE_NATIVE_ROOT])
  for (const path of expectedFiles.keys()) {
    const components = path.split('/')
    components.pop()
    while (components.length > 0) {
      allowed.add(components.join('/'))
      components.pop()
    }
  }
  for (const path of directories) {
    if (path !== 'native' && !path.startsWith('native/')) continue
    if (!allowed.has(path))
      throw new ReleaseCandidateError('package contains an unexpected native directory')
  }
}

function verifyManifestRunIdentity(manifest: NativeResolverManifest): void {
  const first = manifest.targets[NATIVE_TARGETS[0]].assemblyProvenance
  for (const target of NATIVE_TARGETS.slice(1)) {
    const provenance = manifest.targets[target].assemblyProvenance
    if (provenance.runId !== first.runId || provenance.runAttempt !== first.runAttempt) {
      throw new ReleaseCandidateError('native manifest mixes assembly runs')
    }
    if (provenance.toolchain.buildRecipeSha256 !== first.toolchain.buildRecipeSha256) {
      throw new ReleaseCandidateError('native manifest mixes build recipes')
    }
  }
}

function validateNpmFileList(
  record: Readonly<Record<string, unknown>>,
  expected: readonly PackedFileRecord[],
): void {
  if (!Array.isArray(record.files)) throw new ReleaseCandidateError('npm pack files are absent')
  const files = record.files.map((value, index) => {
    const file = objectValue(value, `npm pack files[${index}]`)
    if (typeof file.path !== 'string')
      throw new ReleaseCandidateError('npm pack file path is invalid')
    if (!Number.isSafeInteger(file.size))
      throw new ReleaseCandidateError('npm pack file size is invalid')
    if (file.mode !== 0o644 && file.mode !== 0o755) {
      throw new ReleaseCandidateError('npm pack file mode is invalid')
    }
    return { path: file.path, bytes: file.size, mode: file.mode === 0o755 ? '0755' : '0644' }
  })
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  if (files.length !== expected.length)
    throw new ReleaseCandidateError('npm pack file count differs')
  for (let index = 0; index < files.length; index += 1) {
    const left = files[index]
    const right = expected[index]
    if (
      !left ||
      !right ||
      left.path !== right.path ||
      left.bytes !== right.bytes ||
      left.mode !== right.mode
    ) {
      throw new ReleaseCandidateError('npm pack file list differs from the tar')
    }
  }
  exact(record.entryCount, expected.length, 'npm pack entryCount')
  const unpackedBytes = expected.reduce((total, file) => total + file.bytes, 0)
  exact(record.unpackedSize, unpackedBytes, 'npm pack unpackedSize')
}

function findFile(files: readonly PackedFileRecord[], path: string): PackedFileRecord {
  const file = files.find((candidate) => candidate.path === path)
  if (!file) throw new ReleaseCandidateError(`package omits required file: ${path}`)
  return file
}

function objectValue(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReleaseCandidateError(`${label} is not an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function exact(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) throw new ReleaseCandidateError(`${label} differs`)
}
