import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseCanonicalNativePayload } from '../../src/config-resolver/schema'
import {
  assertNoEmbeddedFontPayloads,
  DARWIN_DYNAMIC_DEPENDENCIES,
  inspectNativeBinary,
} from './artifacts'
import { canonicalObjectBytes, NativeContractError, sha256 } from './canonical'
import { NATIVE_SOURCE_DATE_EPOCH } from './constants'
import { loadBuildRecipe, validateNativeBuildRecipe } from './contract'
import { projectObservedLinkArgv, validateLinkPlan } from './link-plan'
import { nativeProtocolGoldenPayload } from './native-golden'
import { verifyUstarArchive, writeDeterministicUstar } from './ustar'

const scriptRoot = join(process.cwd(), 'scripts/config-resolver-native')
let passed = 0
let rejected = 0

if (process.argv.length !== 2)
  throw new NativeContractError('native self-test accepts no arguments')

testCanonicalVectors()
testNativeProtocolGolden()
testLinkPlanProjection()
testBuildRecipe()
testMachOUuidInspection()
testExcludedFontInspection()
testUstar()

process.stdout.write(canonicalObjectBytes({ passed, rejected }))

function testCanonicalVectors(): void {
  const value = {
    utf8: 'é/雪',
    scientific: 1e-7,
    negativeZero: -0,
    nested: { β: true, a: null },
    integer: 9_007_199_254_740_991,
    array: [3, 'x', false],
  }
  const expected = Buffer.from(
    '{"array":[3,"x",false],"integer":9007199254740991,"negativeZero":0,"nested":{"a":null,"β":true},"scientific":1e-7,"utf8":"é/雪"}\n',
  )
  equalBytes(canonicalObjectBytes(value), expected, 'canonical cross-runtime bytes')
  equal(
    sha256(expected),
    '38b64ce956958ca308faa21bc090def6165c260bd834538764100d811f739479',
    'canonical vector digest',
  )
  expectFailure(() => canonicalObjectBytes({ invalid: Number.NaN }))
  expectFailure(() => canonicalObjectBytes({ invalid: '\ud800' }))
}

function testNativeProtocolGolden(): void {
  const path = join(scriptRoot, 'fixtures/native-protocol/canonical-ready.json')
  const bytes = readFileSync(path)
  equal(bytes.length, 13_705, 'native golden byte length')
  equal(
    sha256(bytes),
    '5b9997766094f19fe871435458d2df4a2003f894cc0fd49f9620d0225b3a2629',
    'native golden digest',
  )
  const payload = parseCanonicalNativePayload(bytes)
  equalBytes(bytes, canonicalObjectBytes(payload), 'native golden canonical parser')
  equalBytes(bytes, canonicalObjectBytes(nativeProtocolGoldenPayload()), 'native golden generator')
  equal(payload.profiles.light.surface.backgroundOpacity, 1e-7, 'scientific native number')
  equal(payload.profiles.dark.surface.backgroundOpacity, 1e-6, 'decimal boundary native number')

  const main = readFileSync(join(scriptRoot, 'main.zig'), 'utf8')
  includes(main, '@embedFile("native-protocol-golden.json")', 'Zig golden binding')
  includes(main, sha256(bytes), 'Zig golden digest binding')
  includes(main, 'if (@abs(value) < 0.000001)', 'Zig scientific threshold')
  includes(main, 'const payload = writer.buffered();', 'bounded native payload')
  includes(main, 'const written = std.c.write(1, payload.ptr, payload.len);', 'single native write')
  const profileOrder = [
    'background',
    'cursorColor',
    'cursorText',
    'foreground',
    'minimumContrast',
    'palette',
    'selectionBackground',
    'selectionForeground',
    'surface',
    'windowColorspace',
  ].map((name) => `\\"${name}\\"`)
  assertOrdered(main, profileOrder, 'Zig profile key order')
}

