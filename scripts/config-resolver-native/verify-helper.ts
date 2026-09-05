import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  copyFileSync,
  cpSync,
  constants as fsConstants,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { release as osRelease, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import { canonicalObjectBytes } from './canonical'
import { parseCanonicalNativePayload } from '../../src/config-resolver/schema'

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const
const UPSTREAM_REVISION = 'c8554f28e0efe2f5595f32020371c34b25ec628f'
const OUTPUT_LIMIT = 128 * 1024
const SENTINELS = [
  'PLAN065_PATH_SENTINEL',
  'PLAN065_SECRET_SENTINEL',
  'PLAN065_THEME_SENTINEL',
  'PLAN065_DIAGNOSTIC_SENTINEL',
] as const
const PALETTE_SHA256 = '3924d9bb39f6716d63524fb520f2100c5e93c52708967ecf5bc7e648cab0fa65'
const DARWIN_MINIMUM_VERSION = '13.0.0'
const LINUX_MINIMUM_VERSION = '5.10.0'
const MAX_DEPENDENCIES = 128
const MAX_EVIDENCE_BYTES = 256 * 1024
const NATIVE_GOLDEN_SHA256 = '5b9997766094f19fe871435458d2df4a2003f894cc0fd49f9620d0225b3a2629'
const scriptDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(scriptDir, 'fixtures')

type Target = (typeof TARGETS)[number]
type JsonObject = Record<string, unknown>
type Rgb = { readonly r: number; readonly g: number; readonly b: number }
type Matrix = readonly (readonly [number, number, number])[]
type NativeColor =
  | { readonly kind: 'unset' }
  | { readonly kind: 'rgb'; readonly value: Rgb }
  | { readonly kind: 'cell-foreground' }
  | { readonly kind: 'cell-background' }
type NativeProfile = {
  readonly background: Rgb
  readonly foreground: Rgb
  readonly cursorColor: NativeColor
  readonly cursorText: NativeColor
  readonly selectionBackground: NativeColor
  readonly selectionForeground: NativeColor
  readonly minimumContrast: number
  readonly palette: readonly Rgb[]
  readonly windowColorspace: 'display-p3' | 'srgb'
  readonly surface: {
    readonly backgroundOpacity: number
    readonly backgroundOpacityCells: boolean
    readonly backgroundBlur:
      | { readonly kind: 'none' }
      | { readonly kind: 'radius'; readonly value: number }
      | { readonly kind: 'macos-glass'; readonly variant: 'clear' | 'regular' }
  }
}
type NativeResult = {
  readonly nativeSchemaVersion: 1
  readonly upstreamRevision: string
  readonly diagnosticCount: number
  readonly profiles: {
    readonly light: NativeProfile
    readonly dark: NativeProfile
  }
}
type Arguments = {
  readonly helper: string
  readonly resources: string
  readonly target: Target
  readonly evidence: string
  readonly node: string
  readonly bun: string
}
type FixtureRoot = {
  readonly path: string
  readonly home: string
  readonly config: string
  readonly cache: string
  readonly temporary: string
}
type DefaultLocation = {
  readonly id: 'app-current' | 'app-legacy' | 'xdg-current' | 'xdg-legacy'
  readonly path: string
  readonly fixture: string
  readonly expected: Rgb
}
type Runner = {
  readonly os: 'darwin' | 'linux'
  readonly arch: 'arm64' | 'x64'
  readonly unameSystem: 'Darwin' | 'Linux'
  readonly unameMachine: 'arm64' | 'aarch64' | 'x86_64'
}
type BinaryCompatibility = {
  readonly format: 'elf64' | 'mach-o-64'
  readonly arch: 'arm64' | 'x64'
  readonly minimumOsVersion: string
  readonly linkage: 'static' | 'system-dynamic'
}
type DependencyDetail = {
  readonly format: BinaryCompatibility['format']
  readonly linkage: BinaryCompatibility['linkage']
  readonly entries: readonly string[]
  readonly fileInspection: 'pass'
  readonly platformInspection: 'pass'
}
type RuntimeProbe = {
  readonly schemaVersion: 1
  readonly target: Target
  readonly runtime: 'bun' | 'node'
  readonly runtimeVersion: string
  readonly hostVersion: string
  readonly minimumOsVersion: string
  readonly vectors: 'pass'
  readonly result: 'pass'
}
type CompatibilityDetail = {
  readonly minimumOsVersion: string
  readonly node: RuntimeProbe
  readonly bun: RuntimeProbe
}
type FixtureDetail = {
  readonly semanticCases: number
  readonly immutableSnapshots: number
  readonly absentCases: number
  readonly deleteRaceCases: number
  readonly renameRaceCases: number
}
type ResourceIdentity = {
  readonly sha256: string
  readonly bytes: number
  readonly entries: number
}

class NativeVerifyFailure extends Error {}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  const runner = assertNativeTarget(args.target)
  verifyNativeProtocolGolden()
  verifyDisplayP3Vectors()

  const workRoot = mkdtempSync(join(tmpdir(), 'config-resolver-native-verify-'))
  try {
    const bundle = nativeStage('relocation setup', () =>
      relocateBundle(workRoot, args.helper, args.resources),
    )
    nativeStage('relocation audit', () => assertRelocationIndependence(args, bundle.helper))
    const binary = nativeStage('binary inspection', () =>
      inspectBinaryCompatibility(bundle.helper, args.target),
    )
    const dependencies = nativeStage('dependency inspection', () =>
      inspectDependencies(bundle.helper, args.target, binary),
    )
    const compatibility = nativeStage('compatibility inspection', () =>
      verifyCompatibilityAcrossRuntimes(args, bundle.helper, binary),
    )
    const fixtures = await nativeAsyncStage('fixture execution', () =>
      runFixtures(workRoot, bundle.helper, bundle.resources, args.target),
    )
    const resources = nativeStage('resource inspection', () => resourceIdentity(bundle.resources))
    writeEvidence(args, bundle.helper, runner, dependencies, compatibility, fixtures, resources)
  } finally {
    rmSync(workRoot, { recursive: true, force: true })
  }

  process.stdout.write(`${JSON.stringify({ target: args.target, result: 'pass' })}\n`)
}

function nativeStage<T>(label: string, action: () => T): T {
  try {
    return action()
  } catch (error) {
    if (error instanceof NativeVerifyFailure) throw error
    throw new NativeVerifyFailure(`unexpected ${label} failure`)
  }
}

async function nativeAsyncStage<T>(label: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof NativeVerifyFailure) throw error
    throw new NativeVerifyFailure(`unexpected ${label} failure`)
  }
}

function parseArguments(argv: readonly string[]): Arguments {
  const allowed = new Set(['--bun', '--evidence', '--helper', '--node', '--resources', '--target'])
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value) throw new NativeVerifyFailure('invalid arguments')
    if (!allowed.has(name) || values.has(name))
      throw new NativeVerifyFailure('unsupported argument')
    values.set(name, value)
  }

  const helper = values.get('--helper')
  const resources = values.get('--resources')
  const target = values.get('--target')
  const evidence = values.get('--evidence')
  if (!helper || !resources || !target || !evidence)
    throw new NativeVerifyFailure('missing argument')
  if (!TARGETS.includes(target as Target)) throw new NativeVerifyFailure('unsupported target')

  return {
    helper: realpathSync(helper),
    resources: realpathSync(resources),
    target: target as Target,
    evidence,
    node: optionalRuntime(values, '--node', 'node'),
    bun: optionalRuntime(values, '--bun', 'bun'),
  }
}

