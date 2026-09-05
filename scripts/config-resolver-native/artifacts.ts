import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { NativeContractError, readStableRegularFile, sha256 } from './canonical'
import {
  NATIVE_EXECUTABLE_PATH,
  NATIVE_RESOURCES_ROOT,
  NATIVE_TARGET_CEILINGS,
  type NativeTarget,
} from './constants'
import type { NativeArtifactFile, NativeCompatibility } from './contract'
import { compareBytes } from './order'

const LC_LOAD_DYLIB = 0x0c
const LC_LOAD_WEAK_DYLIB = 0x80000018
const LC_REEXPORT_DYLIB = 0x8000001f
const LC_LOAD_UPWARD_DYLIB = 0x80000023
const LC_UUID = 0x1b
const LC_SEGMENT_64 = 0x19
const LC_SYMTAB = 0x02
const MAX_LOAD_COMMANDS = 4096
const MAX_MACHO_SECTIONS = 4096
const MAX_MACHO_SYMBOLS = 1_000_000
const MAX_ELF_PROGRAM_HEADERS = 1024
const MAX_FONT_PAYLOAD_BYTES = 16 * 1024 * 1024
const FONT_SLICE_BYTES = 512
const FONT_SLICE_COUNT = 4
const MIN_FONT_SLICE_DISTINCT_BYTES = 64

export const DARWIN_DYNAMIC_DEPENDENCIES = [
  '/System/Library/Frameworks/Carbon.framework/Versions/A/Carbon',
  '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation',
  '/System/Library/Frameworks/CoreGraphics.framework/Versions/A/CoreGraphics',
  '/System/Library/Frameworks/CoreText.framework/Versions/A/CoreText',
  '/System/Library/Frameworks/CoreVideo.framework/Versions/A/CoreVideo',
  '/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation',
  '/System/Library/Frameworks/IOSurface.framework/Versions/A/IOSurface',
  '/System/Library/Frameworks/QuartzCore.framework/Versions/A/QuartzCore',
  '/usr/lib/libSystem.B.dylib',
  '/usr/lib/libobjc.A.dylib',
] as const

export function inspectNativeBundle(
  bundleRoot: string,
  target: NativeTarget,
): {
  readonly files: readonly NativeArtifactFile[]
  readonly totalBytes: number
  readonly compatibility: NativeCompatibility
} {
  const files = collectBundleFiles(bundleRoot, target)
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
  if (totalBytes > NATIVE_TARGET_CEILINGS[target]) {
    throw new NativeContractError(`${target} bundle exceeds its accepted ceiling`)
  }
  const executable = join(bundleRoot, ...NATIVE_EXECUTABLE_PATH.split('/'))
  const compatibility = inspectNativeBinary(executable, target)
  return { files, totalBytes, compatibility }
}

export function inspectNativeBinary(path: string, target: NativeTarget): NativeCompatibility {
  const artifact = readStableRegularFile(path, NATIVE_TARGET_CEILINGS[target])
  if (target.startsWith('darwin-')) return inspectMachO(artifact, target)
  return inspectElf(artifact, target)
}

export function assertNoEmbeddedFontPayloads(
  path: string,
  target: NativeTarget,
  fontPaths: readonly string[],
): void {
  const artifact = readStableRegularFile(path, NATIVE_TARGET_CEILINGS[target])
  if (fontPaths.length !== 7) {
    throw new NativeContractError('native font-input guard lacks its exact source set')
  }
  for (const fontPath of fontPaths) {
    const payload = readStableRegularFile(fontPath, MAX_FONT_PAYLOAD_BYTES)
    assertFontPayloadAbsent(artifact, payload)
  }
}

function assertFontPayloadAbsent(artifact: Buffer, payload: Buffer): void {
  if (artifact.indexOf(payload) >= 0) {
    throw new NativeContractError('native binary embeds a complete excluded font payload')
  }
  for (const slice of distinctiveFontSlices(payload)) {
    if (artifact.indexOf(slice) < 0) continue
    throw new NativeContractError('native binary embeds an excluded font payload slice')
  }
}

