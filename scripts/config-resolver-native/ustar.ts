import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  canonicalObjectBytes,
  NativeContractError,
  readStableRegularFile,
  sha256,
} from './canonical'
import { NATIVE_SOURCE_DATE_EPOCH } from './constants'
import { compareBytes } from './order'
import type { NativeArtifactFile } from './contract'

const BLOCK_BYTES = 512
const USTAR_MAGIC = Buffer.from('ustar\0', 'ascii')
const USTAR_VERSION = Buffer.from('00', 'ascii')
const MAX_ARCHIVE_BYTES = 11 * 1024 * 1024

type ParsedEntry = {
  readonly path: string
  readonly type: 'directory' | 'file'
  readonly mode: '0644' | '0755'
  readonly bytes: number
  readonly data: Buffer
}

export function writeDeterministicUstar(
  bundleRoot: string,
  files: readonly NativeArtifactFile[],
  outputPath: string,
  sourceDateEpoch: number,
): { readonly bytes: number; readonly sha256: string } {
  const entries = archiveEntries(files)
  const descriptor = openExclusive(outputPath)
  try {
    for (const entry of entries) writeArchiveEntry(descriptor, bundleRoot, entry, sourceDateEpoch)
    writeSync(descriptor, Buffer.alloc(BLOCK_BYTES * 2))
  } finally {
    closeSync(descriptor)
  }
  const bytes = readStableRegularFile(outputPath, MAX_ARCHIVE_BYTES)
  return { bytes: bytes.length, sha256: sha256(bytes) }
}

export function verifyUstarArchive(
  archivePath: string,
  expectedFiles: readonly NativeArtifactFile[],
  sourceDateEpoch = NATIVE_SOURCE_DATE_EPOCH,
): readonly ParsedEntry[] {
  const bytes = readStableRegularFile(archivePath, MAX_ARCHIVE_BYTES)
  const entries = parseArchive(bytes, sourceDateEpoch)
  verifyArchiveFileProjection(entries, expectedFiles)
  return entries
}

export function extractVerifiedUstar(entries: readonly ParsedEntry[], destination: string): void {
  mkdirSync(destination, { mode: 0o755 })
  for (const entry of entries) {
    const path = join(destination, ...entry.path.split('/'))
    if (entry.type === 'directory') {
      mkdirSync(path, { mode: 0o755 })
      continue
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
    writeFileSync(path, entry.data, { flag: 'wx', mode: Number.parseInt(entry.mode, 8) })
    chmodSync(path, Number.parseInt(entry.mode, 8))
  }
}

export function archiveIdentityPreimage(entries: readonly ParsedEntry[]): Buffer {
  return canonicalObjectBytes(
    entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        bytes: entry.bytes,
        sha256: sha256(entry.data),
      })),
  )
}

function archiveEntries(files: readonly NativeArtifactFile[]): readonly ParsedEntry[] {
  const result = new Map<string, ParsedEntry>()
  for (const file of files) {
    addParentDirectories(result, file.path)
    result.set(file.path, {
      path: file.path,
      type: 'file',
      mode: file.mode,
      bytes: file.bytes,
      data: Buffer.alloc(0),
    })
  }
  return [...result.values()].sort((left, right) => compareBytes(left.path, right.path))
}

function addParentDirectories(entries: Map<string, ParsedEntry>, path: string): void {
  const components = path.split('/')
  for (let index = 1; index < components.length; index += 1) {
    const parent = components.slice(0, index).join('/')
    if (entries.has(parent)) continue
    entries.set(parent, {
      path: parent,
      type: 'directory',
      mode: '0755',
      bytes: 0,
      data: Buffer.alloc(0),
    })
  }
}

function writeArchiveEntry(
  descriptor: number,
  root: string,
  entry: ParsedEntry,
  sourceDateEpoch: number,
): void {
  if (entry.type === 'directory') {
    writeSync(descriptor, createHeader(entry.path, entry.mode, 0, sourceDateEpoch, entry.type))
    return
  }
  const path = join(root, ...entry.path.split('/'))
  const before = assertArchiveInput(path, entry)
  const data = readStableRegularFile(path, entry.bytes)
  const after = assertArchiveInput(path, entry)
  if (!sameArchiveInput(before, after)) {
    throw new NativeContractError('archive input changed while it was read')
  }
  if (data.length !== entry.bytes) throw new NativeContractError('archive input length changed')
  const header = createHeader(entry.path, entry.mode, data.length, sourceDateEpoch, entry.type)
  writeSync(descriptor, header)
  if (data.length === 0) return
  writeSync(descriptor, data)
  const padding = paddingBytes(data.length)
  if (padding > 0) writeSync(descriptor, Buffer.alloc(padding))
}