function optionalRuntime(
  values: ReadonlyMap<string, string>,
  name: '--bun' | '--node',
  fallback: 'bun' | 'node',
): string {
  const configured = values.get(name)
  if (configured) return realpathSync(configured)
  return resolveExecutable(fallback)
}

function resolveExecutable(name: 'bun' | 'node'): string {
  const path = process.env.PATH ?? ''
  for (const directory of path.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return realpathSync(candidate)
    } catch {
      continue
    }
  }
  throw new NativeVerifyFailure('required runtime unavailable')
}

function assertNativeTarget(target: Target): Runner {
  const system = runFixed('/usr/bin/uname', ['-s']).trim()
  const machine = runFixed('/usr/bin/uname', ['-m']).trim()
  const os = normalizeUnameSystem(system)
  const arch = normalizeUnameMachine(machine)
  if (!os || !arch || `${os}-${arch}` !== target)
    throw new NativeVerifyFailure('native target mismatch')
  if (process.platform !== os || normalizeRuntimeArch(process.arch) !== arch) {
    throw new NativeVerifyFailure('runtime target mismatch')
  }
  if (os === 'darwin') assertNotTranslatedDarwin()
  return {
    os,
    arch,
    unameSystem: system as Runner['unameSystem'],
    unameMachine: machine as Runner['unameMachine'],
  }
}

function normalizeUnameSystem(value: string): Runner['os'] | null {
  if (value === 'Darwin') return 'darwin'
  if (value === 'Linux') return 'linux'
  return null
}

function normalizeUnameMachine(value: string): Runner['arch'] | null {
  if (value === 'arm64' || value === 'aarch64') return 'arm64'
  if (value === 'x86_64') return 'x64'
  return null
}

function normalizeRuntimeArch(value: string): Runner['arch'] | null {
  if (value === 'arm64') return 'arm64'
  if (value === 'x64') return 'x64'
  return null
}

function assertNotTranslatedDarwin(): void {
  const result = spawnSync(
    '/usr/sbin/sysctl',
    ['-in', 'sysctl.proc_translated'],
    fixedProcessOptions(),
  )
  if (result.status !== 0) return
  if (result.stdout.trim() === '1')
    throw new NativeVerifyFailure('translated Darwin runner unsupported')
}

function relocateBundle(
  workRoot: string,
  helperSource: string,
  resourceSource: string,
): { readonly helper: string; readonly resources: string } {
  const root = join(workRoot, 'relocated', 'nested', 'bundle')
  const helper = join(root, 'bin', 'ghostty-config-resolver-proof')
  const resources = join(root, 'resources')
  mkdirSync(dirname(helper), { recursive: true })
  relocateFile(helperSource, helper, true)
  relocateTree(resourceSource, resources)
  return { helper, resources }
}

function relocateTree(source: string, target: string): void {
  const stat = lstatSync(source)
  if (stat.isFile()) {
    relocateFile(source, target, false)
    return
  }
  if (!stat.isDirectory()) throw new NativeVerifyFailure('unsupported relocation entry')
  mkdirSync(target, { recursive: true })
  chmodSync(target, stat.mode & 0o777)
  const entries = readdirSync(source).sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )
  for (const entry of entries) relocateTree(join(source, entry), join(target, entry))
}

function relocateFile(source: string, target: string, executable: boolean): void {
  try {
    linkSync(source, target)
    if (executable && (statSync(target).mode & 0o111) === 0) {
      throw new NativeVerifyFailure('relocated helper is not executable')
    }
    return
  } catch (error) {
    if (!isCrossDeviceLink(error)) throw error
  }
  copyFileSync(source, target)
  if (executable) chmodSync(target, 0o755)
}

function isCrossDeviceLink(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EXDEV')
}

function assertRelocationIndependence(args: Arguments, relocatedHelper: string): void {
  const artifact = readFileSync(relocatedHelper)
  const forbidden = new Set([
    args.helper,
    dirname(args.helper),
    args.resources,
    dirname(args.resources),
  ])
  for (const path of forbidden) {
    if (path.length < 2) continue
    if (artifact.includes(Buffer.from(path)))
      throw new NativeVerifyFailure('artifact embeds build path')
  }
}

function inspectBinaryCompatibility(helper: string, target: Target): BinaryCompatibility {
  const artifact = readFileSync(helper)
  if (target.startsWith('linux-')) return inspectElfCompatibility(artifact, target)
  return inspectMachOCompatibility(artifact, target)
}

function inspectElfCompatibility(artifact: Buffer, target: Target): BinaryCompatibility {
  if (artifact.length < 64) throw new NativeVerifyFailure('ELF header is truncated')
  if (!artifact.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new NativeVerifyFailure('ELF magic mismatch')
  }
  if (artifact[4] !== 2 || artifact[5] !== 1 || artifact[6] !== 1) {
    throw new NativeVerifyFailure('ELF class mismatch')
  }

  const expectedMachine = target.endsWith('arm64') ? 183 : 62
  if (artifact.readUInt16LE(18) !== expectedMachine)
    throw new NativeVerifyFailure('ELF machine mismatch')
  assertNoElfInterpreter(artifact)
  return {
    format: 'elf64',
    arch: target.endsWith('arm64') ? 'arm64' : 'x64',
    minimumOsVersion: LINUX_MINIMUM_VERSION,
    linkage: 'static',
  }
}

function assertNoElfInterpreter(artifact: Buffer): void {
  const tableOffset = safeBigIntNumber(artifact.readBigUInt64LE(32), 'ELF program table offset')
  const entryBytes = artifact.readUInt16LE(54)
  const entryCount = artifact.readUInt16LE(56)
  if (entryBytes < 56 || entryCount > 1024)
    throw new NativeVerifyFailure('ELF program table mismatch')
  const tableEnd = tableOffset + entryBytes * entryCount
  if (tableEnd > artifact.length) throw new NativeVerifyFailure('ELF program table is truncated')

  for (let index = 0; index < entryCount; index += 1) {
    const offset = tableOffset + index * entryBytes
    if (artifact.readUInt32LE(offset) === 3)
      throw new NativeVerifyFailure('ELF interpreter is present')
  }
}

function safeBigIntNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new NativeVerifyFailure(`${label} is too large`)
  return Number(value)
}

function inspectMachOCompatibility(artifact: Buffer, target: Target): BinaryCompatibility {
  if (artifact.length < 32 || artifact.readUInt32LE(0) !== 0xfeedfacf) {
    throw new NativeVerifyFailure('Mach-O header mismatch')
  }
  const expectedCpu = target.endsWith('arm64') ? 0x0100000c : 0x01000007
  if (artifact.readUInt32LE(4) !== expectedCpu) throw new NativeVerifyFailure('Mach-O CPU mismatch')
  const minimum = readMachOMinimumVersion(artifact)
  if (minimum !== DARWIN_MINIMUM_VERSION)
    throw new NativeVerifyFailure('Mach-O deployment target mismatch')
  return {
    format: 'mach-o-64',
    arch: target.endsWith('arm64') ? 'arm64' : 'x64',
    minimumOsVersion: minimum,
    linkage: 'system-dynamic',
  }
}