function testLinkPlanProjection(): void {
  const root = '/tmp/native-self-test-work'
  const key0 = '0123456789abcdef0123456789abcdef'
  const key1 = 'fedcba9876543210fedcba9876543210'
  const raw = [
    '/usr/bin/zig',
    `${root}/final-cache/o/${key0}/one.o`,
    `--object=${root}/final-cache/o/${key0}/two.o`,
    `-L${root}/final-cache/o/${key1}/lib`,
  ]
  const projected = projectObservedLinkArgv(raw, 'linux-x64', root)
  equalBytes(
    canonicalObjectBytes(projected),
    canonicalObjectBytes([
      '/usr/bin/zig',
      `${root}/final-cache/o/{{zig-cache-key-0000}}/one.o`,
      `--object=${root}/final-cache/o/{{zig-cache-key-0000}}/two.o`,
      `-L${root}/final-cache/o/{{zig-cache-key-0001}}/lib`,
    ]),
    'native link-plan projection',
  )
  expectFailure(() =>
    projectObservedLinkArgv([`${root}/final-cache/o/${'A'.repeat(32)}`], 'linux-x64', root),
  )
  expectFailure(() =>
    projectObservedLinkArgv([`${root}/final-cache/o/${'a'.repeat(31)}`], 'linux-x64', root),
  )
  expectFailure(() =>
    projectObservedLinkArgv([`x${root}/final-cache/o/${key0}`], 'linux-x64', root),
  )
  expectFailure(() =>
    projectObservedLinkArgv([`${root}/final-cache/o/{{zig-cache-key-0000}}`], 'linux-x64', root),
  )
  expectFailure(() => validateLinkPlan([`${root}/final-cache/o/{{zig-cache-key-0001}}`], root))
  expectFailure(() => validateLinkPlan([`x{{zig-cache-key-0000}}`], root))
}

function testBuildRecipe(): void {
  const recipe = loadBuildRecipe(join(scriptRoot, 'build-recipe.json')).value
  const executable = '$OUTPUT/bin/ghostty-config-resolver'
  for (const target of ['darwin-arm64', 'darwin-x64'] as const) {
    equalBytes(
      canonicalObjectBytes(recipe.targets[target].stripArgv),
      canonicalObjectBytes(['/usr/bin/strip', '-x', '-no_uuid', executable]),
      `${target} no-UUID strip recipe`,
    )
  }
  for (const target of ['linux-arm64', 'linux-x64'] as const) {
    equalBytes(
      canonicalObjectBytes(recipe.targets[target].stripArgv),
      canonicalObjectBytes(['/usr/bin/strip', '--strip-all', executable]),
      `${target} strip recipe`,
    )
  }
  expectFailure(() => validateNativeBuildRecipe({ ...recipe, schemaVersion: 1 }))
}