function createHeader(
  path: string,
  mode: '0644' | '0755',
  bytes: number,
  epoch: number,
  type: ParsedEntry['type'],
): Buffer {
  const header = Buffer.alloc(BLOCK_BYTES)
  const names = splitUstarPath(type === 'directory' ? `${path}/` : path)
  writeText(header, 0, 100, names.name)
  writeOctal(header, 100, 8, Number.parseInt(mode, 8))
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, bytes)
  writeOctal(header, 136, 12, epoch)
  header.fill(0x20, 148, 156)
  header[156] = type === 'directory' ? 0x35 : 0x30
  USTAR_MAGIC.copy(header, 257)
  USTAR_VERSION.copy(header, 263)
  writeText(header, 345, 155, names.prefix)
  writeChecksum(header)
  return header
}

function parseArchive(bytes: Buffer, sourceDateEpoch: number): readonly ParsedEntry[] {
  if (bytes.length < BLOCK_BYTES * 2 || bytes.length % BLOCK_BYTES !== 0) {
    throw new NativeContractError('ustar length is invalid')
  }
  const entries: ParsedEntry[] = []
  const seen = new Set<string>()
  let offset = 0
  while (offset + BLOCK_BYTES * 2 <= bytes.length) {
    if (zeroBlock(bytes.subarray(offset, offset + BLOCK_BYTES))) break
    const parsed = parseHeader(bytes, offset, sourceDateEpoch)
    offset += BLOCK_BYTES
    if (offset + parsed.bytes > bytes.length)
      throw new NativeContractError('ustar entry is truncated')
    const data = Buffer.from(bytes.subarray(offset, offset + parsed.bytes))
    offset += parsed.bytes
    const padding = paddingBytes(parsed.bytes)
    if (!zeroBlock(bytes.subarray(offset, offset + padding))) {
      throw new NativeContractError('ustar entry padding is not zero')
    }
    offset += padding
    if (seen.has(parsed.path)) throw new NativeContractError('ustar contains a duplicate path')
    seen.add(parsed.path)
    entries.push({ ...parsed, data })
  }
  if (offset + BLOCK_BYTES * 2 !== bytes.length) {
    throw new NativeContractError('ustar has trailing or missing end blocks')
  }
  if (!zeroBlock(bytes.subarray(offset, offset + BLOCK_BYTES * 2))) {
    throw new NativeContractError('ustar end blocks are invalid')
  }
  assertSortedEntries(entries)
  return entries
}

function parseHeader(
  bytes: Buffer,
  offset: number,
  sourceDateEpoch: number,
): Omit<ParsedEntry, 'data'> {
  const header = bytes.subarray(offset, offset + BLOCK_BYTES)
  if (!header.subarray(257, 263).equals(USTAR_MAGIC)) {
    throw new NativeContractError('archive is not POSIX ustar')
  }
  if (!header.subarray(263, 265).equals(USTAR_VERSION)) {
    throw new NativeContractError('archive ustar version is invalid')
  }
  verifyHeaderChecksum(header)
  verifyEmptyHeaderIdentityFields(header)
  if (readOctal(header, 136, 12) !== sourceDateEpoch) {
    throw new NativeContractError('ustar entry timestamp is not canonical')
  }
  const typeflag = header[156]
  if (typeflag !== 0x30 && typeflag !== 0x35) {
    throw new NativeContractError('ustar entry type is not allowed')
  }
  const directory = typeflag === 0x35
  const rawPath = joinedHeaderPath(header)
  const path = normalizeArchivePath(directory ? removeDirectorySlash(rawPath) : rawPath)
  const modeNumber = readOctal(header, 100, 8)
  const mode = modeNumber === 0o755 ? '0755' : modeNumber === 0o644 ? '0644' : null
  if (!mode) throw new NativeContractError('ustar entry mode is not canonical')
  const entryBytes = readOctal(header, 124, 12)
  if (directory && (entryBytes !== 0 || mode !== '0755')) {
    throw new NativeContractError('ustar directory metadata is invalid')
  }
  return { path, type: directory ? 'directory' : 'file', mode, bytes: entryBytes }
}

function verifyArchiveFileProjection(
  entries: readonly ParsedEntry[],
  expectedFiles: readonly NativeArtifactFile[],
): void {
  const expected = expectedFiles.map((file) => ({
    path: file.path,
    mode: file.mode,
    bytes: file.bytes,
    sha256: file.sha256,
  }))
  const actual = entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      bytes: entry.bytes,
      sha256: sha256(entry.data),
    }))
  if (!canonicalObjectBytes(actual).equals(canonicalObjectBytes(expected))) {
    throw new NativeContractError('ustar files do not match provenance')
  }
  const expectedDirectories = archiveEntries(expectedFiles)
    .filter((entry) => entry.type === 'directory')
    .map((entry) => entry.path)
  const actualDirectories = entries
    .filter((entry) => entry.type === 'directory')
    .map((entry) => entry.path)
  if (JSON.stringify(actualDirectories) !== JSON.stringify(expectedDirectories)) {
    throw new NativeContractError('ustar directory set does not match provenance')
  }
}