function readMachOMinimumVersion(artifact: Buffer): string {
  const commandCount = artifact.readUInt32LE(16)
  const commandBytes = artifact.readUInt32LE(20)
  if (commandCount > 4096 || 32 + commandBytes > artifact.length) {
    throw new NativeVerifyFailure('Mach-O load commands are truncated')
  }

  let offset = 32
  let minimum: string | null = null
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > artifact.length)
      throw new NativeVerifyFailure('Mach-O load command is truncated')
    const command = artifact.readUInt32LE(offset)
    const bytes = artifact.readUInt32LE(offset + 4)
    if (bytes < 8 || offset + bytes > artifact.length) {
      throw new NativeVerifyFailure('Mach-O load command size mismatch')
    }
    const versionOffset = machOVersionOffset(command)
    if (versionOffset !== null) {
      if (bytes < versionOffset + 4)
        throw new NativeVerifyFailure('Mach-O version command is truncated')
      const current = unpackMachOVersion(artifact.readUInt32LE(offset + versionOffset))
      if (minimum && current !== minimum)
        throw new NativeVerifyFailure('Mach-O minimum versions differ')
      minimum = current
    }
    offset += bytes
  }
  if (!minimum) throw new NativeVerifyFailure('Mach-O deployment target missing')
  return minimum
}

function machOVersionOffset(command: number): 8 | 12 | null {
  if (command === 0x32) return 12
  if (command === 0x24) return 8
  return null
}

function unpackMachOVersion(value: number): string {
  return `${value >>> 16}.${(value >>> 8) & 0xff}.${value & 0xff}`
}

function inspectDependencies(
  helper: string,
  target: Target,
  binary: BinaryCompatibility,
): DependencyDetail {
  assertFileInspection(helper, target)
  if (target.startsWith('linux-')) return inspectLinuxDependencies(helper, binary)
  return inspectDarwinDependencies(helper, binary)
}

function assertFileInspection(helper: string, target: Target): void {
  const output = runFixed('/usr/bin/file', ['-b', helper])
  if (
    target === 'linux-arm64' &&
    output.includes('ELF 64-bit LSB') &&
    output.includes('ARM aarch64')
  )
    return
  if (target === 'linux-x64' && output.includes('ELF 64-bit LSB') && output.includes('x86-64'))
    return
  if (target === 'darwin-arm64' && output.includes('Mach-O 64-bit') && output.includes('arm64'))
    return
  if (target === 'darwin-x64' && output.includes('Mach-O 64-bit') && output.includes('x86_64'))
    return
  throw new NativeVerifyFailure('file architecture inspection mismatch')
}

function inspectLinuxDependencies(helper: string, binary: BinaryCompatibility): DependencyDetail {
  const readelf = spawnSync('/usr/bin/readelf', ['-d', helper], fixedProcessOptions())
  if (readelf.status !== 0 || readelf.stderr.length !== 0)
    throw new NativeVerifyFailure('readelf failed')
  if (readelf.stdout.includes('(NEEDED)')) throw new NativeVerifyFailure('Linux helper is dynamic')
  assertNoSentinel(Buffer.from(readelf.stdout), Buffer.from(readelf.stderr))

  const ldd = spawnSync('/usr/bin/ldd', [helper], fixedProcessOptions())
  const lddOutput = `${ldd.stdout}${ldd.stderr}`
  if (!/not a dynamic executable|statically linked/.test(lddOutput)) {
    throw new NativeVerifyFailure('ldd static inspection mismatch')
  }
  assertNoSentinel(Buffer.from(ldd.stdout), Buffer.from(ldd.stderr))
  return {
    format: binary.format,
    linkage: binary.linkage,
    entries: [],
    fileInspection: 'pass',
    platformInspection: 'pass',
  }
}

function inspectDarwinDependencies(helper: string, binary: BinaryCompatibility): DependencyDetail {
  const result = spawnSync('/usr/bin/otool', ['-L', helper], fixedProcessOptions())
  if (result.status !== 0 || result.stderr.length !== 0)
    throw new NativeVerifyFailure('otool failed')
  assertNoSentinel(Buffer.from(result.stdout), Buffer.from(result.stderr))
  const entries = parseDarwinDependencies(result.stdout)
  return {
    format: binary.format,
    linkage: binary.linkage,
    entries,
    fileInspection: 'pass',
    platformInspection: 'pass',
  }
}

