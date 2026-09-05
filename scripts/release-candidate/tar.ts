import { gunzipSync } from 'node:zlib'
import { sha256 } from '../config-resolver-native/canonical'
import {
  RELEASE_MAX_FILES,
  RELEASE_MAX_PATH_BYTES,
  RELEASE_MAX_UNCOMPRESSED_BYTES,
} from './constants'
import type { PackedFileList, PackedFileRecord } from './types'
import { ReleaseCandidateError, validatePackedFileList } from './validation'

const TAR_BLOCK_BYTES = 512
const TAR_END_BLOCKS = 2

export type InspectedPackageTar = {
  readonly fileList: PackedFileList
  readonly contents: ReadonlyMap<string, Buffer>
  readonly directories: readonly string[]
}

export function inspectPackageTarball(bytes: Uint8Array): InspectedPackageTar {
  const tar = decompressTarball(bytes)
  if (tar.length === 0 || tar.length % TAR_BLOCK_BYTES !== 0) {
    throw new ReleaseCandidateError('package tar has an invalid block length')
  }

  const files: PackedFileRecord[] = []
  const contents = new Map<string, Buffer>()
  const directories: string[] = []
  const paths = new Set<string>()
  const filePaths = new Set<string>()
  let offset = 0

  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES)
    if (isZeroBlock(header)) {
      validateTarEnd(tar, offset)
      offset = tar.length
      continue
    }
    if (files.length + directories.length >= RELEASE_MAX_FILES) {
      throw new ReleaseCandidateError('package tar has too many entries')
    }
    const entry = parseHeader(header)
    const contentStart = offset + TAR_BLOCK_BYTES
    const paddedBytes = Math.ceil(entry.bytes / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
    const contentEnd = contentStart + entry.bytes
    const nextHeader = contentStart + paddedBytes
    if (nextHeader > tar.length) throw new ReleaseCandidateError('package tar entry is truncated')
    requireZeroPadding(tar.subarray(contentEnd, nextHeader))
    const path = packagePath(entry.path, entry.directory)
    if (paths.has(path)) throw new ReleaseCandidateError('package tar contains a duplicate path')
    validatePathTypes(path, entry.directory, paths, filePaths)
    paths.add(path)
    if (entry.directory) {
      directories.push(path)
      offset = nextHeader
      continue
    }
    const content = Buffer.from(tar.subarray(contentStart, contentEnd))
    const record = { path, mode: entry.mode, bytes: entry.bytes, sha256: sha256(content) } as const
    files.push(record)
    filePaths.add(path)
    contents.set(path, content)
    offset = nextHeader
  }

  files.sort((left, right) => compareUtf8(left.path, right.path))
  directories.sort(compareUtf8)
  const fileList = validatePackedFileList({ schemaVersion: 1, files })
  return { fileList, contents, directories }
}

function validatePathTypes(
  path: string,
  directory: boolean,
  paths: ReadonlySet<string>,
  files: ReadonlySet<string>,
): void {
  const components = path.split('/')
  for (let length = 1; length < components.length; length += 1) {
    const parent = components.slice(0, length).join('/')
    if (files.has(parent)) {
      throw new ReleaseCandidateError('package tar nests an entry beneath a regular file')
    }
  }
  if (directory) return
  for (const existing of paths) {
    if (existing.startsWith(`${path}/`)) {
      throw new ReleaseCandidateError('package tar regular file contains an existing entry')
    }
  }
}

function decompressTarball(bytes: Uint8Array): Buffer {
  try {
    return gunzipSync(bytes, { maxOutputLength: RELEASE_MAX_UNCOMPRESSED_BYTES })
  } catch {
    throw new ReleaseCandidateError('package tarball is not a bounded gzip archive')
  }
}