function testMachOUuidInspection(): void {
  const root = mkdtempSync(join(tmpdir(), 'native-macho-self-test-'))
  try {
    const cleanPath = join(root, 'without-uuid')
    const uuidPath = join(root, 'with-uuid')
    const gettextSymbolPath = join(root, 'with-gettext-symbol')
    const libintlSymbolPath = join(root, 'with-libintl-symbol')
    const nlInternalSymbolPath = join(root, 'with-nl-internal-symbol')
    const libcLocaleSymbolPath = join(root, 'with-libc-locale-symbol')
    const libintlSectionPath = join(root, 'with-libintl-section')
    writeFileSync(cleanPath, syntheticMachO(false), { mode: 0o755 })
    writeFileSync(uuidPath, syntheticMachO(true), { mode: 0o755 })
    writeFileSync(gettextSymbolPath, syntheticMachOWithSymbol('_gettext'), { mode: 0o755 })
    writeFileSync(libintlSymbolPath, syntheticMachOWithSymbol('_libintl_gettext'), { mode: 0o755 })
    writeFileSync(nlInternalSymbolPath, syntheticMachOWithSymbol('__nl_find_domain'), {
      mode: 0o755,
    })
    writeFileSync(libcLocaleSymbolPath, syntheticMachOWithSymbol('_nl_langinfo', true), {
      mode: 0o755,
    })
    writeFileSync(libintlSectionPath, syntheticMachOWithSection('__libintl'), { mode: 0o755 })
    const compatibility = inspectNativeBinary(cleanPath, 'darwin-arm64')
    equal(compatibility.os, 'darwin', 'Mach-O target inspection')
    if (compatibility.os !== 'darwin') throw new NativeContractError('Mach-O type differs')
    equal(compatibility.minimumProductVersion, '13.0.0', 'Mach-O deployment inspection')
    expectFailure(() => inspectNativeBinary(uuidPath, 'darwin-arm64'))
    expectFailure(() => inspectNativeBinary(gettextSymbolPath, 'darwin-arm64'))
    expectFailure(() => inspectNativeBinary(libintlSymbolPath, 'darwin-arm64'))
    expectFailure(() => inspectNativeBinary(nlInternalSymbolPath, 'darwin-arm64'))
    inspectNativeBinary(libcLocaleSymbolPath, 'darwin-arm64')
    passed += 1
    expectFailure(() => inspectNativeBinary(libintlSectionPath, 'darwin-arm64'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function testExcludedFontInspection(): void {
  const root = mkdtempSync(join(tmpdir(), 'native-font-self-test-'))
  try {
    const block = Buffer.from(Array.from({ length: 512 }, (_, index) => index % 256))
    const font = Buffer.concat(Array.from({ length: 8 }, () => block))
    const fontPaths = Array.from({ length: 7 }, (_, index) => join(root, `font-${index}.ttf`))
    for (const path of fontPaths) writeFileSync(path, font, { mode: 0o644 })
    const clean = join(root, 'clean')
    const whole = join(root, 'whole')
    const slice = join(root, 'slice')
    writeFileSync(clean, Buffer.alloc(4096, 0x5a), { mode: 0o755 })
    writeFileSync(whole, Buffer.concat([Buffer.from('prefix'), font]), { mode: 0o755 })
    writeFileSync(slice, Buffer.concat([Buffer.from('prefix'), block]), { mode: 0o755 })
    assertNoEmbeddedFontPayloads(clean, 'darwin-arm64', fontPaths)
    passed += 1
    expectFailure(() => assertNoEmbeddedFontPayloads(whole, 'darwin-arm64', fontPaths))
    expectFailure(() => assertNoEmbeddedFontPayloads(slice, 'darwin-arm64', fontPaths))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function syntheticMachOWithSymbol(name: string, withDependencies = false): Buffer {
  const strings = Buffer.from(`\0${name}\0`, 'ascii')
  const dylibBytes = withDependencies
    ? DARWIN_DYNAMIC_DEPENDENCIES.reduce((total, path) => total + machoDylibCommandBytes(path), 0)
    : 0
  const commandBytes = 48 + dylibBytes
  const symbolsOffset = 32 + commandBytes
  const stringsOffset = symbolsOffset + 16
  const result = Buffer.alloc(stringsOffset + strings.length)
  writeMachOHeader(
    result,
    2 + (withDependencies ? DARWIN_DYNAMIC_DEPENDENCIES.length : 0),
    commandBytes,
  )
  writeBuildVersionCommand(result, 32)
  let offset = 56
  if (withDependencies) offset = writeAcceptedDylibCommands(result, offset)
  result.writeUInt32LE(0x02, offset)
  result.writeUInt32LE(24, offset + 4)
  result.writeUInt32LE(symbolsOffset, offset + 8)
  result.writeUInt32LE(1, offset + 12)
  result.writeUInt32LE(stringsOffset, offset + 16)
  result.writeUInt32LE(strings.length, offset + 20)
  result.writeUInt32LE(1, symbolsOffset)
  strings.copy(result, stringsOffset)
  return result
}

function syntheticMachOWithSection(sectionName: string): Buffer {
  const result = Buffer.alloc(32 + 24 + 152)
  writeMachOHeader(result, 2, 176)
  writeBuildVersionCommand(result, 32)
  result.writeUInt32LE(0x19, 56)
  result.writeUInt32LE(152, 60)
  result.write('__TEXT', 64, 'ascii')
  result.writeUInt32LE(1, 120)
  result.write(sectionName, 128, 'ascii')
  result.write('__TEXT', 144, 'ascii')
  return result
}

function syntheticMachO(withUuid: boolean): Buffer {
  const dylibBytes = DARWIN_DYNAMIC_DEPENDENCIES.reduce(
    (total, path) => total + machoDylibCommandBytes(path),
    0,
  )
  const commandBytes = 24 + dylibBytes + (withUuid ? 24 : 0)
  const result = Buffer.alloc(32 + commandBytes)
  writeMachOHeader(
    result,
    1 + DARWIN_DYNAMIC_DEPENDENCIES.length + (withUuid ? 1 : 0),
    commandBytes,
  )
  writeBuildVersionCommand(result, 32)
  const offset = writeAcceptedDylibCommands(result, 56)
  if (!withUuid) return result
  result.writeUInt32LE(0x1b, offset)
  result.writeUInt32LE(24, offset + 4)
  result.fill(0xab, offset + 8, offset + 24)
  return result
}

function writeAcceptedDylibCommands(result: Buffer, start: number): number {
  let offset = start
  for (const path of DARWIN_DYNAMIC_DEPENDENCIES) {
    offset = writeDylibCommand(result, offset, path)
  }
  return offset
}

function writeDylibCommand(result: Buffer, offset: number, path: string): number {
  const bytes = machoDylibCommandBytes(path)
  result.writeUInt32LE(0x0c, offset)
  result.writeUInt32LE(bytes, offset + 4)
  result.writeUInt32LE(24, offset + 8)
  result.write(path, offset + 24, 'ascii')
  return offset + bytes
}

function machoDylibCommandBytes(path: string): number {
  return Math.ceil((24 + Buffer.byteLength(path) + 1) / 8) * 8
}

function writeMachOHeader(result: Buffer, commands: number, commandBytes: number): void {
  result.writeUInt32LE(0xfeedfacf, 0)
  result.writeUInt32LE(0x0100000c, 4)
  result.writeUInt32LE(2, 12)
  result.writeUInt32LE(commands, 16)
  result.writeUInt32LE(commandBytes, 20)
}

function writeBuildVersionCommand(result: Buffer, offset: number): void {
  result.writeUInt32LE(0x32, offset)
  result.writeUInt32LE(24, offset + 4)
  result.writeUInt32LE(1, offset + 8)
  result.writeUInt32LE(13 << 16, offset + 12)
  result.writeUInt32LE(13 << 16, offset + 16)
}

function testUstar(): void {
  const root = mkdtempSync(join(tmpdir(), 'native-ustar-self-test-'))
  try {
    const first = createArchiveFixture(root, 'first')
    const second = createArchiveFixture(root, 'second')
    const firstArchive = join(root, 'first.tar')
    const secondArchive = join(root, 'second.tar')
    const firstIdentity = writeDeterministicUstar(
      first.root,
      first.files,
      firstArchive,
      NATIVE_SOURCE_DATE_EPOCH,
    )
    const secondIdentity = writeDeterministicUstar(
      second.root,
      second.files,
      secondArchive,
      NATIVE_SOURCE_DATE_EPOCH,
    )
    equalBytes(readFileSync(firstArchive), readFileSync(secondArchive), 'independent ustar bytes')
    equal(firstIdentity.sha256, secondIdentity.sha256, 'independent ustar digest')
    verifyUstarArchive(firstArchive, first.files)
    passed += 1

    mutateArchive(root, firstArchive, 'bad-checksum.tar', (bytes) => {
      bytes[0] = (bytes[0] ?? 0) ^ 1
    })
    mutateArchive(root, firstArchive, 'bad-type.tar', (bytes) => {
      const header = findHeader(bytes, 'bin/ghostty-config-resolver')
      bytes[header + 156] = 0x32
      updateHeaderChecksum(bytes, header)
    })
    mutateArchive(root, firstArchive, 'bad-time.tar', (bytes) => {
      const header = findHeader(bytes, 'bin/ghostty-config-resolver')
      writeOctalField(bytes, header + 136, 12, NATIVE_SOURCE_DATE_EPOCH + 1)
      updateHeaderChecksum(bytes, header)
    })
    mutateArchive(root, firstArchive, 'bad-padding.tar', (bytes) => {
      const header = findHeader(bytes, 'bin/ghostty-config-resolver')
      bytes[header + 512 + first.files[0]!.bytes] = 1
    })
    const trailing = Buffer.concat([readFileSync(firstArchive), Buffer.alloc(512)])
    const trailingPath = join(root, 'trailing.tar')
    writeFileSync(trailingPath, trailing)
    expectFailure(() => verifyUstarArchive(trailingPath, first.files))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function createArchiveFixture(
  root: string,
  name: string,
): {
  readonly root: string
  readonly files: readonly {
    readonly role: 'executable' | 'resource'
    readonly path: string
    readonly sha256: string
    readonly bytes: number
    readonly mode: '0644' | '0755'
  }[]
} {
  const bundle = join(root, name)
  const executable = Buffer.from('native-executable')
  const resource = Buffer.from('native-resource')
  mkdirSync(join(bundle, 'bin'), { recursive: true, mode: 0o755 })
  mkdirSync(join(bundle, 'resources/themes'), { recursive: true, mode: 0o755 })
  writeFileSync(join(bundle, 'bin/ghostty-config-resolver'), executable, { mode: 0o755 })
  writeFileSync(join(bundle, 'resources/themes/example'), resource, { mode: 0o644 })
  chmodSync(join(bundle, 'bin/ghostty-config-resolver'), 0o755)
  chmodSync(join(bundle, 'resources/themes/example'), 0o644)
  return {
    root: bundle,
    files: [
      {
        role: 'executable',
        path: 'bin/ghostty-config-resolver',
        sha256: sha256(executable),
        bytes: executable.length,
        mode: '0755',
      },
      {
        role: 'resource',
        path: 'resources/themes/example',
        sha256: sha256(resource),
        bytes: resource.length,
        mode: '0644',
      },
    ],
  }
}

function mutateArchive(
  root: string,
  source: string,
  name: string,
  mutate: (bytes: Buffer) => void,
): void {
  const bytes = readFileSync(source)
  mutate(bytes)
  const path = join(root, name)
  writeFileSync(path, bytes)
  expectFailure(() => verifyUstarArchive(path, createArchiveFixtureFiles()))
}

function createArchiveFixtureFiles(): readonly {
  readonly role: 'executable' | 'resource'
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly mode: '0644' | '0755'
}[] {
  const executable = Buffer.from('native-executable')
  const resource = Buffer.from('native-resource')
  return [
    {
      role: 'executable',
      path: 'bin/ghostty-config-resolver',
      sha256: sha256(executable),
      bytes: executable.length,
      mode: '0755',
    },
    {
      role: 'resource',
      path: 'resources/themes/example',
      sha256: sha256(resource),
      bytes: resource.length,
      mode: '0644',
    },
  ]
}

function findHeader(bytes: Buffer, path: string): number {
  for (let offset = 0; offset + 512 <= bytes.length; offset += 512) {
    const end = bytes.indexOf(0, offset)
    if (end < offset || end >= offset + 100) continue
    if (bytes.subarray(offset, end).toString('utf8') === path) return offset
  }
  throw new NativeContractError('self-test ustar header is missing')
}

function writeOctalField(bytes: Buffer, offset: number, length: number, value: number): void {
  bytes.fill(0, offset, offset + length)
  bytes.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii')
}

function updateHeaderChecksum(bytes: Buffer, offset: number): void {
  bytes.fill(0x20, offset + 148, offset + 156)
  let checksum = 0
  for (const byte of bytes.subarray(offset, offset + 512)) checksum += byte
  bytes.write(checksum.toString(8).padStart(6, '0'), offset + 148, 6, 'ascii')
  bytes[offset + 154] = 0
  bytes[offset + 155] = 0x20
}

function expectFailure(action: () => unknown): void {
  try {
    action()
  } catch {
    rejected += 1
    return
  }
  throw new NativeContractError('self-test mutation was accepted')
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new NativeContractError(`${label} differs`)
  passed += 1
}

function equalBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (!Buffer.from(actual).equals(Buffer.from(expected))) {
    throw new NativeContractError(`${label} differs`)
  }
  passed += 1
}

function includes(value: string, expected: string, label: string): void {
  if (!value.includes(expected)) throw new NativeContractError(`${label} is missing`)
  passed += 1
}

function assertOrdered(value: string, markers: readonly string[], label: string): void {
  let offset = 0
  for (const marker of markers) {
    const next = value.indexOf(marker, offset)
    if (next < 0) throw new NativeContractError(`${label} differs`)
    offset = next + marker.length
  }
  passed += 1
}