function parseDarwinDependencies(output: string): readonly string[] {
  const entries: string[] = []
  for (const line of output.trim().split('\n').slice(1)) {
    const dependency = line.trim().split(/\s+\(/, 1)[0]
    if (!dependency) throw new NativeVerifyFailure('Darwin dependency record mismatch')
    if (!isSystemDarwinDependency(dependency)) {
      throw new NativeVerifyFailure('Darwin helper has a non-system dependency')
    }
    if (dependency.length > 512 || !/^[\x20-\x7e]+$/.test(dependency)) {
      throw new NativeVerifyFailure('Darwin dependency is not bounded ASCII')
    }
    entries.push(dependency)
  }
  if (entries.length > MAX_DEPENDENCIES)
    throw new NativeVerifyFailure('too many Darwin dependencies')
  return entries.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
}

function isSystemDarwinDependency(path: string): boolean {
  if (path.startsWith('/usr/lib/')) return true
  if (path.startsWith('/System/Library/Frameworks/')) return true
  return path.startsWith('/System/Library/PrivateFrameworks/')
}

function verifyCompatibilityAcrossRuntimes(
  args: Arguments,
  helper: string,
  binary: BinaryCompatibility,
): CompatibilityDetail {
  const node = runCompatibilityProbe(args.node, 'node', args.target, helper)
  const bun = runCompatibilityProbe(args.bun, 'bun', args.target, helper)
  if (node.minimumOsVersion !== binary.minimumOsVersion) {
    throw new NativeVerifyFailure('Node minimum compatibility mismatch')
  }
  if (bun.minimumOsVersion !== binary.minimumOsVersion) {
    throw new NativeVerifyFailure('Bun minimum compatibility mismatch')
  }
  return { minimumOsVersion: binary.minimumOsVersion, node, bun }
}

function runCompatibilityProbe(
  runtime: string,
  expectedRuntime: RuntimeProbe['runtime'],
  target: Target,
  helper: string,
): RuntimeProbe {
  const result = spawnSync(
    runtime,
    [
      fileURLToPath(import.meta.url),
      '--compatibility-probe',
      '--helper',
      helper,
      '--target',
      target,
    ],
    {
      encoding: 'buffer',
      env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      maxBuffer: OUTPUT_LIMIT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  )
  if (result.status !== 0 || result.stderr.length !== 0) {
    throw new NativeVerifyFailure('compatibility runtime probe failed')
  }
  assertNoSentinel(result.stdout, result.stderr)
  const probe = validateRuntimeProbe(result.stdout, target)
  if (probe.runtime !== expectedRuntime)
    throw new NativeVerifyFailure('compatibility runtime mismatch')
  return probe
}

function validateRuntimeProbe(stdout: Buffer, target: Target): RuntimeProbe {
  if (stdout.length === 0 || stdout.length > OUTPUT_LIMIT) {
    throw new NativeVerifyFailure('compatibility probe output length mismatch')
  }
  let value: unknown
  try {
    value = JSON.parse(stdout.toString('utf8'))
  } catch {
    throw new NativeVerifyFailure('compatibility probe output is not JSON')
  }
  const probe = asObject(value, 'compatibility probe')
  assertKeys(
    probe,
    [
      'hostVersion',
      'minimumOsVersion',
      'result',
      'runtime',
      'runtimeVersion',
      'schemaVersion',
      'target',
      'vectors',
    ],
    'compatibility probe',
  )
  if (
    probe.schemaVersion !== 1 ||
    probe.target !== target ||
    probe.result !== 'pass' ||
    probe.vectors !== 'pass'
  ) {
    throw new NativeVerifyFailure('compatibility probe identity mismatch')
  }
  if (probe.runtime !== 'node' && probe.runtime !== 'bun') {
    throw new NativeVerifyFailure('compatibility probe runtime mismatch')
  }
  for (const key of ['hostVersion', 'minimumOsVersion', 'runtimeVersion'] as const) {
    assertBoundedAscii(probe[key], `compatibility ${key}`)
  }
  return probe as RuntimeProbe
}

function compatibilityProbeMain(argv: readonly string[]): void {
  const values = parseInternalProbeArguments(argv)
  assertNativeTarget(values.target)
  const binary = inspectBinaryCompatibility(values.helper, values.target)
  verifyCompatibilityVectors(values.helper, values.target, binary)
  const hostVersion = readHostVersion(values.target)
  if (compareVersions(hostVersion, binary.minimumOsVersion) < 0) {
    throw new NativeVerifyFailure('host OS is below minimum')
  }
  const bunVersion = process.versions.bun
  const runtime = typeof bunVersion === 'string' ? 'bun' : 'node'
  const runtimeVersion = bunVersion ?? process.versions.node
  const result: RuntimeProbe = {
    schemaVersion: 1,
    target: values.target,
    runtime,
    runtimeVersion,
    hostVersion,
    minimumOsVersion: binary.minimumOsVersion,
    vectors: 'pass',
    result: 'pass',
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function parseInternalProbeArguments(argv: readonly string[]): {
  readonly helper: string
  readonly target: Target
} {
  if (argv.length !== 4 || argv[0] !== '--helper' || argv[2] !== '--target') {
    throw new NativeVerifyFailure('invalid compatibility probe arguments')
  }
  const target = argv[3]
  if (!target || !TARGETS.includes(target as Target))
    throw new NativeVerifyFailure('unsupported target')
  if (!argv[1]) throw new NativeVerifyFailure('missing compatibility artifact')
  return { helper: realpathSync(argv[1]), target: target as Target }
}

function readHostVersion(target: Target): string {
  if (target.startsWith('linux-')) return normalizeVersion(osRelease())
  return normalizeVersion(runFixed('/usr/bin/sw_vers', ['-productVersion']))
}

function normalizeVersion(value: string): string {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value.trim())
  if (!match) throw new NativeVerifyFailure('host version format mismatch')
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3] ?? 0)}`
}

function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!
    if (difference !== 0) return difference
  }
  return 0
}

function verifyCompatibilityVectors(
  helper: string,
  target: Target,
  binary: BinaryCompatibility,
): void {
  const older = target.startsWith('linux-') ? '5.9.999' : '12.99.999'
  const newer = target.startsWith('linux-') ? '6.0.0' : '14.0.0'
  if (compareVersions(binary.minimumOsVersion, binary.minimumOsVersion) !== 0) {
    throw new NativeVerifyFailure('equal compatibility vector mismatch')
  }
  if (compareVersions(older, binary.minimumOsVersion) >= 0) {
    throw new NativeVerifyFailure('older compatibility vector mismatch')
  }
  if (compareVersions(newer, binary.minimumOsVersion) <= 0) {
    throw new NativeVerifyFailure('newer compatibility vector mismatch')
  }
  assertMismatchedArtifactRejected(helper, oppositeTarget(target))
}

function oppositeTarget(target: Target): Target {
  if (target === 'darwin-arm64') return 'darwin-x64'
  if (target === 'darwin-x64') return 'darwin-arm64'
  if (target === 'linux-arm64') return 'linux-x64'
  return 'linux-arm64'
}

function assertMismatchedArtifactRejected(helper: string, target: Target): void {
  let rejected = false
  try {
    inspectBinaryCompatibility(helper, target)
  } catch (error) {
    if (!(error instanceof NativeVerifyFailure)) throw error
    rejected = true
  }
  if (!rejected) throw new NativeVerifyFailure('mismatched artifact vector was accepted')
}

function versionParts(value: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) throw new NativeVerifyFailure('normalized version mismatch')
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function assertBoundedAscii(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new NativeVerifyFailure(`${label} is not bounded`)
  }
  if (!/^[\x20-\x7e]+$/.test(value))
    throw new NativeVerifyFailure(`${label} is not printable ASCII`)
}

function runFixed(command: string, argv: readonly string[]): string {
  const result = spawnSync(command, argv, fixedProcessOptions())
  if (result.status !== 0 || result.stderr.length !== 0) {
    throw new NativeVerifyFailure('inspection subprocess failed')
  }
  assertNoSentinel(Buffer.from(result.stdout), Buffer.from(result.stderr))
  return result.stdout
}

async function runFixtures(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): Promise<FixtureDetail> {
  nativeStage('absent fixture', () => testAbsent(workRoot, helper, resources, target))
  const normalCases = nativeStage('normal search fixtures', () =>
    testNormalSearch(workRoot, helper, resources, target),
  )
  nativeStage('include fixture', () => testIncludeGraph(workRoot, helper, resources, target))
  nativeStage('dual profile fixture', () => testDualProfile(workRoot, helper, resources, target))
  nativeStage('visual fixture', () => testVisualProjection(workRoot, helper, resources, target))
  nativeStage('file theme fixture', () => testFileTheme(workRoot, helper, resources, target))
  nativeStage('surface fixtures', () => testSurfaceVariants(workRoot, helper, resources, target))
  nativeStage('canonical float fixtures', () =>
    testCanonicalFloatVariants(workRoot, helper, resources, target),
  )
  nativeStage('failure protocol', () => testFailureProtocol(workRoot, helper, resources, target))
  const raceCases = await nativeAsyncStage('race fixtures', () =>
    testRaces(workRoot, helper, resources, target),
  )
  const semanticCases = normalCases + 10
  return {
    semanticCases,
    immutableSnapshots: semanticCases + 1 + raceCases * 2,
    absentCases: 1,
    deleteRaceCases: raceCases,
    renameRaceCases: raceCases,
  }
}

function testAbsent(workRoot: string, helper: string, resources: string, target: Target): void {
  const root = createFixtureRoot(workRoot, target)
  runMissingHelper(helper, resources, root)
}

function testNormalSearch(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): number {
  const firstRoot = createFixtureRoot(workRoot, target)
  const locations = defaultLocations(firstRoot, target)
  rmSync(firstRoot.path, { recursive: true, force: true })
  for (const location of locations) {
    const root = createFixtureRoot(workRoot, target)
    const current = defaultLocations(root, target).find((item) => item.id === location.id)
    if (!current) throw new NativeVerifyFailure('location mapping failed')
    installFile(current.fixture, current.path)
    const profile = ready(runFixtureHelper(helper, resources, root)).profiles.light
    assertRgb(profile.background, current.expected, 'single default location')
  }

  const xdgRoot = createFixtureRoot(workRoot, target)
  const xdg = defaultLocations(xdgRoot, target).filter((item) => item.id.startsWith('xdg-'))
  for (const location of xdg) installFile(location.fixture, location.path)
  assertRgb(
    ready(runFixtureHelper(helper, resources, xdgRoot)).profiles.light.background,
    rgb(34, 34, 34),
    'XDG precedence',
  )

  if (!target.startsWith('darwin-')) return locations.length + 1
  const allRoot = createFixtureRoot(workRoot, target)
  for (const location of defaultLocations(allRoot, target)) {
    installFile(location.fixture, location.path)
  }
  assertRgb(
    ready(runFixtureHelper(helper, resources, allRoot)).profiles.light.background,
    rgb(68, 68, 68),
    'macOS precedence',
  )
  return locations.length + 2
}

function testIncludeGraph(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): void {
  const root = createFixtureRoot(workRoot, target)
  installTree(join(fixtureDir, 'include-graph'), currentXdgPath(root))
  const result = ready(runFixtureHelper(helper, resources, root))
  if (result.diagnosticCount !== 3) throw new NativeVerifyFailure('diagnostic count mismatch')
  assertRgb(result.profiles.light.background, rgb(85, 85, 85), 'include order')
  assertRgb(result.profiles.light.foreground, rgb(1, 2, 3), 'include reset')
}

function testDualProfile(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): void {
  const root = createFixtureRoot(workRoot, target)
  installTree(join(fixtureDir, 'dual-profile'), currentXdgPath(root))
  const result = ready(runFixtureHelper(helper, resources, root))
  const { light, dark } = result.profiles
  assertRgb(light.background, rgb(247, 247, 247), 'light background')
  assertRgb(light.foreground, rgb(74, 69, 67), 'light foreground')
  assertRgb(colorRgb(light.cursorText), rgb(247, 247, 247), 'light cursor text')
  assertRgb(light.palette[0]!, rgb(9, 3, 0), 'light palette zero')
  assertRgb(light.palette[15]!, rgb(247, 247, 247), 'light palette fifteen')
  assertRgb(dark.background, rgb(33, 33, 33), 'dark background')
  assertRgb(dark.foreground, rgb(208, 208, 208), 'dark foreground')
  assertRgb(colorRgb(dark.cursorText), rgb(21, 21, 21), 'dark cursor text')
  assertRgb(dark.palette[0]!, rgb(21, 21, 21), 'dark palette zero')
  assertRgb(dark.palette[6]!, rgb(125, 214, 207), 'dark palette six')
  if (light.palette.length !== 256 || dark.palette.length !== 256) {
    throw new NativeVerifyFailure('dual palette length mismatch')
  }
  assertSurface(light, 0.9, false, { kind: 'radius', value: 20 })
  assertSurface(dark, 0.9, false, { kind: 'radius', value: 20 })
}

function testVisualProjection(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): void {
  const root = createFixtureRoot(workRoot, target)
  installTree(join(fixtureDir, 'visual'), currentXdgPath(root))
  const result = ready(runFixtureHelper(helper, resources, root))
  const { light, dark } = result.profiles
  if (JSON.stringify(light) !== JSON.stringify(dark)) {
    throw new NativeVerifyFailure('null conditional clone mismatch')
  }
  assertRgb(light.background, rgb(16, 32, 48), 'explicit background')
  assertRgb(light.foreground, rgb(255, 215, 0), 'named foreground')
  assertColorKind(light.cursorColor, 'cell-foreground')
  assertColorKind(light.cursorText, 'cell-background')
  assertColorKind(light.selectionBackground, 'cell-foreground')
  assertColorKind(light.selectionForeground, 'cell-background')
  if (light.minimumContrast !== 4.5) throw new NativeVerifyFailure('minimum contrast mismatch')
  if (light.windowColorspace !== 'display-p3') throw new NativeVerifyFailure('colorspace mismatch')
  assertSurface(light, 0.75, true, { kind: 'radius', value: 20 })
  assertRgb(light.palette[1]!, rgb(1, 2, 3), 'explicit palette one')
  assertRgb(light.palette[42]!, rgb(18, 52, 86), 'explicit palette forty-two')
  if (paletteSha256(light.palette) !== PALETTE_SHA256) {
    throw new NativeVerifyFailure('generated palette mismatch')
  }
}

function testFileTheme(workRoot: string, helper: string, resources: string, target: Target): void {
  const root = createFixtureRoot(workRoot, target)
  installTree(join(fixtureDir, 'file-theme'), currentXdgPath(root))
  const themeSource = join(fixtureDir, 'file-theme', 'themes', 'PLAN065_THEME_SENTINEL')
  const themeTarget = join(root.config, 'ghostty', 'themes', 'PLAN065_THEME_SENTINEL')
  installFile(themeSource, themeTarget)
  const profile = ready(runFixtureHelper(helper, resources, root)).profiles.light
  assertRgb(profile.background, rgb(18, 58, 188), 'file theme background')
  assertRgb(profile.foreground, rgb(254, 220, 186), 'file theme foreground')
  assertColorKind(profile.cursorText, 'cell-background')
}

function testSurfaceVariants(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): void {
  const vectors = [
    ['macos-glass-clear.ghostty', { kind: 'macos-glass', variant: 'clear' }],
    ['macos-glass-regular.ghostty', { kind: 'macos-glass', variant: 'regular' }],
    ['no-blur.ghostty', { kind: 'none' }],
  ] as const

  for (const [fixture, expected] of vectors) {
    const root = createFixtureRoot(workRoot, target)
    installFile(join(fixtureDir, 'surface', fixture), currentXdgPath(root))
    const profile = ready(runFixtureHelper(helper, resources, root)).profiles.light
    if (JSON.stringify(profile.surface.backgroundBlur) !== JSON.stringify(expected)) {
      throw new NativeVerifyFailure('surface variant mismatch')
    }
  }
}

function testCanonicalFloatVariants(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): void {
  const vectors = [
    ['opacity-scientific.ghostty', 0.0000001],
    ['opacity-decimal-boundary.ghostty', 0.000001],
  ] as const
  for (const [fixture, expected] of vectors) {
    const root = createFixtureRoot(workRoot, target)
    installFile(join(fixtureDir, 'surface', fixture), currentXdgPath(root))
    const profile = runFixtureHelper(helper, resources, root).profiles.light
    if (profile.surface.backgroundOpacity !== expected) {
      throw new NativeVerifyFailure('canonical float value mismatch')
    }
  }
}

function testFailureProtocol(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): void {
  const root = createFixtureRoot(workRoot, target)
  const result = spawnSync(helper, ['unexpected-argument'], {
    cwd: root.path,
    env: helperEnvironment(root, resources),
    encoding: 'buffer',
    maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  rmSync(root.path, { recursive: true, force: true })
  if (result.status !== 21 || result.stdout.length !== 0 || result.stderr.length !== 0) {
    throw new NativeVerifyFailure('failure helper protocol mismatch')
  }
}

async function testRaces(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): Promise<number> {
  const root = createFixtureRoot(workRoot, target)
  const locations = defaultLocations(root, target)
  rmSync(root.path, { recursive: true, force: true })
  for (const location of locations) {
    await runRace(workRoot, helper, resources, target, location.id, 'delete')
    await runRace(workRoot, helper, resources, target, location.id, 'rename')
  }
  return locations.length
}

async function runRace(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
  locationId: DefaultLocation['id'],
  action: 'delete' | 'rename',
): Promise<void> {
  const root = createFixtureRoot(workRoot, target)
  const location = defaultLocations(root, target).find((item) => item.id === locationId)
  if (!location) throw new NativeVerifyFailure('race location missing')
  installFile(location.fixture, location.path)

  const child = spawn(helper, [], {
    cwd: root.path,
    env: { ...helperEnvironment(root, resources), GHOSTTY_CONFIG_RESOLVER_TEST_RACE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  })
  const output: Buffer[] = []
  const errors: Buffer[] = []
  let outputBytes = 0
  let errorBytes = 0
  let overflow = false
  child.stdout?.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length
    if (outputBytes > OUTPUT_LIMIT) overflow = true
    if (overflow) return
    output.push(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    errorBytes += chunk.length
    if (errorBytes > OUTPUT_LIMIT) overflow = true
    if (overflow) return
    errors.push(chunk)
  })

  try {
    await waitForReady(child.stdio[3] as Readable | null)
    if (overflow) throw new NativeVerifyFailure('race helper output exceeded limit')
    applyRaceAction(location.path, root.path, action)
    const before = snapshotRoots(root)
    const continueStream = child.stdio[4] as Writable | null
    if (!continueStream) throw new NativeVerifyFailure('race continue pipe missing')
    continueStream.end('1')
    const code = await waitForClose(child)
    if (code !== 20 || overflow) throw new NativeVerifyFailure('race helper exit mismatch')
    if (Buffer.concat(output).length !== 0 || Buffer.concat(errors).length !== 0) {
      throw new NativeVerifyFailure('race helper emitted output')
    }
    if (before !== snapshotRoots(root)) throw new NativeVerifyFailure('race roots changed')
  } finally {
    await terminateChild(child)
    rmSync(root.path, { recursive: true, force: true })
  }
}

function applyRaceAction(path: string, root: string, action: 'delete' | 'rename'): void {
  if (action === 'delete') {
    rmSync(path)
    return
  }
  renameSync(path, join(root, 'removed-config'))
}

function createFixtureRoot(workRoot: string, _target: Target): FixtureRoot {
  const path = mkdtempSync(join(workRoot, 'fixture-'))
  const root = {
    path,
    home: join(path, 'home'),
    config: join(path, 'config'),
    cache: join(path, 'cache'),
    temporary: join(path, 'tmp'),
  }
  for (const directory of [root.home, root.config, root.cache, root.temporary]) {
    mkdirSync(directory, { recursive: true })
  }
  return root
}

function defaultLocations(root: FixtureRoot, target: Target): readonly DefaultLocation[] {
  const locations: DefaultLocation[] = [
    {
      id: 'xdg-legacy',
      path: join(root.config, 'ghostty', 'config'),
      fixture: join(fixtureDir, 'precedence', 'xdg-legacy.ghostty'),
      expected: rgb(17, 17, 17),
    },
    {
      id: 'xdg-current',
      path: join(root.config, 'ghostty', 'config.ghostty'),
      fixture: join(fixtureDir, 'precedence', 'xdg-current.ghostty'),
      expected: rgb(34, 34, 34),
    },
  ]
  if (!target.startsWith('darwin-')) return locations

  const appSupport = join(root.home, 'Library', 'Application Support', 'com.mitchellh.ghostty')
  locations.push(
    {
      id: 'app-legacy',
      path: join(appSupport, 'config'),
      fixture: join(fixtureDir, 'precedence', 'app-legacy.ghostty'),
      expected: rgb(51, 51, 51),
    },
    {
      id: 'app-current',
      path: join(appSupport, 'config.ghostty'),
      fixture: join(fixtureDir, 'precedence', 'app-current.ghostty'),
      expected: rgb(68, 68, 68),
    },
  )
  return locations
}

function currentXdgPath(root: FixtureRoot): string {
  return join(root.config, 'ghostty', 'config.ghostty')
}

function installTree(source: string, configTarget: string): void {
  const targetDir = dirname(configTarget)
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(source)) {
    if (entry === 'themes') continue
    cpSync(join(source, entry), join(targetDir, entry), { recursive: true })
  }
}

function installFile(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
}

function runFixtureHelper(helper: string, resources: string, root: FixtureRoot): NativeResult {
  const before = snapshotRoots(root)
  let result: NativeResult | null = null
  let failure: unknown = null
  try {
    result = runHelper(helper, resources, root)
  } catch (error) {
    failure = error
  }
  const changed = before !== snapshotRoots(root)
  rmSync(root.path, { recursive: true, force: true })
  if (changed) throw new NativeVerifyFailure('fixture roots changed')
  if (failure) throw failure
  if (!result) throw new NativeVerifyFailure('fixture helper result missing')
  return result
}

function runHelper(helper: string, resources: string, root: FixtureRoot): NativeResult {
  const result = spawnSync(helper, [], {
    cwd: root.path,
    env: helperEnvironment(root, resources),
    encoding: 'buffer',
    maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  if (result.status !== 0) throw new NativeVerifyFailure('helper failed')
  return parseOutput(result.stdout, result.stderr)
}

function runMissingHelper(helper: string, resources: string, root: FixtureRoot): void {
  const before = snapshotRoots(root)
  const result = spawnSync(helper, [], {
    cwd: root.path,
    env: helperEnvironment(root, resources),
    encoding: 'buffer',
    maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  const changed = before !== snapshotRoots(root)
  rmSync(root.path, { recursive: true, force: true })
  if (changed) throw new NativeVerifyFailure('absent fixture roots changed')
  if (result.status !== 20 || result.stdout.length !== 0 || result.stderr.length !== 0) {
    throw new NativeVerifyFailure('absent helper protocol mismatch')
  }
}

function helperEnvironment(root: FixtureRoot, resources: string): NodeJS.ProcessEnv {
  return {
    CFFIXED_USER_HOME: root.home,
    GHOSTTY_RESOURCES_DIR: resources,
    HOME: root.home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: root.temporary,
    XDG_CACHE_HOME: root.cache,
    XDG_CONFIG_HOME: root.config,
  }
}

function fixedProcessOptions(): {
  readonly encoding: 'utf8'
  readonly env: NodeJS.ProcessEnv
  readonly maxBuffer: number
} {
  return {
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    maxBuffer: OUTPUT_LIMIT,
  }
}

function parseOutput(stdout: Buffer, stderr: Buffer): NativeResult {
  if (stderr.length !== 0) throw new NativeVerifyFailure('helper wrote stderr')
  if (stdout.length === 0 || stdout.length > OUTPUT_LIMIT) {
    throw new NativeVerifyFailure('helper stdout length mismatch')
  }
  assertNoSentinel(stdout, stderr)

  let parsed: NativeResult
  try {
    parsed = parseCanonicalNativePayload(stdout) as NativeResult
  } catch {
    throw new NativeVerifyFailure('helper output violates the shared native schema')
  }
  const result = validateResult(parsed)
  if (!stdout.equals(canonicalObjectBytes(result))) {
    throw new NativeVerifyFailure('helper output is not canonical JSON+LF')
  }
  return result
}

function verifyNativeProtocolGolden(): void {
  const path = join(fixtureDir, 'native-protocol', 'canonical-ready.json')
  const bytes = readFileSync(path)
  if (sha256(bytes) !== NATIVE_GOLDEN_SHA256) {
    throw new NativeVerifyFailure('native protocol golden digest mismatch')
  }
  try {
    parseCanonicalNativePayload(bytes)
  } catch {
    throw new NativeVerifyFailure('native protocol golden violates the shared schema')
  }
}

function validateResult(value: unknown): NativeResult {
  const result = asObject(value, 'result')
  if (result.nativeSchemaVersion !== 1) throw new NativeVerifyFailure('schema version mismatch')
  if (result.upstreamRevision !== UPSTREAM_REVISION)
    throw new NativeVerifyFailure('revision mismatch')
  assertKeys(
    result,
    ['diagnosticCount', 'nativeSchemaVersion', 'profiles', 'upstreamRevision'],
    'ready result',
  )
  assertInteger(result.diagnosticCount, 0, 65_535, 'diagnostic count')
  const profiles = asObject(result.profiles, 'profiles')
  assertKeys(profiles, ['dark', 'light'], 'profiles')
  validateProfile(profiles.light)
  validateProfile(profiles.dark)
  return result as NativeResult
}

function validateProfile(value: unknown): NativeProfile {
  const profile = asObject(value, 'profile')
  assertKeys(
    profile,
    [
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
    ],
    'profile',
  )
  validateRgb(profile.background)
  validateRgb(profile.foreground)
  validateColor(profile.cursorColor)
  validateColor(profile.cursorText)
  validateColor(profile.selectionBackground)
  validateColor(profile.selectionForeground)
  assertFinite(profile.minimumContrast, 1, 21, 'minimum contrast')
  if (!Array.isArray(profile.palette) || profile.palette.length !== 256) {
    throw new NativeVerifyFailure('palette length mismatch')
  }
  for (const color of profile.palette) validateRgb(color)
  if (profile.windowColorspace !== 'srgb' && profile.windowColorspace !== 'display-p3') {
    throw new NativeVerifyFailure('window colorspace mismatch')
  }
  validateSurface(profile.surface)
  return profile as NativeProfile
}

function validateRgb(value: unknown): Rgb {
  const color = asObject(value, 'RGB')
  assertKeys(color, ['b', 'g', 'r'], 'RGB')
  for (const channel of ['r', 'g', 'b'] as const) {
    assertInteger(color[channel], 0, 255, `RGB ${channel}`)
  }
  return color as Rgb
}

function validateColor(value: unknown): NativeColor {
  const color = asObject(value, 'color')
  if (color.kind === 'rgb') {
    assertKeys(color, ['kind', 'value'], 'RGB color')
    validateRgb(color.value)
    return color as NativeColor
  }
  assertKeys(color, ['kind'], 'dynamic color')
  if (!['unset', 'cell-foreground', 'cell-background'].includes(color.kind as string)) {
    throw new NativeVerifyFailure('color kind mismatch')
  }
  return color as NativeColor
}

function validateSurface(value: unknown): void {
  const surface = asObject(value, 'surface')
  assertKeys(surface, ['backgroundBlur', 'backgroundOpacity', 'backgroundOpacityCells'], 'surface')
  assertFinite(surface.backgroundOpacity, 0, 1, 'background opacity')
  if (typeof surface.backgroundOpacityCells !== 'boolean') {
    throw new NativeVerifyFailure('background opacity cells mismatch')
  }
  const blur = asObject(surface.backgroundBlur, 'background blur')
  if (blur.kind === 'none') {
    assertKeys(blur, ['kind'], 'none blur')
    return
  }
  if (blur.kind === 'radius') {
    assertKeys(blur, ['kind', 'value'], 'radius blur')
    assertInteger(blur.value, 0, 255, 'blur radius')
    return
  }
  if (blur.kind !== 'macos-glass') throw new NativeVerifyFailure('blur kind mismatch')
  assertKeys(blur, ['kind', 'variant'], 'glass blur')
  if (blur.variant !== 'clear' && blur.variant !== 'regular') {
    throw new NativeVerifyFailure('glass variant mismatch')
  }
}

function ready(result: NativeResult): NativeResult {
  return result
}

function colorRgb(color: NativeColor): Rgb {
  if (color.kind !== 'rgb') throw new NativeVerifyFailure('static color required')
  return color.value
}

function assertColorKind(color: NativeColor, expected: NativeColor['kind']): void {
  if (color.kind !== expected) throw new NativeVerifyFailure('dynamic color mismatch')
}

function assertSurface(
  profile: NativeProfile,
  opacity: number,
  cells: boolean,
  blur: NativeProfile['surface']['backgroundBlur'],
): void {
  if (profile.surface.backgroundOpacity !== opacity)
    throw new NativeVerifyFailure('opacity mismatch')
  if (profile.surface.backgroundOpacityCells !== cells) {
    throw new NativeVerifyFailure('cell opacity mismatch')
  }
  if (JSON.stringify(profile.surface.backgroundBlur) !== JSON.stringify(blur)) {
    throw new NativeVerifyFailure('blur mismatch')
  }
}

function assertRgb(actual: Rgb, expected: Rgb, label: string): void {
  if (actual.r !== expected.r || actual.g !== expected.g || actual.b !== expected.b) {
    throw new NativeVerifyFailure(`${label} RGB mismatch`)
  }
}

function paletteSha256(palette: readonly Rgb[]): string {
  const bytes = Buffer.from(palette.flatMap((color) => [color.r, color.g, color.b]))
  return createHash('sha256').update(bytes).digest('hex')
}

function verifyDisplayP3Vectors(): void {
  const vectors = [
    { input: rgb(0, 0, 0), expected: rgb(0, 0, 0) },
    { input: rgb(255, 255, 255), expected: rgb(255, 255, 255) },
    { input: rgb(255, 0, 0), expected: rgb(255, 0, 0) },
    { input: rgb(0, 255, 0), expected: rgb(0, 255, 0) },
    { input: rgb(0, 0, 255), expected: rgb(0, 0, 255) },
    { input: rgb(128, 128, 128), expected: rgb(128, 128, 128) },
    { input: rgb(10, 10, 10), expected: rgb(10, 10, 10) },
    { input: rgb(11, 11, 11), expected: rgb(11, 11, 11) },
    { input: rgb(111, 85, 28), expected: rgb(116, 84, 8) },
  ] as const

  for (const vector of vectors) {
    const actual = displayP3ToSrgb(vector.input)
    if (!sameRgb(actual, vector.expected))
      throw new NativeVerifyFailure('Display-P3 vector mismatch')
  }

  const below = convertDisplayP3Raw(rgb(42, 35, 42))[2]!
  const above = convertDisplayP3Raw(rgb(198, 135, 238))[2]!
  if (!(below < 42.5 && below > 42.4999)) {
    throw new NativeVerifyFailure('lower rounding vector mismatch')
  }
  if (!(above > 244.5 && above < 244.5001)) {
    throw new NativeVerifyFailure('upper rounding vector mismatch')
  }
}

function displayP3ToSrgb(input: Rgb): Rgb {
  const encoded = convertDisplayP3Raw(input)
  return rgb(roundHalfUp(encoded[0]!), roundHalfUp(encoded[1]!), roundHalfUp(encoded[2]!))
}

function convertDisplayP3Raw(input: Rgb): readonly number[] {
  const p3ToXyz = [
    [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
    [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
    [0, 0.04511338185890264, 1.043944368900976],
  ] as const
  const xyzToSrgb = [
    [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
    [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
    [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
  ] as const
  const linearP3 = [input.r, input.g, input.b].map((channel) => decodeColor(channel / 255))
  const xyz = multiplyMatrix(p3ToXyz, linearP3)
  const linearSrgb = multiplyMatrix(xyzToSrgb, xyz)
  return linearSrgb.map((channel) => encodeColor(clampColor(channel)) * 255)
}

function multiplyMatrix(matrix: Matrix, vector: readonly number[]): readonly number[] {
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index]!, 0))
}

function decodeColor(channel: number): number {
  if (channel <= 0.04045) return channel / 12.92
  return ((channel + 0.055) / 1.055) ** 2.4
}

function encodeColor(channel: number): number {
  if (channel <= 0.0031308) return 12.92 * channel
  return 1.055 * channel ** (1 / 2.4) - 0.055
}

function clampColor(channel: number): number {
  return Math.max(0, Math.min(1, channel))
}

function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5)
}

function sameRgb(left: Rgb, right: Rgb): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b
}

function snapshotRoots(root: FixtureRoot): string {
  const records: string[] = []
  walkSnapshot(root.home, 'home', records)
  walkSnapshot(root.config, 'config', records)
  return createHash('sha256').update(records.join('\n')).digest('hex')
}

function walkSnapshot(path: string, label: string, records: string[]): void {
  const stat = lstatSync(path)
  const mode = (stat.mode & 0o777).toString(8)
  if (stat.isSymbolicLink()) {
    records.push(`${label}\0l\0${mode}\0${readlinkSync(path)}`)
    return
  }
  if (stat.isFile()) {
    records.push(`${label}\0f\0${mode}\0${sha256(readFileSync(path))}`)
    return
  }
  if (!stat.isDirectory()) throw new NativeVerifyFailure('unsupported fixture entry')
  records.push(`${label}\0d\0${mode}`)
  const entries = readdirSync(path).sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )
  for (const entry of entries) walkSnapshot(join(path, entry), `${label}/${entry}`, records)
}

function waitForReady(stream: Readable | null): Promise<void> {
  if (!stream) return Promise.reject(new NativeVerifyFailure('race ready pipe missing'))
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => fail(new NativeVerifyFailure('race ready timeout')), 30_000)
    const fail = (error: NativeVerifyFailure): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    }
    const succeed = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve()
    }
    stream.once('data', (chunk: Buffer) => {
      if (chunk.length !== 1 || chunk[0] !== 0x31) {
        fail(new NativeVerifyFailure('race ready signal mismatch'))
        return
      }
      succeed()
    })
    stream.once('error', () => fail(new NativeVerifyFailure('race ready pipe failed')))
    stream.once('end', () => fail(new NativeVerifyFailure('race ready pipe ended')))
  })
}

function waitForClose(
  child: ReturnType<typeof spawn>,
  timeoutMs: number = 30_000,
): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  if (child.signalCode !== null) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new NativeVerifyFailure('race helper timeout'))
    }, timeoutMs)
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
    child.once('error', () => {
      clearTimeout(timeout)
      reject(new NativeVerifyFailure('race helper spawn failed'))
    })
  })
}

async function terminateChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGKILL')
  try {
    await waitForClose(child, 5_000)
  } catch {
    return
  }
}

function assertNoSentinel(...values: readonly Buffer[]): void {
  for (const value of values) {
    const text = value.toString('utf8')
    if (SENTINELS.some((sentinel) => text.includes(sentinel))) {
      throw new NativeVerifyFailure('sentinel leaked')
    }
  }
}

function resourceIdentity(root: string): ResourceIdentity {
  const hash = createHash('sha256').update('ghostty-proof-resources-v1\0')
  const state = { bytes: 0, entries: 0 }
  walkResources(root, '', hash, state)
  return {
    sha256: hash.digest('hex'),
    bytes: state.bytes,
    entries: state.entries,
  }
}

function walkResources(
  path: string,
  relative: string,
  hash: ReturnType<typeof createHash>,
  state: { bytes: number; entries: number },
): void {
  const stat = lstatSync(path)
  const label = relative || '.'
  if (stat.isFile()) {
    const contents = readFileSync(path)
    hash.update(`f\0${label}\0${stat.mode & 0o777}\0${contents.length}\0`)
    hash.update(createHash('sha256').update(contents).digest())
    state.bytes += contents.length
    state.entries += 1
    return
  }
  if (!stat.isDirectory()) throw new NativeVerifyFailure('unsupported resource entry')
  hash.update(`d\0${label}\0${stat.mode & 0o777}\0`)
  state.entries += 1
  const entries = readdirSync(path).sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry}` : entry
    walkResources(join(path, entry), childRelative, hash, state)
  }
}