function distinctiveFontSlices(payload: Buffer): readonly Buffer[] {
  if (payload.length < FONT_SLICE_BYTES * FONT_SLICE_COUNT) {
    throw new NativeContractError('native font input is too short for payload inspection')
  }
  const candidates: { readonly offset: number; readonly score: number }[] = []
  for (let offset = 0; offset + FONT_SLICE_BYTES <= payload.length; offset += FONT_SLICE_BYTES) {
    const slice = payload.subarray(offset, offset + FONT_SLICE_BYTES)
    candidates.push({ offset, score: distinctByteCount(slice) })
  }
  candidates.sort((left, right) => right.score - left.score || left.offset - right.offset)
  const selected = candidates.slice(0, FONT_SLICE_COUNT)
  if (
    selected.length !== FONT_SLICE_COUNT ||
    selected.some((candidate) => candidate.score < MIN_FONT_SLICE_DISTINCT_BYTES)
  ) {
    throw new NativeContractError('native font input lacks distinctive payload slices')
  }
  return selected.map(({ offset }) => payload.subarray(offset, offset + FONT_SLICE_BYTES))
}

function distinctByteCount(bytes: Buffer): number {
  const present = new Uint8Array(256)
  let count = 0
  for (const byte of bytes) {
    if (present[byte] !== 0) continue
    present[byte] = 1
    count += 1
  }
  return count
}

function collectBundleFiles(root: string, target: NativeTarget): readonly NativeArtifactFile[] {
  const files: NativeArtifactFile[] = []
  walkBundle(root, '', target, files)
  files.sort((left, right) => compareBytes(left.path, right.path))
  if (!files.some((file) => file.path === NATIVE_EXECUTABLE_PATH)) {
    throw new NativeContractError(`${target} bundle is missing its executable`)
  }
  if (!files.some((file) => file.path.startsWith(`${NATIVE_RESOURCES_ROOT}/`))) {
    throw new NativeContractError(`${target} bundle is missing its resources`)
  }
  return files
}

function walkBundle(
  root: string,
  relative: string,
  target: NativeTarget,
  files: NativeArtifactFile[],
): void {
  const current = relative ? join(root, ...relative.split('/')) : root
  const entries = readdirSync(current, { encoding: 'utf8' }).sort(compareBytes)
  for (const name of entries) {
    const path = relative ? `${relative}/${name}` : name
    validateRelativePath(path)
    const absolute = join(root, ...path.split('/'))
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) throw new NativeContractError(`${target} bundle contains a symlink`)
    if (stat.isDirectory()) {
      walkBundle(root, path, target, files)
      continue
    }
    if (!stat.isFile()) throw new NativeContractError(`${target} bundle contains a special file`)
    files.push(bundleFileRecord(absolute, path, stat.mode & 0o777, target))
  }
}

function bundleFileRecord(
  absolute: string,
  path: string,
  mode: number,
  target: NativeTarget,
): NativeArtifactFile {
  const role = path === NATIVE_EXECUTABLE_PATH ? 'executable' : 'resource'
  const expectedMode = role === 'executable' ? 0o755 : 0o644
  if (mode !== expectedMode) throw new NativeContractError(`${target} bundle mode is invalid`)
  if (role === 'resource' && !path.startsWith(`${NATIVE_RESOURCES_ROOT}/`)) {
    throw new NativeContractError(`${target} bundle has an unexpected file`)
  }
  const bytes = readStableRegularFile(absolute, NATIVE_TARGET_CEILINGS[target])
  return {
    role,
    path,
    bytes: bytes.length,
    sha256: sha256(bytes),
    mode: role === 'executable' ? '0755' : '0644',
  }
}