function splitUstarPath(path: string): { readonly name: string; readonly prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  const slashes = [...path.matchAll(/\//g)].map((match) => match.index)
  for (let index = slashes.length - 1; index >= 0; index -= 1) {
    const slash = slashes[index]
    if (slash === undefined) continue
    const prefix = path.slice(0, slash)
    const name = path.slice(slash + 1)
    if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100 || name.length === 0)
      continue
    return { name, prefix }
  }
  throw new NativeContractError('path does not fit a POSIX ustar header')
}

function joinedHeaderPath(header: Buffer): string {
  const name = readText(header, 0, 100)
  const prefix = readText(header, 345, 155)
  if (!prefix) return name
  return `${prefix}/${name}`
}

function normalizeArchivePath(path: string): string {
  if (!path || path.startsWith('/') || path.includes('\\')) {
    throw new NativeContractError('ustar path is not relative POSIX')
  }
  if (Buffer.byteLength(path) > 240) throw new NativeContractError('ustar path exceeds its bound')
  const components = path.split('/')
  if (components.some((component) => !component || component === '.' || component === '..')) {
    throw new NativeContractError('ustar path contains an invalid component')
  }
  return path
}

function removeDirectorySlash(path: string): string {
  if (!path.endsWith('/')) throw new NativeContractError('ustar directory lacks a trailing slash')
  return path.slice(0, -1)
}

function verifyEmptyHeaderIdentityFields(header: Buffer): void {
  if (readOctal(header, 108, 8) !== 0 || readOctal(header, 116, 8) !== 0) {
    throw new NativeContractError('ustar uid or gid is not zero')
  }
  if (readText(header, 265, 32) || readText(header, 297, 32)) {
    throw new NativeContractError('ustar owner or group name is not empty')
  }
  if (!zeroBlock(header.subarray(157, 257))) {
    throw new NativeContractError('ustar link name is not empty')
  }
  if (!zeroBlock(header.subarray(329, 345)) || !zeroBlock(header.subarray(500, 512))) {
    throw new NativeContractError('ustar device or padding fields are not empty')
  }
}

function assertArchiveInput(path: string, entry: ParsedEntry): Stats {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new NativeContractError('archive input is not a real regular file')
  }
  if ((stat.mode & 0o777) !== Number.parseInt(entry.mode, 8) || stat.size !== entry.bytes) {
    throw new NativeContractError('archive input metadata differs from provenance')
  }
  return stat
}

function sameArchiveInput(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function verifyHeaderChecksum(header: Buffer): void {
  const expected = readOctal(header, 148, 8)
  const copy = Buffer.from(header)
  copy.fill(0x20, 148, 156)
  let actual = 0
  for (const byte of copy) actual += byte
  if (actual !== expected) throw new NativeContractError('ustar header checksum is invalid')
}

function writeChecksum(header: Buffer): void {
  let checksum = 0
  for (const byte of header) checksum += byte
  const value = checksum.toString(8).padStart(6, '0')
  header.write(value, 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new NativeContractError('invalid ustar number')
  const octal = value.toString(8)
  if (octal.length > length - 1) throw new NativeContractError('ustar number does not fit')
  header.write(octal.padStart(length - 1, '0'), offset, length - 1, 'ascii')
  header[offset + length - 1] = 0
}

function readOctal(header: Buffer, offset: number, length: number): number {
  const field = header.subarray(offset, offset + length)
  const text = trimUstarPadding(field.toString('ascii'))
  if (!/^[0-7]+$/.test(text)) throw new NativeContractError('ustar octal field is malformed')
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value)) throw new NativeContractError('ustar number exceeds its bound')
  return value
}

function trimUstarPadding(value: string): string {
  let length = value.length
  while (length > 0 && (value.charCodeAt(length - 1) === 0 || value[length - 1] === ' '))
    length -= 1
  return value.slice(0, length)
}

function writeText(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > length) throw new NativeContractError('ustar text does not fit')
  bytes.copy(header, offset)
}

function readText(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length)
  const zero = field.indexOf(0)
  const end = zero < 0 ? field.length : zero
  const value = field.subarray(0, end).toString('utf8')
  if (Buffer.from(value, 'utf8').length !== end)
    throw new NativeContractError('ustar text is invalid UTF-8')
  if (field.subarray(end).some((byte) => byte !== 0)) {
    throw new NativeContractError('ustar text padding is not zero')
  }
  return value
}

function assertSortedEntries(entries: readonly ParsedEntry[]): void {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]
    const current = entries[index]
    if (!previous || !current || compareBytes(previous.path, current.path) >= 0) {
      throw new NativeContractError('ustar entries are not sorted and unique')
    }
  }
}

function openExclusive(path: string): number {
  return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644)
}

function paddingBytes(bytes: number): number {
  return (BLOCK_BYTES - (bytes % BLOCK_BYTES)) % BLOCK_BYTES
}

function zeroBlock(bytes: Buffer): boolean {
  return bytes.every((byte) => byte === 0)
}