function writeEvidence(
  args: Arguments,
  helper: string,
  runner: Runner,
  dependencies: DependencyDetail,
  compatibility: CompatibilityDetail,
  fixtures: FixtureDetail,
  resources: ResourceIdentity,
): void {
  const artifact = readFileSync(helper)
  const evidence = {
    schemaVersion: 1,
    target: args.target,
    runner,
    nativeExecution: 'pass',
    artifactSha256: sha256(artifact),
    artifactBytes: statSync(helper).size,
    resourcesSha256: resources.sha256,
    resourcesBytes: resources.bytes,
    resourceEntries: resources.entries,
    semanticFixtures: 'pass',
    noWriteFixtures: 'pass',
    absentNoWrite: 'pass',
    deleteRaceNoWrite: 'pass',
    renameRaceNoWrite: 'pass',
    privacy: 'pass',
    dependencies: 'pass',
    compatibilityProbe: 'pass',
    relocation: 'pass',
    displayP3Vectors: 'pass',
    dependencyDetail: dependencies,
    compatibilityDetail: compatibility,
    fixtureDetail: fixtures,
  } as const
  const serialized = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`)
  if (serialized.length > MAX_EVIDENCE_BYTES)
    throw new NativeVerifyFailure('verify evidence too large')
  assertNoSentinel(serialized)
  writeFileSync(args.evidence, serialized, { flag: 'wx' })
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NativeVerifyFailure(`${label} must be an object`)
  }
  return value as JsonObject
}

function assertKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new NativeVerifyFailure(`${label} keys mismatch`)
  }
}

function assertInteger(value: unknown, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new NativeVerifyFailure(`${label} must be a bounded integer`)
  }
}

function assertFinite(value: unknown, minimum: number, maximum: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new NativeVerifyFailure(`${label} must be a bounded number`)
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function rgb(r: number, g: number, b: number): Rgb {
  return { r, g, b }
}

async function dispatch(): Promise<void> {
  if (process.argv[2] === '--compatibility-probe') {
    compatibilityProbeMain(process.argv.slice(3))
    return
  }
  await main()
}

try {
  await dispatch()
} catch (error) {
  const reason = error instanceof NativeVerifyFailure ? error.message : 'unexpected proof failure'
  process.stdout.write(`${JSON.stringify({ result: 'fail', reason })}\n`)
  process.exitCode = 1
}