function inspectMachO(artifact: Buffer, target: NativeTarget): NativeCompatibility {
  if (artifact.length < 32 || artifact.readUInt32LE(0) !== 0xfeedfacf) {
    throw new NativeContractError('Mach-O header is invalid')
  }
  const expectedCpu = target.endsWith('arm64') ? 0x0100000c : 0x01000007
  if (artifact.readUInt32LE(4) !== expectedCpu) {
    throw new NativeContractError('Mach-O architecture does not match target')
  }
  const commands = readMachOLoadCommands(artifact)
  if (commands.uuidCount !== 0) {
    throw new NativeContractError('stripped Mach-O still contains LC_UUID')
  }
  if (commands.minimumVersion !== '13.0.0') {
    throw new NativeContractError('Mach-O deployment target is not macOS 13.0.0')
  }
  if (JSON.stringify(commands.dependencies) !== JSON.stringify(DARWIN_DYNAMIC_DEPENDENCIES)) {
    throw new NativeContractError('Mach-O dynamic dependencies differ from accepted evidence')
  }
  return {
    os: 'darwin',
    minimumProductVersion: commands.minimumVersion,
    deploymentLoadCommand: 'pass',
    dynamicDependencies: commands.dependencies,
  }
}

function readMachOLoadCommands(artifact: Buffer): {
  readonly minimumVersion: string
  readonly uuidCount: number
  readonly dependencies: readonly string[]
} {
  const count = artifact.readUInt32LE(16)
  const bytes = artifact.readUInt32LE(20)
  if (count > MAX_LOAD_COMMANDS || 32 + bytes > artifact.length) {
    throw new NativeContractError('Mach-O load command table is invalid')
  }
  let offset = 32
  let minimumVersion: string | null = null
  let uuidCount = 0
  let symbolTableCount = 0
  const dependencies: string[] = []
  for (let index = 0; index < count; index += 1) {
    const command = readMachOCommand(artifact, offset)
    const version = readMachOMinimum(command.command, artifact, offset, command.bytes)
    if (version) minimumVersion = mergeMinimumVersion(minimumVersion, version)
    if (command.command === LC_UUID) uuidCount += 1
    if (isDylibCommand(command.command)) {
      dependencies.push(readMachODylib(artifact, offset, command.bytes))
    }
    if (command.command === LC_SEGMENT_64) {
      assertNoLibintlSections(artifact, offset, command.bytes)
    }
    if (command.command === LC_SYMTAB) {
      symbolTableCount += 1
      assertNoLibintlSymbols(artifact, offset, command.bytes)
    }
    offset += command.bytes
  }
  if (offset !== 32 + bytes || !minimumVersion) {
    throw new NativeContractError('Mach-O load commands do not match their header')
  }
  if (symbolTableCount > 1) throw new NativeContractError('Mach-O has multiple symbol tables')
  dependencies.sort(compareBytes)
  assertSortedUnique(dependencies, 'Mach-O dependencies')
  return { minimumVersion, uuidCount, dependencies }
}

function assertNoLibintlSections(artifact: Buffer, offset: number, bytes: number): void {
  if (bytes < 72) throw new NativeContractError('Mach-O segment command is truncated')
  const sections = artifact.readUInt32LE(offset + 64)
  if (sections > MAX_MACHO_SECTIONS || 72 + sections * 80 !== bytes) {
    throw new NativeContractError('Mach-O segment section table is invalid')
  }
  assertNotLibintlIdentifier(readMachOFixedName(artifact, offset + 8), 'Mach-O segment')
  for (let index = 0; index < sections; index += 1) {
    const section = offset + 72 + index * 80
    assertNotLibintlIdentifier(readMachOFixedName(artifact, section), 'Mach-O section')
    assertNotLibintlIdentifier(readMachOFixedName(artifact, section + 16), 'Mach-O section segment')
  }
}