function parseHeader(header: Buffer): {
  readonly path: string
  readonly mode: '0644' | '0755'
  readonly bytes: number
  readonly directory: boolean
} {
  validateChecksum(header)
  const magic = header.subarray(257, 263)
  const version = header.subarray(263, 265)
  if (!magic.equals(Buffer.from('ustar\0')) || !version.equals(Buffer.from('00'))) {
    throw new ReleaseCandidateError('package tar entry is not POSIX ustar')
  }
  const name = tarString(header.subarray(0, 100), 'package tar entry name')
  const prefix = tarString(header.subarray(345, 500), 'package tar entry prefix')
  const path = prefix ? `${prefix}/${name}` : name
  const type = header[156]
  if (type !== 0 && type !== 0x30 && type !== 0x35) {
    throw new ReleaseCandidateError('package tar contains a disallowed entry type')
  }
  if (tarString(header.subarray(157, 257), 'package tar link name')) {
    throw new ReleaseCandidateError('package tar entry has a link target')
  }
  const directory = type === 0x35
  const bytes = tarNumber(header.subarray(124, 136), 'package tar entry size')
  if (directory && bytes !== 0)
    throw new ReleaseCandidateError('package tar directory is not empty')
  const numericMode = tarNumber(header.subarray(100, 108), 'package tar entry mode')
  if (directory && numericMode !== 0o755) {
    throw new ReleaseCandidateError('package tar directory mode is not canonical')
  }
  if (!directory && numericMode !== 0o644 && numericMode !== 0o755) {
    throw new ReleaseCandidateError('package tar file mode is not canonical')
  }
  return {
    path,
    mode: numericMode === 0o755 ? '0755' : '0644',
    bytes,
    directory,
  }
}

function packagePath(raw: string, directory: boolean): string {
  if (!raw.startsWith('package/')) {
    throw new ReleaseCandidateError('package tar entry is outside the package/ prefix')
  }
  if (raw.includes('\\') || raw.startsWith('/') || raw.includes('\0')) {
    throw new ReleaseCandidateError('package tar entry path is invalid')
  }
  if (directory && !raw.endsWith('/')) {
    throw new ReleaseCandidateError('package tar directory lacks a canonical trailing slash')
  }
  if (!directory && raw.endsWith('/')) {
    throw new ReleaseCandidateError('package tar file has a trailing slash')
  }
  const withoutPrefix = raw.slice('package/'.length)
  const path = directory && withoutPrefix.endsWith('/') ? withoutPrefix.slice(0, -1) : withoutPrefix
  if (path === '' && directory) return path
  if (path === '') throw new ReleaseCandidateError('package tar file has an empty path')
  if (Buffer.byteLength(path, 'utf8') > RELEASE_MAX_PATH_BYTES) {
    throw new ReleaseCandidateError('package tar entry path exceeds its byte bound')
  }
  const components = path.split('/')
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    throw new ReleaseCandidateError('package tar entry path has an invalid component')
  }
  return path
}

function validateChecksum(header: Buffer): void {
  const expected = tarNumber(header.subarray(148, 156), 'package tar header checksum')
  let actual = 0
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0)
  }
  if (actual !== expected) throw new ReleaseCandidateError('package tar header checksum differs')
}

function tarString(field: Buffer, label: string): string {
  const zero = field.indexOf(0)
  const end = zero < 0 ? field.length : zero
  if (zero >= 0 && field.subarray(zero).some((byte) => byte !== 0)) {
    throw new ReleaseCandidateError(`${label} has nonzero bytes after NUL`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(field.subarray(0, end))
  } catch {
    throw new ReleaseCandidateError(`${label} is not valid UTF-8`)
  }
}

function tarNumber(field: Buffer, label: string): number {
  if ((field[0] ?? 0) & 0x80) throw new ReleaseCandidateError(`${label} uses base-256 encoding`)
  const source = trimTarNumber(field.toString('ascii'))
  if (!/^[0-7]+$/.test(source)) throw new ReleaseCandidateError(`${label} is not octal`)
  const value = Number.parseInt(source, 8)
  if (!Number.isSafeInteger(value)) throw new ReleaseCandidateError(`${label} exceeds its bound`)
  return value
}

function trimTarNumber(value: string): string {
  let start = 0
  while (value[start] === ' ') start += 1
  let end = value.length
  while (value[end - 1] === ' ' || value[end - 1] === '\0') end -= 1
  return value.slice(start, end)
}

function validateTarEnd(tar: Buffer, offset: number): void {
  const requiredEnd = offset + TAR_END_BLOCKS * TAR_BLOCK_BYTES
  if (requiredEnd > tar.length) throw new ReleaseCandidateError('package tar lacks two end blocks')
  if (!isZeroBlock(tar.subarray(offset + TAR_BLOCK_BYTES, requiredEnd))) {
    throw new ReleaseCandidateError('package tar has only one end block')
  }
  if (requiredEnd !== tar.length) {
    throw new ReleaseCandidateError('package tar contains data after its end blocks')
  }
}

function requireZeroPadding(bytes: Buffer): void {
  if (bytes.some((byte) => byte !== 0)) {
    throw new ReleaseCandidateError('package tar contains nonzero trailing or padding data')
  }
}

function isZeroBlock(block: Buffer): boolean {
  return block.length === TAR_BLOCK_BYTES && block.every((byte) => byte === 0)
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}