function assertNoLibintlSymbols(artifact: Buffer, offset: number, bytes: number): void {
  if (bytes !== 24) throw new NativeContractError('Mach-O symbol table command is invalid')
  const symbolsOffset = artifact.readUInt32LE(offset + 8)
  const symbolCount = artifact.readUInt32LE(offset + 12)
  const stringsOffset = artifact.readUInt32LE(offset + 16)
  const stringsBytes = artifact.readUInt32LE(offset + 20)
  if (symbolCount > MAX_MACHO_SYMBOLS || symbolsOffset + symbolCount * 16 > artifact.length) {
    throw new NativeContractError('Mach-O symbol table is out of bounds')
  }
  if (stringsBytes < 1 || stringsOffset + stringsBytes > artifact.length) {
    throw new NativeContractError('Mach-O string table is out of bounds')
  }
  const strings = artifact.subarray(stringsOffset, stringsOffset + stringsBytes)
  if (strings[0] !== 0) throw new NativeContractError('Mach-O string table lacks its empty entry')
  for (let index = 0; index < symbolCount; index += 1) {
    const symbol = symbolsOffset + index * 16
    const stringIndex = artifact.readUInt32LE(symbol)
    if (stringIndex === 0) continue
    if (stringIndex >= strings.length) {
      throw new NativeContractError('Mach-O symbol string offset is out of bounds')
    }
    const name = readMachOSymbolName(strings, stringIndex)
    assertNotLibintlIdentifier(name, 'Mach-O symbol')
  }
}

function readMachOFixedName(artifact: Buffer, offset: number): string {
  const bytes = artifact.subarray(offset, offset + 16)
  if (bytes.length !== 16) throw new NativeContractError('Mach-O fixed name is truncated')
  const zero = bytes.indexOf(0)
  const end = zero < 0 ? bytes.length : zero
  if (zero >= 0 && bytes.subarray(end).some((byte) => byte !== 0)) {
    throw new NativeContractError('Mach-O fixed name padding is invalid')
  }
  return boundedAscii(bytes.subarray(0, end), 'Mach-O fixed name')
}

function readMachOSymbolName(strings: Buffer, offset: number): string {
  const terminator = strings.indexOf(0, offset)
  if (terminator < 0) throw new NativeContractError('Mach-O symbol name is unterminated')
  return boundedAscii(strings.subarray(offset, terminator), 'Mach-O symbol name')
}

function boundedAscii(bytes: Buffer, label: string): string {
  if (bytes.length > 1024 || bytes.some((byte) => byte < 0x20 || byte > 0x7e)) {
    throw new NativeContractError(`${label} is not bounded printable ASCII`)
  }
  return bytes.toString('ascii')
}

function assertNotLibintlIdentifier(value: string, label: string): void {
  const normalized = value.toLowerCase().replace(/^_+/, '')
  if (normalized === 'nl_langinfo' || normalized === 'nl_langinfo_l') return
  const exact = new Set([
    'bind_textdomain_codeset',
    'bindtextdomain',
    'dcgettext',
    'dcngettext',
    'dgettext',
    'dngettext',
    'gettext',
    'locale_charset',
    'ngettext',
    'textdomain',
  ])
  if (
    exact.has(normalized) ||
    normalized === 'libintl' ||
    normalized.startsWith('libintl_') ||
    normalized.startsWith('nl_')
  ) {
    throw new NativeContractError(`${label} exposes GNU libintl/gettext content`)
  }
}

function readMachOCommand(
  artifact: Buffer,
  offset: number,
): { readonly command: number; readonly bytes: number } {
  if (offset + 8 > artifact.length) throw new NativeContractError('Mach-O command is truncated')
  const command = artifact.readUInt32LE(offset)
  const bytes = artifact.readUInt32LE(offset + 4)
  if (bytes < 8 || offset + bytes > artifact.length) {
    throw new NativeContractError('Mach-O command size is invalid')
  }
  return { command, bytes }
}

function readMachOMinimum(
  command: number,
  artifact: Buffer,
  offset: number,
  bytes: number,
): string | null {
  const versionOffset = machOVersionOffset(command)
  if (versionOffset === null) return null
  if (versionOffset + 4 > bytes)
    throw new NativeContractError('Mach-O version command is truncated')
  return unpackMachOVersion(artifact.readUInt32LE(offset + versionOffset))
}

function machOVersionOffset(command: number): 8 | 12 | null {
  if (command === 0x32) return 12
  if (command === 0x24) return 8
  return null
}

function readMachODylib(artifact: Buffer, offset: number, bytes: number): string {
  if (bytes < 24) throw new NativeContractError('Mach-O dylib command is truncated')
  const nameOffset = artifact.readUInt32LE(offset + 8)
  if (nameOffset < 24 || nameOffset >= bytes) {
    throw new NativeContractError('Mach-O dylib path offset is invalid')
  }
  const field = artifact.subarray(offset + nameOffset, offset + bytes)
  const terminator = field.indexOf(0)
  if (terminator < 1) throw new NativeContractError('Mach-O dylib path is unterminated')
  const path = field.subarray(0, terminator).toString('utf8')
  if (Buffer.from(path, 'utf8').length !== terminator || !/^[\x20-\x7e]+$/.test(path)) {
    throw new NativeContractError('Mach-O dylib path is not bounded ASCII')
  }
  return path
}

function isDylibCommand(command: number): boolean {
  return [LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB, LC_LOAD_UPWARD_DYLIB].includes(
    command,
  )
}

function inspectElf(artifact: Buffer, target: NativeTarget): NativeCompatibility {
  if (
    artifact.length < 64 ||
    !artifact.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  ) {
    throw new NativeContractError('ELF header is invalid')
  }
  if (artifact[4] !== 2 || artifact[5] !== 1) {
    throw new NativeContractError('ELF is not 64-bit little-endian')
  }
  const expectedMachine = target.endsWith('arm64') ? 183 : 62
  if (artifact.readUInt16LE(18) !== expectedMachine) {
    throw new NativeContractError('ELF architecture does not match target')
  }
  inspectElfProgramHeaders(artifact)
  return { os: 'linux', libc: 'none', interpreter: null, dynamicDependencies: [] }
}

function inspectElfProgramHeaders(artifact: Buffer): void {
  const offset = safeNumber(artifact.readBigUInt64LE(32), 'ELF program header offset')
  const entryBytes = artifact.readUInt16LE(54)
  const count = artifact.readUInt16LE(56)
  if (
    entryBytes < 56 ||
    count > MAX_ELF_PROGRAM_HEADERS ||
    offset + entryBytes * count > artifact.length
  ) {
    throw new NativeContractError('ELF program header table is invalid')
  }
  for (let index = 0; index < count; index += 1) {
    const header = offset + index * entryBytes
    const type = artifact.readUInt32LE(header)
    if (type === 3) throw new NativeContractError('static ELF contains PT_INTERP')
    if (type !== 2) continue
    assertNoElfNeeded(artifact, header)
  }
}

function assertNoElfNeeded(artifact: Buffer, programHeader: number): void {
  const offset = safeNumber(artifact.readBigUInt64LE(programHeader + 8), 'ELF dynamic offset')
  const bytes = safeNumber(artifact.readBigUInt64LE(programHeader + 32), 'ELF dynamic length')
  if (offset + bytes > artifact.length || bytes % 16 !== 0) {
    throw new NativeContractError('ELF dynamic table is invalid')
  }
  for (let entry = offset; entry < offset + bytes; entry += 16) {
    const tag = artifact.readBigInt64LE(entry)
    if (tag === 0n) return
    if (tag === 1n) throw new NativeContractError('static ELF contains DT_NEEDED')
  }
  throw new NativeContractError('ELF dynamic table lacks DT_NULL')
}

function mergeMinimumVersion(current: string | null, next: string): string {
  if (!current || current === next) return next
  throw new NativeContractError('Mach-O has conflicting deployment targets')
}

function unpackMachOVersion(value: number): string {
  return `${value >>> 16}.${(value >>> 8) & 0xff}.${value & 0xff}`
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new NativeContractError(`${label} is too large`)
  return Number(value)
}

function validateRelativePath(path: string): void {
  if (Buffer.byteLength(path) > 240 || path.includes('\\') || path.startsWith('/')) {
    throw new NativeContractError('bundle path is not bounded POSIX')
  }
  const components = path.split('/')
  if (components.some((component) => !component || component === '.' || component === '..')) {
    throw new NativeContractError('bundle path contains an invalid component')
  }
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (!previous || !current || compareBytes(previous, current) >= 0) {
      throw new NativeContractError(`${label} are not unique`)
    }
  }
}
